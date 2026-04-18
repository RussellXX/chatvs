import {
    DesignmentTreeNode,
    ProjectNode,
    ModuleNode
} from './designment-tree-data-provider';
import { persistenceTreeNode } from './designment-tree-persistence';

type NodeTypeString = persistenceTreeNode['type'];
export interface NodeClass {
    fromObject(
        obj: persistenceTreeNode,
        parent?: ProjectNode | ModuleNode
    ): DesignmentTreeNode;
}

const CLASS_TO_TYPE = new Map<Function, NodeTypeString>();
const TYPE_TO_CLASS = new Map<NodeTypeString, NodeClass>();

export function registerNodeType(cls: NodeClass & Function, type: NodeTypeString): void {
    CLASS_TO_TYPE.set(cls, type);
    TYPE_TO_CLASS.set(type, cls);
}

/** 根据类构造函数查询对应的类型字符串 */
export function getTypeByClass(ctor: Function): NodeTypeString | undefined {
    return CLASS_TO_TYPE.get(ctor);
}

/** 根据类型字符串查询对应的类构造函数 */
export function getClassByType(type: NodeTypeString): NodeClass | undefined {
    return TYPE_TO_CLASS.get(type);
}