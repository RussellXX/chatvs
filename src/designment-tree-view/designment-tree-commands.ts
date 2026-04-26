import * as vscode from 'vscode'
import * as fs from 'fs'
import * as designmentService from './designment-tree-service'
import { DesignmentTreeDataProvider, DesignmentTreeNode, ProjectNode } from './designment-tree-data-provider'
import * as settings from '../settings/settings';
import { WorkspaceManager } from '../operation-panel-view/workspace-manager';


export async function createTreeView(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openChatGPTView", async () => {
            const structureReady = await settings.ensureProjectStructure();

            if (structureReady) {
                openChatGPTView(context);
            }
        })
    )
}


const openChatGPTView = (context: vscode.ExtensionContext) => {
    vscode.commands.executeCommand("workbench.view.extension.CodeToolBox").then(() => {
        const designmentTreeDataProvider = DesignmentTreeDataProvider.getInstance();

        const treeView = vscode.window.createTreeView('CodeToolBox.chatGPTView', {
            treeDataProvider: designmentTreeDataProvider
        })

        context.subscriptions.push(treeView);

        // Listen to node selection — only open content file, no workspace loading
        treeView.onDidChangeSelection(async event => {
            if (event.selection.length !== 1) return;

            const selected = event.selection[0];

            const contentPath: string = selected.getContentFilePath();
            if (fs.existsSync(contentPath)) {
                try {
                    const doc = await vscode.workspace.openTextDocument(contentPath);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
                } catch (err) {
                    console.error('Failed to open content file:', err);
                }
            }
        })

        // Right-click command on project root node
        context.subscriptions.push(
            vscode.commands.registerCommand('refinement.loadProjectToWorkspace', async (node: DesignmentTreeNode) => {
                if (!node) return;
                await WorkspaceManager.getInstance().loadProject(node.getRoot());
            })
        )

        // Right-click → delete project
        context.subscriptions.push(
            vscode.commands.registerCommand('refinement.deleteProject', async (node: ProjectNode) => {
                if (!node) return;
                const answer = await vscode.window.showWarningMessage(
                    `是否确定要删除项目 "${node.label}"？此操作不可撤销。`,
                    { modal: true },
                    '确定删除'
                );
                if (answer !== '确定删除') return;
                await designmentService.deleteProject(node);
            })
        )

        // Command for creating a new project
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createProj', async () => {

                const defaultName = "New Project";
                const newProjName = await vscode.window.showInputBox({
                    prompt: 'Enter a new project name',
                    value: defaultName
                });

                if (!newProjName) return;

                await designmentService.createProject(newProjName);
            })
        )

        vscode.commands.executeCommand("setContext", "CodeToolBox.chatGPTView", true);
    })
}
