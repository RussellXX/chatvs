/**
 * Draft overlay helpers.
 *
 * All workspace writes are staged under `<projectAbs>/.tmp/` (the draft root)
 * and promoted to the real project directory only when the user confirms.
 *
 * On Windows, VS Code normalises drive letters to lowercase, while Node keeps
 * whatever case was given.  normPath() resolves and lowercases so that all
 * path comparisons are case-insensitive without mutating stored values.
 */

import * as path from 'path';
import * as fs from 'fs';

export const DRAFT_DIR_NAME = '.tmp';

export function normPath(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function getDraftRoot(projectAbs: string): string {
    return path.join(projectAbs, DRAFT_DIR_NAME);
}

export function isDraftPath(projectAbs: string, p: string): boolean {
    const rel = path.relative(normPath(getDraftRoot(projectAbs)), normPath(p));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toDraftPath(projectAbs: string, realPath: string): string {
    const rel = path.relative(projectAbs, realPath);
    return path.join(getDraftRoot(projectAbs), rel);
}

export function toRealPath(projectAbs: string, draftPath: string): string {
    const rel = path.relative(getDraftRoot(projectAbs), draftPath);
    return path.join(projectAbs, rel);
}

/** Return the write target: mirror into `.tmp/` if it is currently a real path. */
export function toDraftForWrite(projectAbs: string, p: string): string {
    return isDraftPath(projectAbs, p) ? p : toDraftPath(projectAbs, p);
}

/** Delete the entire draft overlay directory. */
export function cleanDraft(projectAbs: string): void {
    const root = getDraftRoot(projectAbs);
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

/** Merge the draft overlay into the real project directory, then delete it. */
export function promoteDraft(projectAbs: string): void {
    const root = getDraftRoot(projectAbs);
    if (!fs.existsSync(root)) return;
    mergeDir(root, projectAbs);
    fs.rmSync(root, { recursive: true, force: true });
}

function mergeDir(src: string, dst: string): void {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            mergeDir(s, d);
        } else {
            if (fs.existsSync(d)) fs.unlinkSync(d);
            fs.renameSync(s, d);
        }
    }
}

export function readJsonSafe(filePath: string): any[] {
    if (!fs.existsSync(filePath)) return [];
    try {
        const text = fs.readFileSync(filePath, 'utf8').trim();
        return text ? JSON.parse(text) : [];
    } catch { return []; }
}

/** Read JSON: prefer draft version, fall back to real. */
export function readJsonDraftFirst(projectAbs: string, realPath: string): any[] {
    const draftPath = toDraftPath(projectAbs, realPath);
    if (fs.existsSync(draftPath)) return readJsonSafe(draftPath);
    return readJsonSafe(realPath);
}
