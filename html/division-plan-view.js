(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function renderPlans(payload) {
        const targetEl = document.getElementById('target-label');
        const root = document.getElementById('plans-root');
        if (!root || !targetEl) return;

        targetEl.textContent = `目标节点: ${payload.targetLabel || ''}`;
        root.innerHTML = '';

        const plans = Array.isArray(payload.plans) ? payload.plans : [];
        plans.forEach((plan, idx) => {
            const card = document.createElement('section');
            card.className = 'plan-card';

            const title = document.createElement('h2');
            title.className = 'plan-title';
            title.textContent = `方案 ${idx + 1}`;
            card.appendChild(title);

            const list = document.createElement('ul');
            list.className = 'modules-list';

            (Array.isArray(plan) ? plan : []).forEach(mod => {
                const item = document.createElement('li');
                item.className = 'module-item';

                const deps = Array.isArray(mod.dependencies) && mod.dependencies.length > 0
                    ? mod.dependencies.join(', ')
                    : '无';

                item.innerHTML = `
                    <p class="module-name">${esc(mod.name)}</p>
                    <p class="module-desc">${esc(mod.description)}</p>
                    <p class="module-deps">依赖: ${esc(deps)}</p>
                `;
                list.appendChild(item);
            });

            card.appendChild(list);

            const chooseBtn = document.createElement('button');
            chooseBtn.type = 'button';
            chooseBtn.className = 'choose-btn';
            chooseBtn.textContent = '选择此方案';
            chooseBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'executeCommand',
                    commandId: 'chooseDivisionPlan',
                    payload: { index: idx }
                });
            });
            card.appendChild(chooseBtn);

            root.appendChild(card);
        });
    }

    function bindEvents() {
        const cancelBtn = document.getElementById('cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'executeCommand',
                    commandId: 'cancelDivisionPlan'
                });
            });
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (!msg || msg.type !== 'renderPlans') return;
            renderPlans(msg.data || {});
        });
    }

    function main() {
        bindEvents();
        vscode.postMessage({ type: 'webviewReady' });
    }

    main();
})();
