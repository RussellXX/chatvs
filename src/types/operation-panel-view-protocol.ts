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
}

// 后端 → 前端 消息
export interface UpdateViewPayload {
    nodes: TreeNodeData[];
    leafOrder: number[];                              // indices into nodes[]
    currentModule: number;                            // -1 = none
    refinementHistories: Record<number, RefinementEntry[]>; // key = node index
    currentRefinementEntry: number;                   // index in current module's history, -1 = none
    isBusy: boolean;
    hasCommonDS: boolean;                             // whether common_data_structures.json exists (draft or real)
}

export interface UpdateViewMessage {
    type: 'updateView';
    data: UpdateViewPayload;
}

export type WebviewOutgoingMessage = UpdateViewMessage;

// 前端 → 后端 消息

export interface WebviewReadyMessage {
    type: 'webviewReady';
}

export type WebviewCommandId =
    | 'selectModule'
    | 'divide'
    | 'refine'          // 全局精化（保持原命名以向后兼容）
    | 'localRefine'     // 局部精化（基于编辑器选区）
    | 'generateCode'
    | 'confirm'
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
