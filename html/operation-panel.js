(function () {
    'use strict';

    // ==========================================================
    // 1. VS Code 通信层
    // ==========================================================
    const vscode = acquireVsCodeApi();

    const Messenger = {
        ready() {
            vscode.postMessage({ type: 'webviewReady' });
        },
        executeCommand(commandId, payload) {
            vscode.postMessage({ type: 'executeCommand', commandId, payload });
        }
    };

    // ==========================================================
    // 2. 状态管理（单一数据源）
    // ==========================================================
    const State = {
        nodes: [],
        leafOrder: [],
        currentModule: -1,
        refinementHistories: {},   // Record<number, RefinementEntry[]>
        currentRefinementEntry: -1,
        isBusy: false,
        treeRoot: null,

        update(data) {
            this.nodes              = Array.isArray(data.nodes)      ? data.nodes      : [];
            this.leafOrder          = Array.isArray(data.leafOrder)  ? data.leafOrder  : [];
            this.currentModule      = Number.isInteger(data.currentModule)         ? data.currentModule         : -1;
            this.refinementHistories = (data.refinementHistories && typeof data.refinementHistories === 'object')
                                       ? data.refinementHistories : {};
            this.currentRefinementEntry = Number.isInteger(data.currentRefinementEntry)
                                          ? data.currentRefinementEntry : -1;
            this.isBusy             = !!data.isBusy;
            this.treeRoot           = TreeBuilder.build(this.nodes);
        }
    };

    // ==========================================================
    // 3. 前序列表 → 多叉树
    // ==========================================================
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

    // ==========================================================
    // 4. 树状图（D3 + foreignObject 节点，支持文字换行与多行显示）
    // ==========================================================
    const TreeView = {
        container: null,
        // 节点尺寸：宽度固定，高度足以容纳标题 + 3 行描述
        NODE_W: 180, NODE_H: 88, H_GAP: 32, V_GAP: 60, PADDING: 18,

        init(containerId) { this.container = document.getElementById(containerId); },

        render(rootData, selectedIndex, onNodeClick) {
            this.container.innerHTML = '';
            if (!rootData) return;

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

            // 连接线
            g.append('g').selectAll('path').data(root.links()).join('path')
                .attr('class', 'tree-link')
                .attr('d', d3.linkVertical()
                    .source(l => [l.source.x, l.source.y + NH])
                    .target(l => [l.target.x, l.target.y])
                    .x(d => d[0]).y(d => d[1]));

            // 节点组
            const nodeG = g.append('g').selectAll('g').data(root.descendants()).join('g')
                .attr('class', d => {
                    const parts = ['tree-node', `node-${d.data.nodeType || 'non-leaf'}`];
                    if (d.data.originalIndex === selectedIndex) parts.push('selected');
                    return parts.join(' ');
                })
                .attr('transform', d => `translate(${d.x - NW / 2}, ${d.y})`)
                .on('click', (event, d) => {
                    event.stopPropagation();
                    if (typeof onNodeClick === 'function') onNodeClick(d.data.originalIndex);
                });

            // 背景矩形（圆角）
            nodeG.append('rect').attr('width', NW).attr('height', NH).attr('rx', 5).attr('ry', 5);

            // foreignObject：嵌入 HTML，实现自动换行与多行描述
            nodeG.append('foreignObject').attr('width', NW).attr('height', NH)
                .append('xhtml:div')
                .attr('class', d => {
                    const parts = ['node-inner', `node-inner-${d.data.nodeType || 'non-leaf'}`];
                    if (d.data.originalIndex === selectedIndex) parts.push('node-inner-selected');
                    return parts.join(' ');
                })
                .html(d => {
                    const t = this._esc(d.data.title);
                    const ds = this._esc(d.data.desc);
                    return `<div class="node-title">${t}</div>` +
                           (ds ? `<div class="node-desc">${ds}</div>` : '');
                });

            // 原生 tooltip：hover 时显示完整内容
            nodeG.append('title').text(d =>
                d.data.title + (d.data.desc ? '\n\n' + d.data.desc : '')
            );

            this.container.appendChild(svg.node());
        },

        _esc(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    };

    // ==========================================================
    // 5. 叶子拓扑顺序
    // ==========================================================
    const LeafOrderView = {
        container: null,
        init(id) { this.container = document.getElementById(id); },

        render(leafOrder, nodes, selectedIndex, onLeafClick) {
            this.container.innerHTML = '';
            if (!leafOrder || leafOrder.length === 0) {
                const hint = document.createElement('span');
                hint.className = 'hint-text';
                hint.textContent = '（暂无叶子节点）';
                this.container.appendChild(hint);
                return;
            }

            leafOrder.forEach((nodeIdx, i) => {
                const raw = nodes[nodeIdx];
                if (!raw) return;

                const chip = document.createElement('span');
                chip.className = 'leaf-chip' + (nodeIdx === selectedIndex ? ' selected' : '');
                chip.title = `${raw.title}\n${raw.desc || ''}`;
                chip.innerHTML =
                    `<span class="chip-index">${i + 1}.</span>${raw.title || '(未命名)'}`;
                chip.addEventListener('click', () => {
                    if (typeof onLeafClick === 'function') onLeafClick(nodeIdx);
                });
                this.container.appendChild(chip);

                if (i < leafOrder.length - 1) {
                    const arrow = document.createElement('span');
                    arrow.className = 'leaf-arrow';
                    arrow.textContent = '→';
                    this.container.appendChild(arrow);
                }
            });
        }
    };

    // ==========================================================
    // 6. 精化历史序列
    // ==========================================================
    const RefinementHistoryView = {
        container: null,
        init(id) { this.container = document.getElementById(id); },

        render(moduleIndex, histories, selectedEntryIndex, onEntryClick) {
            this.container.innerHTML = '';

            const history = histories[moduleIndex];

            if (moduleIndex < 0 || !history) {
                const hint = document.createElement('span');
                hint.className = 'hint-text';
                hint.textContent = '请先选中一个叶子模块';
                this.container.appendChild(hint);
                return;
            }

            if (history.length === 0) {
                const hint = document.createElement('span');
                hint.className = 'hint-text';
                hint.textContent = '（暂无精化历史）';
                this.container.appendChild(hint);
                return;
            }

            history.forEach((entry, i) => {
                // Arrow between blocks
                if (i > 0) {
                    const arrow = document.createElement('span');
                    arrow.className = 'refine-arrow';
                    arrow.textContent = '→';
                    this.container.appendChild(arrow);
                }

                const block = document.createElement('div');
                block.className = 'refine-block';

                const chip = document.createElement('div');
                chip.className = 'refine-chip chip-' + entry.type +
                    (i === selectedEntryIndex ? ' selected' : '');
                chip.textContent = entry.label;
                chip.title = entry.filePath;
                chip.addEventListener('click', () => {
                    if (typeof onEntryClick === 'function') onEntryClick(moduleIndex, i);
                });

                block.appendChild(chip);
                this.container.appendChild(block);
            });
        }
    };

    // ==========================================================
    // 6.5 自定义提示词输入
    // ==========================================================
    const PromptInput = {
        el: null,
        init(id) { this.el = document.getElementById(id); },
        /** 读取并清空输入框（发送后调用） */
        consume() {
            if (!this.el) return '';
            const val = (this.el.value || '').trim();
            this.el.value = '';
            return val;
        },
        setDisabled(disabled) {
            if (this.el) this.el.disabled = !!disabled;
        }
    };

    // ==========================================================
    // 7. 选中控制
    // ==========================================================
    const SelectionController = {
        selectModule(index) {
            Messenger.executeCommand('selectModule', { index });
            // Optimistic local update — backend will confirm via updateView
            State.currentModule = index;
            State.currentRefinementEntry = -1;
            Renderer.renderAll();
        },
        selectRefinement(moduleIndex, entryIndex) {
            Messenger.executeCommand('selectRefinement', { moduleIndex, entryIndex });
            State.currentRefinementEntry = entryIndex;
            Renderer.renderAll();
        }
    };

    // ==========================================================
    // 8. 统一渲染
    // ==========================================================
    const Renderer = {
        renderAll() {
            TreeView.render(
                State.treeRoot,
                State.currentModule,
                idx => SelectionController.selectModule(idx)
            );
            LeafOrderView.render(
                State.leafOrder,
                State.nodes,
                State.currentModule,
                idx => SelectionController.selectModule(idx)
            );
            RefinementHistoryView.render(
                State.currentModule,
                State.refinementHistories,
                State.currentRefinementEntry,
                (mi, ei) => SelectionController.selectRefinement(mi, ei)
            );
            ButtonBar.update();
        }
    };

    // ==========================================================
    // 9. 按钮栏
    // ==========================================================
    const ButtonBar = {
        divideBtn: null,
        refineMainBtn: null,
        refineArrowBtn: null,
        refineDropdown: null,
        confirmBtn: null,

        init() {
            this.divideBtn       = document.getElementById('divide-btn');
            this.refineMainBtn   = document.getElementById('refine-main-btn');
            this.refineArrowBtn  = document.getElementById('refine-dropdown-btn');
            this.refineDropdown  = document.getElementById('refine-dropdown');
            this.confirmBtn      = document.getElementById('confirm-btn');

            // 拆分
            this.divideBtn.addEventListener('click', () => {
                Messenger.executeCommand('divide', {
                    index: State.currentModule,
                    customPrompt: PromptInput.consume()
                });
            });

            // 精化（主按钮 = 精化）
            this.refineMainBtn.addEventListener('click', () => {
                Messenger.executeCommand('refine', {
                    index: State.currentModule,
                    customPrompt: PromptInput.consume()
                });
            });

            // 精化下拉箭头 — 切换菜单
            this.refineArrowBtn.addEventListener('click', e => {
                e.stopPropagation();
                this.refineDropdown.classList.toggle('hidden');
            });

            // 下拉菜单选项：refine(全局精化) / localRefine(局部精化) / generateCode(代码生成)
            this.refineDropdown.querySelectorAll('.dropdown-item').forEach(item => {
                item.addEventListener('click', () => {
                    const action = item.dataset.action;
                    this.refineDropdown.classList.add('hidden');
                    if (action === 'refine' || action === 'localRefine' || action === 'generateCode') {
                        Messenger.executeCommand(action, {
                            index: State.currentModule,
                            customPrompt: PromptInput.consume()
                        });
                    }
                });
            });

            // 确认
            this.confirmBtn.addEventListener('click', () => {
                Messenger.executeCommand('confirm', {});
            });

            // 点击面板其他地方收起下拉菜单
            document.addEventListener('click', () => {
                this.refineDropdown.classList.add('hidden');
            });
        },

        update() {
            const busy = State.isBusy;
            const mi   = State.currentModule;

            // 当 isBusy 时所有操作按钮与输入框均不可用
            this.divideBtn.disabled      = busy;
            this.refineMainBtn.disabled  = busy;
            this.refineArrowBtn.disabled = busy;
            this.confirmBtn.disabled     = busy;
            PromptInput.setDisabled(busy);

            if (!busy) {
                // 拆分：只对选中节点有效（根节点 or 叶子模块节点）
                const nodeData  = mi >= 0 ? State.nodes[mi] : null;
                const isLeafModule = nodeData && nodeData.nodeType === 'leaf'
                    && State.leafOrder.includes(mi);
                const isRoot = nodeData && nodeData.nodeType === 'root';
                this.divideBtn.disabled = !(isLeafModule || isRoot);

                // 精化 / 代码生成：只对当前可操作的叶子模块有效
                const history = mi >= 0 ? State.refinementHistories[mi] : null;
                const hasCode = history && history.some(e => e.type === 'code');
                const canOperate = isLeafModule && !hasCode && this._canOperate(mi);
                this.refineMainBtn.disabled  = !canOperate;
                this.refineArrowBtn.disabled = !canOperate;
            }
        },

        // 检查前置模块是否都已生成代码（与后端逻辑保持一致）
        _canOperate(nodeIndex) {
            const pos = State.leafOrder.indexOf(nodeIndex);
            if (pos <= 0) return true;
            for (let i = 0; i < pos; i++) {
                const prev = State.leafOrder[i];
                const h = State.refinementHistories[prev];
                if (!h || !h.some(e => e.type === 'code')) return false;
            }
            return true;
        }
    };

    // ==========================================================
    // 10. 消息监听
    // ==========================================================
    function bindMessageHandler() {
        window.addEventListener('message', event => {
            const msg = event.data;
            if (!msg || msg.type !== 'updateView') return;
            State.update(msg.data || {});
            Renderer.renderAll();
        });
    }

    // ==========================================================
    // 11. 启动
    // ==========================================================
    function main() {
        TreeView.init('tree-root');
        LeafOrderView.init('leaf-order-root');
        RefinementHistoryView.init('refinement-history-root');
        PromptInput.init('prompt-input');
        ButtonBar.init();
        bindMessageHandler();
        Messenger.ready();
    }

    main();
})();
