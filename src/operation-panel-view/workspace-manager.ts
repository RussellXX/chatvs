import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as settings from '../settings/settings';
import * as openaiHelper from '../openai/openai-helper';
import { ModulesArraySchema, validateModulePrefix } from '../openai/schemas';
import { topoSortLeafModules } from '../tools/module-topology-util';
import {
    DesignmentTreeDataProvider,
    ProjectNode,
    ModuleNode,
    RequirementNode,
    DesignmentTreeNode
} from '../designment-tree-view/designment-tree-data-provider';
import { OperationPanelViewProvider } from './operation-panel-view-provider';
import { DesignTreeViewProvider } from './design-tree-view-provider';
import { DivisionPlanViewProvider } from './division-plan-view-provider';
import {
    NodeType,
    TreeNodeData,
    RefinementEntry,
    UpdateViewPayload,
    ModuleProgressStatus
} from '../types/operation-panel-view-protocol';
import { loadRefinementHistory, saveRefinementHistory } from './workspace-persistence';
import { cleanLLMResponse, getHumanJsonPath, LineData } from './granularity-view-utils';
import {
    normPath,
    isDraftPath,
    toDraftPath,
    toRealPath,
    cleanDraft,
    promoteDraft,
    readJsonDraftFirst,
    getDraftRoot,
} from './draft-overlay';
import { CommonDSManager } from './common-ds-manager';
import { generateActualDS, actualDSRealPath } from './actual-ds-generator';
import * as Diff from 'diff';

// ── helpers ─────────────────────────────────────────────────────────────────

function appendCustomPrompt(userPrompt: string, customPrompt: string): string {
    const trimmed = (customPrompt || '').trim();
    if (!trimmed) return userPrompt;
    return `${userPrompt}\n\n---\n用户额外要求：\n${trimmed}`;
}

function writeJsonAtomically(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${filePath}.tmp.${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        if (fs.existsSync(tempPath)) { try { fs.unlinkSync(tempPath); } catch (_) {} }
        throw err;
    }
}

function readModuleDesc(absolutePath: string): string {
    const contentPath = path.join(absolutePath, 'content.txt');
    if (!fs.existsSync(contentPath)) {
        throw new Error(`Module content file does not exist: ${contentPath}.`);
    }
    const text = fs.readFileSync(contentPath, 'utf8').trim();
    try {
        const json = JSON.parse(text);
        return ((json.description as string) || '').slice(0, 200);
    } catch {
        return text.slice(0, 200);
    }
}

function cloneTree(src: ProjectNode): ProjectNode {
    const clone: ProjectNode = new ProjectNode(src.label, src.absolutePath);
    clone.children = src.children.map(child => {
        if (child instanceof RequirementNode) {
            return new RequirementNode(clone);
        }
        return cloneModuleNode(child as ModuleNode, clone);
    }) as (ModuleNode | RequirementNode)[];
    return clone;
}

function cloneModuleNode(src: ModuleNode, parent: ProjectNode | ModuleNode): ModuleNode {
    const node = new ModuleNode(src.label, src.absolutePath, parent);
    node.children = src.children.map(c => cloneModuleNode(c, node));
    return node;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── WorkspaceManager ────────────────────────────────────────────────────────

export class WorkspaceManager {
    private static _instance: WorkspaceManager | null = null;

    // active project
    private projectRoot: ProjectNode | null = null;
    private workspaceRoot: ProjectNode | null = null;

    // ── Operation-panel state (derived from projectRoot / actual project) ──
    private nodes: TreeNodeData[] = [];
    private leafOrder: number[] = [];
    private leafModuleIndices: Set<number> = new Set();
    private currentModule = -1;
    private currentRefinementEntry = -1;
    private refinementHistories: Record<number, RefinementEntry[]> = {};
    private moduleStatuses: Record<number, ModuleProgressStatus> = {};
    private indexToPath = new Map<number, string>();

    // ── Design-tree state (derived from workspaceRoot / draft overlay) ──
    private dtNodes: TreeNodeData[] = [];
    private dtIndexToPath = new Map<number, string>();

    private isBusy = false;

    private _commonDS: CommonDSManager;

    // Real-path directories to delete when saveDesignTree() is called.
    private _pendingRealDeletes: Set<string> = new Set();

    private constructor(private context: vscode.ExtensionContext) {
        this._commonDS = new CommonDSManager(context);
    }

    static init(context: vscode.ExtensionContext): WorkspaceManager {
        if (!WorkspaceManager._instance) {
            WorkspaceManager._instance = new WorkspaceManager(context);
        }
        return WorkspaceManager._instance;
    }

    static getInstance(): WorkspaceManager {
        if (!WorkspaceManager._instance) {
            throw new Error('WorkspaceManager not initialised — call init() first');
        }
        return WorkspaceManager._instance;
    }

    // ── public API ────────────────────────────────────────────────────────

    /**
     * Open the design-tree workspace for the given project.
     * Cleans any stale draft, resets the workspace overlay, and reveals the
     * design-tree panel.  Does NOT touch operation-panel state.
     */
    async openDesignTree(projectNode: ProjectNode): Promise<void> {
        cleanDraft(projectNode.absolutePath);
        this.projectRoot = projectNode;
        this.workspaceRoot = cloneTree(projectNode);
        this.isBusy = false;
        this._commonDS.reset();
        this._pendingRealDeletes = new Set();
        this.rebuildDesignTreeState();
        // Store payload before createOrShow so the webviewReady handler gets it.
        DesignTreeViewProvider.postMessage({ type: 'updateView', data: this.buildDesignTreePayload() });
        DesignTreeViewProvider.createOrShow();
    }

    /**
     * Load the operation panel with the refinement state of the given project.
     * Does NOT open the design-tree panel.
     * Preserves any in-progress workspaceRoot draft if the project hasn't changed.
     */
    async loadRefinementPanel(projectNode: ProjectNode): Promise<void> {
        this.projectRoot = projectNode;
        // Keep workspaceRoot intact when reloading the same project so that any
        // unsaved design-tree work is not discarded.
        if (!this.workspaceRoot || this.workspaceRoot.absolutePath !== projectNode.absolutePath) {
            this.workspaceRoot = cloneTree(projectNode);
            this._pendingRealDeletes = new Set();
        }
        this.currentModule = -1;
        this.currentRefinementEntry = -1;
        this.refinementHistories = {};
        this.moduleStatuses = {};
        this.isBusy = false;
        this._commonDS.reset();
        this.rebuildDerivedState();
        this.postUpdate();
    }

    /**
     * Divide a node (design-tree workspace operation).
     * Writes only to the .tmp draft overlay; does NOT touch the real project
     * directory or the operation-panel state.
     */
    async divide(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.dtIndexToPath.get(nodeIndex);
        if (!targetPath) return;

        const node = this.findNode(this.workspaceRoot, targetPath);
        if (!node) return;

        if (node instanceof ProjectNode) {
            const hasModules = node.children.some(c => c instanceof ModuleNode);
            if (hasModules) {
                vscode.window.showWarningMessage('项目已完成初始划分，只能对叶子模块进行拆分。');
                return;
            }
        }
        if (node instanceof ModuleNode && !node.isLeaf()) {
            vscode.window.showWarningMessage('只能拆分叶子模块节点。');
            return;
        }

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在划分模块...',
            cancellable: false
        }, async progress => {
            try {
                const applied = await this.performDivision(node, customPrompt);
                if (applied) {
                    progress.report({ message: '模块划分成功！' });
                    await delay(1000);
                } else {
                    progress.report({ message: '已取消本次模块划分。' });
                    await delay(600);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`模块划分失败: ${err}`);
            }
        });

        this.isBusy = false;
        this.rebuildDesignTreeState();
        this.postUpdate();
    }

    /**
     * Global refinement — writes pseudo-code directly to the real module
     * directory (no draft staging).
     */
    async refine(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot) return;

        const history = this.refinementHistories[nodeIndex];
        if (!history || history.length === 0) return;
        if (history[history.length - 1].type === 'code') {
            vscode.window.showWarningMessage('该模块已完成代码生成。');
            return;
        }
        if (!this.canOperate(nodeIndex)) {
            vscode.window.showWarningMessage('请先完成前置模块的代码生成。');
            return;
        }

        const projectAbs = this.projectRoot.absolutePath;
        const modulePath = this.indexToPath.get(nodeIndex)!;

        const isFirstLeaf = this.leafOrder.length > 0 && nodeIndex === this.leafOrder[0];
        const historyIsSpecOnly = history.every(e => e.type === 'spec');
        const shouldGenerateCommonDS = isFirstLeaf && historyIsSpecOnly && !this._commonDS.exists(projectAbs);

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async progress => {
            try {
                if (shouldGenerateCommonDS) {
                    progress.report({ message: '正在提取通用数据结构...' });
                    const ongoingPath = this.resolveOngoingPath(projectAbs);
                    await this._commonDS.generate(projectAbs, ongoingPath);
                    this.postUpdate();
                }
                progress.report({ message: '正在精化...' });

                const commonDSPath = this._commonDS.draftFirstPath(projectAbs);
                const lastEntry = history[history.length - 1];
                const fileContent = fs.readFileSync(lastEntry.filePath, 'utf8');
                const prompt = await openaiHelper.getGlobalRefinePromptDetailed(
                    fileContent, modulePath, commonDSPath
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);

                // Write directly to the real module directory (no draft staging).
                const outputPath = path.join(modulePath, `pseudo_${Date.now()}.txt`);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, raw, 'utf8');

                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                history.push({ label: `粒度${pseudoCount + 1}`, filePath: outputPath, type: 'pseudo' });
                this.currentRefinementEntry = history.length - 1;
                this.markOnlyActive(history, this.currentRefinementEntry);

                saveRefinementHistory(modulePath, history);

                await this.openInEditor(outputPath);
                progress.report({ message: '精化完成！' });
                await delay(1000);
            } catch (err) {
                vscode.window.showErrorMessage(`精化失败: ${err}`);
            }
        });

        this.isBusy = false;
        if (DesignmentTreeDataProvider.hasInstance()) {
            DesignmentTreeDataProvider.getInstance().refresh(undefined);
        }
        this.postUpdate();
    }

    /**
     * Local refinement — writes pseudo-code directly to the real module directory.
     */
    async localRefine(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot) return;

        const history = this.refinementHistories[nodeIndex];
        if (!history || history.length === 0) return;
        const lastEntry = history[history.length - 1];
        if (lastEntry.type === 'code') {
            vscode.window.showWarningMessage('该模块已完成代码生成。');
            return;
        }
        if (!this.canOperate(nodeIndex)) {
            vscode.window.showWarningMessage('请先完成前置模块的代码生成。');
            return;
        }

        const targetPath = normPath(lastEntry.filePath);
        const editor = vscode.window.visibleTextEditors.find(
            e => normPath(e.document.fileName) === targetPath
        );

        if (!editor) {
            vscode.window.showWarningMessage('局部精化前，请先在编辑器中打开当前模块最新的伪代码文件。');
            return;
        }
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先在编辑器中选中要精化的部分。');
            return;
        }

        const projectAbs = this.projectRoot.absolutePath;
        const modulePath = this.indexToPath.get(nodeIndex)!;
        const commonDSPath = this._commonDS.draftFirstPath(projectAbs);

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '',
            cancellable: false
        }, async progress => {
            try {
                progress.report({ message: '正在局部精化...' });
                const selection = editor.selection;
                const fileContent = editor.document.getText();
                const selectedCode = editor.document.getText(selection);
                const startLine = selection.start.line + 1;
                const endLine = selection.end.line + 1;

                const prompt = await openaiHelper.getLocalRefinePrompt(
                    fileContent, startLine, endLine, selectedCode, modulePath, commonDSPath
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);
                const refinedContent = cleanLLMResponse(raw);

                // Write directly to the real module directory (no draft staging).
                const outputPath = path.join(modulePath, `pseudo_local_${Date.now()}.txt`);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });

                const oldHumanPath = getHumanJsonPath(lastEntry.filePath);
                let oldStatus: LineData[] = [];
                if (fs.existsSync(oldHumanPath)) {
                    try { oldStatus = JSON.parse(fs.readFileSync(oldHumanPath, 'utf8')); } catch { oldStatus = []; }
                }

                const { newStatus, highlightRanges } = diffLineStatus(fileContent, refinedContent, oldStatus);

                const refinedLines = refinedContent.split(/\r?\n/);
                if (refinedContent.endsWith('\n') && refinedLines.length > newStatus.length) {
                    refinedLines.pop();
                }
                newStatus.forEach((s, i) => { if (i < refinedLines.length) s.content = refinedLines[i]; });

                fs.writeFileSync(getHumanJsonPath(outputPath), JSON.stringify(newStatus, null, 2), 'utf8');
                fs.writeFileSync(outputPath, refinedContent, 'utf8');
                fs.writeFileSync(outputPath + '.highlight.json', JSON.stringify(highlightRanges, null, 2), 'utf8');

                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                history.push({ label: `粒度${pseudoCount + 1}`, filePath: outputPath, type: 'pseudo' });
                this.currentRefinementEntry = history.length - 1;
                this.markOnlyActive(history, this.currentRefinementEntry);

                saveRefinementHistory(modulePath, history);

                await this.openInEditor(outputPath);
                progress.report({ message: '局部精化完成！' });
                await delay(1000);
            } catch (err) {
                vscode.window.showErrorMessage(`局部精化失败: ${err}`);
            }
        });

        this.isBusy = false;
        this.postUpdate();
    }

    /**
     * Code generation — writes code directly to the real codes directory
     * (no staging / draft overlay).
     */
    async generateCode(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot) return;

        const history = this.refinementHistories[nodeIndex];
        if (!history || history.length === 0) return;
        if (history[history.length - 1].type === 'code') {
            vscode.window.showWarningMessage('该模块已完成代码生成。');
            return;
        }
        if (!this.canOperate(nodeIndex)) {
            vscode.window.showWarningMessage('请先完成前置模块的代码生成。');
            return;
        }

        const projectPath = this.projectRoot.absolutePath;
        const projectName = path.basename(projectPath);
        const modulePath = this.indexToPath.get(nodeIndex)!;
        const language = 'python';
        const realCodeDir = path.join(settings.getCodesPath(), projectName);

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '',
            cancellable: false
        }, async progress => {
            try {
                const topoIdx = this.leafOrder.indexOf(nodeIndex);

                // Phase 1: first-module setup — project scaffold + data structure files.
                if (topoIdx === 0) {
                    const { initialProject } = await import('../tools/project-initializer.js');
                    await initialProject(realCodeDir, language);

                    if (!this._commonDS.exists(projectPath)) {
                        progress.report({ message: '正在提取通用数据结构...' });
                        const ongoingPath = this.resolveOngoingPath(projectPath);
                        await this._commonDS.generate(projectPath, ongoingPath);
                        this.postUpdate();
                    }

                    if (this._commonDS.exists(projectPath)) {
                        progress.report({ message: '正在生成实际数据结构...' });
                        const commonDSContent = fs.readFileSync(
                            this._commonDS.draftFirstPath(projectPath), 'utf8'
                        );
                        await generateActualDS(realCodeDir, commonDSContent, language, this.context);
                        this.postUpdate();
                    }
                }

                // Phase 2: generate module code.
                progress.report({ message: '正在生成代码...' });
                const lastEntry = history[history.length - 1];
                const fileContent = fs.readFileSync(lastEntry.filePath, 'utf8');
                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                const prompt = await openaiHelper.getGenerateCodePrompt(
                    fileContent, `粒度${pseudoCount}`, language, modulePath, realCodeDir
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);
                const code = cleanLLMResponse(raw);

                const { writeModule } = await import('../tools/module-writer.js');
                const moduleRelPath = path.relative(projectPath, modulePath);
                const generatedFilePath = await writeModule(realCodeDir, moduleRelPath, code, language);

                if (topoIdx === this.leafOrder.length - 1) {
                    const { updateRootLaunchConfig } = await import('../tools/launch-config-updater.js');
                    await updateRootLaunchConfig(settings.getProjectPath(), projectName, generatedFilePath, language);
                    vscode.window.showInformationMessage(`已更新调试配置: "Run ${projectName}"`);
                }

                history.push({ label: '实际代码', filePath: generatedFilePath, type: 'code' });
                this.currentRefinementEntry = history.length - 1;
                this.markOnlyActive(history, this.currentRefinementEntry);

                saveRefinementHistory(modulePath, history);

                await this.openInEditor(generatedFilePath);
                progress.report({ message: '代码生成成功！' });
                await delay(1000);
            } catch (err) {
                vscode.window.showErrorMessage(`代码生成失败: ${err}`);
            }
        });

        this.isBusy = false;
        this.rebuildDerivedState();
        if (DesignmentTreeDataProvider.hasInstance()) {
            DesignmentTreeDataProvider.getInstance().refresh(undefined);
        }
        this.postUpdate();
    }

    async rollbackRefinement(nodeIndex: number): Promise<void> {
        if (this.isBusy || !this.projectRoot) return;

        const moduleIndex = Number.isInteger(nodeIndex) && nodeIndex >= 0
            ? nodeIndex
            : this.currentModule;
        if (moduleIndex < 0 || !this.leafOrder.includes(moduleIndex)) {
            vscode.window.showWarningMessage('请先选中一个叶子模块。');
            return;
        }

        const targetIndex = this.currentRefinementEntry;
        if (targetIndex < 0) {
            vscode.window.showWarningMessage('您还没有选择要回退到的伪代码记录');
            return;
        }

        const currentHistory = this.refinementHistories[moduleIndex];
        if (!currentHistory || currentHistory.length === 0) {
            vscode.window.showWarningMessage('读取粒度历史失败，无法执行回退。');
            return;
        }
        if (targetIndex >= currentHistory.length) {
            vscode.window.showWarningMessage('当前选中的历史记录无效，无法回退。');
            return;
        }

        const projectAbs = this.projectRoot.absolutePath;
        const projectName = path.basename(projectAbs);
        const currentPos = this.leafOrder.indexOf(moduleIndex);
        const isFirstLeaf = currentPos === 0;
        const isLastLeaf = currentPos === this.leafOrder.length - 1;

        const removedOfCurrent = currentHistory.slice(targetIndex + 1);
        const removedCurrentHasCode = removedOfCurrent.some(e => e.type === 'code');

        this.isBusy = true;
        this.postUpdate();

        try {
            await this.rollbackSingleModuleToIndex(moduleIndex, targetIndex);

            for (let i = currentPos + 1; i < this.leafOrder.length; i++) {
                const nextModuleIndex = this.leafOrder[i];
                const removedHasCode = await this.rollbackSingleModuleToIndex(nextModuleIndex, 0);
                if (removedHasCode && i === this.leafOrder.length - 1) {
                    await this.removeLaunchConfigSafe(projectName);
                }
            }

            if (removedCurrentHasCode && isFirstLeaf) {
                // Delete the real codes directory (per CLAUDE.md, CommonDS is preserved).
                try {
                    const realCodeDir = path.join(settings.getCodesPath(), projectName);
                    if (fs.existsSync(realCodeDir)) {
                        fs.rmSync(realCodeDir, { recursive: true, force: true });
                    }
                } catch (err) {
                    console.warn('[WorkspaceManager] 清理代码目录失败:', err);
                }
                DesignmentTreeDataProvider.getInstance().refresh(undefined);
            }

            if (removedCurrentHasCode && isLastLeaf) {
                await this.removeLaunchConfigSafe(projectName);
            }

            const currentHistoryAfterRollback = this.refinementHistories[moduleIndex];
            const activeType = currentHistoryAfterRollback?.[targetIndex]?.type ?? 'spec';
            this.syncModuleStatusesToOngoing(moduleIndex, activeType === 'code' ? 'code' : 'pseudo');

            this.currentModule = moduleIndex;
            this.currentRefinementEntry = targetIndex;
            const activeEntry = this.refinementHistories[moduleIndex]?.[targetIndex];
            if (activeEntry) {
                this.openInEditor(activeEntry.filePath).catch(() => {});
            }

            this.postUpdate();
        } catch (err) {
            vscode.window.showErrorMessage(`回退失败: ${err}`);
        } finally {
            this.isBusy = false;
            this.postUpdate();
        }
    }

    /**
     * Save the design-tree workspace: promotes the .tmp draft overlay to the
     * real project directory.  Only the module structure is synced; refinement
     * and code files already live in the real project and codes dir.
     *
     * If the module structure has changed AND refinement history exists, warns
     * the user and clears all histories on confirmation.
     */
    async saveDesignTree(): Promise<void> {
        if (!this.projectRoot || !this.workspaceRoot) return;

        // Validate leaf topology before saving.
        const topoCheck = this._validateLeafTopology();
        if (!topoCheck.valid) {
            vscode.window.showErrorMessage(topoCheck.error ?? '工作区叶子节点拓扑校验失败，无法保存。');
            return;
        }

        const projectAbs = this.projectRoot.absolutePath;

        // Detect whether the draft overlay contains any module-structure changes.
        const draftRoot = getDraftRoot(projectAbs);
        const hasDraftContent = (fs.existsSync(draftRoot) && fs.readdirSync(draftRoot).length > 0)
            || this._pendingRealDeletes.size > 0;

        if (hasDraftContent) {
            const hasHistory = Object.values(this.refinementHistories).some(
                h => h.some(e => e.type === 'pseudo' || e.type === 'code')
            );

            if (hasHistory) {
                const answer = await vscode.window.showWarningMessage(
                    '检测到已存在精化历史，如修改设计，会导致精化历史被清空。是否继续？',
                    { modal: true }, '继续'
                );
                if (answer !== '继续') return;

                // Clear all refinement files from disk for the current actual leaves.
                for (const [idxStr, history] of Object.entries(this.refinementHistories)) {
                    const absPath = this.indexToPath.get(Number(idxStr));
                    if (!absPath) continue;
                    for (const entry of history.slice(1)) {
                        const artifacts = [
                            entry.filePath,
                            getHumanJsonPath(entry.filePath),
                            `${entry.filePath}.highlight.json`
                        ];
                        for (const f of artifacts) {
                            if (f && fs.existsSync(f)) {
                                try { fs.unlinkSync(f); } catch (_) {}
                            }
                        }
                    }
                    const histFile = path.join(absPath, 'refinement_history.json');
                    if (fs.existsSync(histFile)) {
                        try { fs.unlinkSync(histFile); } catch (_) {}
                    }
                }

                // Clear CommonDS (real file) and codes directory.
                // clearReal() also sets _suppress=true so exists() returns false
                // until the next generate() call.
                this._commonDS.clearReal(projectAbs);
                try {
                    const projectName = path.basename(projectAbs);
                    const realCodeDir = path.join(settings.getCodesPath(), projectName);
                    if (fs.existsSync(realCodeDir)) {
                        fs.rmSync(realCodeDir, { recursive: true, force: true });
                    }
                    await this.removeLaunchConfigSafe(projectName);
                } catch (err) {
                    console.warn('[WorkspaceManager] 清理代码目录失败:', err);
                }

                this.refinementHistories = {};
                this.currentModule = -1;
                this.currentRefinementEntry = -1;
            }
        }

        // Promote .tmp → actual project directory.
        try {
            promoteDraft(projectAbs);
        } catch (err) {
            vscode.window.showErrorMessage(`保存失败: ${err}`);
            return;
        }

        // Delete real-path directories that were queued during deleteNode() calls.
        for (const realDir of this._pendingRealDeletes) {
            try {
                if (fs.existsSync(realDir)) fs.rmSync(realDir, { recursive: true, force: true });
            } catch (err) {
                console.warn('[WorkspaceManager] 删除节点目录失败:', err);
            }
        }
        this._pendingRealDeletes = new Set();

        // Remap workspaceRoot draft paths → real paths, then sync to projectRoot.
        this.remapTreeToReal(this.workspaceRoot, projectAbs);
        this.projectRoot.children = this.workspaceRoot.children.map(child => {
            if (child instanceof RequirementNode) {
                return new RequirementNode(this.projectRoot!);
            }
            return cloneModuleNode(child as ModuleNode, this.projectRoot!);
        }) as (ModuleNode | RequirementNode)[];
        this.fixParentRefs(this.projectRoot);

        // Rebuild real ongoing manifest from the actual tree/content so
        // operation-panel topology uses the latest dependencies.
        this._rewriteRealOngoingFromProjectTree();

        this.rebuildDerivedState();

        DesignmentTreeDataProvider.getInstance().refresh(undefined);
        this.postUpdate();
        vscode.window.showInformationMessage('设计树已保存。');
        DesignTreeViewProvider.currentPanel?.dispose();
    }

    /**
     * Reset the design-tree workspace: discard all draft changes and reload
     * the module structure from the actual project directory.
     */
    async resetWorkspace(): Promise<void> {
        if (!this.projectRoot || !this.workspaceRoot) return;

        cleanDraft(this.projectRoot.absolutePath);
        this._pendingRealDeletes = new Set();
        this.workspaceRoot = cloneTree(this.projectRoot);

        this.rebuildDesignTreeState();
        this.postUpdate();
    }

    /**
     * Clear all workspace state (called when the loaded project is deleted).
     * Disposes the design-tree panel and posts empty state to both panels.
     */
    clearWorkspace(): void {
        if (this.projectRoot) {
            cleanDraft(this.projectRoot.absolutePath);
        }
        this.projectRoot = null;
        this.workspaceRoot = null;
        this.nodes = [];
        this.leafOrder = [];
        this.leafModuleIndices = new Set();
        this.currentModule = -1;
        this.currentRefinementEntry = -1;
        this.refinementHistories = {};
        this.moduleStatuses = {};
        this.indexToPath = new Map();
        this.dtNodes = [];
        this.dtIndexToPath = new Map();
        this.isBusy = false;
        this._commonDS.reset();
        this._pendingRealDeletes = new Set();

        this.postUpdate();
        DesignTreeViewProvider.currentPanel?.dispose();
    }

    /**
     * If the project at `absolutePath` is currently loaded, clear the workspace.
     * Safe to call even when WorkspaceManager has not been initialised.
     */
    static clearIfLoaded(absolutePath: string): void {
        if (!WorkspaceManager._instance) return;
        const loaded = WorkspaceManager._instance.projectRoot?.absolutePath;
        if (!loaded) return;
        if (normPath(loaded) === normPath(absolutePath)) {
            WorkspaceManager._instance.clearWorkspace();
        }
    }

    /** Open the common_data_structures.json file in the editor. */
    async openCommonDS(): Promise<void> {
        if (!this.projectRoot) return;
        const filePath = this._commonDS.draftFirstPath(this.projectRoot.absolutePath);
        if (fs.existsSync(filePath)) {
            await this.openInEditor(filePath);
        }
    }

    /** Open the language-specific data structure file (e.g. data_structures.py) in the editor. */
    async openActualDS(): Promise<void> {
        if (!this.projectRoot) return;
        try {
            const realCodeDir = path.join(settings.getCodesPath(), path.basename(this.projectRoot.absolutePath));
            const filePath = actualDSRealPath(realCodeDir, 'python');
            if (fs.existsSync(filePath)) {
                await this.openInEditor(filePath);
            }
        } catch (_) {}
    }

    /**
     * Delete a node (and its entire subtree) from the workspace draft.
     * Draft-path subtrees are removed from .tmp immediately; real-path subtree
     * roots are queued in _pendingRealDeletes for deletion on save.
     */
    async deleteNode(nodeIndex: number): Promise<void> {
        if (this.isBusy || !this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.dtIndexToPath.get(nodeIndex);
        if (!targetPath) return;

        const node = this.findNode(this.workspaceRoot, targetPath);
        if (!node || !(node instanceof ModuleNode)) return;

        const parent = node.parent!;
        (parent.children as any[]) = (parent.children as any[]).filter(c => c !== node);

        const projectAbs = this.projectRoot.absolutePath;

        // Remove all leaf names in the subtree from draft manifests.
        const leafNames = this._collectLeafNames(node);
        this._removeLeafNamesFromDraftManifests(leafNames);

        // Delete or queue the subtree root (fs.rmSync is recursive).
        if (isDraftPath(projectAbs, targetPath)) {
            try {
                if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
            } catch (err) {
                console.warn('[WorkspaceManager] 删除暂存节点失败:', err);
            }
        } else {
            this._pendingRealDeletes.add(targetPath);
        }

        // If deleting this subtree makes the parent a leaf again, restore the
        // parent module entry into draft manifests so topology can include it.
        if (parent instanceof ModuleNode && parent.isLeaf()) {
            this._ensureLeafSpecInDraftManifests(parent);
        }

        this.rebuildDesignTreeState();
        this.postUpdate();
    }

    /**
     * Send the add-child-node dialog data to the design-tree webview.
     * Actual node creation happens in confirmAddChildNode() after the user confirms.
     */
    async addChildNode(nodeIndex: number): Promise<void> {
        if (this.isBusy || !this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.dtIndexToPath.get(nodeIndex);
        if (!targetPath) return;

        const node = this.findNode(this.workspaceRoot, targetPath);
        if (!node) return;

        const parentNode     = node as ProjectNode | ModuleNode;
        const availableLeaves = this._getWorkspaceLeafNames(
            parentNode instanceof ModuleNode ? parentNode : undefined
        );

        DesignTreeViewProvider.showAddNodeDialog(nodeIndex, parentNode.label, availableLeaves);
    }

    /**
     * Create a new child node in the workspace draft after the user confirms
     * the add-node dialog (sent back as confirmAddChildNode command).
     */
    async confirmAddChildNode(
        nodeIndex: number,
        name: string,
        description: string,
        dependencies: string[]
    ): Promise<void> {
        if (!this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.dtIndexToPath.get(nodeIndex);
        if (!targetPath) return;

        const node = this.findNode(this.workspaceRoot, targetPath);
        if (!node) return;

        const parentNode     = node as ProjectNode | ModuleNode;
        const isRoot         = parentNode instanceof ProjectNode;
        const namePrefix     = isRoot ? '' : (parentNode as ModuleNode).getPrefix() + '.';
        const childFullName  = namePrefix + name;
        const projectAbs     = this.projectRoot.absolutePath;

        const realParentPath = isDraftPath(projectAbs, targetPath)
            ? toRealPath(projectAbs, targetPath)
            : targetPath;
        const childDraftPath = toDraftPath(projectAbs, path.join(realParentPath, name));

        const spec: DivisionModuleSpec = {
            name:         childFullName,
            description,
            dependencies,
            path:         path.join(this.projectRoot.label, childFullName.replace(/\./g, path.sep))
        };

        fs.mkdirSync(childDraftPath, { recursive: true });
        fs.writeFileSync(
            path.join(childDraftPath, 'content.txt'),
            JSON.stringify(spec, null, 2),
            'utf8'
        );

        const modulesRealPath  = path.join(projectAbs, 'modules.json');
        const ongoingRealPath  = path.join(projectAbs, 'ongoing_leaf_modules.json');
        const modulesDraftPath = toDraftPath(projectAbs, modulesRealPath);
        const ongoingDraftPath = toDraftPath(projectAbs, ongoingRealPath);

        let allModules: any[] = readJsonDraftFirst(projectAbs, modulesRealPath);
        let ongoing: any[]    = readJsonDraftFirst(projectAbs, ongoingRealPath);

        if (!isRoot && (parentNode as ModuleNode).isLeaf()) {
            const parentFullName = (parentNode as ModuleNode).getPrefix();
            // Remove parent from ongoing (current leaves) only; allModules is cumulative.
            ongoing = ongoing.filter((m: any) => m.name !== parentFullName);
        }

        allModules.push(spec);
        ongoing.push(spec);

        writeJsonAtomically(modulesDraftPath, allModules);
        writeJsonAtomically(ongoingDraftPath, ongoing);

        const childNode = new ModuleNode(name, childDraftPath, parentNode);
        (parentNode.children as any[]).push(childNode);

        this.rebuildDesignTreeState();
        this.postUpdate();
    }

    /** Select a module from the operation panel. */
    selectModule(nodeIndex: number): void {
        this.currentModule = nodeIndex;
        this.currentRefinementEntry = -1;

        if (this.leafModuleIndices.has(nodeIndex)) {
            const history = this.refinementHistories[nodeIndex];
            if (history && history.length > 0) {
                this.currentRefinementEntry = this.getActiveRefinementIndex(history);
                this.openInEditor(history[this.currentRefinementEntry].filePath).catch(() => {});
            }
        } else {
            const absPath = this.indexToPath.get(nodeIndex);
            if (absPath) {
                const contentFile = path.join(absPath, 'content.txt');
                if (fs.existsSync(contentFile)) {
                    this.openInEditor(contentFile).catch(() => {});
                }
            }
        }

        this.postUpdate();
    }

    /** Select a node in the design tree: open its content file in the editor. */
    selectDesignTreeModule(nodeIndex: number): void {
        const absPath = this.dtIndexToPath.get(nodeIndex);
        if (absPath) {
            const contentFile = path.join(absPath, 'content.txt');
            if (fs.existsSync(contentFile)) {
                this.openInEditor(contentFile).catch(() => {});
            }
        }

        this.postUpdate();
    }

    selectRefinement(moduleNodeIndex: number, entryIndex: number): void {
        this.currentModule = moduleNodeIndex;

        const history = this.refinementHistories[moduleNodeIndex];
        if (history?.[entryIndex]) {
            this.currentRefinementEntry = entryIndex;
            this.markOnlyActive(history, entryIndex);
            this.openInEditor(history[entryIndex].filePath).catch(() => {});
        } else {
            this.currentRefinementEntry = -1;
        }

        this.postUpdate();
    }

    // ── private helpers ───────────────────────────────────────────────────

    /** Return the full dotted names of all workspace-tree leaf modules, optionally excluding one node. */
    private _getWorkspaceLeafNames(exclude?: ModuleNode): string[] {
        if (!this.workspaceRoot) return [];
        const names: string[] = [];
        const collect = (node: ProjectNode | ModuleNode) => {
            const kids = (node instanceof ProjectNode
                ? node.children.filter(c => c instanceof ModuleNode)
                : node.children) as ModuleNode[];
            if (kids.length === 0 && node instanceof ModuleNode && node !== exclude) {
                names.push(node.getPrefix());
            }
            for (const child of kids) collect(child);
        };
        collect(this.workspaceRoot);
        return names;
    }

    /** Collect all leaf module full names under a subtree root. */
    private _collectLeafNames(node: ModuleNode): string[] {
        if (node.isLeaf()) return [node.getPrefix()];
        const names: string[] = [];
        for (const child of node.children) names.push(...this._collectLeafNames(child));
        return names;
    }

    /** Remove a set of leaf module names from the draft manifest files, cleaning up dep references too.
     *  Also writes updated content.txt drafts for any surviving module whose deps were affected. */
    private _removeLeafNamesFromDraftManifests(leafNames: string[]): void {
        if (!this.projectRoot || leafNames.length === 0) return;
        const nameSet          = new Set(leafNames);
        const projectAbs       = this.projectRoot.absolutePath;
        const pseudoPath       = settings.getPseudoPath();
        const modulesRealPath  = path.join(projectAbs, 'modules.json');
        const ongoingRealPath  = path.join(projectAbs, 'ongoing_leaf_modules.json');
        const modulesDraftPath = toDraftPath(projectAbs, modulesRealPath);
        const ongoingDraftPath = toDraftPath(projectAbs, ongoingRealPath);

        const depUpdated: any[] = [];

        const clean = (arr: any[], track?: any[]) => {
            const filtered = arr.filter((m: any) => !nameSet.has(m.name));
            filtered.forEach((m: any) => {
                if (Array.isArray(m.dependencies)) {
                    const before = m.dependencies.length;
                    m.dependencies = m.dependencies.filter((d: string) => !nameSet.has(d));
                    if (track && m.dependencies.length !== before) track.push(m);
                }
            });
            return filtered;
        };

        writeJsonAtomically(modulesDraftPath, clean(readJsonDraftFirst(projectAbs, modulesRealPath)));
        writeJsonAtomically(ongoingDraftPath, clean(readJsonDraftFirst(projectAbs, ongoingRealPath), depUpdated));

        // Persist dep-cleaned content.txt files to draft so _validateLeafTopology reads them.
        for (const mod of depUpdated) {
            if (!mod.path) continue;
            const modRealDir       = path.join(pseudoPath, String(mod.path).replace(/[\/\\]/g, path.sep));
            const contentRealPath  = path.join(modRealDir, 'content.txt');
            const contentDraftPath = toDraftPath(projectAbs, contentRealPath);
            try {
                const src = fs.existsSync(contentDraftPath) ? contentDraftPath : contentRealPath;
                const existing = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, 'utf8')) : {};
                fs.mkdirSync(path.dirname(contentDraftPath), { recursive: true });
                fs.writeFileSync(
                    contentDraftPath,
                    JSON.stringify({ ...existing, dependencies: mod.dependencies }, null, 2),
                    'utf8'
                );
            } catch (err) {
                console.warn('[WorkspaceManager] 清理依赖 content.txt 失败:', err);
            }
        }
    }

    /** Ensure a leaf module has a spec entry in draft manifests (upsert by name). */
    private _ensureLeafSpecInDraftManifests(moduleNode: ModuleNode): void {
        if (!this.projectRoot) return;

        const projectAbs       = this.projectRoot.absolutePath;
        const modulesRealPath  = path.join(projectAbs, 'modules.json');
        const ongoingRealPath  = path.join(projectAbs, 'ongoing_leaf_modules.json');
        const modulesDraftPath = toDraftPath(projectAbs, modulesRealPath);
        const ongoingDraftPath = toDraftPath(projectAbs, ongoingRealPath);

        const spec = this._buildModuleSpec(moduleNode);
        const upsertByName = (arr: any[]) => {
            const idx = arr.findIndex((m: any) => m?.name === spec.name);
            if (idx >= 0) arr[idx] = { ...arr[idx], ...spec };
            else arr.push(spec);
            return arr;
        };

        writeJsonAtomically(modulesDraftPath, upsertByName(readJsonDraftFirst(projectAbs, modulesRealPath)));
        writeJsonAtomically(ongoingDraftPath, upsertByName(readJsonDraftFirst(projectAbs, ongoingRealPath)));
    }

    /** Build a manifest spec object from a module node's current content file. */
    private _buildModuleSpec(moduleNode: ModuleNode): DivisionModuleSpec {
        const fullName = moduleNode.getPrefix();
        const contentPath = path.join(moduleNode.absolutePath, 'content.txt');

        let description = '';
        let dependencies: string[] = [];
        if (fs.existsSync(contentPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
                description = typeof parsed?.description === 'string' ? parsed.description : '';
                dependencies = Array.isArray(parsed?.dependencies)
                    ? parsed.dependencies.filter((d: unknown): d is string => typeof d === 'string')
                    : [];
            } catch {
                description = '';
                dependencies = [];
            }
        }

        return {
            name: fullName,
            description,
            dependencies,
            path: path.join(this.projectRoot!.label, fullName.replace(/\./g, path.sep))
        };
    }

    /**
     * Validate that workspace leaf nodes form a valid DAG with no missing deps.
     * Returns { valid: true } or { valid: false, error: string }.
     */
    private _validateLeafTopology(): { valid: boolean; error?: string } {
        if (!this.workspaceRoot) return { valid: true };

        const leafNodes: { name: string; deps: string[] }[] = [];
        const leafNameSet = new Set<string>();

        const collect = (node: ProjectNode | ModuleNode) => {
            const kids = (node instanceof ProjectNode
                ? node.children.filter(c => c instanceof ModuleNode)
                : node.children) as ModuleNode[];
            if (kids.length === 0 && node instanceof ModuleNode) {
                const name = node.getPrefix();
                leafNameSet.add(name);
                let deps: string[] = [];
                try {
                    const projectAbs  = this.projectRoot!.absolutePath;
                    // Resolve to the real path so toDraftPath produces a correct draft path,
                    // then prefer draft if it exists (dep-propagation writes updates there).
                    const nodeRealDir = isDraftPath(projectAbs, node.absolutePath)
                        ? toRealPath(projectAbs, node.absolutePath)
                        : node.absolutePath;
                    const realContent  = path.join(nodeRealDir, 'content.txt');
                    const json: any = readJsonDraftFirst(projectAbs, realContent);
                    deps = Array.isArray(json?.dependencies) ? json.dependencies : [];
                } catch { deps = []; }
                leafNodes.push({ name, deps });
            }
            for (const child of kids) collect(child);
        };
        collect(this.workspaceRoot);

        if (leafNodes.length === 0) return { valid: true };

        // Check for missing references.
        for (const { name, deps } of leafNodes) {
            for (const dep of deps) {
                if (!leafNameSet.has(dep)) {
                    return { valid: false, error: `模块 "${name}" 的依赖 "${dep}" 不存在于当前叶子节点中，无法保存。` };
                }
            }
        }

        // Kahn's algorithm — check for cycles.
        const inDegree = new Map<string, number>();
        const adj      = new Map<string, string[]>();
        for (const { name } of leafNodes) { inDegree.set(name, 0); adj.set(name, []); }
        for (const { name, deps } of leafNodes) {
            for (const dep of deps) {
                adj.get(dep)!.push(name);
                inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
            }
        }
        const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
        let count = 0;
        while (queue.length > 0) {
            const n = queue.shift()!;
            count++;
            for (const dep of (adj.get(n) ?? [])) {
                const d = (inDegree.get(dep) ?? 0) - 1;
                inDegree.set(dep, d);
                if (d === 0) queue.push(dep);
            }
        }
        if (count !== leafNodes.length) {
            return { valid: false, error: '当前工作区叶子节点不存在拓扑排序，无法保存。' };
        }

        return { valid: true };
    }

    private getActiveRefinementIndex(history: RefinementEntry[]): number {
        const activeIdx = history.findIndex(entry => entry.active === true);
        if (activeIdx >= 0) return activeIdx;
        return history.length - 1;
    }

    private markOnlyActive(history: RefinementEntry[], activeIndex: number): void {
        history.forEach((entry, index) => {
            entry.active = index === activeIndex;
        });
    }

    private async rollbackSingleModuleToIndex(moduleIndex: number, targetIndex: number): Promise<boolean> {
        const history = this.refinementHistories[moduleIndex];
        if (!history || history.length === 0) return false;

        const safeTarget = Math.max(0, Math.min(targetIndex, history.length - 1));
        const removedEntries = history.slice(safeTarget + 1);
        const removedHasCode = removedEntries.some(entry => entry.type === 'code');

        if (removedEntries.length > 0) {
            const modulePath = this.indexToPath.get(moduleIndex);
            if (modulePath) {
                const backupDir = path.join(modulePath, '.rollback_backup', `${Date.now()}_${safeTarget}`);
                fs.mkdirSync(backupDir, { recursive: true });

                removedEntries.forEach((entry, idx) => {
                    this.backupAndDeleteEntryArtifacts(entry, backupDir, idx + 1);
                });
            }
        }

        const nextHistory = history.slice(0, safeTarget + 1);
        this.markOnlyActive(nextHistory, safeTarget);
        this.refinementHistories[moduleIndex] = nextHistory;

        const modulePath = this.indexToPath.get(moduleIndex);
        if (modulePath) {
            saveRefinementHistory(modulePath, nextHistory);
        }
        return removedHasCode;
    }

    private backupAndDeleteEntryArtifacts(entry: RefinementEntry, backupDir: string, order: number): void {
        const artifacts = [
            entry.filePath,
            getHumanJsonPath(entry.filePath),
            `${entry.filePath}.highlight.json`
        ];

        for (const filePath of artifacts) {
            if (!filePath || !fs.existsSync(filePath)) continue;
            try {
                const parsed = path.parse(filePath);
                const backupName = `${String(order).padStart(2, '0')}_${parsed.base}`;
                fs.copyFileSync(filePath, path.join(backupDir, backupName));
            } catch (err) {
                console.warn('[WorkspaceManager] 备份回退文件失败:', err);
                continue;
            }

            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                console.warn('[WorkspaceManager] 删除回退文件失败:', err);
            }
        }
    }

    private syncModuleStatusesToOngoing(currentModuleIndex: number, activeType: 'pseudo' | 'code'): void {
        if (!this.projectRoot) return;

        const statusMap: Record<number, ModuleProgressStatus> = {};
        this.leafOrder.forEach(idx => {
            const history = this.refinementHistories[idx] || [];
            const hasCode = history.some(entry => entry.type === 'code');
            statusMap[idx] = hasCode ? 'completed' : 'pending';
        });

        if (activeType === 'pseudo') {
            statusMap[currentModuleIndex] = 'inProgress';
        } else {
            const pos = this.leafOrder.indexOf(currentModuleIndex);
            const nextIndex = pos >= 0 ? this.leafOrder[pos + 1] : undefined;
            if (nextIndex !== undefined) {
                statusMap[nextIndex] = 'inProgress';
            }
        }
        this.moduleStatuses = statusMap;

        try {
            const projectAbs = this.projectRoot.absolutePath;
            // Always use real path for ongoing_leaf_modules.json — operation-panel state
            // is based on the actual project directory, not the draft overlay.
            const ongoingPath = this.resolveOngoingPath(projectAbs);
            if (!fs.existsSync(ongoingPath)) return;

            const ongoing = JSON.parse(fs.readFileSync(ongoingPath, 'utf8')) as any[];
            const pseudoRoot = settings.getPseudoPath();

            const pathToLeafIndex = new Map<string, number>();
            this.leafOrder.forEach(idx => {
                const abs = this.indexToPath.get(idx);
                if (!abs) return;
                const rel = path.relative(pseudoRoot, abs).split(path.sep).join('/');
                pathToLeafIndex.set(rel, idx);
            });

            const toFileStatus = (status: ModuleProgressStatus): string => {
                if (status === 'completed') return '已完成';
                if (status === 'inProgress') return '进行中';
                return '待处理';
            };

            ongoing.forEach(item => {
                const key = String(item?.path ?? '').split(path.sep).join('/');
                const leafIdx = pathToLeafIndex.get(key);
                if (leafIdx === undefined) return;
                item.status = toFileStatus(statusMap[leafIdx] ?? 'pending');
            });

            // Write directly to the real file (not to .tmp).
            writeJsonAtomically(ongoingPath, ongoing);
        } catch (err) {
            console.warn('[WorkspaceManager] 同步模块状态失败:', err);
            vscode.window.showWarningMessage('模块状态文件更新失败，已完成内存状态回退。');
        }
    }

    private async removeLaunchConfigSafe(projectName: string): Promise<void> {
        try {
            const { removeRootLaunchConfig } = await import('../tools/launch-config-updater.js');
            await removeRootLaunchConfig(settings.getProjectPath(), projectName, 'python');
        } catch (err) {
            console.warn('[WorkspaceManager] 清理调试配置失败:', err);
        }
    }

    /**
     * Resolve ongoing_leaf_modules.json — always uses the real project path
     * for operation-panel state.  The draft overlay is only relevant for the
     * design-tree view.
     */
    private resolveOngoingPath(projectAbs: string): string {
        return path.join(projectAbs, 'ongoing_leaf_modules.json');
    }

    private async performDivision(
        node: ProjectNode | ModuleNode,
        customPrompt = ''
    ): Promise<boolean> {
        const projectPath = this.projectRoot!.absolutePath;
        const pseudoPath = settings.getPseudoPath();

        const modulesRealPath = path.join(projectPath, 'modules.json');
        const ongoingRealPath = path.join(projectPath, 'ongoing_leaf_modules.json');
        const modulesDraftPath = toDraftPath(projectPath, modulesRealPath);
        const ongoingDraftPath = toDraftPath(projectPath, ongoingRealPath);

        let allModules = readJsonDraftFirst(projectPath, modulesRealPath);
        let ongoing = readJsonDraftFirst(projectPath, ongoingRealPath);

        const realNodePath = isDraftPath(projectPath, node.absolutePath)
            ? toRealPath(projectPath, node.absolutePath)
            : node.absolutePath;

        const isFirstLevel: boolean = node instanceof ProjectNode;
        let prompt: { system: string; user: string };
        let expectedPrefix: string = '';

        if (isFirstLevel) {
            allModules = [];
            ongoing = [];
            writeJsonAtomically(modulesDraftPath, []);
            writeJsonAtomically(ongoingDraftPath, []);
            node.children = node.children.filter(c => c instanceof RequirementNode);

            prompt = await openaiHelper.getModuleDivisionPrompt1(
                node.getContentFilePath(), this.context
            );
        } else {
            const currentModuleName: string = node.getPrefix();
            expectedPrefix = currentModuleName + '.';

            const ongoingForPrompt = fs.existsSync(ongoingDraftPath)
                ? ongoingDraftPath
                : ongoingRealPath;
            prompt = await openaiHelper.getModuleDivisionPrompt2(
                ongoingForPrompt,
                path.join(projectPath, 'content.txt'),
                currentModuleName,
                this.context
            );
        }

        const plans = await this.generateDivisionPlans(prompt, customPrompt, expectedPrefix, 3);
        const picked = await DivisionPlanViewProvider.pickPlan(node.label, plans);
        if (picked === undefined) {
            return false;
        }
        const result = plans[picked];

        if (!isFirstLevel) {
            const relPath = path.relative(pseudoPath, realNodePath);
            const parentName = path.relative(projectPath, realNodePath)
                .split(path.sep).join('.');

            ongoing = ongoing.filter((m: any) =>
                (m.path ?? '').replace(/[\/\\]/g, path.sep) !== relPath
            );

            const newNames = result.map((m: DivisionModuleSpec) => m.name);

            // Track which ongoing modules had their deps updated so we can
            // persist the change to their content.txt in the draft overlay.
            const updatedOngoing = new Set<any>();
            const propagateDeps = (list: any[], track?: Set<any>) => list.forEach((m: any) => {
                if (m.dependencies?.includes(parentName)) {
                    m.dependencies = m.dependencies.filter((d: string) => d !== parentName);
                    newNames.forEach((n: string) => {
                        if (!m.dependencies.includes(n)) m.dependencies.push(n);
                    });
                    track?.add(m);
                }
            });
            propagateDeps(ongoing, updatedOngoing);
            propagateDeps(allModules);

            // Write updated content.txt files to the draft for affected modules.
            for (const mod of updatedOngoing) {
                if (!mod.path) continue;
                const modRealDir = path.join(
                    pseudoPath, String(mod.path).replace(/[\/\\]/g, path.sep)
                );
                const contentRealPath  = path.join(modRealDir, 'content.txt');
                const contentDraftPath = toDraftPath(projectPath, contentRealPath);
                try {
                    const src = fs.existsSync(contentDraftPath) ? contentDraftPath : contentRealPath;
                    const existing = fs.existsSync(src)
                        ? JSON.parse(fs.readFileSync(src, 'utf8'))
                        : {};
                    fs.mkdirSync(path.dirname(contentDraftPath), { recursive: true });
                    fs.writeFileSync(
                        contentDraftPath,
                        JSON.stringify({ ...existing, dependencies: mod.dependencies }, null, 2),
                        'utf8'
                    );
                } catch (err) {
                    console.warn('[WorkspaceManager] 更新依赖模块 content.txt 失败:', err);
                }
            }
        }

        for (const mod of result) {
            mod.path = path.join(this.projectRoot!.label, mod.name.replace(/\./g, path.sep));
            allModules.push(mod);
            ongoing.push(mod);

            const childName: string = mod.name.split('.').pop()!;
            const childRealPath = path.join(realNodePath, childName);
            const childDraftPath = toDraftPath(projectPath, childRealPath);

            fs.mkdirSync(childDraftPath, { recursive: true });
            fs.writeFileSync(
                path.join(childDraftPath, 'content.txt'),
                JSON.stringify(mod, null, 2),
                'utf8'
            );

            const childNode = new ModuleNode(childName, childDraftPath, node);
            (node.children as any[]).push(childNode);
        }

        writeJsonAtomically(modulesDraftPath, allModules);
        writeJsonAtomically(ongoingDraftPath, ongoing);
        return true;
    }

    private async generateDivisionPlans(
        prompt: { system: string; user: string },
        customPrompt: string,
        expectedPrefix: string,
        count: number
    ): Promise<DivisionModuleSpec[][]> {
        const plans: DivisionModuleSpec[][] = [];
        const seen = new Set<string>();
        const maxRounds = Math.max(8, count * 3);

        for (let round = 0; round < maxRounds && plans.length < count; round++) {
            let userPrompt = appendCustomPrompt(prompt.user, customPrompt);
            userPrompt += `\n\n请给出一个与之前不同的模块划分方案，强调方案差异。`;
            userPrompt += `\n\n模块数量必须按需求复杂度自然决定，禁止固定输出某个数量（例如固定 5 个）。`;
            if (plans.length > 0) {
                const existingNames = plans
                    .map((p, idx) => `方案${idx + 1}: ${p.map(m => m.name).join(', ')}`)
                    .join('\n');
                userPrompt += `\n\n已有方案如下，请避免重复：\n${existingNames}`;
            }

            const candidate = await this.generateSingleDivisionPlan(prompt.system, userPrompt, expectedPrefix);
            const key = JSON.stringify(candidate.map(m => ({
                name: m.name,
                description: m.description,
                dependencies: [...(m.dependencies ?? [])].sort()
            })));

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            plans.push(candidate);
        }

        if (plans.length === 0) {
            throw new Error('LLM 未能生成可用的模块划分方案。');
        }

        return plans;
    }

    private async generateSingleDivisionPlan(
        systemPrompt: string,
        initialUserPrompt: string,
        expectedPrefix: string
    ): Promise<DivisionModuleSpec[]> {
        let userPrompt = initialUserPrompt;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const raw = await openaiHelper.callOpenAIForJSON(
                    systemPrompt,
                    userPrompt,
                    ModulesArraySchema,
                    3
                );

                const parsed = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim()) as DivisionModuleSpec[];
                const check = validateModulePrefix(parsed, expectedPrefix);
                if (check.valid) {
                    return parsed;
                }

                userPrompt += `\n\n注意：以下模块名称不符合要求，必须以 "${expectedPrefix}" 开头: ${check.invalidModules.join(', ')}。请修正。`;
            } catch (e) {
                console.error(`Division plan attempt ${attempt + 1} failed:`, e);
            }
        }

        throw new Error('LLM 未能生成符合命名规范的方案。');
    }

    /**
     * Rebuild the operation-panel derived state from projectRoot (actual project directory).
     * Also calls rebuildDesignTreeState() to refresh the design-tree view.
     */
    private rebuildDerivedState(): void {
        const prevSelectedPath = this.indexToPath.get(this.currentModule);

        if (!this.projectRoot) {
            this.nodes = [];
            this.leafOrder = [];
            this.leafModuleIndices = new Set();
            this.indexToPath = new Map();
            this.moduleStatuses = {};
            this.rebuildDesignTreeState();
            return;
        }

        const nodes: TreeNodeData[] = [];
        const indexToPath = new Map<number, string>();
        const pathToIndex = new Map<string, number>();
        const leafNameToIndex = new Map<string, number>();
        const leafModuleIndices = new Set<number>();

        const serialize = (node: DesignmentTreeNode) => {
            if (node instanceof RequirementNode) return;

            const idx = nodes.length;
            indexToPath.set(idx, node.absolutePath);
            pathToIndex.set(node.absolutePath, idx);

            let nodeType: NodeType;
            let moduleChildren: DesignmentTreeNode[];

            if (node instanceof ProjectNode) {
                moduleChildren = node.children.filter(c => c instanceof ModuleNode);
                nodeType = 'root';
            } else {
                moduleChildren = (node as ModuleNode).children;
                nodeType = moduleChildren.length === 0 ? 'leaf' : 'non-leaf';
                if (nodeType === 'leaf') {
                    leafModuleIndices.add(idx);
                    leafNameToIndex.set((node as ModuleNode).getPrefix(), idx);
                }
            }

            let desc = '';
            try { desc = readModuleDesc(node.absolutePath); } catch { desc = ''; }
            nodes.push({
                nodeType,
                title: node.label,
                desc,
                childCount: moduleChildren.length
            });

            for (const child of moduleChildren) serialize(child);
        };

        // Build OP state from the REAL project tree (projectRoot), not the workspace.
        serialize(this.projectRoot);

        this.nodes = nodes;
        this.indexToPath = indexToPath;
        this.leafModuleIndices = leafModuleIndices;

        // Compute OP topology from current leaf content specs (authoritative),
        // instead of trusting potentially stale manifest order.
        try {
            const leafSpecs = this._collectLeafSpecsFromProjectTree(this.projectRoot);
            const sorted = topoSortLeafModules(leafSpecs);
            this.leafOrder = sorted
                .map((m: any) => leafNameToIndex.get(m.name) ?? -1)
                .filter(i => i >= 0);
        } catch (err) {
            console.warn('[WorkspaceManager] 叶子拓扑排序失败，回退为树前序：', err);
            this.leafOrder = [...leafModuleIndices];
        }

        const next: Record<number, RefinementEntry[]> = {};
        for (const ni of this.leafOrder) {
            const absPath = indexToPath.get(ni);
            if (!absPath) continue;

            if (this.refinementHistories[ni]) {
                next[ni] = this.refinementHistories[ni];
            } else {
                const stored = loadRefinementHistory(absPath);
                if (stored && stored.length > 0) {
                    next[ni] = stored;
                } else {
                    const specPath = path.join(absPath, 'content.txt');
                    next[ni] = fs.existsSync(specPath)
                        ? [{ label: '模块规约', filePath: specPath, type: 'spec' }]
                        : [];
                }
            }

            if (next[ni]?.length) {
                next[ni] = next[ni].map(entry => ({ ...entry }));
                const activeIdx = this.getActiveRefinementIndex(next[ni]);
                this.markOnlyActive(next[ni], activeIdx);
            }
        }
        this.refinementHistories = next;

        const statuses: Record<number, ModuleProgressStatus> = {};
        let ongoingModuleFound: boolean = false;
        this.leafOrder.forEach(idx => {
            const history = this.refinementHistories[idx] || [];
            const hasCode = history.some(entry => entry.type === 'code');
            // statuses[idx] = hasCode ? 'completed' : 'pending';
            if (hasCode) statuses[idx] = 'completed';
            else {
                statuses[idx] = ongoingModuleFound ? 'pending' : 'inProgress';
                ongoingModuleFound = true;
            }
        });

        // if (this.currentModule >= 0 && this.leafOrder.includes(this.currentModule)) {
        //     const history = this.refinementHistories[this.currentModule] || [];
        //     const activeIdx = this.getActiveRefinementIndex(history);
        //     this.currentRefinementEntry = activeIdx;
        //     const activeType = history[activeIdx]?.type;
        //     if (activeType === 'code') {
        //         const pos = this.leafOrder.indexOf(this.currentModule);
        //         const nextModule = this.leafOrder[pos + 1];
        //         if (nextModule !== undefined) statuses[nextModule] = 'inProgress';
        //     } else if (history.length > 0) {
        //         statuses[this.currentModule] = 'inProgress';
        //     }
        // }

        this.moduleStatuses = statuses;

        if (prevSelectedPath) {
            const remapped = [...this.indexToPath.entries()]
                .find(([, p]) => normPath(p) === normPath(prevSelectedPath));
            this.currentModule = remapped ? remapped[0] : -1;
        } else {
            this.currentModule = -1;
        }

        this.rebuildDesignTreeState();
    }

    /** Collect leaf module specs from current real project tree/content files. */
    private _collectLeafSpecsFromProjectTree(root: ProjectNode): DivisionModuleSpec[] {
        const specs: DivisionModuleSpec[] = [];

        const walk = (node: ProjectNode | ModuleNode) => {
            const kids = (node instanceof ProjectNode
                ? node.children.filter(c => c instanceof ModuleNode)
                : node.children) as ModuleNode[];

            if (node instanceof ModuleNode && kids.length === 0) {
                specs.push(this._buildModuleSpec(node));
                return;
            }
            for (const child of kids) walk(child);
        };

        walk(root);
        return specs;
    }

    /** Rewrite real ongoing_leaf_modules.json from current project tree/content. */
    private _rewriteRealOngoingFromProjectTree(): void {
        if (!this.projectRoot) return;
        const projectAbs = this.projectRoot.absolutePath;
        const ongoingPath = this.resolveOngoingPath(projectAbs);

        try {
            const leafSpecs = this._collectLeafSpecsFromProjectTree(this.projectRoot);
            const sorted = topoSortLeafModules(leafSpecs);
            writeJsonAtomically(ongoingPath, sorted);
        } catch (err) {
            console.warn('[WorkspaceManager] 重建 ongoing_leaf_modules.json 失败:', err);
        }
    }

    /**
     * Rebuild the design-tree derived state from workspaceRoot (draft overlay).
     * This is the only state sent to the design-tree panel.
     */
    private rebuildDesignTreeState(): void {
        if (!this.workspaceRoot) {
            this.dtNodes = [];
            this.dtIndexToPath = new Map();
            return;
        }

        const nodes: TreeNodeData[] = [];
        const indexToPath = new Map<number, string>();

        const serialize = (node: DesignmentTreeNode) => {
            if (node instanceof RequirementNode) return;

            const idx = nodes.length;
            indexToPath.set(idx, node.absolutePath);

            let nodeType: NodeType;
            let moduleChildren: DesignmentTreeNode[];

            if (node instanceof ProjectNode) {
                moduleChildren = node.children.filter(c => c instanceof ModuleNode);
                nodeType = 'root';
            } else {
                moduleChildren = (node as ModuleNode).children;
                nodeType = moduleChildren.length === 0 ? 'leaf' : 'non-leaf';
            }

            let desc = '';
            try { desc = readModuleDesc(node.absolutePath); } catch { desc = ''; }

            nodes.push({
                nodeType,
                title: node.label,
                desc,
                childCount: moduleChildren.length
            });

            for (const child of moduleChildren) serialize(child);
        };

        serialize(this.workspaceRoot);

        this.dtNodes = nodes;
        this.dtIndexToPath = indexToPath;
    }

    private canOperate(nodeIndex: number): boolean {
        const pos = this.leafOrder.indexOf(nodeIndex);
        if (pos <= 0) return true;
        for (let i = 0; i < pos; i++) {
            const prev = this.leafOrder[i];
            const h = this.refinementHistories[prev];
            if (!h?.some(e => e.type === 'code')) return false;
        }
        return true;
    }

    private findNode(
        root: ProjectNode | ModuleNode,
        targetPath: string
    ): ProjectNode | ModuleNode | null {
        if (root.absolutePath === targetPath) return root;
        for (const child of (root.children ?? [])) {
            if (child instanceof ModuleNode) {
                const found = this.findNode(child, targetPath);
                if (found) return found;
            }
        }
        return null;
    }

    private remapTreeToReal(node: ProjectNode | ModuleNode, projectAbs: string): void {
        for (const child of (node.children ?? [])) {
            if (child instanceof ModuleNode) {
                if (isDraftPath(projectAbs, child.absolutePath)) {
                    child.absolutePath = toRealPath(projectAbs, child.absolutePath);
                }
                this.remapTreeToReal(child, projectAbs);
            }
        }
    }

    private fixParentRefs(node: ProjectNode | ModuleNode): void {
        for (const child of (node.children ?? [])) {
            (child as any).parent = node;
            if (child instanceof ModuleNode) this.fixParentRefs(child);
        }
    }

    /** True if data_structures.py exists in the real codes directory. */
    private _hasActualDS(): boolean {
        if (!this.projectRoot) return false;
        try {
            const realCodeDir = path.join(settings.getCodesPath(), path.basename(this.projectRoot.absolutePath));
            return fs.existsSync(actualDSRealPath(realCodeDir, 'python'));
        } catch { return false; }
    }

    private async openInEditor(filePath: string): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });
        } catch (err) {
            console.error('Cannot open file:', err);
        }
    }

    /** Build the operation-panel payload (based on projectRoot / actual project). */
    private buildPayload(): UpdateViewPayload {
        return {
            nodes: this.nodes,
            leafOrder: this.leafOrder,
            currentModule: this.currentModule,
            refinementHistories: this.refinementHistories,
            currentRefinementEntry: this.currentRefinementEntry,
            moduleStatuses: this.moduleStatuses,
            isBusy: this.isBusy,
            hasCommonDS: this.projectRoot
                ? this._commonDS.exists(this.projectRoot.absolutePath)
                : false,
            hasActualDS: this._hasActualDS()
        };
    }

    /** Build the design-tree payload (based on workspaceRoot / draft overlay). */
    private buildDesignTreePayload(): UpdateViewPayload {
        return {
            nodes: this.dtNodes,
            leafOrder: [],
            currentModule: -1,
            refinementHistories: {},
            currentRefinementEntry: -1,
            moduleStatuses: {},
            isBusy: this.isBusy,
            hasCommonDS: false,
            hasActualDS: false
        };
    }

    private postUpdate(): void {
        OperationPanelViewProvider.postMessage({ type: 'updateView', data: this.buildPayload() });
        DesignTreeViewProvider.postMessage({ type: 'updateView', data: this.buildDesignTreePayload() });
    }
}

// ── local refine diff helper ─────────────────────────────────────────────────

function diffLineStatus(
    oldContent: string,
    newContent: string,
    oldStatus: LineData[]
): { newStatus: LineData[]; highlightRanges: { start: number; end: number }[] } {
    const changes = Diff.diffLines(oldContent, newContent);
    const highlightRanges: { start: number; end: number }[] = [];
    const newStatus: LineData[] = [];
    let currentOffset = 0;
    let oldLineIndex = 0;

    for (const part of changes) {
        const lineCount = part.count || 0;
        const textLength = part.value.length;

        if (part.added) {
            highlightRanges.push({ start: currentOffset, end: currentOffset + textLength });
            for (let i = 0; i < lineCount; i++) newStatus.push({ type: 0, content: '' });
            currentOffset += textLength;
        } else if (part.removed) {
            oldLineIndex += lineCount;
        } else {
            for (let i = 0; i < lineCount; i++) {
                newStatus.push({
                    type: oldLineIndex < oldStatus.length ? oldStatus[oldLineIndex].type : 0,
                    content: ''
                });
                oldLineIndex++;
            }
            currentOffset += textLength;
        }
    }

    return { newStatus, highlightRanges };
}

interface DivisionModuleSpec {
    name: string;
    description: string;
    dependencies: string[];
    path?: string;
}
