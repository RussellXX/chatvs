import * as vscode from 'vscode'
import * as fs from 'fs'
import {
    WebviewOutgoingMessage,
    WebviewIncomingMessage,
} from '../types/operation-panel-view-protocol';
import { WorkspaceManager } from './workspace-manager';

export class OperationPanelViewProvider implements vscode.WebviewViewProvider {
    public static currentView: vscode.WebviewView | undefined
    private readonly _extensionUri: vscode.Uri

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Thenable<void> | void {

        OperationPanelViewProvider.currentView = webviewView
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'html')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

        webviewView.webview.onDidReceiveMessage(async (message: WebviewIncomingMessage) => {
            if (message.type === 'webviewReady') {
                return;
            }

            if (message.type !== 'executeCommand') return;

            const { commandId, payload } = message;
            const wm = WorkspaceManager.getInstance();
            const p = payload as any;

            const customPrompt =
                typeof p?.customPrompt === 'string' ? p.customPrompt.trim() : '';

            switch (commandId) {
                case 'selectModule':
                    wm.selectModule(p?.index ?? -1);
                    break;

                case 'refine':
                    await wm.refine(p?.index ?? -1, customPrompt);
                    break;

                case 'localRefine':
                    await wm.localRefine(p?.index ?? -1, customPrompt);
                    break;

                case 'generateCode':
                    await wm.generateCode(p?.index ?? -1, customPrompt);
                    break;

                case 'rollbackRefinement':
                    await wm.rollbackRefinement(p?.index ?? -1);
                    break;

                case 'openCommonDS':
                    await wm.openCommonDS();
                    break;

                case 'selectRefinement':
                    wm.selectRefinement(p?.moduleIndex ?? -1, p?.entryIndex ?? -1);
                    break;
            }
        })
    }

    public static postMessage(message: WebviewOutgoingMessage): void {
        if (OperationPanelViewProvider.currentView) {
            OperationPanelViewProvider.currentView.webview.postMessage(message)
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const stylePath = vscode.Uri.joinPath(this._extensionUri, 'html', 'operation-panel.css');
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'html', 'operation-panel.html');
        const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'html', 'operation-panel.js');

        const styleUri = webview.asWebviewUri(stylePath).toString();
        const scriptUri = webview.asWebviewUri(scriptPath).toString();

        let html = fs.readFileSync(htmlPath.fsPath, 'utf8')
        html = html
            .replace(/{{styleUri}}/g, styleUri)
            .replace(/{{scriptUri}}/g, scriptUri);

        return html;
    }
}
