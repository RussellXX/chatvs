
// rawList 的条目形如 { name, dependencies[], description, path } —— 由 ModuleSchema 写入
// `ongoing_leaf_modules.json`。索引键与递归入口都使用 `name`。
export function topoSortLeafModules(rawList: any[]): any[] {
    const nodeMap = new Map<string, any>();
    for (const item of rawList) {
        nodeMap.set(item.name, item);
    }

    const result: any[] = [];
    const state = new Map<string, 'visiting' | 'visited'>();

    function dfs(moduleName: string) {
        const st = state.get(moduleName);
        if (st === 'visiting') {
            throw new Error(`Topological sort failed: cycle detected involving module: ${moduleName}`);
        }
        if (st === 'visited') return;

        const node = nodeMap.get(moduleName);
        if (!node) {
            // 依赖可能指向非叶子模块（即已被继续拆分的父模块）——
            // 这些不在 rawList 里，按"无需排序的外部依赖"忽略即可。
            return;
        }

        state.set(moduleName, 'visiting');
        for (const dep of node.dependencies ?? []) {
            dfs(dep);
        }
        state.set(moduleName, 'visited');
        result.push(node);
    }

    for (const item of rawList) {
        dfs(item.name);
    }

    return result;
}
