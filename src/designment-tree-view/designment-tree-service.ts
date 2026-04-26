import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeDataProvider, ProjectNode, RequirementNode } from './designment-tree-data-provider'
import { WorkspaceManager } from '../operation-panel-view/workspace-manager'

export async function createProject(label: string) {

    // 确保项目结构存在（codes 和 pseudocodes 文件夹）
    const structureReady = await settings.ensureProjectStructure();
    if (!structureReady) {
        return; // 用户取消了创建
    }

    const dataProvider = DesignmentTreeDataProvider.getInstance();
    if (dataProvider.localNodeTree.find(child => child.label === label)) {
        vscode.window.showErrorMessage(`已存在同名项目 ${label}，请更换项目名称。`);
        return;
    }

    const absolutePath = path.join(settings.getPseudoPath(), label);
    const filePath = path.join(absolutePath, 'content.txt');

    try {
        fs.mkdirSync(absolutePath, { recursive: true });
        fs.writeFileSync(filePath, 'Empty content.', 'utf8');

    } catch (error) {
        vscode.window.showErrorMessage(`创建项目失败: ${error}`);
        throw error;
    }

    const newProjectNode = new ProjectNode(label, absolutePath);
    const requirementNode = new RequirementNode(newProjectNode);
    newProjectNode.children.push(requirementNode);

    dataProvider.localNodeTree.push(newProjectNode);
    dataProvider.refresh(undefined);
}

export async function deleteProject(node: ProjectNode): Promise<void> {
    const dataProvider = DesignmentTreeDataProvider.getInstance();

    // If this project is currently loaded in the workspace, clear it first.
    WorkspaceManager.clearIfLoaded(node.absolutePath);

    // Delete the pseudocodes project directory.
    if (fs.existsSync(node.absolutePath)) {
        fs.rmSync(node.absolutePath, { recursive: true, force: true });
    }

    // Also delete the corresponding codes directory if it exists.
    try {
        const projectName = path.basename(node.absolutePath);
        const codesDir = path.join(settings.getCodesPath(), projectName);
        if (fs.existsSync(codesDir)) {
            fs.rmSync(codesDir, { recursive: true, force: true });
        }
    } catch { /* codes dir may not exist or settings not configured */ }

    // Remove from the in-memory tree and persist.
    const idx = dataProvider.localNodeTree.indexOf(node);
    if (idx >= 0) dataProvider.localNodeTree.splice(idx, 1);
    dataProvider.refresh(undefined);
}
