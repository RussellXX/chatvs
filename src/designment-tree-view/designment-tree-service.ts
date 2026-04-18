import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeDataProvider, ProjectNode } from './designment-tree-data-provider'

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

    dataProvider.localNodeTree.push(newProjectNode);
    dataProvider.refresh(undefined);
}
