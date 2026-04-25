import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { buildTreeFromSerializedForm, persistenceTreeNode, persistTree } from './designment-tree-persistence'
import { getTypeByClass, registerNodeType } from './node-type-registry'
import { getCodesPath } from '../settings/settings'
import { actualDSRealPath } from '../operation-panel-view/actual-ds-generator'

const CONTENT_FILENAME = 'content.txt';
const REQUIREMENT_NODE_LABEL = 'Project Requirement'

export abstract class DesignmentTreeNode {
    constructor(
        public label: string,
        public absolutePath: string,
        public parent?: ProjectNode | ModuleNode,
        public children?: (ModuleNode | RequirementNode)[]
    ) {}

    abstract isExtendable(): boolean
    abstract isLeaf(): boolean
    abstract getContentFilePath(): string

    // Get the object form of this node for serialization, which can be directly used to construct the same node.
    getObject(): persistenceTreeNode {
        const type = getTypeByClass(this.constructor);
        if (!type) {
            throw new Error(`Unknown node class: ${this.constructor.name}`);
        }
        return {
            label: this.label,
            absolutePath: this.absolutePath,
            type,
            childrenCount: this.children?.length ?? 0
        };
    }

    // Get the root node.
    getRoot(): ProjectNode {
        let iterator: DesignmentTreeNode = this;
        while (iterator.parent) {
            iterator = iterator.parent;
        }

        if (!(iterator instanceof ProjectNode)) {
            throw new Error('Unexpected error: root node not of type ProjectNode.');
        }
        return iterator
    }

    static fromObject(
        obj: persistenceTreeNode,
        parent?: ProjectNode | ModuleNode
    ): DesignmentTreeNode {
        throw new Error('DesignmentTreeNode subclass must implement static method fromObject.')
    }

    getPrefix(): string {
        throw new Error('DesignmentTreeNode subclass does not implement getPrefix method.')
    }
}

export class ProjectNode extends DesignmentTreeNode {

    public children: (ModuleNode | RequirementNode)[]

    constructor(
        label: string,
        absolutePath: string,
        children?: (ModuleNode | RequirementNode)[]
    ) {
        super(label, absolutePath);
        this.children = children ?? [];
    }

    isExtendable(): boolean {
        return true;
    }

    isLeaf(): boolean {
        return false;
    }

    getContentFilePath(): string {
        return path.join(this.absolutePath, CONTENT_FILENAME); // to be checked
    }

    static fromObject(obj: persistenceTreeNode): ProjectNode {
        const node = new ProjectNode(obj.label, obj.absolutePath);
        node.children = [];
        return node;
    }

    getPrefix(): string {
        return '';
    }
}

export class ModuleNode extends DesignmentTreeNode {
    
    public children: ModuleNode[]

    constructor(
        label: string,
        absolutePath: string,
        parent: ProjectNode | ModuleNode,
        children?: ModuleNode[]
    ) {
        super(label, absolutePath, parent)
        this.children = children || []
    }

    isExtendable(): boolean {
        return this.children.length > 0;
    }

    isLeaf(): boolean {
        return this.children.length === 0;
    }

    getContentFilePath(): string {
        return path.join(this.absolutePath, CONTENT_FILENAME); // to be checked
    }

    static fromObject(
        obj: persistenceTreeNode,
        parent: ProjectNode | ModuleNode
    ): ModuleNode {
        return new ModuleNode(obj.label, obj.absolutePath, parent);
    }

    getPrefix(): string {
        if (this.parent instanceof ProjectNode) return this.label;
        return this.parent!.getPrefix() + '.' + this.label;
    }
}

export class RequirementNode extends DesignmentTreeNode {
    constructor(
        parent: ProjectNode
    ) {
        const absolutePath: string = path.join(parent.absolutePath, CONTENT_FILENAME);
        super(REQUIREMENT_NODE_LABEL, absolutePath, parent);
    }

    isExtendable(): boolean {
        return false;
    }

    isLeaf(): boolean {
        return true;
    }

    getContentFilePath(): string {
        return this.absolutePath;
    }

    static fromObject(
        obj: persistenceTreeNode,
        parent: ProjectNode
    ): RequirementNode {
        return new RequirementNode(parent);
    }
}

/**
 * Virtual node representing the language-specific data structure source file
 * (e.g. data_structures.py) under the project's codes directory.
 * Dynamically injected by getChildren(); never persisted.
 */
export class ActualDataStructureNode extends DesignmentTreeNode {
    private readonly filePath: string;

    constructor(parent: ProjectNode, filePath: string) {
        super('Actual Data Structure', parent.absolutePath, parent);
        this.filePath = filePath;
    }

    isExtendable(): boolean { return false; }
    isLeaf(): boolean { return true; }
    getContentFilePath(): string { return this.filePath; }

    getObject(): persistenceTreeNode {
        throw new Error('ActualDataStructureNode is virtual and must not be persisted.');
    }

    static fromObject(_obj: persistenceTreeNode, _parent: ProjectNode): ActualDataStructureNode {
        throw new Error('ActualDataStructureNode cannot be reconstructed from serialized form.');
    }
}

/**
 * Virtual node representing common_data_structures.json under a project.
 * It is dynamically injected by getChildren() and is never persisted to disk.
 */
export class CommonDataStructureNode extends DesignmentTreeNode {
    constructor(parent: ProjectNode) {
        super('Common Data Structure', parent.absolutePath, parent);
    }

    isExtendable(): boolean { return false; }
    isLeaf(): boolean { return true; }

    getContentFilePath(): string {
        return path.join(this.absolutePath, 'common_data_structures.json');
    }

    getObject(): persistenceTreeNode {
        throw new Error('CommonDataStructureNode is virtual and must not be persisted.');
    }

    static fromObject(_obj: persistenceTreeNode, parent: ProjectNode): CommonDataStructureNode {
        return new CommonDataStructureNode(parent);
    }
}

// Use singleton pattern for global unique instance.
export class DesignmentTreeDataProvider implements vscode.TreeDataProvider<DesignmentTreeNode> {

    private static instance: DesignmentTreeDataProvider | null = null

    private constructor() {
        this.localNodeTree = buildTreeFromSerializedForm()
    }

    static getInstance(): DesignmentTreeDataProvider {
        if (!this.instance) {
            this.instance = new DesignmentTreeDataProvider()
        }   
        return this.instance
    }

    static hasInstance(): boolean {
        return this.instance !== null
    }

    // Below are normal TreeDataProvider implementations.

    private _onDidChangeTreeData = new vscode.EventEmitter<DesignmentTreeNode | DesignmentTreeNode[] | undefined | null>()
    public onDidChangeTreeData = this._onDidChangeTreeData.event

    // The actual tree structure data stored in memory.
    public localNodeTree: DesignmentTreeNode[] = []

    getTreeItem(element: DesignmentTreeNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(element.label, this.getCollapsibleState(element))
        treeItem.iconPath = this.getIconPath(element)
        if (element instanceof ProjectNode) {
            treeItem.contextValue = 'projectNode';
        }
        if (element instanceof CommonDataStructureNode || element instanceof ActualDataStructureNode) {
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(element.getContentFilePath())]
            };
        }
        return treeItem
    }

    private getCollapsibleState(element: DesignmentTreeNode): vscode.TreeItemCollapsibleState {
        return element.isExtendable() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    }

    private getIconPath(element: DesignmentTreeNode): vscode.ThemeIcon | vscode.Uri {
        if (element instanceof ProjectNode) return new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.white'));
        if (element instanceof ModuleNode) {
            const iconName = element.isLeaf() ? 'circle' : 'type-hierarchy';
            return new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.blue'));
        }
        if (element instanceof RequirementNode) return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.yellow'));
        if (element instanceof CommonDataStructureNode) return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.orange'));
        if (element instanceof ActualDataStructureNode) return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.red'));
        throw new Error('Unexpected node type for icon path retrieval.');
    }


    getChildren(element?: DesignmentTreeNode): Thenable<DesignmentTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.localNodeTree);
        }

        if (element instanceof ProjectNode) {
            const children: DesignmentTreeNode[] = [...(element.children ?? [])];

            const commonDSPath = path.join(element.absolutePath, 'common_data_structures.json');
            const hasCommonDS = fs.existsSync(commonDSPath);
            if (hasCommonDS) {
                children.unshift(new CommonDataStructureNode(element));
            }

            // Inject actual data structure node right after CommonDS (index 1 when
            // CommonDS is present, otherwise index 0) so it appears near the top.
            try {
                const projectName = path.basename(element.absolutePath);
                const realCodeDir = path.join(getCodesPath(), projectName);
                const dsPath = actualDSRealPath(realCodeDir, 'python');
                if (fs.existsSync(dsPath)) {
                    const insertAt = hasCommonDS ? 1 : 0;
                    children.splice(insertAt, 0, new ActualDataStructureNode(element, dsPath));
                }
            } catch { /* settings not configured; skip silently */ }

            return Promise.resolve(children);
        }

        return Promise.resolve(element.children ?? []);
    }


    // Given the absolute path of project, then return the corresponding project node.
    getProjectNodeByAbsolutePath(absolutePath: string): ProjectNode | undefined {
        return this.localNodeTree.find(node => 
            node instanceof ProjectNode && 
            path.resolve(node.absolutePath) === path.resolve(absolutePath)
        ) as ProjectNode | undefined
    }

    // Update the view after changing node data.
    refresh(fileNode: DesignmentTreeNode | DesignmentTreeNode[] | undefined | null): void {
        this._onDidChangeTreeData.fire(fileNode)
        persistTree(this.localNodeTree)
    }

    
    // Invoked when the extension is activated
    dispose() {
        persistTree(this.localNodeTree)
    }
}

registerNodeType(ProjectNode, 'Project');
registerNodeType(ModuleNode, 'Module');
registerNodeType(RequirementNode, 'Requirement');
