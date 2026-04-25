import * as vscode from 'vscode';
import * as fs from 'fs';

export interface AddNodeDialogResult {
    name: string;
    description: string;
    dependencies: string[];
}

export class AddNodeDialogProvider {
    /**
     * Open the add-child-node dialog as a WebviewPanel.
     * Resolves with the form result, or undefined if the user cancelled.
     */
    static show(
        extensionUri: vscode.Uri,
        parentName: string,
        availableModules: string[]
    ): Promise<AddNodeDialogResult | undefined> {
        return new Promise(resolve => {
            let resolved = false;

            const panel = vscode.window.createWebviewPanel(
                'addNodeDialog',
                '新增子节点',
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'html')],
                    retainContextWhenHidden: false
                }
            );

            const styleUri  = panel.webview.asWebviewUri(
                vscode.Uri.joinPath(extensionUri, 'html', 'add-node-dialog.css')
            );
            const scriptUri = panel.webview.asWebviewUri(
                vscode.Uri.joinPath(extensionUri, 'html', 'add-node-dialog.js')
            );

            let html = fs.readFileSync(
                vscode.Uri.joinPath(extensionUri, 'html', 'add-node-dialog.html').fsPath,
                'utf8'
            );
            html = html
                .replace('{{styleUri}}', styleUri.toString())
                .replace('{{scriptUri}}', scriptUri.toString());
            panel.webview.html = html;

            const done = (result: AddNodeDialogResult | undefined) => {
                if (resolved) return;
                resolved = true;
                resolve(result);
                try { panel.dispose(); } catch (_) {}
            };

            panel.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'submit') {
                    done(msg.data as AddNodeDialogResult);
                } else if (msg.type === 'cancel') {
                    done(undefined);
                }
            });

            panel.onDidDispose(() => done(undefined));

            // Send init data once the webview is ready.
            setTimeout(() => {
                panel.webview.postMessage({ type: 'init', parentName, availableModules });
            }, 200);
        });
    }
}
