(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    const State = {
        nodes: [],
        currentModule: -1,
        isBusy: false,
        treeRoot: null,

        update(data) {
            this.nodes         = Array.isArray(data.nodes) ? data.nodes : [];
            this.currentModule = Number.isInteger(data.currentModule) ? data.currentModule : -1;
            this.isBusy        = !!data.isBusy;
            this.treeRoot      = TreeBuilder.build(this.nodes);
        }
    };

    // ── Pre-order list → multi-way tree ──────────────────────────────────────
    const TreeBuilder = {
        build(nodes) {
            if (!nodes || nodes.length === 0) return null;
            let cursor = 0;
            const walk = () => {
                if (cursor >= nodes.length) return null;
                const raw = nodes[cursor];
                const index = cursor++;
                const node = {
                    originalIndex: index,
                    nodeType: raw.nodeType,
                    title: raw.title || '',
                    desc: raw.desc || '',
                    children: []
                };
                for (let i = 0; i < (raw.childCount || 0); i++) {
                    const child = walk();
                    if (child) node.children.push(child);
                }
                return node;
            };
            return walk();
        }
    };

    // ── D3 tree view ─────────────────────────────────────────────────────────
    const TreeView = {
        container: null,
        stage: null,
        canvas: null,
        saveButton: null,
        baseWidth: 0,
        baseHeight: 0,
        scale: 1,
        MIN_SCALE: 0.6,
        MAX_SCALE: 1.8,
        WHEEL_STEP: 0.02,
        NODE_W: 180, NODE_H: 88, H_GAP: 32, V_GAP: 60, PADDING: 18,
        // Extra width reserved to the right of each node for the action bar.
        ACTION_BAR_W: 44,

        init(containerId) {
            this.container = document.getElementById('tree-scroll');
            this.stage = document.getElementById('tree-stage');
            this.canvas = document.getElementById('tree-canvas');
            this.saveButton = document.getElementById('save-btn');
            this._bindEvents();
        },

        render(rootData, selectedIndex, onNodeClick, onDivideClick, onAddChildClick, onDeleteClick) {
            this.canvas.innerHTML = '';
            this.baseWidth = 0;
            this.baseHeight = 0;
            if (!rootData) {
                this._applyZoom();
                return;
            }

            const root = d3.hierarchy(rootData);
            const layout = d3.tree().nodeSize([this.NODE_W + this.H_GAP, this.NODE_H + this.V_GAP]);
            layout(root);

            let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
            root.each(d => {
                if (d.x < minX) minX = d.x;
                if (d.x > maxX) maxX = d.x;
                if (d.y > maxY) maxY = d.y;
            });

            // Add extra right margin for action bars on the rightmost nodes.
            const svgW = (maxX - minX) + this.NODE_W + this.ACTION_BAR_W + this.PADDING * 2;
            const svgH = maxY + this.NODE_H + this.PADDING * 2;
            const NW = this.NODE_W, NH = this.NODE_H;

            const svg = d3.create('svg').attr('width', svgW).attr('height', svgH);
            const g = svg.append('g').attr('transform',
                `translate(${this.PADDING - minX + NW / 2}, ${this.PADDING})`);

            g.append('g').selectAll('path').data(root.links()).join('path')
                .attr('class', 'tree-link')
                .attr('d', d3.linkVertical()
                    .source(l => [l.source.x, l.source.y + NH])
                    .target(l => [l.target.x, l.target.y])
                    .x(d => d[0]).y(d => d[1]));

            const isSelected = d => d.data.originalIndex >= 0 && d.data.originalIndex === selectedIndex;

            const nodeG = g.append('g').selectAll('g').data(root.descendants()).join('g')
                .attr('class', d => {
                    const parts = ['tree-node', `node-${d.data.nodeType || 'non-leaf'}`];
                    if (isSelected(d)) parts.push('selected');
                    return parts.join(' ');
                })
                .attr('transform', d => `translate(${d.x - NW / 2}, ${d.y})`)
                .on('mouseenter', function() { d3.select(this).raise(); })
                .on('click', (event, d) => {
                    event.stopPropagation();
                    if (typeof onNodeClick === 'function') {
                        onNodeClick(d.data.originalIndex);
                    }
                });

            nodeG.append('rect').attr('width', NW).attr('height', NH).attr('rx', 5).attr('ry', 5);

            nodeG.append('foreignObject').attr('width', NW).attr('height', NH)
                .append('xhtml:div')
                .attr('class', d => {
                    const parts = ['node-inner', `node-inner-${d.data.nodeType || 'non-leaf'}`];
                    if (isSelected(d)) parts.push('node-inner-selected');
                    return parts.join(' ');
                })
                .html(d => {
                    const t = this._esc(d.data.title);
                    const ds = this._esc(d.data.desc);
                    return `<div class="node-title">${t}</div>` +
                           (ds ? `<div class="node-desc">${ds}</div>` : '');
                });

            nodeG.append('title').text(d =>
                d.data.title + (d.data.desc ? '\n\n' + d.data.desc : '')
            );

            // ── Action bar (shown on hover for all nodes) ─────────────────
            // "拆分" is only enabled for leaf or solo-root nodes.
            const canDivide = d =>
                d.data.nodeType === 'leaf' ||
                (d.data.nodeType === 'root' && (!d.data.children || d.data.children.length === 0));

            const allNodesG = nodeG.filter(d => d.data.originalIndex >= 0);

            // foreignObject overlaps the node rect by 2px to eliminate the hover dead zone.
            const actionFO = allNodesG.append('foreignObject')
                .attr('x', NW - 2)
                .attr('y', 0)
                .attr('width', this.ACTION_BAR_W)
                .attr('height', NH)
                .attr('class', 'node-action-bar-fo');

            actionFO.append('xhtml:div')
                .attr('class', 'node-action-bar')
                .html(d => {
                    const isRoot = d.data.nodeType === 'root';
                    const divDis = canDivide(d) ? '' : ' disabled';
                    const delDis = isRoot ? ' disabled' : '';
                    return `<button class="action-bar-btn" data-role="divide"   title="划分该模块"${divDis}>拆分</button>` +
                           `<button class="action-bar-btn" data-role="addChild" title="新增子节点">新增</button>` +
                           `<button class="action-bar-btn" data-role="delete"   title="删除该节点"${delDis}>删除</button>`;
                });

            // Click handler: listen on the foreignObject (SVG element, D3-compatible).
            // Events from buttons inside bubble up here; datum d is correctly bound.
            actionFO.on('click', function (event, d) {
                event.stopPropagation();
                const btn = event.target.closest('[data-role]');
                if (!btn || btn.disabled) return;
                const role = btn.dataset.role;
                const idx  = d.data.originalIndex;
                if (role === 'divide'   && typeof onDivideClick   === 'function') onDivideClick(idx);
                if (role === 'addChild' && typeof onAddChildClick === 'function') onAddChildClick(idx);
                if (role === 'delete'   && typeof onDeleteClick   === 'function') onDeleteClick(idx);
            });

            this.baseWidth = svgW;
            this.baseHeight = svgH;
            this.canvas.appendChild(svg.node());
            this._applyZoom();
        },

        _bindEvents() {
            this.container?.addEventListener('wheel', event => {
                if (!event.ctrlKey) return;
                event.preventDefault();
                this._changeZoom(event.deltaY < 0 ? this.WHEEL_STEP : -this.WHEEL_STEP);
            }, { passive: false });

            this.saveButton?.addEventListener('click', () => {
                vscode.postMessage({ type: 'executeCommand', commandId: 'save', payload: {} });
            });
        },

        _changeZoom(delta) {
            const nextScale = this._clampScale(this.scale + delta);
            if (Math.abs(nextScale - this.scale) < 0.0001) return;
            this.scale = nextScale;
            this._applyZoom();
        },

        _applyZoom() {
            const width = this.baseWidth > 0 ? Math.ceil(this.baseWidth * this.scale) : 0;
            const height = this.baseHeight > 0 ? Math.ceil(this.baseHeight * this.scale) : 0;

            this.stage.style.width = width > 0 ? `${width}px` : '100%';
            this.stage.style.height = height > 0 ? `${height}px` : '100%';
            this.canvas.style.transform = `scale(${this.scale})`;
            this.canvas.style.width = this.baseWidth > 0 ? `${this.baseWidth}px` : '0';
            this.canvas.style.height = this.baseHeight > 0 ? `${this.baseHeight}px` : '0';
            this._updateSaveButton();
        },

        _clampScale(scale) {
            return Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, scale));
        },

        _updateSaveButton() {
            if (this.saveButton) {
                this.saveButton.disabled = State.isBusy;
            }
        },

        _esc(s) { return _esc(s); }
    };

    // ── Shared escape helper ──────────────────────────────────────────────────
    function _esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _dropdownNavigate(dd, dir) {
        const items = Array.from(dd.querySelectorAll('[data-value]'));
        if (!items.length) return;
        const cur = items.findIndex(el => el.classList.contains('active'));
        const next = Math.max(0, Math.min(items.length - 1, cur + dir));
        items.forEach(el => el.classList.remove('active'));
        items[next].classList.add('active');
        items[next].scrollIntoView({ block: 'nearest' });
    }

    // ── Add-node dialog (inline overlay) ─────────────────────────────────────
    const DialogManager = {
        _nodeIndex: -1,
        _selectedDeps: [],
        _availableModules: [],

        show(nodeIndex, parentName, availableModules) {
            this._nodeIndex = nodeIndex;
            this._selectedDeps = [];
            this._availableModules = availableModules || [];

            _id('add-node-parent-hint').textContent =
                parentName ? `将作为 "${parentName}" 的子节点` : '';
            _id('add-node-name').value = '';
            _id('add-node-desc').value = '';
            _id('add-node-tag-input').value = '';
            _id('add-node-name-err').hidden = true;
            this._renderTags();
            this._hideDropdown();

            _id('add-node-overlay').hidden = false;
            setTimeout(() => _id('add-node-name').focus(), 50);
        },

        hide() {
            _id('add-node-overlay').hidden = true;
            this._nodeIndex = -1;
            this._selectedDeps = [];
        },

        _renderTags() {
            const box   = _id('add-node-tag-box');
            const input = _id('add-node-tag-input');
            box.querySelectorAll('.add-node-tag').forEach(t => t.remove());
            this._selectedDeps.forEach((dep, i) => {
                const tag = document.createElement('span');
                tag.className = 'add-node-tag';
                tag.innerHTML =
                    `<span title="${_esc(dep)}">${_esc(dep)}</span>` +
                    `<button class="add-node-tag-remove" data-idx="${i}" tabindex="-1">×</button>`;
                box.insertBefore(tag, input);
            });
        },

        _addDep(name) {
            const t = name.trim();
            if (!t || this._selectedDeps.includes(t)) return;
            this._selectedDeps.push(t);
            this._renderTags();
            _id('add-node-tag-input').value = '';
            this._hideDropdown();
        },

        _removeDep(idx) {
            this._selectedDeps.splice(idx, 1);
            this._renderTags();
        },

        _showDropdown(query) {
            const q = query.toLowerCase();
            const filtered = this._availableModules.filter(
                m => m.toLowerCase().includes(q) && !this._selectedDeps.includes(m)
            );
            const dd = _id('add-node-dropdown');
            if (!filtered.length) { this._hideDropdown(); return; }
            dd.innerHTML = filtered
                .map(m => `<div class="add-node-dropdown-item" data-value="${_esc(m)}">${_esc(m)}</div>`)
                .join('');
            dd.style.display = 'block';
        },

        _hideDropdown() { _id('add-node-dropdown').style.display = 'none'; },

        submit() {
            const nameEl = _id('add-node-name');
            const errEl  = _id('add-node-name-err');
            const name   = nameEl.value.trim();
            if (!name) {
                errEl.textContent = '模块名称不能为空。';
                errEl.hidden = false;
                nameEl.focus();
                return;
            }
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                errEl.textContent = '名称只能含字母、数字、下划线，且不以数字开头。';
                errEl.hidden = false;
                nameEl.focus();
                return;
            }
            errEl.hidden = true;
            vscode.postMessage({
                type: 'executeCommand',
                commandId: 'confirmAddChildNode',
                payload: {
                    index: this._nodeIndex,
                    name,
                    description: _id('add-node-desc').value.trim(),
                    dependencies: this._selectedDeps.slice()
                }
            });
            this.hide();
        },

        bindEvents() {
            const tagInput  = _id('add-node-tag-input');
            const tagBox    = _id('add-node-tag-box');
            const dropdown  = _id('add-node-dropdown');
            const self      = this;

            _id('add-node-ok').addEventListener('click', () => self.submit());
            _id('add-node-cancel').addEventListener('click', () => self.hide());

            // Dismiss on backdrop click.
            _id('add-node-overlay').addEventListener('click', e => {
                if (e.target === _id('add-node-overlay')) self.hide();
            });

            _id('add-node-name').addEventListener('input', () => {
                _id('add-node-name-err').hidden = true;
            });

            tagInput.addEventListener('input', () => self._showDropdown(tagInput.value));

            tagInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const active = dropdown.querySelector('.add-node-dropdown-item.active');
                    if (active) self._addDep(active.dataset.value);
                    else if (tagInput.value.trim()) self._addDep(tagInput.value);
                } else if (e.key === 'Backspace' && !tagInput.value && self._selectedDeps.length) {
                    self._removeDep(self._selectedDeps.length - 1);
                } else if (e.key === 'ArrowDown') { e.preventDefault(); _dropdownNavigate(dropdown, 1); }
                  else if (e.key === 'ArrowUp')   { e.preventDefault(); _dropdownNavigate(dropdown, -1); }
                  else if (e.key === 'Escape')     { self._hideDropdown(); }
            });

            tagInput.addEventListener('blur', () => setTimeout(() => self._hideDropdown(), 150));

            dropdown.addEventListener('mousedown', e => {
                const item = e.target.closest('[data-value]');
                if (!item) return;
                e.preventDefault();
                self._addDep(item.dataset.value);
                tagInput.focus();
            });

            tagBox.addEventListener('click', e => {
                const btn = e.target.closest('.add-node-tag-remove');
                if (btn) { self._removeDep(parseInt(btn.dataset.idx, 10)); return; }
                tagInput.focus();
            });
        }
    };

    function _id(id) { return document.getElementById(id); }

    // ── Message handler ───────────────────────────────────────────────────────
    function bindMessageHandler() {
        window.addEventListener('message', event => {
            const msg = event.data;
            if (!msg) return;

            if (msg.type === 'showAddNodeDialog') {
                const { nodeIndex, parentName, availableModules } = msg.data || {};
                DialogManager.show(nodeIndex, parentName, availableModules);
                return;
            }

            if (msg.type !== 'updateView') return;
            State.update(msg.data || {});

            TreeView.render(
                State.treeRoot,
                State.currentModule,
                idx => vscode.postMessage({
                    type: 'executeCommand',
                    commandId: 'selectDesignTreeModule',
                    payload: { index: idx }
                }),
                idx => {
                    if (!State.isBusy) vscode.postMessage({
                        type: 'executeCommand', commandId: 'divide', payload: { index: idx }
                    });
                },
                idx => {
                    if (!State.isBusy) vscode.postMessage({
                        type: 'executeCommand', commandId: 'addChildNode', payload: { index: idx }
                    });
                },
                idx => {
                    if (!State.isBusy) vscode.postMessage({
                        type: 'executeCommand', commandId: 'deleteNode', payload: { index: idx }
                    });
                }
            );

            TreeView._updateSaveButton();
        });
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    function main() {
        TreeView.init('tree-root');
        DialogManager.bindEvents();
        bindMessageHandler();
        vscode.postMessage({ type: 'webviewReady' });
    }

    main();
})();
