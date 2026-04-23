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
    toDraftForWrite,
    cleanDraft,
    promoteDraft,
    readJsonDraftFirst,
} from './draft-overlay';
import { CommonDSManager } from './common-ds-manager';
import { generateActualDS, actualDSStagingPath, actualDSRealPath } from './actual-ds-generator';
import * as Diff from 'diff';

// ── helpers ─────────────────────────────────────────────────────────────────

/** Recursively copy src into dst, creating directories as needed.
 *  Uses copyFileSync + mkdirSync so it works on all Node.js versions. */
function copyDirSync(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

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

    // view state
    private nodes: TreeNodeData[] = [];
    private leafOrder: number[] = [];
    private leafModuleIndices: Set<number> = new Set();
    private currentModule = -1;
    private currentRefinementEntry = -1;
    private refinementHistories: Record<number, RefinementEntry[]> = {};
    private moduleStatuses: Record<number, ModuleProgressStatus> = {};
    private isBusy = false;
    private _suppressHistoryPaths: Set<string> = new Set();

    // index <-> path mapping (rebuilt from workspace tree each time)
    private indexToPath = new Map<number, string>();

    private _commonDS: CommonDSManager;

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

    async loadProject(projectNode: ProjectNode): Promise<void> {
        cleanDraft(projectNode.absolutePath);

        this.projectRoot = projectNode;
        this.workspaceRoot = cloneTree(projectNode);
        this.currentModule = -1;
        this.currentRefinementEntry = -1;
        this.refinementHistories = {};
        this.moduleStatuses = {};
        this.isBusy = false;
        this._commonDS.reset();

        this.rebuildDerivedState();
        this.postUpdate();
        DesignTreeViewProvider.createOrShow();
    }

    async divide(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.indexToPath.get(nodeIndex);
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

        const hasRefinementHistory = Object.values(this.refinementHistories).some(
            h => h.some(e => e.type === 'pseudo' || e.type === 'code')
        );

        if (hasRefinementHistory) {
            const answer = await vscode.window.showWarningMessage(
                '检测到当前工作区已有精化历史，拆分操作会导致精化历史被清除，是否继续？',
                { modal: true }, '继续'
            );
            if (answer !== '继续') return;

            const hasCodeHistory = Object.values(this.refinementHistories).some(
                h => h.some(e => e.type === 'code')
            );
            if (hasCodeHistory) {
                // Clean staging (code generated but not yet confirmed).
                const stagingDir = this.codesStagingDir(this.projectRoot.absolutePath);
                if (fs.existsSync(stagingDir)) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                }
                // Clean real codes dir (code was confirmed in a previous save).
                try {
                    const realCodeDir = path.join(
                        settings.getCodesPath(), path.basename(this.projectRoot.absolutePath)
                    );
                    if (fs.existsSync(realCodeDir)) {
                        fs.rmSync(realCodeDir, { recursive: true, force: true });
                    }
                } catch (err) {
                    console.warn('[WorkspaceManager] 清理代码目录失败:', err);
                }
            }

            this._suppressHistoryPaths = new Set(
                Object.keys(this.refinementHistories)
                    .map(ni => this.indexToPath.get(Number(ni)))
                    .filter((p): p is string => !!p)
            );
            this.refinementHistories = {};

            // Common DS is tied to the refinement phase; clear it for this session.
            this._commonDS.clearDraft(this.projectRoot.absolutePath);
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
        this.rebuildDerivedState();
        this.postUpdate();
    }

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
                    this.postUpdate(); // reveal the common DS node in the UI immediately
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

                const outputRealPath = path.join(modulePath, `pseudo_${Date.now()}.txt`);
                const outputPath = toDraftForWrite(projectAbs, outputRealPath);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, raw, 'utf8');

                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                history.push({ label: `粒度${pseudoCount + 1}`, filePath: outputPath, type: 'pseudo' });
                this.currentRefinementEntry = history.length - 1;
                this.markOnlyActive(history, this.currentRefinementEntry);

                await this.openInEditor(outputPath);
                progress.report({ message: '精化完成！' });
                await delay(1000);
            } catch (err) {
                vscode.window.showErrorMessage(`精化失败: ${err}`);
            }
        });

        this.isBusy = false;
        this.postUpdate();
    }

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

                const outputRealPath = path.join(modulePath, `pseudo_local_${Date.now()}.txt`);
                const outputPath = toDraftForWrite(projectAbs, outputRealPath);
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

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '',
            cancellable: false
        }, async progress => {
            try {
                const stagingRoot = this.codesStagingDir(projectPath);
                const topoIdx = this.leafOrder.indexOf(nodeIndex);

                // Phase 1: first-module setup — project scaffold + data structure files.
                // Must complete before building the code prompt so that data_structures.py
                // is already in staging when the prompt reads it.
                if (topoIdx === 0) {
                    const { initialProject } = await import('../tools/project-initializer.js');
                    await initialProject(stagingRoot, language);

                    // Generate common DS if not yet available (e.g. user skipped refine).
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
                        await generateActualDS(stagingRoot, commonDSContent, language, this.context);
                        this.postUpdate(); // reveal the actual-ds node in the design tree immediately
                    }
                }

                // Phase 2: generate module code.
                // For topoIdx === 0, data_structures.py was just written to stagingRoot.
                // For topoIdx > 0, it was promoted to realCodeDir by a prior confirm —
                // stagingRoot no longer has it, so fall back to realCodeDir.
                let dsRoot = stagingRoot;
                if (topoIdx > 0 && !fs.existsSync(actualDSStagingPath(stagingRoot, language))) {
                    try {
                        dsRoot = path.join(settings.getCodesPath(), projectName);
                    } catch (_) { /* settings not configured; DS will be absent from prompt */ }
                }

                progress.report({ message: '正在生成代码...' });
                const lastEntry = history[history.length - 1];
                const fileContent = fs.readFileSync(lastEntry.filePath, 'utf8');
                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                const prompt = await openaiHelper.getGenerateCodePrompt(
                    fileContent, `粒度${pseudoCount}`, language, modulePath, dsRoot
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);
                const code = cleanLLMResponse(raw);

                const { writeModule } = await import('../tools/module-writer.js');
                const realModulePath = isDraftPath(projectPath, modulePath)
                    ? toRealPath(projectPath, modulePath)
                    : modulePath;
                const moduleRelPath = path.relative(projectPath, realModulePath);
                const generatedFilePath = await writeModule(stagingRoot, moduleRelPath, code, language);

                if (topoIdx === this.leafOrder.length - 1) {
                    // Launch config points to the real path (post-confirm location).
                    const realCodeDir = path.join(settings.getCodesPath(), projectName);
                    const realFilePath = path.join(realCodeDir, path.relative(stagingRoot, generatedFilePath));
                    const { updateRootLaunchConfig } = await import('../tools/launch-config-updater.js');
                    await updateRootLaunchConfig(settings.getProjectPath(), projectName, realFilePath, language);
                    vscode.window.showInformationMessage(`已更新调试配置: "Run ${projectName}"`);
                }

                history.push({ label: '实际代码', filePath: generatedFilePath, type: 'code' });
                this.currentRefinementEntry = history.length - 1;
                this.markOnlyActive(history, this.currentRefinementEntry);

                await this.openInEditor(generatedFilePath);
                progress.report({ message: '代码生成成功！' });
                await delay(1000);
            } catch (err) {
                vscode.window.showErrorMessage(`代码生成失败: ${err}`);
            }
        });

        this.isBusy = false;
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
                const codeProjectDir = path.join(settings.getCodesPath(), projectName);
                if (fs.existsSync(codeProjectDir)) {
                    fs.rmSync(codeProjectDir, { recursive: true, force: true });
                }
                const stagingDir = this.codesStagingDir(projectAbs);
                if (fs.existsSync(stagingDir)) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                }
                this._commonDS.clearDraft(projectAbs);
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

    async confirm(): Promise<void> {
        if (!this.projectRoot || !this.workspaceRoot) return;

        const projectAbs = this.projectRoot.absolutePath;
        const stagingDir = this.codesStagingDir(projectAbs);
        let realCodeDir = '';

        try {
            realCodeDir = path.join(settings.getCodesPath(), path.basename(projectAbs));

            // Promote generated code staging to the real codes directory first,
            // so that promoteDraft() does not copy it into projectAbs.
            // Merge (not replace): staging files overwrite existing, but files
            // already in realCodeDir (e.g. data_structures.py from a prior
            // confirm) are preserved.
            if (fs.existsSync(stagingDir)) {
                copyDirSync(stagingDir, realCodeDir);
                fs.rmSync(stagingDir, { recursive: true, force: true });
            }
            promoteDraft(projectAbs);
            this._commonDS.cleanupOnConfirm(projectAbs);
        } catch (err) {
            vscode.window.showErrorMessage(`草稿合并失败: ${err}`);
            return;
        }

        this.remapTreeToReal(this.workspaceRoot, projectAbs);
        for (const history of Object.values(this.refinementHistories)) {
            for (const entry of history) {
                if (!isDraftPath(projectAbs, entry.filePath)) continue;
                if (entry.type === 'code') {
                    // Code entries were staged in .tmp/_code_output; remap to real codes dir.
                    entry.filePath = path.join(realCodeDir, path.relative(stagingDir, entry.filePath));
                } else {
                    entry.filePath = toRealPath(projectAbs, entry.filePath);
                }
            }
        }

        this.projectRoot.children = this.workspaceRoot.children.map(child => {
            if (child instanceof RequirementNode) {
                return new RequirementNode(this.projectRoot!);
            }
            return cloneModuleNode(child as ModuleNode, this.projectRoot!);
        }) as (ModuleNode | RequirementNode)[];
        this.fixParentRefs(this.projectRoot);

        this.rebuildDerivedState();

        for (const [idxStr, history] of Object.entries(this.refinementHistories)) {
            const absPath = this.indexToPath.get(Number(idxStr));
            if (absPath) saveRefinementHistory(absPath, history);
        }

        DesignmentTreeDataProvider.getInstance().refresh(undefined);
        this.postUpdate();
        vscode.window.showInformationMessage('工作区已保存。');
    }

    /** Open the common_data_structures.json file (draft-first) in the editor. */
    async openCommonDS(): Promise<void> {
        if (!this.projectRoot) return;
        const filePath = this._commonDS.draftFirstPath(this.projectRoot.absolutePath);
        if (fs.existsSync(filePath)) {
            await this.openInEditor(filePath);
        }
    }

    /** Open the language-specific data structure file (e.g. data_structures.py) in the editor.
     *  Follows draft-first: prefers the staged copy when it exists. */
    async openActualDS(): Promise<void> {
        if (!this.projectRoot) return;
        try {
            const projectAbs = this.projectRoot.absolutePath;
            const stagingPath = actualDSStagingPath(this.codesStagingDir(projectAbs), 'python');
            if (fs.existsSync(stagingPath)) {
                await this.openInEditor(stagingPath);
                return;
            }
            const realCodeDir = path.join(settings.getCodesPath(), path.basename(projectAbs));
            const filePath = actualDSRealPath(realCodeDir, 'python');
            if (fs.existsSync(filePath)) {
                await this.openInEditor(filePath);
            }
        } catch (_) {}
    }

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
            const ongoingPath = this.resolveOngoingPath(projectAbs);
            if (!fs.existsSync(ongoingPath)) return;

            const ongoing = JSON.parse(fs.readFileSync(ongoingPath, 'utf8')) as any[];
            const pseudoRoot = settings.getPseudoPath();

            const pathToLeafIndex = new Map<string, number>();
            this.leafOrder.forEach(idx => {
                const abs = this.indexToPath.get(idx);
                if (!abs) return;
                const realPath = isDraftPath(projectAbs, abs) ? toRealPath(projectAbs, abs) : abs;
                const rel = path.relative(pseudoRoot, realPath).split(path.sep).join('/');
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

            const realPath = path.join(projectAbs, 'ongoing_leaf_modules.json');
            const draftPath = toDraftPath(projectAbs, realPath);
            writeJsonAtomically(draftPath, ongoing);
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

    /** Resolve ongoing_leaf_modules.json preferring draft. */
    private resolveOngoingPath(projectAbs: string): string {
        const real = path.join(projectAbs, 'ongoing_leaf_modules.json');
        const draft = toDraftPath(projectAbs, real);
        return fs.existsSync(draft) ? draft : real;
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
            const propagateDeps = (list: any[]) => list.forEach((m: any) => {
                if (m.dependencies?.includes(parentName)) {
                    m.dependencies = m.dependencies.filter((d: string) => d !== parentName);
                    newNames.forEach((n: string) => {
                        if (!m.dependencies.includes(n)) m.dependencies.push(n);
                    });
                }
            });
            propagateDeps(ongoing);
            propagateDeps(allModules);
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

    private rebuildDerivedState(): void {
        if (!this.workspaceRoot) {
            this.nodes = [];
            this.leafOrder = [];
            this.leafModuleIndices = new Set();
            this.indexToPath = new Map();
            this.moduleStatuses = {};
            return;
        }

        const nodes: TreeNodeData[] = [];
        const indexToPath = new Map<number, string>();
        const pathToIndex = new Map<string, number>();
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
                if (nodeType === 'leaf') leafModuleIndices.add(idx);
            }

            nodes.push({
                nodeType,
                title: node.label,
                desc: readModuleDesc(node.absolutePath),
                childCount: moduleChildren.length
            });

            for (const child of moduleChildren) serialize(child);
        };

        serialize(this.workspaceRoot);

        this.nodes = nodes;
        this.indexToPath = indexToPath;
        this.leafModuleIndices = leafModuleIndices;

        const pseudoPath = settings.getPseudoPath();
        const projectAbs = this.projectRoot!.absolutePath;
        const ongoingPath = this.resolveOngoingPath(projectAbs);

        if (fs.existsSync(ongoingPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(ongoingPath, 'utf8'));
                const sorted = topoSortLeafModules(raw);
                this.leafOrder = sorted
                    .map((m: any) => {
                        const realP = path.join(pseudoPath, m.path);
                        const draftP = toDraftPath(projectAbs, realP);
                        return pathToIndex.get(draftP) ?? pathToIndex.get(realP) ?? -1;
                    })
                    .filter(i => i >= 0);
            } catch (err) {
                console.warn('[WorkspaceManager] 叶子拓扑排序失败，回退为树前序：', err);
                this.leafOrder = [...leafModuleIndices];
            }
        } else {
            this.leafOrder = [...leafModuleIndices];
        }

        const next: Record<number, RefinementEntry[]> = {};
        for (const ni of this.leafOrder) {
            const absPath = indexToPath.get(ni);
            if (!absPath) continue;

            if (this.refinementHistories[ni]) {
                next[ni] = this.refinementHistories[ni];
            } else if (this._suppressHistoryPaths.has(absPath)) {
                const specPath = path.join(absPath, 'content.txt');
                next[ni] = fs.existsSync(specPath)
                    ? [{ label: '模块规约', filePath: specPath, type: 'spec' }]
                    : [];
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
        this._suppressHistoryPaths.clear();

        const statuses: Record<number, ModuleProgressStatus> = {};
        this.leafOrder.forEach(idx => {
            const history = this.refinementHistories[idx] || [];
            const hasCode = history.some(entry => entry.type === 'code');
            statuses[idx] = hasCode ? 'completed' : 'pending';
        });

        if (this.currentModule >= 0 && this.leafOrder.includes(this.currentModule)) {
            const history = this.refinementHistories[this.currentModule] || [];
            const activeIdx = this.getActiveRefinementIndex(history);
            this.currentRefinementEntry = activeIdx;
            const activeType = history[activeIdx]?.type;
            if (activeType === 'code') {
                const pos = this.leafOrder.indexOf(this.currentModule);
                const nextModule = this.leafOrder[pos + 1];
                if (nextModule !== undefined) statuses[nextModule] = 'inProgress';
            } else if (history.length > 0) {
                statuses[this.currentModule] = 'inProgress';
            }
        }

        this.moduleStatuses = statuses;
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

    /** Staging directory for generated code files within the draft overlay. */
    private codesStagingDir(projectAbs: string): string {
        return path.join(projectAbs, '.tmp', '_code_output');
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

    private postUpdate(): void {
        const payload = this.buildPayload();
        OperationPanelViewProvider.postMessage({ type: 'updateView', data: payload });
        DesignTreeViewProvider.postMessage({ type: 'updateView', data: payload });
    }

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

    /** Draft-first check: true if data_structures.py exists in staging OR in realCodeDir. */
    private _hasActualDS(): boolean {
        if (!this.projectRoot) return false;
        try {
            const projectAbs = this.projectRoot.absolutePath;
            const stagingPath = actualDSStagingPath(this.codesStagingDir(projectAbs), 'python');
            if (fs.existsSync(stagingPath)) return true;
            const realCodeDir = path.join(settings.getCodesPath(), path.basename(projectAbs));
            return fs.existsSync(actualDSRealPath(realCodeDir, 'python'));
        } catch { return false; }
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
