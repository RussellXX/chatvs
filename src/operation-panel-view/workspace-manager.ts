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
import {
    TreeNodeData,
    RefinementEntry,
    UpdateViewPayload
} from '../types/operation-panel-view-protocol';
import { loadRefinementHistory, saveRefinementHistory } from './workspace-persistence';
import { cleanLLMResponse, getHumanJsonPath, LineData } from './granularity-view-utils';
import * as Diff from 'diff';

// ── helpers ─────────────────────────────────────────────────────────────────

function appendCustomPrompt(userPrompt: string, customPrompt: string): string {
    const trimmed = (customPrompt || '').trim();
    if (!trimmed) return userPrompt;
    return `${userPrompt}\n\n---\n用户额外要求：\n${trimmed}`;
}

function writeJsonAtomically(filePath: string, data: unknown): void {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        if (fs.existsSync(tempPath)) { try { fs.unlinkSync(tempPath); } catch (_) {} }
        throw err;
    }
}

function readJsonSafe(filePath: string): any[] {
    if (!fs.existsSync(filePath)) return [];
    try {
        const text = fs.readFileSync(filePath, 'utf8').trim();
        return text ? JSON.parse(text) : [];
    } catch { return []; }
}

function readModuleDesc(absolutePath: string): string {
    const contentPath = path.join(absolutePath, 'content.txt');
    if (!fs.existsSync(contentPath)) return '';
    try {
        const text = fs.readFileSync(contentPath, 'utf8').trim();
        if (text.startsWith('{')) {
            const json = JSON.parse(text);
            return ((json.description as string) || '').slice(0, 40);
        }
        return text.slice(0, 40);
    } catch { return ''; }
}

// Deep-copy the project tree into a workspace-private copy so the DataProvider
// is not mutated until the user explicitly confirms.
function cloneTree(source: ProjectNode): ProjectNode {
    const clone = ProjectNode.fromObject({
        label: source.label,
        absolutePath: source.absolutePath,
        type: 'Project',
        childrenCount: 0
    });
    clone.children = source.children.map(child => {
        if (child instanceof RequirementNode) {
            return RequirementNode.fromObject(
                { label: child.label, absolutePath: child.absolutePath, type: 'Requirement', childrenCount: 0 },
                clone
            );
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

// ── WorkspaceManager ────────────────────────────────────────────────────────

export class WorkspaceManager {
    private static _instance: WorkspaceManager | null = null;

    // active project
    // private projectPath: string | null = null;
    private projectRoot: ProjectNode | null = null;
    private workspaceRoot: ProjectNode | null = null;

    // view state
    private nodes: TreeNodeData[] = [];
    private leafOrder: number[] = [];
    private leafModuleIndices: Set<number> = new Set();
    private currentModule = -1;
    private currentRefinementEntry = -1;
    private refinementHistories: Record<number, RefinementEntry[]> = {};
    private isBusy = false;

    // index <-> path mapping (rebuilt from workspace tree each time)
    private indexToPath = new Map<number, string>();
    private pathToIndex = new Map<string, number>();

    private constructor(private context: vscode.ExtensionContext) {}

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
        this.projectRoot = projectNode;
        this.workspaceRoot = cloneTree(projectNode);
        this.currentModule = -1;
        this.currentRefinementEntry = -1;
        this.refinementHistories = {};
        this.isBusy = false;

        this.rebuildDerivedState();
        this.postUpdate();
    }

    async divide(nodeIndex: number, customPrompt = ''): Promise<void> {
        if (this.isBusy || !this.projectRoot || !this.workspaceRoot) return;

        const targetPath = this.indexToPath.get(nodeIndex);
        if (!targetPath) return;

        const node = this.findNode(this.workspaceRoot, targetPath);
        if (!node) return;

        // Only ProjectNode or a leaf ModuleNode can be divided
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
                await this.performDivision(node, customPrompt);
                progress.report({ message: '模块划分成功！' });
                await delay(1000);
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

        const modulePath = this.indexToPath.get(nodeIndex)!;
        const commonDSPath = path.join(this.projectRoot.absolutePath, 'common_data_structures.json');

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在精化...',
            cancellable: false
        }, async progress => {
            try {
                const lastEntry = history[history.length - 1];
                const fileContent = fs.readFileSync(lastEntry.filePath, 'utf8');
                const prompt = await openaiHelper.getGlobalRefinePromptDetailed(
                    fileContent, modulePath, commonDSPath
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);

                const outputPath = path.join(modulePath, `pseudo_${Date.now()}.txt`);
                fs.writeFileSync(outputPath, raw, 'utf8');

                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                history.push({ label: `粒度${pseudoCount + 1}`, filePath: outputPath, type: 'pseudo' });
                this.currentRefinementEntry = history.length - 1;

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

        // 需要一个活动编辑器，且正在编辑当前模块最新条目的文件，且有非空选区
        const editor = vscode.window.activeTextEditor;
        const sameFile = editor
            && path.resolve(editor.document.fileName) === path.resolve(lastEntry.filePath);

        if (!editor || !sameFile) {
            vscode.window.showWarningMessage(
                '局部精化前，请先在编辑器中打开当前模块最新的伪代码文件。'
            );
            return;
        }
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先在编辑器中选中要精化的部分。');
            return;
        }

        const modulePath = this.indexToPath.get(nodeIndex)!;
        const commonDSPath = path.join(this.projectRoot.absolutePath, 'common_data_structures.json');

        this.isBusy = true;
        this.postUpdate();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在局部精化...',
            cancellable: false
        }, async progress => {
            try {
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

                const outputPath = path.join(modulePath, `pseudo_local_${Date.now()}.txt`);

                // 读取旧条目的确认状态侧挂文件（若存在）
                const oldHumanPath = getHumanJsonPath(lastEntry.filePath);
                let oldStatus: LineData[] = [];
                if (fs.existsSync(oldHumanPath)) {
                    try {
                        oldStatus = JSON.parse(fs.readFileSync(oldHumanPath, 'utf8'));
                    } catch { oldStatus = []; }
                }

                // Diff 旧/新 内容，推导新侧挂状态 + 高亮字符区间
                const changes = Diff.diffLines(fileContent, refinedContent);
                const highlightRanges: { start: number; end: number }[] = [];
                const newStatus: LineData[] = [];
                let currentOffset = 0;
                let oldLineIndex = 0;

                for (const part of changes) {
                    const lineCount = part.count || 0;
                    const textLength = part.value.length;

                    if (part.added) {
                        highlightRanges.push({ start: currentOffset, end: currentOffset + textLength });
                        for (let i = 0; i < lineCount; i++) {
                            newStatus.push({ type: 0, content: '' });
                        }
                        currentOffset += textLength;
                    } else if (part.removed) {
                        oldLineIndex += lineCount;
                    } else {
                        for (let i = 0; i < lineCount; i++) {
                            newStatus.push({
                                type: oldLineIndex < oldStatus.length
                                    ? oldStatus[oldLineIndex].type
                                    : 0,
                                content: ''
                            });
                            oldLineIndex++;
                        }
                        currentOffset += textLength;
                    }
                }

                const refinedLines = refinedContent.split(/\r?\n/);
                if (refinedContent.endsWith('\n') && refinedLines.length > newStatus.length) {
                    refinedLines.pop();
                }
                newStatus.forEach((status, index) => {
                    if (index < refinedLines.length) status.content = refinedLines[index];
                });

                const newHumanPath = getHumanJsonPath(outputPath);
                fs.writeFileSync(newHumanPath, JSON.stringify(newStatus, null, 2), 'utf8');
                fs.writeFileSync(outputPath, refinedContent, 'utf8');

                // 同时把高亮区间侧挂到 `${outputPath}.highlight.json`，留给行级确认特性使用
                const highlightPath = outputPath + '.highlight.json';
                fs.writeFileSync(highlightPath, JSON.stringify(highlightRanges, null, 2), 'utf8');

                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                history.push({
                    label: `粒度${pseudoCount + 1}`,
                    filePath: outputPath,
                    type: 'pseudo'
                });
                this.currentRefinementEntry = history.length - 1;

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
            title: '正在生成代码...',
            cancellable: false
        }, async progress => {
            try {
                const lastEntry = history[history.length - 1];
                const fileContent = fs.readFileSync(lastEntry.filePath, 'utf8');
                const pseudoCount = history.filter(e => e.type === 'pseudo').length;
                const prompt = await openaiHelper.getGenerateCodePrompt(
                    fileContent, `粒度${pseudoCount}`, language, modulePath
                );
                const userPrompt = appendCustomPrompt(prompt.user, customPrompt);
                const raw = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt);
                const code = cleanLLMResponse(raw);

                const codeProjectRoot = path.join(settings.getCodesPath(), projectName);
                const topoIdx = this.leafOrder.indexOf(nodeIndex);

                if (topoIdx === 0) {
                    const { initialProject } = await import('../tools/project-initializer.js');
                    await initialProject(codeProjectRoot, language);
                    progress.report({ message: '正在初始化代码项目...' });
                }

                const { writeModule } = await import('../tools/module-writer.js');
                const moduleRelPath = path.relative(projectPath, modulePath);
                const generatedFilePath = await writeModule(codeProjectRoot, moduleRelPath, code, language);

                if (topoIdx === this.leafOrder.length - 1) {
                    const { updateRootLaunchConfig } = await import('../tools/launch-config-updater.js');
                    await updateRootLaunchConfig(settings.getProjectPath(), projectName, generatedFilePath, language);
                    vscode.window.showInformationMessage(`已更新调试配置: "Run ${projectName}"`);
                }

                history.push({ label: '实际代码', filePath: generatedFilePath, type: 'code' });
                this.currentRefinementEntry = history.length - 1;

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

    async confirm(): Promise<void> {
        if (!this.projectRoot || !this.workspaceRoot) return;

        // Flush workspace tree into DataProvider
        this.projectRoot.children = this.workspaceRoot.children;
        this.fixParentRefs(this.projectRoot);

        // Persist each module's refinement history
        for (const [idxStr, history] of Object.entries(this.refinementHistories)) {
            const absPath = this.indexToPath.get(Number(idxStr));
            if (absPath) saveRefinementHistory(absPath, history);
        }

        DesignmentTreeDataProvider.getInstance().refresh(undefined);
        vscode.window.showInformationMessage('工作区已保存。');
    }

    selectModule(nodeIndex: number): void {
        this.currentModule = nodeIndex;
        this.currentRefinementEntry = -1;

        if (this.leafModuleIndices.has(nodeIndex)) {
            const history = this.refinementHistories[nodeIndex];
            if (history && history.length > 0) {
                this.currentRefinementEntry = history.length - 1;
                this.openInEditor(history[this.currentRefinementEntry].filePath).catch(() => {});
            }
        } else {
            // Non-leaf or root — open content file
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
        this.currentRefinementEntry = entryIndex;

        const history = this.refinementHistories[moduleNodeIndex];
        if (history?.[entryIndex]) {
            this.openInEditor(history[entryIndex].filePath).catch(() => {});
        }

        this.postUpdate();
    }

    // ── private helpers ───────────────────────────────────────────────────

    private async performDivision(
        node: ProjectNode | ModuleNode,
        customPrompt = ''
    ): Promise<void> {
        const projectPath = this.projectRoot!.absolutePath;
        const aiPath = settings.getPseudoPath();
        const projectName = path.basename(projectPath);

        const modulesPath = path.join(projectPath, 'modules.json');
        const ongoingPath = path.join(projectPath, 'ongoing_leaf_modules.json');

        let allModules = readJsonSafe(modulesPath);
        let ongoing = readJsonSafe(ongoingPath);

        const isFirstLevel = node instanceof ProjectNode;
        let prompt: { system: string; user: string };
        let expectedPrefix = '';

        if (isFirstLevel) {
            allModules = [];
            ongoing = [];
            writeJsonAtomically(modulesPath, []);
            writeJsonAtomically(ongoingPath, []);
            prompt = await openaiHelper.getModuleDivisionPrompt1(
                node.getContentFilePath(), this.context
            );
        } else {
            const relRaw = path.relative(aiPath, node.absolutePath);
            const currentModuleName = relRaw.split(path.sep).join('.');
            const prefix = projectName + '.';
            const clean = currentModuleName.startsWith(prefix)
                ? currentModuleName.slice(prefix.length)
                : currentModuleName;
            expectedPrefix = clean + '.';
            prompt = await openaiHelper.getModuleDivisionPrompt2(
                ongoingPath,
                path.join(projectPath, 'content.txt'),
                currentModuleName,
                this.context
            );
        }

        // LLM call with prefix validation retries
        let result: any[] = [];
        let userPrompt = appendCustomPrompt(prompt.user, customPrompt);
        let valid = false;

        for (let attempt = 0; attempt < 3 && !valid; attempt++) {
            try {
                const raw = await openaiHelper.callOpenAIForJSON(
                    prompt.system, userPrompt, ModulesArraySchema, 3
                );
                result = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
                const check = validateModulePrefix(result, expectedPrefix);
                if (check.valid) {
                    valid = true;
                } else {
                    userPrompt += `\n\n注意：以下模块名称不符合要求，必须以 "${expectedPrefix}" 开头: ${check.invalidModules.join(', ')}。请修正。`;
                }
            } catch (e) {
                console.error(`Division attempt ${attempt + 1} failed:`, e);
            }
        }

        if (!valid) throw new Error('LLM 未能生成符合命名规范的结果。');

        // Update ongoing list: remove parent (non-first), propagate dependencies
        if (!isFirstLevel) {
            const relPath = path.relative(aiPath, node.absolutePath);
            const parentName = path.relative(path.join(aiPath, projectName), node.absolutePath)
                .split(path.sep).join('.');

            ongoing = ongoing.filter((m: any) =>
                (m.path ?? '').replace(/[\/\\]/g, path.sep) !== relPath
            );

            const newNames = result.map((m: any) => m.name);
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

        // Create child module directories and add to workspace tree
        for (const mod of result) {
            mod.path = path.join(projectName, mod.name.replace(/\./g, path.sep));
            allModules.push(mod);
            ongoing.push(mod);

            const childName: string = mod.name.split('.').pop()!;
            const childPath = path.join(node.absolutePath, childName);
            fs.mkdirSync(childPath, { recursive: true });
            fs.writeFileSync(
                path.join(childPath, 'content.txt'),
                JSON.stringify(mod, null, 2),
                'utf8'
            );

            const childNode = new ModuleNode(childName, childPath, node);
            (node.children as any[]).push(childNode);
        }

        writeJsonAtomically(modulesPath, allModules);
        writeJsonAtomically(ongoingPath, ongoing);
    }

    private rebuildDerivedState(): void {
        if (!this.workspaceRoot) {
            this.nodes = [];
            this.leafOrder = [];
            this.leafModuleIndices = new Set();
            this.indexToPath = new Map();
            this.pathToIndex = new Map();
            return;
        }

        const nodes: TreeNodeData[] = [];
        const indexToPath = new Map<number, string>();
        const pathToIndex = new Map<string, number>();
        const leafModuleIndices = new Set<number>();

        const serialize = (node: DesignmentTreeNode) => {
            if (node instanceof RequirementNode) return; // hide from design tree

            const idx = nodes.length;
            indexToPath.set(idx, node.absolutePath);
            pathToIndex.set(node.absolutePath, idx);

            let nodeType: 'root' | 'leaf' | 'non-leaf';
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
        this.pathToIndex = pathToIndex;
        this.leafModuleIndices = leafModuleIndices;

        // Topological order from ongoing_leaf_modules.json
        const aiPath = settings.getPseudoPath();
        const ongoingPath = path.join(this.projectRoot!.absolutePath, 'ongoing_leaf_modules.json');

        if (fs.existsSync(ongoingPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(ongoingPath, 'utf8'));
                const sorted = topoSortLeafModules(raw);
                this.leafOrder = sorted
                    .map((m: any) => pathToIndex.get(path.join(aiPath, m.path)) ?? -1)
                    .filter(i => i >= 0);
            } catch {
                this.leafOrder = [...leafModuleIndices];
            }
        } else {
            this.leafOrder = [...leafModuleIndices];
        }

        // Initialise / preserve refinement histories for current leaf modules
        const next: Record<number, RefinementEntry[]> = {};
        for (const ni of this.leafOrder) {
            const absPath = indexToPath.get(ni);
            if (!absPath) continue;

            if (this.refinementHistories[ni]) {
                // Preserve in-memory history (accumulated this session)
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
        }
        this.refinementHistories = next;
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

    private fixParentRefs(node: ProjectNode | ModuleNode): void {
        for (const child of (node.children ?? [])) {
            (child as any).parent = node;
            if (child instanceof ModuleNode) this.fixParentRefs(child);
        }
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
        OperationPanelViewProvider.postMessage({
            type: 'updateView',
            data: this.buildPayload()
        });
    }

    private buildPayload(): UpdateViewPayload {
        return {
            nodes: this.nodes,
            leafOrder: this.leafOrder,
            currentModule: this.currentModule,
            refinementHistories: this.refinementHistories,
            currentRefinementEntry: this.currentRefinementEntry,
            isBusy: this.isBusy
        };
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
