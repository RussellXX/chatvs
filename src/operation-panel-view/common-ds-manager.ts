/**
 * Manages the lifecycle of `common_data_structures.json` within the draft-first
 * pattern.  All writes target the `.tmp/` overlay; the real file is only touched
 * when WorkspaceManager.confirm() calls promoteDraft().
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as openaiHelper from '../openai/openai-helper';
import { toDraftPath } from './draft-overlay';

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
     * True if common DS is available for use (draft-first) and not suppressed.
     * Suppression is lifted only by generate() or reset().
     */
    exists(projectAbs: string): boolean {
        if (this._suppress) return false;
        const draft = toDraftPath(projectAbs, this._realPath(projectAbs));
        return fs.existsSync(draft) || fs.existsSync(this._realPath(projectAbs));
    }

    /**
     * Returns draft path when the draft exists, otherwise returns real path.
     * Use this for read operations inside refine / localRefine.
     */
    draftFirstPath(projectAbs: string): string {
        const real = this._realPath(projectAbs);
        const draft = toDraftPath(projectAbs, real);
        return fs.existsSync(draft) ? draft : real;
    }

    /**
     * Generate common_data_structures.json from the LLM and write it to the
     * draft overlay.  ongoingPath should already be draft-first resolved.
     */
    async generate(projectAbs: string, ongoingPath: string): Promise<void> {
        const requirementsPath = path.join(projectAbs, 'content.txt');
        const prompt = await openaiHelper.getCommonDSPrompt(
            ongoingPath, requirementsPath, this.context
        );
        const raw = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const draftPath = toDraftPath(projectAbs, this._realPath(projectAbs));
        fs.mkdirSync(path.dirname(draftPath), { recursive: true });
        fs.writeFileSync(draftPath, cleaned, 'utf8');
        this._suppress = false;
    }

    /**
     * Remove the draft file and suppress display for this session.
     * Called when divide-after-refinement resets the workspace.
     * The real file (if any) is intentionally left untouched until confirm().
     */
    clearDraft(projectAbs: string): void {
        const draftPath = toDraftPath(projectAbs, this._realPath(projectAbs));
        if (fs.existsSync(draftPath)) {
            try { fs.unlinkSync(draftPath); } catch (_) {}
        }
        this._suppress = true;
    }

    /**
     * Called from WorkspaceManager.confirm() after promoteDraft().
     * If the common DS was suppressed this session, delete the real file so the
     * left-sidebar node disappears and the next refinement regenerates it fresh.
     */
    cleanupOnConfirm(projectAbs: string): void {
        if (!this._suppress) return;
        const realPath = this._realPath(projectAbs);
        if (fs.existsSync(realPath)) {
            try { fs.unlinkSync(realPath); } catch (_) {}
        }
    }

    private _realPath(projectAbs: string): string {
        return path.join(projectAbs, COMMON_DS_FILENAME);
    }
}
