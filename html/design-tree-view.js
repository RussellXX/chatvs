(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    const State = {
        nodes: [],
        currentModule: -1,
        treeRoot: null,

        update(data) {
            this.nodes         = Array.isArray(data.nodes) ? data.nodes : [];
            this.currentModule = Number.isInteger(data.currentModule) ? data.currentModule : -1;
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

            g.append('g').selectAll('path').data(root.links()).join('path')
                .attr('class', 'tree-link')
                .attr('d', d3.linkVertical()
                    .source(l => [l.source.x, l.source.y + NH])
                    .target(l => [l.target.x, l.target.y])
                    .x(d => d[0]).y(d => d[1]));

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

            nodeG.append('rect').attr('width', NW).attr('height', NH).attr('rx', 5).attr('ry', 5);

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
