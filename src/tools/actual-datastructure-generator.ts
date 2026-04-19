// src/tools/actual-datastructure-generator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as openaiHelper from '../openai/openai-helper';
import { getSrcFileSuffix } from './lang-util';
import { DesignmentTreeDataProvider } from '../designment-tree-view/designment-tree-data-provider';


/**
 * 检查项目根目录下是否已存在实际数据结构文件
 * @param projectRootPath 项目根目录路径
 * @param language 目标语言
 * @returns 如果文件存在，返回文件路径；否则返回 null
 */
export function checkActualDataStructureExists(projectRootPath: string, language: string): string | null {
    const suffix = getSrcFileSuffix(language);
    if (!suffix) {
        return null;
    }
    
    const dsFileName = `data_structures${suffix}`;
    const dsFilePath = path.join(projectRootPath, dsFileName);
    
    return fs.existsSync(dsFilePath) ? dsFilePath : null;
}

/**
 * 生成实际的数据结构代码文件
 * @param projectRootPath 项目根目录路径
 * @param language 目标语言（如 'python', 'java'）
 * @param context VSCode extension context
 * @returns 生成的数据结构文件路径
 */
export async function generateActualDataStructure(
    projectRootPath: string,
    codeProjectRootPath: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<string> {
    // 1. 检查 common_data_structures.json 是否存在
    const commonDSJsonPath = path.join(projectRootPath, 'common_data_structures.json');
    if (!fs.existsSync(commonDSJsonPath)) {
        throw new Error(`未找到通用数据结构定义文件: ${commonDSJsonPath}`);
    }
    
    // 2. 读取 common_data_structures.json 内容
    let commonDSJsonContent = fs.readFileSync(commonDSJsonPath, 'utf8');

    // 临时措施，将commonDSJsonContent中的project.前缀去掉
    const projectName= path.basename(projectRootPath);
    const prefixToRemove = projectName + '.';
    commonDSJsonContent = commonDSJsonContent.replace(new RegExp(`"${prefixToRemove}`, 'g'), '"');
    
    // 3. 根据语言选择不同的生成逻辑
    let dsFilePath: string;
    
    switch (language.toLowerCase()) {
        case 'python':
            dsFilePath = await generatePythonDataStructure(
                commonDSJsonContent,
                codeProjectRootPath,
                language,
                context
            );
            break;
        
        default:
            dsFilePath = await generateDefaultDataStructure(
                commonDSJsonContent,
                codeProjectRootPath,
                language,
                context
            );
            break;
    }
    
    return dsFilePath;
}

/**
 * 获取实际数据结构文件的内容
 * @param projectRootPath 项目根目录路径
 * @param language 目标语言
 * @returns 数据结构文件内容，如果文件不存在返回空字符串
 */
export function getActualDataStructureContent(projectRootPath: string, language: string): string {
    const dsFilePath = checkActualDataStructureExists(projectRootPath, language);
    
    if (!dsFilePath) {
        return '';
    }
    
    try {
        return fs.readFileSync(dsFilePath, 'utf8');
    } catch (error) {
        console.error(`读取实际数据结构文件失败: ${dsFilePath}`, error);
        return '';
    }
}

/**
 * Python 特定的数据结构生成逻辑
 */
async function generatePythonDataStructure(
    commonDSJsonContent: string,
    codeProjectRootPath: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<string> {
    // 获取 Python 对应的文件后缀
    const suffix = getSrcFileSuffix(language);
    if (!suffix) {
        throw new Error(`不支持的语言: ${language}`);
    }
    
    const dsFileName = `data_structures${suffix}`;
    const dsFilePath = path.join(codeProjectRootPath, dsFileName);
    
    // 如果文件已存在，提示用户是否覆盖
    if (fs.existsSync(dsFilePath)) {
        const result = await vscode.window.showWarningMessage(
            `数据结构文件 ${dsFileName} 已存在。是否覆盖？`,
            { modal: true },
            '覆盖',
            '取消'
        );
        
        if (result !== '覆盖') {
            throw new Error('用户取消了数据结构文件的生成。');
        }
    }
    
    // 调用 OpenAI 生成实际数据结构代码（Python 专用 prompt）
    const prompt = await openaiHelper.getActualDataStructurePrompt(
        commonDSJsonContent,
        language,
        context
    );
    
    const generatedCode = await openaiHelper.callOpenAIForJSON(
        prompt.system,
        prompt.user
    );
    
    // 清理可能的 markdown 标记
    const cleanedCode = cleanLLMResponse(generatedCode);
    
    // 写入文件（仅写入 codes 下的项目根目录）
    fs.writeFileSync(dsFilePath, cleanedCode, 'utf8');
    DesignmentTreeDataProvider.getInstance().refresh(undefined);
    
    console.log(`[ActualDS] Python 实际数据结构文件已生成: ${dsFilePath}`);
    
    return dsFilePath;
}

/**
 * 默认的数据结构生成逻辑（用于其他语言）
 */
async function generateDefaultDataStructure(
    commonDSJsonContent: string,
    codeProjectRootPath: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<string> {
    // 获取对应语言的文件后缀
    const suffix = getSrcFileSuffix(language);
    if (!suffix) {
        throw new Error(`不支持的语言: ${language}`);
    }
    
    const dsFileName = `data_structures${suffix}`;
    const dsFilePath = path.join(codeProjectRootPath, dsFileName);
    
    // 如果文件已存在，提示用户是否覆盖
    if (fs.existsSync(dsFilePath)) {
        const result = await vscode.window.showWarningMessage(
            `数据结构文件 ${dsFileName} 已存在。是否覆盖？`,
            { modal: true },
            '覆盖',
            '取消'
        );
        
        if (result !== '覆盖') {
            throw new Error('用户取消了数据结构文件的生成。');
        }
    }
    
    // 调用 OpenAI 生成实际数据结构代码（通用 prompt）
    const prompt = await openaiHelper.getActualDataStructurePrompt(
        commonDSJsonContent,
        language,
        context
    );
    
    const generatedCode = await openaiHelper.callOpenAIForJSON(
        prompt.system,
        prompt.user
    );
    
    // 清理可能的 markdown 标记
    const cleanedCode = cleanLLMResponse(generatedCode);
    
    // 写入文件（仅写入 codes 下的项目根目录）
    fs.writeFileSync(dsFilePath, cleanedCode, 'utf8');
    DesignmentTreeDataProvider.getInstance().refresh(undefined);
    
    console.log(`[ActualDS] ${language} 实际数据结构文件已生成: ${dsFilePath}`);
    
    return dsFilePath;
}

/**
 * 清理 LLM 返回的响应，移除 markdown 代码块标记
 */
function cleanLLMResponse(response: string): string {
    // 移除 markdown 代码块标记
    let cleaned = response.replace(/```[a-zA-Z]*\n/g, '').replace(/```/g, '').trim();
    return cleaned;
}