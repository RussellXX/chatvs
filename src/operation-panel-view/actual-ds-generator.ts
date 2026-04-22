/**
 * Generates the language-specific data structure file (e.g. data_structures.py)
 * from common_data_structures.json, within the draft overlay.
 *
 * The file is written to the code staging directory and promoted to the real
 * codes directory when the user confirms (same lifecycle as module code files).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as openaiHelper from '../openai/openai-helper';
import { getSrcFileSuffix } from '../tools/lang-util';

const DS_BASE_NAME = 'data_structures';

/** Absolute path to the staged data structure source file. */
export function actualDSStagingPath(stagingRoot: string, language: string): string {
    const suffix = getSrcFileSuffix(language) ?? '.py';
    return path.join(stagingRoot, `${DS_BASE_NAME}${suffix}`);
}

/** Absolute path to the promoted (real) data structure source file. */
export function actualDSRealPath(realCodeDir: string, language: string): string {
    const suffix = getSrcFileSuffix(language) ?? '.py';
    return path.join(realCodeDir, `${DS_BASE_NAME}${suffix}`);
}

/**
 * Generate the language-specific data structure file into the code staging
 * directory.  The file content is derived from the common DS JSON via LLM.
 */
export async function generateActualDS(
    stagingRoot: string,
    commonDSContent: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const prompt = await openaiHelper.getActualDataStructurePrompt(commonDSContent, language, context);
    const raw = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
    const cleaned = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```\n?/g, '').trim();

    const filePath = actualDSStagingPath(stagingRoot, language);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, cleaned, 'utf8');
}
