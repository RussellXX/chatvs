export function cleanLLMResponse(text: string): string {
    const startMarker = '```';
    const firstIndex = text.indexOf(startMarker);
    
    if (firstIndex === -1) {
        return text.trim();
    }
    
    // Find the end of the line containing the opening ```
    const nextNewline = text.indexOf('\n', firstIndex);
    let contentStartIndex = 0;
    
    if (nextNewline !== -1) {
        contentStartIndex = nextNewline + 1;
    } else {
        // Fallback if no newline found (unlikely for valid code blocks)
        contentStartIndex = firstIndex + startMarker.length;
    }
    
    let content = text.substring(contentStartIndex);
    
    // Find the closing ```
    const closingIndex = content.indexOf(startMarker);
    if (closingIndex !== -1) {
        content = content.substring(0, closingIndex);
    }
    
    return content.trim();
}


export function getHumanJsonPath(fileName: string): string {
    if (fileName.endsWith('.pseudo')) {
        return fileName.replace(/\.pseudo$/, '_pseudo_human.json')
    } else {
        return fileName.replace(/\.[^.]+$/, '_py_human.json')
    }
}

export interface LineData {
    type: number // 0: AI, 1: Human
    content: string
}