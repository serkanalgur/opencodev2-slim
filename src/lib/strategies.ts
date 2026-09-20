import type { MessageWithParts, SlimConfig } from "./types"
import { getToolName, getToolResultContent, getMessageText } from "./compress"
import { getDuplicateToolCalls, getErroredToolCalls } from "./state"
import type { SessionState } from "./types"

export function pruneMessages(
    messages: MessageWithParts[],
    config: SlimConfig,
    _messageCount: number,
): MessageWithParts[] {
    let pruned = [...messages]

    // Apply deduplication
    if (config.strategies.deduplication.enabled) {
        pruned = applyDeduplication(pruned, config.strategies.deduplication.protectedTools)
    }

    return pruned
}

function applyDeduplication(messages: MessageWithParts[], protectedTools: string[]): MessageWithParts[] {
    const seen = new Map<string, number>()
    const toRemove = new Set<number>()

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const toolName = getToolName(msg)

        // Skip protected tools
        if (toolName && protectedTools.includes(toolName)) {
            continue
        }

        // Create a fingerprint of the message
        const text = getMessageText(msg)
        const toolContent = getToolResultContent(msg)
        const fingerprint = `${msg.info.role}:${text.slice(0, 200)}:${toolContent.slice(0, 200)}`

        const existingIndex = seen.get(fingerprint)
        if (existingIndex !== undefined) {
            // Mark later duplicate for removal
            toRemove.add(i)
        } else {
            seen.set(fingerprint, i)
        }
    }

    return messages.filter((_, i) => !toRemove.has(i))
}
