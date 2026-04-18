import * as vscode from 'vscode'
import { OperationPanelViewProvider } from './operation-panel-view-provider'

// export let currentRecord: GranularityRecord | null = null

const refineHighlightType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: '#CCA700',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})

export const refinementDiagnostics = vscode.languages.createDiagnosticCollection('refinement');

// Invoked in activation function.
export function registerWebviewForGranularityPanel(context: vscode.ExtensionContext) {

    const provider = new OperationPanelViewProvider(context.extensionUri)

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('OperationPanelView', provider)
    )

    context.subscriptions.push(refinementDiagnostics);
}
