export function getSystemPrompt(): string {
    return `
## Context Management (Slim)

You have access to context management tools. Use them wisely:

### compress tool
Use \`compress\` to reduce context size when it gets large. It supports:
- Range mode: Compress a specific message range (start/end indices) into one summary
- Topic mode: Compress messages matching a topic keyword
- Auto mode: Intelligently selects what to compress

Example: \`compress({ focus: "old exploration" })\`

Compressed ranges are replaced by their summary on outgoing requests, so the
model keeps the essential information while token usage drops on every
subsequent request. Protected tool results (task, skill, todowrite, todoread)
are preserved inside the summary.

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

The compression creates a summary preserving key information (including
protected tool outputs) and replaces the selected messages with that summary on
future requests, so the context stays small.`
}

// ─── DCP-style limit nudges ────────────────────────────────────────────────
//
// Every nudge carries a stable marker so the pipeline can detect an existing
// nudge regardless of its dynamic content (percentages change every request).

export const NUDGE_MARKERS = {
    contextLimit: "[[slim:context-limit]]",
    turn: "[[slim:turn]]",
    iteration: "[[slim:iteration]]",
} as const

export function contextLimitNudge(percent: number, maxTokens: number): string {
    return `${NUDGE_MARKERS.contextLimit}\n\n> ⚠️ **Context at capacity: ${percent}% of ${maxTokens.toLocaleString()} tokens.** Older completed work should be compressed now to keep the session efficient. Call \`compress\` with a focus describing the oldest exchange, e.g. \`compress({ focus: "initial exploration" })\`. Past ranges are replaced by summaries to avoid re-sending tokens.`
}

export function turnNudge(percent: number): string {
    return `${NUDGE_MARKERS.turn}\n\n> 💡 **Context is getting large (${percent}% of limit).** When you finish the current task, consider calling \`compress\` on the completed portion to keep the session fast and cheap.`
}

export function iterationNudge(percent: number): string {
    return `${NUDGE_MARKERS.iteration}\n\n> 💡 **Many tool iterations since the last user message (${percent}% of limit used).** If the explored subtree is done, call \`compress({ focus: "exploration so far" })\` to replace it with a summary.`
}