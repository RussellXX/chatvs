import * as vscode from 'vscode';

import { registerCreateSetting } from "./settings/settings";
import { remake } from './make-new/remake';
import { confirm } from './confirm/confirm';
import { registerWebviewForGranularityPanel } from "./operation-panel-view/create-granularity-panel";
import { DesignmentTreeDataProvider } from './designment-tree-view/designment-tree-data-provider';
import { createTreeView } from './designment-tree-view/designment-tree-commands';
import { initializeLangIconsRepoPath } from './tools/lang-util';
import { WorkspaceManager } from './operation-panel-view/workspace-manager';

interface Project {
    id: string;
    name: string;
    segments: Project[];
}

export const projects: Project[] = [];

export async function activate(context: vscode.ExtensionContext) {
    registerCreateSetting(context);
    initializeLangIconsRepoPath(context);
    WorkspaceManager.init(context);
    createTreeView(context);
    remake(context);
    confirm(context);
    registerWebviewForGranularityPanel(context);
}

export function deactivate() {
    if (DesignmentTreeDataProvider.hasInstance()) {
        DesignmentTreeDataProvider.getInstance().dispose();
    }
}
