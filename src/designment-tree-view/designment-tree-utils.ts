import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { DesignmentTreeNode } from './designment-tree-data-provider'
import { topoSortLeafModules } from '../tools/module-topology-util'
import * as openaiHelper from '../openai/openai-helper'
import * as settings from '../settings/settings'
import { LeafModulesArraySchema } from '../openai/schemas'

function writeJsonAtomically(filePath: string, data: any) {
    const tempPath = `${filePath}.tmp.${Date.now()}`
    const content = JSON.stringify(data, null, 2)
    
    try {
        fs.writeFileSync(tempPath, content, 'utf8')
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        throw error
    }
}

function readJsonSafe(filePath: string): any[] {
    if (!fs.existsSync(filePath)) {
        return []
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8')
        return content.trim() ? JSON.parse(content) : []
    } catch (e) {
        console.error(`读取 JSON 失败: ${filePath}`, e)
        return []
    }
}

// Given a node in the tree, find the project root path.
function getProjectRootPath(element: DesignmentTreeNode): string {
    while (element.parent) {
        element = element.parent
    }
    return element.absolutePath
}


export async function getLeafModules(
    projectPath: string,
    context: vscode.ExtensionContext
) {
    const requirementsPath = path.join(projectPath, 'content.txt')
    const ongoingLeafModulesPath = path.join(projectPath, 'ongoing_leaf_modules.json')
    const commonDSPath = path.join(projectPath, 'common_data_structures.json')

    const prompt = await openaiHelper.getLeafModules(ongoingLeafModulesPath, requirementsPath, commonDSPath, context)
    
    try {
        const resultString = await openaiHelper.callOpenAIForJSON(
            prompt.system, 
            prompt.user,
            LeafModulesArraySchema,
            3
        )
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim())

        // Currently, we assume that the topology sequence is fixed after designment stage.
        const sortedResult = topoSortLeafModules(result)
        const aiPath = settings.getPseudoPath()
        const projectName = path.basename(projectPath)

        sortedResult.forEach((item: any, index: any) => {
            item.status = index === 0 ? 'ongoing' : 'pending'

            item.path = path.join(projectName, item.module_name.replace(/\./g, path.sep));

            // Write the designment information to each leaf module.
            const filePath = path.join(
                aiPath,
                item.path,
                'designment_info.txt'
            )
            
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, JSON.stringify(item, null, 4), 'utf8')
            }
        })

        const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
        
        if (sortedResult) {
            writeJsonAtomically(leafModulesPath, sortedResult)
        }
    } catch (error) {
        console.error('生成叶子模块列表失败:', error)
        // [修改] 抛出错误，以便上层捕获
        throw error
    }
}