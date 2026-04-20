import * as vscode from 'vscode';
import * as fs from 'fs';
import { WebviewOutgoingMessage, WebviewIncomingMessage } from '../types/operation-panel-view-protocol';
import { WorkspaceManager } from './workspace-manager';

export class DesignTreeViewProvider implements vscode.WebviewViewProvider {
    public static currentView: vscode.WebviewView | undefined;
    private readonly _extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        DesignTreeViewProvider.currentView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'html')]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message: WebviewIncomingMessage) => {
            if (message.type === 'webviewReady') return;
            if (message.type !== 'executeCommand') return;

            const { commandId, payload } = message;
            if (commandId === 'selectModule') {
                WorkspaceManager.getInstance().selectModule((payload as any)?.index ?? -1);
            }
        });
    }

    public static postMessage(message: WebviewOutgoingMessage): void {
        if (DesignTreeViewProvider.currentView) {
            DesignTreeViewProvider.currentView.webview.postMessage(message);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const stylePath  = vscode.Uri.joinPath(this._extensionUri, 'html', 'design-tree-view.css');
        const htmlPath   = vscode.Uri.joinPath(this._extensionUri, 'html', 'design-tree-view.html');
        const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'html', 'design-tree-view.js');
        const d3Path     = vscode.Uri.joinPath(this._extensionUri, 'html', 'd3.v7.min.js');

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
