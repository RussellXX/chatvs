(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    const Messenger = {
        ready() {
            vscode.postMessage({ type: 'webviewReady' });
        },
        executeCommand(commandId, payload) {
            vscode.postMessage({ type: 'executeCommand', commandId, payload });
        }
    };

    const State = {
        nodes: [],
        leafOrder: [],
        currentModule: -1,
        refinementHistories: {},
        currentRefinementEntry: -1,
        moduleStatuses: {},
        isBusy: false,

        update(data) {
            this.nodes = Array.isArray(data.nodes) ? data.nodes : [];
            this.leafOrder = Array.isArray(data.leafOrder) ? data.leafOrder : [];
            this.currentModule = Number.isInteger(data.currentModule) ? data.currentModule : -1;
            this.refinementHistories =
                (data.refinementHistories && typeof data.refinementHistories === 'object')
                    ? data.refinementHistories
                    : {};
            this.currentRefinementEntry = Number.isInteger(data.currentRefinementEntry)
                ? data.currentRefinementEntry
                : -1;
            this.moduleStatuses =
                (data.moduleStatuses && typeof data.moduleStatuses === 'object')
                    ? data.moduleStatuses
                    : {};
            this.isBusy = !!data.isBusy;
        }
    };

    const LeafOrderView = {
        container: null,

        init(id) {
            this.container = document.getElementById(id);
        },

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
                chip.innerHTML = `<span class="chip-index">${i + 1}.</span>${raw.title || '(未命名)'}`;
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

    const RefinementHistoryView = {
        container: null,

        init(id) {
            this.container = document.getElementById(id);
        },

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

    const PromptInput = {
        el: null,

        init(id) {
            this.el = document.getElementById(id);
        },

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

    const SelectionController = {
        selectModule(index) {
            Messenger.executeCommand('selectModule', { index });
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

    const Renderer = {
        renderAll() {
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

    const ButtonBar = {
        refineMainBtn: null,
        refineDropdownBtn: null,
        refineSelectedLabel: null,
        refineDropdown: null,
        generateBtn: null,
        rollbackBtn: null,
        selectedRefineAction: 'refine',
        refineActionLabels: {
            refine: '全局精化',
            localRefine: '局部精化'
        },

        init() {
            document.getElementById('show-tree-btn').addEventListener('click', () => {
                Messenger.executeCommand('showDesignTree', {});
            });

            this.refineMainBtn = document.getElementById('refine-main-btn');
            this.refineDropdownBtn = document.getElementById('refine-dropdown-btn');
            this.refineSelectedLabel = document.getElementById('refine-selected-label');
            this.refineDropdown = document.getElementById('refine-dropdown');
            this.generateBtn = document.getElementById('generate-btn');
            this.rollbackBtn = document.getElementById('rollback-btn');

            this._syncRefineSelectionUi();

            this.refineMainBtn.addEventListener('click', () => {
                Messenger.executeCommand(this.selectedRefineAction, {
                    index: State.currentModule,
                    customPrompt: PromptInput.consume()
                });
            });

            this.generateBtn.addEventListener('click', () => {
                Messenger.executeCommand('generateCode', {
                    index: State.currentModule,
                    customPrompt: PromptInput.consume()
                });
            });

            this.rollbackBtn.addEventListener('click', () => {
                Messenger.executeCommand('rollbackRefinement', {
                    index: State.currentModule
                });
            });

            this.refineDropdownBtn.addEventListener('click', event => {
                event.stopPropagation();
                this.refineDropdown.classList.toggle('hidden');
                this.refineDropdownBtn.setAttribute(
                    'aria-expanded',
                    this.refineDropdown.classList.contains('hidden') ? 'false' : 'true'
                );
            });

            this.refineDropdown.querySelectorAll('.dropdown-item').forEach(item => {
                item.addEventListener('click', () => {
                    const action = item.dataset.action;
                    if (action !== 'refine' && action !== 'localRefine') {
                        return;
                    }
                    this.selectedRefineAction = action;
                    this._syncRefineSelectionUi();
                    this.refineDropdown.classList.add('hidden');
                    this.refineDropdownBtn.setAttribute('aria-expanded', 'false');
                });
            });

            document.addEventListener('click', () => {
                this.refineDropdown.classList.add('hidden');
                this.refineDropdownBtn.setAttribute('aria-expanded', 'false');
            });
        },

        update() {
            const busy = State.isBusy;
            const mi = State.currentModule;

            this.refineMainBtn.disabled = busy;
            this.refineDropdownBtn.disabled = busy;
            this.generateBtn.disabled = busy;
            this.rollbackBtn.disabled = busy;
            PromptInput.setDisabled(busy);

            if (!busy) {
                const nodeData = mi >= 0 ? State.nodes[mi] : null;
                const isLeafModule = nodeData && nodeData.nodeType === 'leaf'
                    && State.leafOrder.includes(mi);

                const history = mi >= 0 ? State.refinementHistories[mi] : null;
                const hasCode = history && history.some(e => e.type === 'code');
                const canOperate = isLeafModule && !hasCode && this._canOperate(mi);

                const historyLen = Array.isArray(history) ? history.length : 0;
                const selectedEntryIndex = Number.isInteger(State.currentRefinementEntry)
                    ? State.currentRefinementEntry
                    : -1;
                const hasSelectedEntry = selectedEntryIndex >= 0 && selectedEntryIndex < historyLen;
                const isViewingLast = hasSelectedEntry && selectedEntryIndex === historyLen - 1;

                const moduleStatus = State.moduleStatuses[String(mi)] || State.moduleStatuses[mi] || 'pending';

                const showRefineAndGenerate =
                    isLeafModule && isViewingLast && moduleStatus === 'inProgress';
                // const showRollbackOnly =
                //     isLeafModule && hasSelectedEntry && (!isViewingLast || moduleStatus === 'completed' || moduleStatus === 'pending');

                // this.refineMainBtn.style.display = showRefineAndGenerate ? '' : 'none';
                // this.refineDropdownBtn.style.display = showRefineAndGenerate ? '' : 'none';
                // this.generateBtn.style.display = showRefineAndGenerate ? '' : 'none';
                // this.rollbackBtn.style.display = (showRefineAndGenerate || showRollbackOnly) ? '' : 'none';

                this.refineMainBtn.disabled = !showRefineAndGenerate || !canOperate;
                this.refineDropdownBtn.disabled = !showRefineAndGenerate || !canOperate;
                this.generateBtn.disabled = !showRefineAndGenerate || !canOperate;
                this.rollbackBtn.disabled = !isLeafModule || !hasSelectedEntry;
            }
        },

        _syncRefineSelectionUi() {
            if (this.refineSelectedLabel) {
                this.refineSelectedLabel.textContent =
                    this.refineActionLabels[this.selectedRefineAction] || this.refineActionLabels.refine;
            }

            if (!this.refineDropdown) return;
            this.refineDropdown.querySelectorAll('.dropdown-item').forEach(item => {
                const selected = item.dataset.action === this.selectedRefineAction;
                item.classList.toggle('selected', selected);
                item.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
        },

        _canOperate(nodeIndex) {
            const pos = State.leafOrder.indexOf(nodeIndex);
            if (pos <= 0) return true;
            for (let i = 0; i < pos; i++) {
                const prev = State.leafOrder[i];
                const history = State.refinementHistories[prev];
                if (!history || !history.some(e => e.type === 'code')) return false;
            }
            return true;
        }
    };

    function bindMessageHandler() {
        window.addEventListener('message', event => {
            const msg = event.data;
            if (!msg || msg.type !== 'updateView') return;
            State.update(msg.data || {});
            Renderer.renderAll();
        });
    }

    function main() {
        LeafOrderView.init('leaf-order-root');
        RefinementHistoryView.init('refinement-history-root');
        PromptInput.init('prompt-input');
        ButtonBar.init();
        bindMessageHandler();
        Messenger.ready();
    }

    main();
})();
