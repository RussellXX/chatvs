import * as vscode from 'vscode'
import * as fs from 'fs'
import * as designmentService from './designment-tree-service'
import { DesignmentTreeDataProvider } from './designment-tree-data-provider'
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

        // Listen to node selection
        treeView.onDidChangeSelection(async event => {
            if (event.selection.length !== 1) return;

            const selected = event.selection[0];

            // Open the associated content file in the editor
            const contentPath: string = selected.getContentFilePath();

            if (fs.existsSync(contentPath)) {
                try {
                    const doc = await vscode.workspace.openTextDocument(contentPath);
                    await vscode.window.showTextDocument(doc);
                } catch (err) {
                    console.error('Failed to open content file:', err);
                }
            }
            
            WorkspaceManager.getInstance().loadProject(selected.getRoot());
        })

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
