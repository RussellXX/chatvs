import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeNode, ProjectNode, ModuleNode } from './designment-tree-data-provider'
import { getClassByType } from './node-type-registry'

export interface persistenceTreeNode {
    label: string
    absolutePath: string
    type: string
    // When parsing the object tree, we only need to know if it has children or not.
    childrenCount: number
}

function getPersistentFilePath(): string {
    return path.join(settings.getPseudoPath(), 'persisted_tree.json');
}


export function buildTreeFromSerializedForm(): DesignmentTreeNode[] {
    const filePath = getPersistentFilePath();

    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf-8').trim();
        const treeSequences: persistenceTreeNode[][] = JSON.parse(raw);
        const tree = treeSequences.map(seq => deserializeTree(seq));
        return tree;
    } catch (err) {
        throw new Error('Failed to deserialize persistent tree.');
    }
}


// Recursive function to parse a project tree.
function deserializeTree(
    treeSequence: persistenceTreeNode[]
): ProjectNode {
    let cursor = 0;

    function walk(parent?: ProjectNode | ModuleNode): DesignmentTreeNode {
        const obj = treeSequence[cursor++];
        const cls = getClassByType(obj.type);
        if (!cls) {
            throw new Error(`Unknown node type encountered while parsing persistent tree: ${obj.type}`);
        }
        const node = cls.fromObject(obj, parent);

        // Handle subtree recursively.
        if (obj.childrenCount > 0) {
            const children: DesignmentTreeNode[] = [];
            for (let i = 0; i < obj.childrenCount; ++i) {
                children.push(walk(node as ProjectNode | ModuleNode));
            }
            (node as ProjectNode | ModuleNode).children = children;
        }

        return node;
    }

    const root: DesignmentTreeNode = walk();
    if (!(root instanceof ProjectNode)) {
        throw new Error('Unexpected error: project root node is not of type ProjectNode.');
    }

    return root;
}


export async function persistTree(
    designmentTree: DesignmentTreeNode[]
): Promise<void> {
    const projects: persistenceTreeNode[][] = [];
    designmentTree.forEach(project => {
        if (project instanceof ProjectNode) {
            const projectObjectSequence: persistenceTreeNode[] = [];
            preOrderTraverseProject(project, projectObjectSequence);
            projects.push(projectObjectSequence);
        } else {
            throw Error('Unexpected error: root node of a designment tree is not a project directory node');
        }
    })

    const filePath = getPersistentFilePath();
    fs.writeFileSync(filePath, JSON.stringify(projects, null, 2));
}

// Recursive function for serializing a project tree.
function preOrderTraverseProject(
    root: DesignmentTreeNode,
    sequence: persistenceTreeNode[]
): void {
    sequence.push(root.getObject());
    root.children?.forEach(child => {
        preOrderTraverseProject(child, sequence);
    })
}
