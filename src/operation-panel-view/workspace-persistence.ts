import * as fs from 'fs';
import * as path from 'path';
import { RefinementEntry } from '../types/operation-panel-view-protocol';

const HISTORY_FILENAME = 'refinement_history.json';

export function loadRefinementHistory(modulePath: string): RefinementEntry[] | null {
    const jsonPath = path.join(modulePath, HISTORY_FILENAME);
    if (!fs.existsSync(jsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as RefinementEntry[];
    } catch {
        return null;
    }
}

export function saveRefinementHistory(modulePath: string, history: RefinementEntry[]): void {
    const jsonPath = path.join(modulePath, HISTORY_FILENAME);
    fs.writeFileSync(jsonPath, JSON.stringify(history, null, 2), 'utf8');
}
