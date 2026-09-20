export function getSystemPrompt(): string {
    return `
## Context Management (Slim)

You have access to context management tools. Use them wisely:

### compress tool
Use \`compress\` to reduce context size when it gets large. It supports:
- Auto mode: Intelligently selects what to compress
- Range mode: Compress specific message range
- Topic mode: Compress messages matching a topic

Example: \`compress({ focus: "old exploration" })\`

### panel tool
Use \`panel\` to view current context usage and statistics.

### When to compress
- Context usage > 80%: Consider compressing
- Context usage > 90%: Compress immediately
- After completing a major task: Compress related messages
- Before starting a new task: Clean up old context
`
}

export function getCompressToolDescription(): string {
    return `Compress context to free up tokens. Supports multiple modes:

- Auto mode (default): Intelligently selects what to compress based on age and relevance
- Range mode: Compress specific message range (start/end indices)
- Topic mode: Compress messages matching a topic keyword

The compression creates a summary preserving key information while removing redundancy.`
}

export function getNudgeMessage(reason: string, currentTokens: number, maxTokens: number): string {
    const percent = Math.round((currentTokens / maxTokens) * 100)
    return `💡 **Context Optimization Available**

${reason} (${percent}% used)

Consider using the \`compress\` tool to free up context space:
\`\`\`
compress({ focus: "describe what to compress" })
\`\`\`

This will create a summary of older messages, preserving key information while freeing tokens.`
}
