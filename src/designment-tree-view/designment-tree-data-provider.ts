import * as vscode from 'vscode'
import * as path from 'path'
import { buildTreeFromSerializedForm, persistenceTreeNode, persistTree } from './designment-tree-persistence'
import { getTypeByClass, registerNodeType } from './node-type-registry'

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
        throw new Error('DesignmentTreeNode subclass must implement static fromObject.')
    }
}

export class ProjectNode extends DesignmentTreeNode {

    public children: (ModuleNode | RequirementNode)[] = []

    constructor(
        label: string,
        absolutePath: string,
    ) {
        super(label, absolutePath)
        this.children.push(
            new RequirementNode(absolutePath, this)
        )
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
}

export class RequirementNode extends DesignmentTreeNode {
    constructor(
        absolutePath: string,
        parent: ProjectNode
    ) {
        super(REQUIREMENT_NODE_LABEL, absolutePath, parent)
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
        return new RequirementNode(obj.absolutePath, parent);
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
        // treeItem.contextValue = this.getContextValue(element)
        treeItem.iconPath = this.getIconPath(element)
        return treeItem
    }

    private getCollapsibleState(element: DesignmentTreeNode): vscode.TreeItemCollapsibleState {
        return element.isExtendable() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    }

    private getIconPath(element: DesignmentTreeNode): vscode.ThemeIcon | vscode.Uri {

        if (element instanceof ProjectNode) return new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.white'));
        else if (element instanceof ModuleNode) {
            const iconName = element.isLeaf() ? 'circle' : 'type-hierarchy';
            return new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.blue'));
        }
        else if (element instanceof RequirementNode) return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.yellow'));
        else {
            // No other types
            throw new Error('Unexpected node type for icon path retrieval.')
        }
    }


    getChildren(element?: DesignmentTreeNode): Thenable<DesignmentTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.localNodeTree)
        }

        return Promise.resolve(
            element.children ?? []
        )
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
