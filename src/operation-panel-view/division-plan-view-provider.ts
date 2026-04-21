import * as vscode from 'vscode';
import * as fs from 'fs';

interface DivisionPlanItem {
    name: string;
    description: string;
    dependencies: string[];
}

interface DivisionPlanRenderMessage {
    type: 'renderPlans';
    data: {
        targetLabel: string;
        plans: DivisionPlanItem[][];
    };
}

interface WebviewReadyMessage {
    type: 'webviewReady';
}

interface ExecuteCommandMessage {
    type: 'executeCommand';
    commandId: 'chooseDivisionPlan' | 'cancelDivisionPlan';
    payload?: unknown;
}

type DivisionPlanIncomingMessage = WebviewReadyMessage | ExecuteCommandMessage;

export class DivisionPlanViewProvider {
    public static currentPanel: vscode.WebviewPanel | undefined;
    private static _extensionUri: vscode.Uri;
    private static _lastPayload: DivisionPlanRenderMessage | undefined;
    private static _pendingResolver: ((value: number | undefined) => void) | undefined;

    public static init(extensionUri: vscode.Uri): void {
        DivisionPlanViewProvider._extensionUri = extensionUri;
    }

    public static async pickPlan(
        targetLabel: string,
        plans: DivisionPlanItem[][]
    ): Promise<number | undefined> {
        if (plans.length === 0) {
            return undefined;
        }

        if (DivisionPlanViewProvider.currentPanel) {
            DivisionPlanViewProvider.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'DivisionPlanView',
            '模块划分候选方案',
            vscode.ViewColumn.Three,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(DivisionPlanViewProvider._extensionUri, 'html')
                ],
                retainContextWhenHidden: true
            }
        );

        panel.iconPath = vscode.Uri.joinPath(DivisionPlanViewProvider._extensionUri, 'images', 'hierarchy-svgrepo-com.svg');
        DivisionPlanViewProvider.currentPanel = panel;
        panel.webview.html = DivisionPlanViewProvider._getHtmlForWebview(panel.webview);

        const payload: DivisionPlanRenderMessage = {
            type: 'renderPlans',
            data: { targetLabel, plans }
        };
        DivisionPlanViewProvider._lastPayload = payload;

        return await new Promise<number | undefined>((resolve) => {
            DivisionPlanViewProvider._pendingResolver = resolve;

            panel.webview.onDidReceiveMessage((message: DivisionPlanIncomingMessage) => {
                if (message.type === 'webviewReady') {
                    if (DivisionPlanViewProvider._lastPayload) {
                        panel.webview.postMessage(DivisionPlanViewProvider._lastPayload);
                    }
                    return;
                }

                if (message.type !== 'executeCommand') return;

                if (message.commandId === 'chooseDivisionPlan') {
                    const idx = Number((message.payload as { index?: unknown } | undefined)?.index);
                    if (!Number.isInteger(idx) || idx < 0 || idx >= plans.length) {
                        vscode.window.showWarningMessage('无效的方案选择。');
                        return;
                    }
                    DivisionPlanViewProvider._resolvePending(idx);
                    panel.dispose();
                    return;
                }

                if (message.commandId === 'cancelDivisionPlan') {
                    DivisionPlanViewProvider._resolvePending(undefined);
                    panel.dispose();
                }
            });

            panel.onDidDispose(() => {
                DivisionPlanViewProvider.currentPanel = undefined;
                if (DivisionPlanViewProvider._pendingResolver) {
                    DivisionPlanViewProvider._resolvePending(undefined);
                }
            });

            panel.reveal(vscode.ViewColumn.Three);
        });
    }

    private static _resolvePending(value: number | undefined): void {
        const resolver = DivisionPlanViewProvider._pendingResolver;
        DivisionPlanViewProvider._pendingResolver = undefined;
        if (resolver) {
            resolver(value);
        }
    }

    private static _getHtmlForWebview(webview: vscode.Webview): string {
        const stylePath = vscode.Uri.joinPath(DivisionPlanViewProvider._extensionUri, 'html', 'division-plan-view.css');
        const htmlPath = vscode.Uri.joinPath(DivisionPlanViewProvider._extensionUri, 'html', 'division-plan-view.html');
        const scriptPath = vscode.Uri.joinPath(DivisionPlanViewProvider._extensionUri, 'html', 'division-plan-view.js');

        const styleUri = webview.asWebviewUri(stylePath).toString();
        const scriptUri = webview.asWebviewUri(scriptPath).toString();

        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        html = html
            .replace(/{{styleUri}}/g, styleUri)
            .replace(/{{scriptUri}}/g, scriptUri);

        return html;
    }
}
