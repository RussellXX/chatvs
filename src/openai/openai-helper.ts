import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import { validateWithSchema } from './schemas';
import { getAzureOpenAIConfig, getPseudoPath, getCodesPath } from '../settings/settings';

dotenv.config();

let openaiClient: AzureOpenAI | undefined;

/**
 * 初始化 Azure OpenAI 客户端
 */
async function initializeOpenAI(): Promise<AzureOpenAI> {
    if (!openaiClient) {
        const { endpoint, apiKey } = await getAzureOpenAIConfig();

        openaiClient = new AzureOpenAI({
            endpoint,
            apiKey,
            apiVersion: '2024-02-01'
        });
    }
    return openaiClient;
}

/**
 * 调用 OpenAI 生成结构化输出（JSON 格式），支持 Schema 验证和自动重试
 * @param systemPrompt 系统提示词
 * @param userPrompt 用户提示词
 * @param schema 可选的 Zod schema，用于验证返回的 JSON
 * @param maxRetries 最大重试次数，默认 3 次
 * @returns 生成的文本内容
 */
export async function callOpenAIForJSON<T = any>(
    systemPrompt: string,
    userPrompt: string,
    schema?: z.ZodSchema<T>,
    maxRetries: number = 3,
    maxTokens: number = -1
): Promise<string> {
    let lastError: any = null;
    let modifiedUserPrompt = userPrompt;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const client = await initializeOpenAI();
            let response;
            if (maxTokens < 0) {
                response = await client.chat.completions.create({
                    model: 'gpt-4',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: modifiedUserPrompt
                        }
                    ],
                    temperature: 0.1,
                    max_tokens: 1024 * 16
                });
            }
            else{
                response = await client.chat.completions.create({
                    model: 'gpt-4',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: modifiedUserPrompt
                        }
                    ],
                    temperature: 0.1,
                    max_tokens: maxTokens
                });
                

            }

            const content = response.choices[0]?.message?.content || '';

            // 如果没有提供 schema，直接返回
            if (!schema) {
                return content;
            }

            // 清理 JSON，移除可能的 markdown 标记
            const cleanJson = content.replace(/```json/g, '').replace(/```/g, '').trim();

            // 尝试解析 JSON
            let parsedData: any;
            try {
                parsedData = JSON.parse(cleanJson);
            } catch (parseError) {
                console.error(`[callOpenAIForJSON] JSON 解析失败 (第 ${attempt + 1} 次尝试):`, parseError);
                lastError = new Error(`JSON 解析失败: ${parseError}`);

                // 如果不是最后一次尝试，继续重试
                if (attempt < maxRetries - 1) {
                    console.log(`[callOpenAIForJSON] 将在下次尝试中要求 LLM 返回有效的 JSON`);
                    // 更新 userPrompt 以强调返回有效 JSON
                    modifiedUserPrompt += `\n\n注意：上一次返回的内容不是有效的 JSON 格式。请确保返回严格符合 JSON 标准的内容，不要包含任何额外的文本或格式标记。`;
                    continue;
                }
                throw lastError;
            }

            // 使用 schema 验证
            const validationResult = validateWithSchema(schema, parsedData);

            if (validationResult.success) {
                console.log(`[callOpenAIForJSON] Schema 验证通过 (第 ${attempt + 1} 次尝试)`);
                return content;
            } else {
                console.error(`[callOpenAIForJSON] Schema 验证失败 (第 ${attempt + 1} 次尝试):`, validationResult.errors);
                lastError = new Error(`Schema 验证失败: ${validationResult.errors.join('; ')}`);

                // 如果不是最后一次尝试，继续重试并提供错误信息
                if (attempt < maxRetries - 1) {
                    console.log(`[callOpenAIForJSON] 将在下次尝试中修正验证错误`);
                    // 更新 userPrompt 以包含验证错误信息
                    modifiedUserPrompt += `\n\n注意：上一次返回的 JSON 不符合要求。验证错误：${validationResult.errors.join('; ')}。请修正这些问题并重新生成。`;
                    continue;
                }
                throw lastError;
            }
        } catch (error) {
            lastError = error;
            console.error(`[callOpenAIForJSON] 调用失败 (第 ${attempt + 1} 次尝试):`, error);

            // 如果是最后一次尝试或者是 API 错误（非验证错误），直接抛出
            if (attempt === maxRetries - 1 || (error instanceof Error && error.message.includes('API'))) {
                vscode.window.showErrorMessage(`OpenAI API 调用失败: ${error}`);
                throw error;
            }
        }
    }

    // 理论上不会到这里，但为了类型安全
    throw lastError || new Error('未知错误');
}

/**
 * 获取依赖模块的代码内容
 * @param currentModulePath 当前模块路径
 * @param codeType 'pseudocode' 返回伪代码，'actual' 返回实际代码
 */
async function getDependencyModulesCode(currentModulePath: string, codeType: 'pseudocode' | 'actual' = 'pseudocode'): Promise<string> {
    try {
        const aiPath = getPseudoPath();

        // 使用 path.relative 和 path.dirname 来安全地获取项目根路径
        // currentModulePath 是模块目录，需要向上找到项目根目录
        let projectRootPath = currentModulePath;

        // 向上查找，直到找到包含 leaf_modules.json 的目录
        let foundLeafModules = false;
        let searchDepth = 0;
        const maxSearchDepth = 10; // 防止无限循环

        while (searchDepth < maxSearchDepth) {
            const testPath = path.join(projectRootPath, 'leaf_modules.json');
            if (fs.existsSync(testPath)) {
                foundLeafModules = true;
                break;
            }

            const parentPath = path.dirname(projectRootPath);
            if (parentPath === projectRootPath) {
                // 已经到达根目录
                break;
            }

            projectRootPath = parentPath;
            searchDepth++;
        }

        if (!foundLeafModules) {
            console.log('[getDependencyModulesCode] 未找到leaf_modules.json文件，从', currentModulePath, '向上搜索');
            return '';
        }

        const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json');

        // 读取leaf_modules.json
        const leafModulesContent = fs.readFileSync(leafModulesPath, 'utf-8');
        const leafModules = JSON.parse(leafModulesContent);

        // 获取当前模块名称 - 使用相对路径
        const relativePath = path.relative(aiPath, currentModulePath);

        // 找到当前模块 - 使用 path 字段匹配（统一为当前操作系统的路径分隔符）
        const currentModule = leafModules.find((mod: any) => {
            // 将 mod.path 标准化为当前操作系统的路径分隔符
            const modPath = mod.path ? mod.path.replace(/[\/\\]/g, path.sep) : '';
            return modPath === relativePath;
        });
        if (!currentModule || !currentModule.dependencies || currentModule.dependencies.length === 0) {
            console.log('[getDependencyModulesCode] 当前模块没有依赖或找不到模块，路径:', relativePath);
            return '';
        }

        console.log('[getDependencyModulesCode] 找到', currentModule.dependencies.length, '个依赖模块');

        // 获取项目名称（用于构建路径）
        const projectName = relativePath.split(path.sep)[0];

        // 读取所有依赖模块的代码
        let dependenciesCode = '';
        for (const depModuleName of currentModule.dependencies) {
            if (codeType === 'actual') {
                // 实际代码存放在 codes 目录下
                const codesPath = getCodesPath();

                // 从 leaf_modules.json 中查找依赖模块的 path 字段
                const depModule = leafModules.find((mod: any) => mod.module_name === depModuleName);
                if (!depModule || !depModule.path) {
                    console.log(`[getDependencyModulesCode] 未找到依赖模块的 path 信息:`, depModuleName);
                    continue;
                }

                // path 字段已包含项目名，如 "sleep/CLIDriver"，直接使用
                const depCodePath = path.join(codesPath, depModule.path);

                // 尝试匹配各种语言的文件扩展名
                const extensions = ['.py', '.java', '.c', '.cpp', '.js', '.ts'];
                let foundFile = false;

                for (const ext of extensions) {
                    const depFilePath = depCodePath + ext;
                    if (fs.existsSync(depFilePath)) {
                        const depCode = fs.readFileSync(depFilePath, 'utf-8');
                        // 使用 modulename 作为显示名称（传给大模型）
                        dependenciesCode += `\n\n=== 依赖模块: ${depModuleName} ===\n${depCode}\n`;
                        console.log(`[getDependencyModulesCode] 成功读取依赖模块的实际代码:`, depModuleName, '文件:', path.basename(depFilePath));
                        foundFile = true;
                        break;
                    }
                }

                if (!foundFile) {
                    console.log(`[getDependencyModulesCode] 未找到依赖模块的实际代码文件:`, depModuleName, '搜索路径:', depCodePath);
                }
            } else {
                // 伪代码从 .ai 目录的 node.json 查找
                // 从 leaf_modules.json 中查找依赖模块的 path 字段
                const depModule = leafModules.find((mod: any) => mod.module_name === depModuleName);
                if (!depModule || !depModule.path) {
                    console.log(`[getDependencyModulesCode] 未找到依赖模块的 path 信息:`, depModuleName);
                    continue;
                }

                // path 字段已包含项目名，如 "sleep/CLIDriver"，直接使用
                const depModulePath = path.join(aiPath, depModule.path);
                const depNodeJsonPath = path.join(depModulePath, 'node.json');

                if (fs.existsSync(depNodeJsonPath)) {
                    const nodeData = JSON.parse(fs.readFileSync(depNodeJsonPath, 'utf-8'));

                    let targetNode = null;

                    // 查找最后一版伪代码：从后往前找第一个不是 generated_ 开头的文件
                    for (let i = nodeData.length - 1; i >= 0; i--) {
                        const node = nodeData[i];
                        if (node.filePath) {
                            const fileName = path.basename(node.filePath);
                            if (!fileName.startsWith('generated_')) {
                                targetNode = node;
                                break;
                            }
                        }
                    }

                    if (targetNode && targetNode.filePath && fs.existsSync(targetNode.filePath)) {
                        const depCode = fs.readFileSync(targetNode.filePath, 'utf-8');
                        // 使用 modulename 作为显示名称（传给大模型）
                        dependenciesCode += `\n\n=== 依赖模块: ${depModuleName} ===\n${depCode}\n`;
                        console.log(`[getDependencyModulesCode] 成功读取依赖模块的伪代码:`, depModuleName, '文件:', path.basename(targetNode.filePath));
                    } else {
                        console.log(`[getDependencyModulesCode] 未找到依赖模块的伪代码节点:`, depModuleName);
                    }
                } else {
                    console.log('[getDependencyModulesCode] 未找到依赖模块的node.json:', depNodeJsonPath);
                }
            }
        }

        return dependenciesCode;
    } catch (error) {
        console.error('[getDependencyModulesCode] 获取依赖模块代码失败:', error);
        return '';
    }
}

/**
 * JSON转伪代码提示词 - 将JSON设计文档转换为伪代码（粒度0专用）
 * @param fileContent JSON设计文档内容
 * @param currentModulePath 当前模块路径
 * @param commonDSPath 通用数据结构路径
 */
export async function getJson2PsePrompt(fileContent: string, currentModulePath?: string, commonDSPath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getJson2PsePrompt] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('读取通用数据结构失败:', error);
        }
    }

    // 获取扩展根路径 - 使用__dirname向上查找
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const json2psePromptPath = path.join(extensionPath, 'resources', 'prompts', 'json2pse_v5.md');

    const projectName = currentModulePath ? path.basename(path.dirname(currentModulePath)) : '';

    // 临时措施，从 fileContent和commonDSContent 中移除所有项目名前缀
    if (projectName) {
        const regex = new RegExp(`"${projectName}\\.`, "g");
        fileContent = fileContent.replace(regex, '"');
        commonDSContent = commonDSContent.replace(regex, '"');
    }

    let userPrompt = `请根据以下JSON设计文档生成详细的伪代码：\n\n${fileContent}\n\n`;

    if (commonDSContent) {
        userPrompt += `通用数据结构定义（JSON 格式）：\n${commonDSContent}\n\n`;
    }

    if (dependenciesCode) {
        userPrompt += `以下是该模块依赖的上游模块的伪代码实现，在生成目标模块伪代码时请参考这些依赖模块的函数签名和接口：${dependenciesCode}\n\n`;
    }

    userPrompt += `请直接返回伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    if (!fs.existsSync(json2psePromptPath)) {
        console.error('找不到json2pse_v5.md文件:', json2psePromptPath);
        // 回退到简单的系统提示
        return {
            system: `你是一个资深的软件架构师和算法工程师。你的任务是将JSON格式的模块设计文档转换为高质量、结构清晰的伪代码。

请遵循以下规则：
1. **完整性**：生成的伪代码必须严格包含JSON设计文档中的所有信息。
2. **逻辑转换**：将自然语言逻辑步骤准确转换为算法步骤。
3. **错误处理**：设计文档中提到的错误处理必须显式体现在伪代码中。
4. **依赖一致性**：在调用依赖模块时，必须参考提供的上游依赖模块的实际函数签名。

重要：请直接返回生成的完整伪代码内容，不要使用markdown代码块标记，只返回纯文本的伪代码。`,
            user: userPrompt
        };
    }
    const json2psePrompt = fs.readFileSync(json2psePromptPath, 'utf-8');

    return {
        system: json2psePrompt,
        user: userPrompt
    };
}

/**
 * 全局精化提示词 - 对伪代码的全局优化（粒度>0专用）
 * @param fileContent 伪代码文件内容
 * @param currentModulePath 当前模块路径
 * @param commonDSPath 通用数据结构路径
 */
export async function getGlobalRefinePrompt(fileContent: string, currentModulePath?: string, commonDSPath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'pseudocode');
    }

    // 针对现有伪代码的全局优化
    const userPrompt = dependenciesCode
        ? `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n**依赖模块的伪代码实现（这些模块已存在，不需要重新实现）**：${dependenciesCode}\n\n**重要说明**：\n- 上面列出的依赖模块已经存在，在精化时只需调用它们，不要修改或重新实现这些依赖模块\n- 请仔细检查当前伪代码中调用依赖模块的地方，确保函数名、参数列表、返回值类型与依赖模块的实际定义完全一致\n- 如果发现调用不一致的地方，请修正\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
        : `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行全局精化，帮助改进其清晰性、逻辑性和完整性。

请对伪代码的以下方面进行优化：
1. 逻辑流程清晰性 - 确保流程步骤清晰、易懂
2. 算法设计 - 优化算法逻辑和流程
3. 结构完整性 - 检查是否有遗漏的步骤或分支
4. 边界条件处理 - 确保处理了所有边界情况
5. 变量和函数命名 - 确保名称清晰能够表达意图
6. 依赖一致性 - 如果提供了依赖模块代码，确保调用依赖模块的函数名、参数和返回值与依赖模块的实际定义完全一致

重要：请直接返回改进后的完整伪代码内容，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的格式化标记，只返回纯文本的伪代码内容。`,
        user: userPrompt
    };
}

/**
 * 全局精化提示词 - 细致级别（粒度>0专用）
 * @param fileContent 伪代码文件内容
 * @param currentModulePath 当前模块路径
 * @param commonDSPath 通用数据结构路径
 */
export async function getGlobalRefinePromptDetailed(fileContent: string, currentModulePath?: string, commonDSPath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getGlobalRefinePromptDetailed] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('[getGlobalRefinePromptDetailed] 读取通用数据结构失败:', error);
        }
    }

    // 获取扩展根路径
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const promptPath = path.join(extensionPath, 'resources', 'prompts', '细粒度精化Prompt.md');

    // 构建用户提示词，按照 prompt.md 中的 Inputs 顺序传递
    let userPrompt = `# Input 1: Target Module Pseudocode\n\n${fileContent}\n\n`;

    if (dependenciesCode) {
        userPrompt += `# Input 2: Upstream Dependency Implementations\n${dependenciesCode}\n\n`;
    }

    if (commonDSContent) {
        userPrompt += `# Input 3: Common Data Structures\n\n${commonDSContent}\n\n`;
    }

    userPrompt += `请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    if (!fs.existsSync(promptPath)) {
        console.error('[getGlobalRefinePromptDetailed] 找不到细粒度精化Prompt.md文件:', promptPath);
        // 回退到简单的系统提示
        return {
            system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行全局精化，帮助改进其清晰性、逻辑性和完整性。\n\n请直接返回改进后的完整伪代码内容，不要使用任何markdown代码块标记，只返回纯文本的伪代码内容。`,
            user: userPrompt
        };
    }

    const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 全局精化提示词 - 粗糙级别（粒度>0专用）
 * @param fileContent 伪代码文件内容
 * @param currentModulePath 当前模块路径
 * @param commonDSPath 通用数据结构路径
 */
export async function getGlobalRefinePromptCoarse(fileContent: string, currentModulePath?: string, commonDSPath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getGlobalRefinePromptCoarse] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('[getGlobalRefinePromptCoarse] 读取通用数据结构失败:', error);
        }
    }

    // 获取扩展根路径
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const promptPath = path.join(extensionPath, 'resources', 'prompts', '粗粒度精化prompt.md');

    // 构建用户提示词，按照 prompt.md 中的 Inputs 顺序传递
    let userPrompt = `# Input 1: Target Module Pseudocode\n\n${fileContent}\n\n`;

    if (dependenciesCode) {
        userPrompt += `# Input 2: Upstream Dependency Implementations\n${dependenciesCode}\n\n`;
    }

    if (commonDSContent) {
        userPrompt += `# Input 3: Common Data Structures\n\n${commonDSContent}\n\n`;
    }

    userPrompt += `请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    if (!fs.existsSync(promptPath)) {
        console.error('[getGlobalRefinePromptCoarse] 找不到粗粒度精化prompt.md文件:', promptPath);
        // 回退到简单的系统提示
        return {
            system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行较粗粒度的全局精化。\n\n请直接返回改进后的完整伪代码内容，不要使用任何markdown代码块标记，只返回纯文本的伪代码内容。`,
            user: userPrompt
        };
    }

    const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 局部精化提示词 - 对伪代码片段的局部优化
 */
export async function getLocalRefinePrompt(
    fileContent: string,
    startLine: number,
    endLine: number,
    selectedCode: string,
    currentModulePath?: string,
    commonDSPath?: string
): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getLocalRefinePrompt] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('[getLocalRefinePrompt] 读取通用数据结构失败:', error);
        }
    }

    // 获取扩展根路径
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const promptPath = path.join(extensionPath, 'resources', 'prompts', '局部精化prompt.md');

    // 构建用户提示词，按照 prompt.md 中的 Inputs 顺序传递
    let userPrompt = `# Input 1: Target Module Pseudocode (Full)\n\n${fileContent}\n\n`;

    userPrompt += `# Input 2: Selected Code Fragment\n\n第 ${startLine} - ${endLine} 行：\n\n${selectedCode}\n\n`;

    if (dependenciesCode) {
        userPrompt += `# Input 3: Upstream Dependency Implementations\n${dependenciesCode}\n\n`;
    }

    if (commonDSContent) {
        userPrompt += `# Input 4: Common Data Structures\n\n${commonDSContent}\n\n`;
    }

    userPrompt += `请对选中部分进行精化，并返回修改后的**完整**伪代码内容。直接返回完整伪代码，不要使用markdown代码块标记（如 \`\`\`），只返回纯文本内容。`;

    if (!fs.existsSync(promptPath)) {
        console.error('[getLocalRefinePrompt] 找不到局部精化prompt.md文件:', promptPath);
        // 回退到简单的系统提示
        return {
            system: `你是一个专业的伪代码审查专家。你的任务是对伪代码的特定部分进行局部精化，但必须返回**修改后的完整文件内容**。\n\n请对选中部分进行优化，确保全局一致性，并输出修改后的完整伪代码。\n\n重要：请直接返回修改后的完整伪代码，不要使用markdown代码块标记（如 \`\`\`），只返回纯文本内容。`,
            user: userPrompt
        };
    }

    const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 代码生成提示词 - 从伪代码生成实际代码
 */
export async function getGenerateCodePrompt(fileContent: string, lastGranularity: string, language: string = 'python', currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 根据语言路由到对应的实现函数
    switch (language.toLowerCase()) {
        case 'python':
            return getGenerateCodePromptForPython(fileContent, lastGranularity, currentModulePath);

        // 其他语言可以在这里扩展
        // case 'java':
        //     return getGenerateCodePromptForJava(fileContent, lastGranularity, currentModulePath);
        // case 'cpp':
        // case 'c++':
        //     return getGenerateCodePromptForCpp(fileContent, lastGranularity, currentModulePath);

        default:
            // 回退到通用实现（使用硬编码prompt）
            console.warn(`[getGenerateCodePrompt] 语言 ${language} 暂未实现专用prompt，使用通用prompt`);
            return getGenerateCodePromptGeneric(fileContent, lastGranularity, language, currentModulePath);
    }
}

/**
 * Python语言专用：代码生成提示词
 */
async function getGenerateCodePromptForPython(fileContent: string, lastGranularity: string, currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码 - 代码生成时需要实际代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'actual');
    }

    // 获取实际数据结构文件内容
    let actualDataStructureCode = '';
    if (currentModulePath) {
        const aiPath = getPseudoPath();
        const relativePath = path.relative(aiPath, currentModulePath);
        const pathParts = relativePath.split(path.sep);

        if (pathParts.length > 0) {
            // 实际数据结构文件存放在 codes 目录下
            const projectName = pathParts[0];
            const codeProjectRoot = path.join(getCodesPath(), projectName);
            const { getActualDataStructureContent } = await import('../tools/actual-datastructure-generator.js');
            actualDataStructureCode = getActualDataStructureContent(codeProjectRoot, 'python');

            if (actualDataStructureCode) {
                console.log('[getGenerateCodePromptForPython] 成功读取实际数据结构文件');
            } else {
                console.log('[getGenerateCodePromptForPython] 未找到实际数据结构文件');
            }
        }
    }

    // 获取扩展根路径
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const promptPath = path.join(extensionPath, 'resources', 'prompts', 'generateCode_python.md');

    // 构建用户提示词，按照 prompt.md 中的 Inputs 顺序传递
    let userPrompt = `# Input 1: Target Module Pseudocode\n\n${fileContent}\n\n`;

    if (actualDataStructureCode) {
        userPrompt += `# Input 2: Project Data Structures\n\n${actualDataStructureCode}\n\n`;
    }

    if (dependenciesCode) {
        userPrompt += `# Input 3: Upstream Dependency Implementations\n${dependenciesCode}\n\n`;
    }

    userPrompt += `请根据上述伪代码的整体逻辑生成完整、可运行的 Python 代码。请直接返回 Python 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`;

    if (!fs.existsSync(promptPath)) {
        console.error('[getGenerateCodePromptForPython] 找不到generateCode_python.md文件:', promptPath);
        // 回退到通用实现
        return getGenerateCodePromptGeneric(fileContent, lastGranularity, 'python', currentModulePath);
    }

    const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 通用实现：代码生成提示词（回退方案）
 */
async function getGenerateCodePromptGeneric(fileContent: string, lastGranularity: string, language: string, currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'actual');
    }

    // 获取实际数据结构文件内容
    let actualDataStructureCode = '';
    if (currentModulePath) {
        const aiPath = getPseudoPath();
        const relativePath = path.relative(aiPath, currentModulePath);
        const pathParts = relativePath.split(path.sep);

        if (pathParts.length > 0) {
            // 实际数据结构文件存放在 codes 目录下
            const projectName = pathParts[0];
            const codeProjectRoot = path.join(getCodesPath(), projectName);
            const { getActualDataStructureContent } = await import('../tools/actual-datastructure-generator.js');
            actualDataStructureCode = getActualDataStructureContent(codeProjectRoot, language);

            if (actualDataStructureCode) {
                console.log('[getGenerateCodePromptGeneric] 成功读取实际数据结构文件');
            } else {
                console.log('[getGenerateCodePromptGeneric] 未找到实际数据结构文件');
            }
        }
    }

    // 获取扩展根路径
    let extensionPath = __dirname;
    while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
        const parent = path.dirname(extensionPath);
        if (parent === extensionPath) {
            break;
        }
        extensionPath = parent;
    }

    const promptPath = path.join(extensionPath, 'resources', 'prompts', 'generateCode.md');

    // 构建用户提示词，按照 prompt.md 中的 Inputs 顺序传递
    let userPrompt = `# Input 1: Target Module Pseudocode\n\n${fileContent}\n\n`;

    if (actualDataStructureCode) {
        userPrompt += `# Input 2: Project Data Structures\n\n${actualDataStructureCode}\n\n`;
    }

    if (dependenciesCode) {
        userPrompt += `# Input 3: Upstream Dependency Implementations\n${dependenciesCode}\n\n`;
    }

    userPrompt += `请根据上述伪代码的整体逻辑生成完整、可运行的 ${language} 代码。请直接返回 ${language} 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`;

    if (!fs.existsSync(promptPath)) {
        console.error('[getGenerateCodePromptGeneric] 找不到generateCode.md文件:', promptPath);
        // 回退到简单的系统提示
        return {
            system: `你是 ${language} 代码生成专家。根据伪代码生成可运行的代码，导入已存在的数据结构和依赖模块。直接返回代码，不使用 markdown 标记。`,
            user: userPrompt
        };
    }

    const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getModuleDivisionPrompt1(filePath: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/非碎片化模块划分.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const fileContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const fileContent = new TextDecoder().decode(fileContentBytes);

    const projectName = path.basename(path.dirname(filePath));
    const userPrompt = `请根据以下原始需求文档进行模块划分：\n\n${fileContent}\n\n
    请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;


    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getModuleDivisionPrompt2(modulesPath: string, requirementsPath: string, moduleName: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/子模块划分.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(modulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);

    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);

    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n待拆解的目标模块名称：\n${moduleName}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getCommonDSPrompt(leafModulesPath: string, requirementsPath: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/通用数据结构提示词.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(leafModulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);

    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);

    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getLeafModules(leafModulesPath: string, requirementsPath: string, commonDSPath: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/所有叶子节点生成提示词.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(leafModulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);

    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);

    const commonDSContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(commonDSPath));
    const commonDSContent = new TextDecoder().decode(commonDSContentBytes);

    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n通用数据结构定义：\n${commonDSContent}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 生成实际数据结构代码的提示词
 * @param commonDSJsonContent common_data_structures.json 的内容
 * @param language 目标编程语言（如 'python', 'java'）
 * @param context VSCode extension context
 * @returns 包含 system 和 user 提示词的对象
 */
export async function getActualDataStructurePrompt(
    commonDSJsonContent: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<{ system: string; user: string }> {
    // 根据语言路由到对应的实现函数
    switch (language.toLowerCase()) {
        case 'python':
            return getActualDataStructurePromptForPython(commonDSJsonContent, context);

        // 其他语言可以在这里扩展
        // case 'java':
        //     return getActualDataStructurePromptForJava(commonDSJsonContent, context);
        // case 'cpp':
        // case 'c++':
        //     return getActualDataStructurePromptForCpp(commonDSJsonContent, context);

        default:
            // 回退到通用实现（使用通用prompt）
            console.warn(`[getActualDataStructurePrompt] 语言 ${language} 暂未实现专用prompt，使用通用prompt`);
            return getActualDataStructurePromptGeneric(commonDSJsonContent, language, context);
    }
}

/**
 * Python语言专用：生成实际数据结构代码的提示词
 */
async function getActualDataStructurePromptForPython(
    commonDSJsonContent: string,
    context: vscode.ExtensionContext
): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/commonDataStructure_python.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const userPrompt = `# Input 1: Source JSON\n\n${commonDSJsonContent}\n\n# Input 2: Target Language\n\nPython\n\n请将上述 JSON 定义的所有数据结构转换为 Python 语言的纯数据代码。请直接返回代码，不要使用 markdown 代码块标记（如 \`\`\`），只返回纯代码内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * 通用实现：生成实际数据结构代码的提示词（回退方案）
 */
async function getActualDataStructurePromptGeneric(
    commonDSJsonContent: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/commonDataStructure.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const userPrompt = `Source JSON：\n${commonDSJsonContent}\n\nTarget Language: ${language}\n\n请直接返回代码，不要使用 markdown 代码块标记。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

