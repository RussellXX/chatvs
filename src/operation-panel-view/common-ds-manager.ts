/**
 * Manages the lifecycle of `common_data_structures.json`.
 * In the new design, all writes go directly to the real project directory —
 * no draft overlay is used for common DS.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as openaiHelper from '../openai/openai-helper';

const COMMON_DS_FILENAME = 'common_data_structures.json';

export class CommonDSManager {
    /** When true, exists() returns false even if the file is on disk. */
    private _suppress = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Call on loadProject() to start fresh. */
    reset(): void {
        this._suppress = false;
    }

    /**
     * True if common DS is available and not suppressed.
     * Suppression is lifted only by generate() or reset().
     */
    exists(projectAbs: string): boolean {
        if (this._suppress) return false;
        return fs.existsSync(this._realPath(projectAbs));
    }

    /**
     * Returns the real path to common_data_structures.json.
     */
    draftFirstPath(projectAbs: string): string {
        return this._realPath(projectAbs);
    }

    /**
     * Generate common_data_structures.json from the LLM and write it directly
     * to the real project directory.
     */
    async generate(projectAbs: string, ongoingPath: string): Promise<void> {
        const requirementsPath = path.join(projectAbs, 'content.txt');
        const prompt = await openaiHelper.getCommonDSPrompt(
            ongoingPath, requirementsPath, this.context
        );
        const raw = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const realPath = this._realPath(projectAbs);
        fs.mkdirSync(path.dirname(realPath), { recursive: true });
        fs.writeFileSync(realPath, cleaned, 'utf8');
        this._suppress = false;
    }

    /**
     * Delete the real common DS file and suppress display for this session.
     * Called when saving the design tree with a changed structure clears all history.
     */
    clearReal(projectAbs: string): void {
        const realPath = this._realPath(projectAbs);
        if (fs.existsSync(realPath)) {
            try { fs.unlinkSync(realPath); } catch (_) {}
        }
        this._suppress = true;
    }

    /** No-op kept for compatibility; no longer needed in the new design. */
    cleanupOnConfirm(_projectAbs: string): void {}

    private _realPath(projectAbs: string): string {
        return path.join(projectAbs, COMMON_DS_FILENAME);
    }
}
