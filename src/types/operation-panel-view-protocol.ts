export type NodeType = 'root' | 'leaf' | 'non-leaf';

export interface TreeNodeData {
    nodeType: NodeType;
    title: string;
    desc: string;
    childCount: number;
}

export interface RefinementEntry {
    label: string;      // "模块规约" | "粒度1" | "粒度2" | ... | "实际代码"
    filePath: string;   // absolute path — opened in editor on click
    type: 'spec' | 'pseudo' | 'code';
    active?: boolean;
    highlightRange?: [number, number][];
}

export type ModuleProgressStatus = 'pending' | 'inProgress' | 'completed';

// 后端 → 前端 消息
export interface UpdateViewPayload {
    nodes: TreeNodeData[];
    leafOrder: number[];                              // indices into nodes[]
    currentModule: number;                            // -1 = none
    refinementHistories: Record<number, RefinementEntry[]>; // key = node index
    currentRefinementEntry: number;                   // index in current module's history, -1 = none
    moduleStatuses: Record<number, ModuleProgressStatus>;
    isBusy: boolean;
    hasCommonDS: boolean;                             // whether common_data_structures.json exists (draft or real)
    hasActualDS: boolean;                             // whether data_structures.py exists in the real codes dir
}

export interface UpdateViewMessage {
    type: 'updateView';
    data: UpdateViewPayload;
}

export interface ShowAddNodeDialogMessage {
    type: 'showAddNodeDialog';
    data: {
        nodeIndex: number;
        parentName: string;
        availableModules: string[];
    };
}

export type WebviewOutgoingMessage = UpdateViewMessage | ShowAddNodeDialogMessage;

// 前端 → 后端 消息

export interface WebviewReadyMessage {
    type: 'webviewReady';
}

export type WebviewCommandId =
    | 'selectModule'
    | 'selectDesignTreeModule'
    | 'divide'
    | 'deleteNode'
    | 'addChildNode'
    | 'confirmAddChildNode'
    | 'save'
    | 'refine'
    | 'localRefine'
    | 'generateCode'
    | 'rollbackRefinement'
    | 'selectRefinement'
    | 'showDesignTree'
    | 'openCommonDS';

/**
 * Payload for divide / refine / generateCode commands.
 * customPrompt (optional) is appended to the LLM user prompt when non-empty.
 */
export interface ModuleActionPayload {
    index: number;
    customPrompt?: string;
}

export interface ExecuteCommandMessage {
    type: 'executeCommand';
    commandId: WebviewCommandId;
    payload?: unknown;
}

export type WebviewIncomingMessage = WebviewReadyMessage | ExecuteCommandMessage;
