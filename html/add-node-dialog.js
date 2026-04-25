(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    let availableModules = [];
    let selectedDeps = [];

    const nameInput    = document.getElementById('name-input');
    const nameError    = document.getElementById('name-error');
    const descInput    = document.getElementById('desc-input');
    const tagContainer = document.getElementById('tag-container');
    const tagTextInput = document.getElementById('tag-text-input');
    const dropdown     = document.getElementById('tag-dropdown');
    const okBtn        = document.getElementById('ok-btn');
    const cancelBtn    = document.getElementById('cancel-btn');
    const parentHint   = document.getElementById('parent-hint');

    // ── Init message from backend ────────────────────────────────────────────
    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type !== 'init') return;
        availableModules = Array.isArray(msg.availableModules) ? msg.availableModules : [];
        if (msg.parentName) {
            parentHint.textContent = `将作为 "${msg.parentName}" 的子节点`;
        }
    });

    // ── Tag rendering ────────────────────────────────────────────────────────
    function renderTags() {
        tagContainer.querySelectorAll('.tag').forEach(t => t.remove());
        selectedDeps.forEach((dep, i) => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML =
                `<span title="${escHtml(dep)}">${escHtml(dep)}</span>` +
                `<button class="tag-remove" data-idx="${i}" tabindex="-1">×</button>`;
            tagContainer.insertBefore(tag, tagTextInput);
        });
    }

    function addDep(name) {
        const trimmed = name.trim();
        if (!trimmed || selectedDeps.includes(trimmed)) return;
        selectedDeps.push(trimmed);
        renderTags();
        tagTextInput.value = '';
        hideDropdown();
    }

    function removeDep(idx) {
        selectedDeps.splice(idx, 1);
        renderTags();
    }

    // ── Dropdown ─────────────────────────────────────────────────────────────
    function showDropdown(query) {
        const q = query.toLowerCase();
        const filtered = availableModules.filter(
            m => m.toLowerCase().includes(q) && !selectedDeps.includes(m)
        );
        if (filtered.length === 0) { hideDropdown(); return; }
        dropdown.innerHTML = filtered
            .map(m => `<div class="tag-dropdown-item" data-value="${escHtml(m)}">${escHtml(m)}</div>`)
            .join('');
        dropdown.style.display = 'block';
    }

    function hideDropdown() {
        dropdown.style.display = 'none';
    }

    // ── Events: tag input ────────────────────────────────────────────────────
    tagTextInput.addEventListener('input', () => {
        showDropdown(tagTextInput.value);
    });

    tagTextInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const active = dropdown.querySelector('.tag-dropdown-item.active');
            if (active) {
                addDep(active.dataset.value);
            } else {
                const val = tagTextInput.value.trim();
                if (val) addDep(val);
            }
        } else if (e.key === 'Backspace' && tagTextInput.value === '' && selectedDeps.length > 0) {
            removeDep(selectedDeps.length - 1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateDropdown(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateDropdown(-1);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    tagTextInput.addEventListener('blur', () => {
        // Small delay so dropdown mousedown fires first.
        setTimeout(hideDropdown, 150);
    });

    dropdown.addEventListener('mousedown', e => {
        const item = e.target.closest('[data-value]');
        if (!item) return;
        e.preventDefault();
        addDep(item.dataset.value);
        tagTextInput.focus();
    });

    tagContainer.addEventListener('click', e => {
        const removeBtn = e.target.closest('.tag-remove');
        if (removeBtn) {
            removeDep(parseInt(removeBtn.dataset.idx, 10));
            return;
        }
        tagTextInput.focus();
    });

    function navigateDropdown(dir) {
        const items = Array.from(dropdown.querySelectorAll('.tag-dropdown-item'));
        if (items.length === 0) return;
        const activeIdx = items.findIndex(el => el.classList.contains('active'));
        const nextIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
        items.forEach(el => el.classList.remove('active'));
        items[nextIdx].classList.add('active');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
    }

    // ── Form submission ───────────────────────────────────────────────────────
    okBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

    function submit() {
        const name = nameInput.value.trim();
        if (!name) {
            nameError.textContent = '模块名称不能为空。';
            nameError.classList.add('visible');
            nameInput.focus();
            return;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            nameError.textContent = '名称只能含字母、数字、下划线，且不以数字开头。';
            nameError.classList.add('visible');
            nameInput.focus();
            return;
        }
        nameError.classList.remove('visible');
        vscode.postMessage({
            type: 'submit',
            data: { name, description: descInput.value.trim(), dependencies: selectedDeps }
        });
    }

    cancelBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });

    nameInput.addEventListener('input', () => nameError.classList.remove('visible'));

    // ── Utils ─────────────────────────────────────────────────────────────────
    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    nameInput.focus();
})();
