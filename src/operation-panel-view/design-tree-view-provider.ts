import * as vscode from 'vscode';
import * as fs from 'fs';
import { WebviewOutgoingMessage, WebviewIncomingMessage } from '../types/operation-panel-view-protocol';
import { WorkspaceManager } from './workspace-manager';

export class DesignTreeViewProvider {
    public static currentPanel: vscode.WebviewPanel | undefined;
    private static _extensionUri: vscode.Uri;
    private static _lastPayload: WebviewOutgoingMessage | undefined;

    public static init(extensionUri: vscode.Uri): void {
        DesignTreeViewProvider._extensionUri = extensionUri;
    }

    public static createOrShow(): void {
        if (DesignTreeViewProvider.currentPanel) {
            DesignTreeViewProvider.currentPanel.reveal(vscode.ViewColumn.Two);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'DesignTreeView',
            '设计树',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'html')
                ],
                retainContextWhenHidden: true
            }
        );

        panel.iconPath = vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'images', 'hierarchy-svgrepo-com.svg');
        DesignTreeViewProvider.currentPanel = panel;
        panel.webview.html = DesignTreeViewProvider._getHtmlForWebview(panel.webview);

        panel.webview.onDidReceiveMessage(async (message: WebviewIncomingMessage) => {
            if (message.type === 'webviewReady') {
                if (DesignTreeViewProvider._lastPayload) {
                    panel.webview.postMessage(DesignTreeViewProvider._lastPayload);
                }
                return;
            }
            if (message.type !== 'executeCommand') return;
            const { commandId, payload } = message;
            if (commandId === 'selectModule') {
                WorkspaceManager.getInstance().selectModule((payload as any)?.index ?? -1);
            } else if (commandId === 'openCommonDS') {
                WorkspaceManager.getInstance().openCommonDS();
            }
        });

        panel.onDidDispose(() => {
            DesignTreeViewProvider.currentPanel = undefined;
        });
    }

    public static postMessage(message: WebviewOutgoingMessage): void {
        DesignTreeViewProvider._lastPayload = message;
        if (DesignTreeViewProvider.currentPanel) {
            DesignTreeViewProvider.currentPanel.webview.postMessage(message);
        }
    }

    private static _getHtmlForWebview(webview: vscode.Webview): string {
        const stylePath  = vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'html', 'design-tree-view.css');
        const htmlPath   = vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'html', 'design-tree-view.html');
        const scriptPath = vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'html', 'design-tree-view.js');
        const d3Path     = vscode.Uri.joinPath(DesignTreeViewProvider._extensionUri, 'html', 'd3.v7.min.js');

        const styleUri  = webview.asWebviewUri(stylePath).toString();
        const scriptUri = webview.asWebviewUri(scriptPath).toString();
        const d3Uri     = webview.asWebviewUri(d3Path).toString();

        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        html = html
            .replace(/{{styleUri}}/g, styleUri)
            .replace(/{{scriptUri}}/g, scriptUri)
            .replace(/{{d3Uri}}/g, d3Uri);
        return html;
    }
}
