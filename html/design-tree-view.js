(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    const State = {
        nodes: [],
        currentModule: -1,
        hasCommonDS: false,
        hasActualDS: false,
        treeRoot: null,

        update(data) {
            this.nodes         = Array.isArray(data.nodes) ? data.nodes : [];
            this.currentModule = Number.isInteger(data.currentModule) ? data.currentModule : -1;
            this.hasCommonDS   = !!data.hasCommonDS;
            this.hasActualDS   = !!data.hasActualDS;
            this.treeRoot      = TreeBuilder.build(this.nodes, this.hasCommonDS, this.hasActualDS);
        }
    };

    // ── Pre-order list → multi-way tree ──────────────────────────────────────
    const TreeBuilder = {
        build(nodes, hasCommonDS, hasActualDS) {
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
            const root = walk();
            // Inject common DS as the first child of root when available.
            // Inject actual DS as its sole child when the promoted file exists.
            if (root && hasCommonDS) {
                const commonDSChildren = [];
                if (hasActualDS) {
                    commonDSChildren.push({
                        originalIndex: -2,
                        nodeType: 'actual-ds',
                        title: '实际数据结构',
                        desc: '由通用数据结构转换生成的语言实现代码',
                        children: []
                    });
                }
                root.children.unshift({
                    originalIndex: -1,
                    nodeType: 'common-ds',
                    title: '通用数据结构',
                    desc: '各模块间传递的共用数据结构，含字段语义描述与使用模块说明',
                    children: commonDSChildren
                });
            }
            return root;
        }
    };

    // ── D3 tree view ─────────────────────────────────────────────────────────
    const TreeView = {
        container: null,
        stage: null,
        canvas: null,
        zoomInButton: null,
        zoomOutButton: null,
        baseWidth: 0,
        baseHeight: 0,
        scale: 1,
        MIN_SCALE: 0.6,
        MAX_SCALE: 1.8,
        BUTTON_STEP: 0.1,
        WHEEL_STEP: 0.02,
        NODE_W: 180, NODE_H: 88, H_GAP: 32, V_GAP: 60, PADDING: 18,

        init(containerId) {
            this.container = document.getElementById('tree-scroll');
            this.stage = document.getElementById('tree-stage');
            this.canvas = document.getElementById('tree-canvas');
            this.zoomInButton = document.getElementById('zoom-in-btn');
            this.zoomOutButton = document.getElementById('zoom-out-btn');
            this._bindEvents();
            this._updateZoomButtons();
        },

        render(rootData, selectedIndex, onNodeClick) {
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

            const svgW = (maxX - minX) + this.NODE_W + this.PADDING * 2;
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
                .on('click', (event, d) => {
                    event.stopPropagation();
                    if (d.data.originalIndex === -2) {
                        vscode.postMessage({ type: 'executeCommand', commandId: 'openActualDS', payload: {} });
                    } else if (d.data.originalIndex === -1) {
                        vscode.postMessage({ type: 'executeCommand', commandId: 'openCommonDS', payload: {} });
                    } else if (typeof onNodeClick === 'function') {
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

            this.baseWidth = svgW;
            this.baseHeight = svgH;
            this.canvas.appendChild(svg.node());
            this._applyZoom();
        },

        _bindEvents() {
            this.zoomInButton?.addEventListener('click', () => this._changeZoom(this.BUTTON_STEP));
            this.zoomOutButton?.addEventListener('click', () => this._changeZoom(-this.BUTTON_STEP));
            this.container?.addEventListener('wheel', event => {
                if (!event.ctrlKey) return;
                event.preventDefault();
                this._changeZoom(event.deltaY < 0 ? this.WHEEL_STEP : -this.WHEEL_STEP);
            }, { passive: false });
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
            this._updateZoomButtons();
        },

        _clampScale(scale) {
            return Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, scale));
        },

        _updateZoomButtons() {
            const hasContent = this.baseWidth > 0 && this.baseHeight > 0;
            if (this.zoomInButton) {
                this.zoomInButton.disabled = !hasContent || this.scale >= this.MAX_SCALE - 0.001;
            }
            if (this.zoomOutButton) {
                this.zoomOutButton.disabled = !hasContent || this.scale <= this.MIN_SCALE + 0.001;
            }
        },

        _esc(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    };

    // ── Message handler ───────────────────────────────────────────────────────
    function bindMessageHandler() {
        window.addEventListener('message', event => {
            const msg = event.data;
            if (!msg || msg.type !== 'updateView') return;
            State.update(msg.data || {});
            TreeView.render(
                State.treeRoot,
                State.currentModule,
                idx => vscode.postMessage({ type: 'executeCommand', commandId: 'selectModule', payload: { index: idx } })
            );

        });
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    function main() {
        TreeView.init('tree-root');
        bindMessageHandler();
        vscode.postMessage({ type: 'webviewReady' });
    }

    main();
})();
