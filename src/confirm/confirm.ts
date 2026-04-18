import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { remake } from '../make-new/remake';
import { refinementDiagnostics } from '../operation-panel-view/create-granularity-panel';
// --- 类型定义 ---

enum LineStatus {
    AI = 0,     // 未确认 (机器生成)
    Human = 1   // 已确认 (人工/已阅)
}

interface LineData {
    type: LineStatus
    content: string
}

// --- 核心类定义 (保持不变) ---

/**
 * 状态管理器：负责管理单个文档的内存状态、磁盘同步以及逻辑计算
 */
class DocumentStateManager {
    private lineStates: LineData[] = [];
    private humanJsonPath: string;
    private pyJsonPath: string;
    private document: vscode.TextDocument;
    
    private isDirty: boolean = false;
    private saveTimer: NodeJS.Timeout | undefined;
    private readonly SAVE_DELAY = 1000; // 1秒防抖

    constructor(document: vscode.TextDocument) {
        this.document = document;
        const fileName = document.fileName;
        this.humanJsonPath = fileName.replace(/\.[^.]+$/, '_py_human.json');
        this.pyJsonPath = fileName.replace(/\.[^.]+$/, '_py.json');
        this.load();
    }

    // src/confirm/confirm.ts

    public load() {
        let loadedData: LineData[] = [];
        if (fs.existsSync(this.humanJsonPath)) {
            try {
                const raw = fs.readFileSync(this.humanJsonPath, 'utf-8');
                loadedData = JSON.parse(raw);
            } catch (e) {
                console.error(`[Confirm] Error reading JSON: ${e}`);
            }
        }

        const docLineCount = this.document.lineCount;
        this.lineStates = new Array(docLineCount);

        for (let i = 0; i < docLineCount; i++) {
            const lineText = this.document.lineAt(i).text.trim();
            
            // [核心修改] 优先尝试按索引匹配
            // 如果 JSON 长度足够，且该位置的内容与文件内容一致，直接使用该位置的状态
            // 这样就能区分不同位置但内容相同的行（如多个"结束程序"）
            if (i < loadedData.length && loadedData[i].content.trim() === lineText) {
                this.lineStates[i] = { type: loadedData[i].type, content: lineText };
            } 
            // 只有当索引对不上（比如手动修改了文件导致错位）时，才回退到全表查找
            else {
                const matchedItem = loadedData.find(item => item.content.trim() === lineText);
                if (matchedItem) {
                    this.lineStates[i] = { type: matchedItem.type, content: lineText };
                } else {
                    this.lineStates[i] = { type: LineStatus.AI, content: lineText };
                }
            }
        }
    }

    public applyChanges(changes: readonly vscode.TextDocumentContentChangeEvent[]) {
        const sortedChanges = [...changes].sort((a, b) => b.range.start.compareTo(a.range.start));

        for (const change of sortedChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const text = change.text;
            let linesInserted = 0;
            for (const char of text) { if (char === '\n') linesInserted++; }
            const linesRemoved = endLine - startLine;

            if (this.lineStates[startLine]) {
                this.lineStates[startLine].type = LineStatus.Human;
            } else {
                this.lineStates[startLine] = { type: LineStatus.Human, content: '' };
            }

            if (linesRemoved > 0) {
                this.lineStates.splice(startLine + 1, linesRemoved);
            }

            if (linesInserted > 0) {
                const newLines: LineData[] = new Array(linesInserted).fill(null).map(() => ({
                    type: LineStatus.Human, 
                    content: '' 
                }));
                this.lineStates.splice(startLine + 1, 0, ...newLines);
            }
        }
        this.triggerSave();
    }

    public confirmLine(lineIndex: number): boolean {
        // 边界检查
        if (lineIndex >= 0 && lineIndex < this.lineStates.length) {
            
            // [修改] 切换逻辑：如果是 Human 则改为 AI，如果是 AI 则改为 Human
            const currentType = this.lineStates[lineIndex].type;
            const newType = (currentType === LineStatus.Human) ? LineStatus.AI : LineStatus.Human;

            this.lineStates[lineIndex].type = newType;
            this.triggerSave();
            return true; // 返回 true 表示状态确实改变了
        }
        return false;
    }

    public getLineStatus(lineIndex: number): LineStatus {
        return this.lineStates[lineIndex]?.type ?? LineStatus.AI;
    }

    private getSnapshot(): LineData[] {
        return this.lineStates.map((state, index) => ({
            type: state.type,
            content: this.document.lineAt(index).text.trim()
        }));
    }

    private triggerSave() {
        this.isDirty = true;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveToDisk(), this.SAVE_DELAY);
    }

    public saveToDisk() {
        if (!this.isDirty) return;
        const data = this.getSnapshot();
        const jsonString = JSON.stringify(data, null, 2);
        try {
            fs.writeFileSync(this.humanJsonPath, jsonString, 'utf-8');
            if (fs.existsSync(this.pyJsonPath)) {
                 fs.writeFileSync(this.pyJsonPath, jsonString, 'utf-8');
            }
            this.isDirty = false;
        } catch (error) {
            console.error(`[Confirm] Save failed: ${error}`);
        }
    }

    public dispose() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveToDisk();
    }
}

// --- 视图控制器 (保持不变) ---

class DecorationController {
    private confirmType: vscode.TextEditorDecorationType;
    private questionType: vscode.TextEditorDecorationType;
    private isEnabled: boolean = true;

    constructor() {
        this.confirmType = vscode.window.createTextEditorDecorationType({
            before: { contentText: ' ✔️', color: '#008000', margin: '0 10px 0 0', textDecoration: 'none' }
        });
        this.questionType = vscode.window.createTextEditorDecorationType({
            before: { contentText: ' ❓', color: '#0000FF', margin: '0 10px 0 0', textDecoration: 'none' }
        });
    }

    public setEnabled(enabled: boolean) { this.isEnabled = enabled; }

    public update(editor: vscode.TextEditor, stateManager: DocumentStateManager) {
        if (!this.isEnabled) {
            this.clear(editor);
            return;
        }
        const confirmedRanges: vscode.Range[] = [];
        const questionRanges: vscode.Range[] = [];
        const lineCount = editor.document.lineCount;

        for (let i = 0; i < lineCount; i++) {
            const text = editor.document.lineAt(i).text;
            if (!text.trim()) continue; 

            const status = stateManager.getLineStatus(i);
            const range = new vscode.Range(i, 0, i, 0);

            if (status === LineStatus.Human) {
                confirmedRanges.push(range);
            } else {
                questionRanges.push(range);
            }
        }
        editor.setDecorations(this.confirmType, confirmedRanges);
        editor.setDecorations(this.questionType, questionRanges);
    }
    
    public clear(editor: vscode.TextEditor) {
        editor.setDecorations(this.confirmType, []);
        editor.setDecorations(this.questionType, []);
    }
}


// --- 主入口 (主要修改部分) ---

export const confirm = (context: vscode.ExtensionContext) => {
    const decorationController = new DecorationController();
    const managers = new Map<string, DocumentStateManager>();
    let isJsonDisplayMode = true; 

    const getManager = (doc: vscode.TextDocument): DocumentStateManager => {
        const key = doc.fileName;
        if (!managers.has(key)) {
            managers.set(key, new DocumentStateManager(doc));
        }
        return managers.get(key)!;
    };

    const updateCurrentView = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const mgr = getManager(editor.document);
            decorationController.update(editor, mgr);
        }
    };

    const removeDiagnosticForLine = (uri: vscode.Uri, line: number) => {
        const diagnostics = refinementDiagnostics.get(uri);
        if (diagnostics && diagnostics.length > 0) {
            const lineRange = new vscode.Range(line, 0, line + 0, 0);
            // 过滤掉与当前行相交的 diagnostic
            // 注意：DiagnosticCollection 返回的是 ReadonlyArray，需要转换
            const newDiagnostics = [...diagnostics].filter(d => !d.range.intersection(lineRange));
            
            // 如果数量有变化，说明移除了 diagnostic，更新集合
            if (newDiagnostics.length !== diagnostics.length) {
                refinementDiagnostics.set(uri, newDiagnostics);
            }
        }
    };

    // [修改] 命令：确认/切换行状态 (支持参数调用 或 当前选区批量处理)
    const confirmCommand = vscode.commands.registerCommand('CodeToolBox.confirmLine', (line?: number) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const mgr = getManager(editor.document);
            let hasChanges = false;

            // 情况1：指定了行号 (通常是 UI 点击或代码调用)
            if (typeof line === 'number') {
                if (mgr.confirmLine(line)) {
                    hasChanges = true;
                }
            } 
            // 情况2：未指定行号 (通常是快捷键触发)，则处理当前所有选区
            else {
                for (const selection of editor.selections) {
                    const startLine = selection.start.line;
                    const endLine = selection.end.line;
                    // 遍历选区内的每一行进行切换
                    for (let l = startLine; l <= endLine; l++) {
                        if (mgr.confirmLine(l)) {
                            hasChanges = true;
                            removeDiagnosticForLine(editor.document.uri, l);
                        }
                    }
                }
            }

            if (hasChanges) {
                decorationController.update(editor, mgr);
            }
        }
    });

    // 命令：切换模式
    const switchDisplayCommand = vscode.commands.registerCommand('CodeToolBox.switchDisplay', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        if (isJsonDisplayMode) {
            isJsonDisplayMode = false;
            decorationController.setEnabled(false);
            decorationController.clear(editor);
            remake(context); 
        } else {
            isJsonDisplayMode = true;
            decorationController.setEnabled(true);
            const mgr = getManager(editor.document);
            decorationController.update(editor, mgr);
        }
    });

    context.subscriptions.push(confirmCommand, switchDisplayCommand);

    // 监听：文档变更
    vscode.workspace.onDidChangeTextDocument(event => {
        const mgr = getManager(event.document);
        mgr.applyChanges(event.contentChanges);
        if (isJsonDisplayMode && vscode.window.activeTextEditor?.document === event.document) {
            decorationController.update(vscode.window.activeTextEditor, mgr);
        }
    }, null, context.subscriptions);

    // ============================================================
    // 4. 监听：选区变化 (实现拖拽/多选确认)
    // ============================================================
    // vscode.window.onDidChangeTextEditorSelection(event => {
    //     if (!isJsonDisplayMode) return;

    //     const editor = event.textEditor;
    //     const mgr = getManager(editor.document);
    //     let hasChanges = false;

    //     // 遍历所有的光标/选区 (VSCode 支持 Alt+Click 多光标，也支持鼠标拖拽选区)
    //     for (const selection of event.selections) {
    //         // 获取选区的起始行和结束行
    //         const startLine = selection.start.line;
    //         const endLine = selection.end.line;

    //         // 遍历选区内的每一行进行确认
    //         for (let line = startLine; line <= endLine; line++) {
    //             // confirmLine 内部会检查状态是否已经是 Human，如果是则返回 false
    //             // 这样可以避免不必要的渲染
    //             if (mgr.confirmLine(line)) {
    //                 hasChanges = true;
    //             }
    //         }
    //     }

    //     // 只有当状态确实发生变化时，才刷新 UI，避免拖拽过程中频繁闪烁
    //     if (hasChanges) {
    //         decorationController.update(editor, mgr);
    //     }
    // }, null, context.subscriptions);
    // ============================================================

    // 监听：切换编辑器
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && isJsonDisplayMode) {
            setTimeout(() => updateCurrentView(), 50);
        }
    }, null, context.subscriptions);

    // 监听：关闭文档
    vscode.workspace.onDidCloseTextDocument(doc => {
        if (managers.has(doc.fileName)) {
            managers.get(doc.fileName)?.dispose();
            managers.delete(doc.fileName);
        }
    }, null, context.subscriptions);

    // 监听：文件重命名
    vscode.workspace.onDidRenameFiles(event => {
        for (const file of event.files) {
            const oldPath = file.oldUri.fsPath;
            const newPath = file.newUri.fsPath;

            // 这里假设插件主要处理 .py 或其他源码文件
            if (!oldPath.endsWith('.json')) {
                
                // 计算旧的 JSON 路径
                const oldHumanJsonPath = oldPath.replace(/\.[^.]+$/, '_py_human.json');
                const oldPyJsonPath = oldPath.replace(/\.[^.]+$/, '_py.json');

                // 计算新的 JSON 路径
                const newHumanJsonPath = newPath.replace(/\.[^.]+$/, '_py_human.json');
                const newPyJsonPath = newPath.replace(/\.[^.]+$/, '_py.json');

                try {
                    // 重命名 _py_human.json
                    if (fs.existsSync(oldHumanJsonPath)) {
                        fs.renameSync(oldHumanJsonPath, newHumanJsonPath);
                        // 如果内存中有旧文件的 manager，需要清理或更新
                        // 简单做法：直接清理，下次访问新文件时会自动加载新 JSON
                        if (managers.has(oldPath)) {
                            managers.get(oldPath)?.dispose();
                            managers.delete(oldPath);
                        }
                        console.log(`[Confirm] Renamed state file: ${path.basename(oldHumanJsonPath)} -> ${path.basename(newHumanJsonPath)}`);
                    }

                    // 重命名 _py.json (如果有)
                    if (fs.existsSync(oldPyJsonPath)) {
                        fs.renameSync(oldPyJsonPath, newPyJsonPath);
                    }
                } catch (error) {
                    console.error(`[Confirm] Failed to rename JSON files: ${error}`);
                }
            }
        }
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
        updateCurrentView();
    }
};