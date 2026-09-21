import type { MessageWithParts, SlimConfig, SessionState, CompressionBlock } from "./types"
import { getToolName, getMessageText } from "./compress"
import { contextLimitNudge, turnNudge, iterationNudge, NUDGE_MARKERS } from "./prompts"

// ─── DCP-style Compression Blocks ───────────────────────────────────────────
//
// A compression block replaces a contiguous range of messages with a summary
// placeholder on every outgoing request. The summary is injected as a synthetic
// user message at the block's *anchor* message (the first message after the
// range, or the last message when the range reaches the end). The covered
// messages are removed from the outgoing request only — session history is
// never modified. Newer blocks "consume" older ones (nested compression).

/**
 * Activates/deactivates blocks based on which messages are present in the
 * current outgoing request. A block is active while both its origin message
 * (compressMessageId) and its anchor message are still present. A newer active
 * block deactivates any older block whose anchor falls inside its covered range.
 */
export function syncCompressionBlocks(state: SessionState, presentIds: Set<string>): void {
    const blocks = state.compressionBlocks ?? []
    if (blocks.length === 0) return

    for (const block of blocks) {
        const hasOrigin =
            block.compressMessageId.length > 0 ? presentIds.has(block.compressMessageId) : true
        block.active = hasOrigin && presentIds.has(block.anchorMessageId)
    }

    // Nested consumption: newest active block wins over older blocks it covers,
    // and inherits their covered messages so nothing resurfaces behind the
    // newest summary. Loop until stable to handle chains (A -> B -> C).
    const sorted = [...blocks].sort((a, b) => a.blockId - b.blockId)
    let changed = true
    while (changed) {
        changed = false
        for (const block of sorted) {
            if (!block.active) continue
            for (const older of sorted) {
                if (older.blockId >= block.blockId || !older.active) continue
                if (block.coveredMessageIds.includes(older.anchorMessageId)) {
                    older.active = false
                    for (const id of older.coveredMessageIds) {
                        if (!block.coveredMessageIds.includes(id)) {
                            block.coveredMessageIds.push(id)
                            changed = true
                        }
                    }
                }
            }
        }
    }

    // Orphaned blocks: inactive and none of their referenced messages survive
    // (e.g. after OpenCode compaction) — safe to forget, otherwise dead entries
    // accumulate in persisted state forever.
    const alive = blocks.filter((b) => {
        if (b.active) return true
        const refs = [b.anchorMessageId, b.compressMessageId, ...(b.coveredMessageIds ?? [])]
        return refs.some((id) => typeof id === "string" && presentIds.has(id))
    })
    if (alive.length !== blocks.length) {
        state.compressionBlocks = alive
    }
}

/**
 * Produces the outgoing message list: active blocks inject their summary at the
 * anchor and drop every covered message. Returns a new array; the caller should
 * splice it back into the event.
 */
export function applyCompressedRanges(state: SessionState, messages: any[]): any[] {
    const blocks = (state.compressionBlocks ?? []).filter((b) => b.active)
    if (blocks.length === 0 || messages.length === 0) return messages

    const covered = new Set<string>()
    const byAnchor = new Map<string, CompressionBlock>()
    for (const block of blocks) {
        for (const id of block.coveredMessageIds) covered.add(id)
        byAnchor.set(block.anchorMessageId, block)
    }

    const result: any[] = []
    for (const msg of messages) {
        const id = (msg && (msg.id ?? msg.info?.id)) as string | undefined
        if (typeof id === "string") {
            const block = byAnchor.get(id)
            if (block && block.summary) {
                result.push({
                    role: "user",
                    id: `slim-summary-${block.blockId}`,
                    content: [{ type: "text", text: block.summary }],
                })
            }
            if (covered.has(id)) {
                continue
            }
        }
        result.push(msg)
    }
    return result
}

export interface RegisterBlockOptions {
    coveredIds: string[]
    anchorMessageId: string
    summary: string
    topic: string
    compressMessageId?: string
    summaryTokens?: number
}

/**
 * Registers a new compression block. Older active blocks whose anchor lies
 * inside the new range are consumed (deactivated) so only the newest summary
 * is injected — information survives through layers of compression.
 */
export function registerCompressionBlock(
    state: SessionState,
    opts: RegisterBlockOptions,
): CompressionBlock | null {
    const blocks = state.compressionBlocks ?? []
    const nextId =
        state.nextBlockId ??
        blocks.reduce((max, b) => Math.max(max, b.blockId), 0) + 1

    const consumed = blocks
        .filter((b) => b.active && opts.coveredIds.includes(b.anchorMessageId))
        .map((b) => b.blockId)

    const block: CompressionBlock = {
        blockId: nextId,
        topic: opts.topic,
        summary: opts.summary,
        anchorMessageId: opts.anchorMessageId,
        compressMessageId: opts.compressMessageId ?? "",
        coveredMessageIds: opts.coveredIds,
        consumedBlockIds: consumed,
        active: true,
        createdAt: Date.now(),
        summaryTokens: opts.summaryTokens ?? 0,
    }

    blocks.push(block)
    state.compressionBlocks = blocks
    state.nextBlockId = nextId + 1

    for (const consumedId of consumed) {
        const target = blocks.find((b) => b.blockId === consumedId)
        if (target) {
            target.active = false
            // Inherit the consumed block's covered messages so they stay
            // hidden behind the newer summary (nested compression).
            for (const id of target.coveredMessageIds) {
                if (!block.coveredMessageIds.includes(id)) {
                    block.coveredMessageIds.push(id)
                }
            }
        }
    }

    return block
}

// ─── Summary building (with protected content) ─────────────────────────────

/**
 * Builds the compression summary used as the placeholder. Protected tool
 * outputs (task, skill, todowrite, todoread, ...) are appended verbatim so the
 * most important information survives compression — DCP behaviour.
 */
export async function buildCompressionSummary(
    messages: MessageWithParts[],
    focus: string,
    protectedTools: string[],
    protectUserMessages = false,
): Promise<string> {
    const lines: string[] = []
    lines.push(`## Compression Summary`)
    lines.push(`Focus: ${focus}`)
    lines.push(`Messages compressed: ${messages.length}`)
    lines.push("")

    const toolCalls: string[] = []
    const errors: string[] = []
    const decisions: string[] = []

    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === "tool-call") {
                toolCalls.push(
                    `${part.name}: ${JSON.stringify(part.input || {}).slice(0, 100)}`,
                )
            }
            if (part.type === "tool-result") {
                if (part.result?.type === "error") {
                    errors.push(String(part.result.value).slice(0, 200) || "Unknown error")
                }
            }
            if (part.type === "text") {
                const text = part.text || ""
                if (
                    text.includes("decided") ||
                    text.includes("chose") ||
                    text.includes("implemented")
                ) {
                    decisions.push(text.slice(0, 200))
                }
            }
        }
    }

    if (toolCalls.length > 0) {
        lines.push("### Tool Calls")
        toolCalls.slice(0, 10).forEach((tc) => lines.push(`- ${tc}`))
        lines.push("")
    }

    if (errors.length > 0) {
        lines.push("### Errors Encountered")
        errors.slice(0, 5).forEach((e) => lines.push(`- ${e}`))
        lines.push("")
    }

    if (decisions.length > 0) {
        lines.push("### Key Decisions")
        decisions.slice(0, 5).forEach((d) => lines.push(`- ${d}`))
        lines.push("")
    }

    const protectedContent = collectProtectedToolOutputs(messages, protectedTools)
    if (protectedContent.length > 0) {
        lines.push("### Protected Tool Outputs")
        lines.push(protectedContent)
        lines.push("")
    }

    // DCP protectUserMessages: the user's own instructions survive compression
    // verbatim inside the summary, so nothing the user asked is ever lost to a
    // lossy paraphrase.
    if (protectUserMessages) {
        const userTexts: string[] = []
        for (const msg of messages) {
            if (msg.info.role !== "user") continue
            const text = getMessageText(msg)
            if (text.trim().length > 0) userTexts.push(text.trim())
        }
        if (userTexts.length > 0) {
            lines.push("### User Messages (preserved verbatim)")
            userTexts.forEach((t, i) => lines.push(`- [user ${i + 1}] ${t.slice(0, 2000)}`))
            lines.push("")
        }
    }

    return lines.join("\n")
}

function collectProtectedToolOutputs(
    messages: MessageWithParts[],
    protectedTools: string[],
): string {
    if (protectedTools.length === 0) return ""

    const resultsByCallId = new Map<string, string>()
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type !== "tool-result") continue
            const callId = part.toolCallID ?? part.callID
            if (!callId) continue
            const val = part.result?.value ?? part.result
            if (val !== undefined && val !== null && part.result?.type !== "error") {
                resultsByCallId.set(String(callId), String(val))
            }
        }
    }

    const output: string[] = []
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type !== "tool-call") continue
            const name = part.name
            if (!name || !protectedTools.includes(name)) continue
            const input = JSON.stringify(part.input ?? {}).slice(0, 1000)
            const callId = part.toolCallID ?? part.callID
            const result = callId ? resultsByCallId.get(String(callId)) : undefined
            output.push(
                result
                    ? `- [${name}] input: ${input}\n  output: ${result.slice(0, 2000)}`
                    : `- [${name}] input: ${input}`,
            )
        }
    }
    return output.join("\n")
}

// ─── Pruning: dedup + purge errored tool inputs ────────────────────────────

/** Kept for compatibility: pure deduplication over MessageWithParts. */
export function pruneMessages(
    messages: MessageWithParts[],
    config: SlimConfig,
    _messageCount: number,
): MessageWithParts[] {
    let pruned = [...messages]

    if (config.strategies.deduplication.enabled) {
        pruned = applyDeduplication(pruned, config.strategies.deduplication.protectedTools)
    }

    return pruned
}

export function applyDeduplication(
    messages: MessageWithParts[],
    protectedTools: string[],
): MessageWithParts[] {
    const seen = new Set<string>()
    const toRemove = new Set<number>()

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const toolName = getToolName(msg)

        if (toolName && protectedTools.includes(toolName)) {
            continue
        }

        // Exact full-content fingerprint: only identical messages are removed.
        const fingerprint = `${msg.info.role}:${JSON.stringify(msg.parts)}`
        if (seen.has(fingerprint)) {
            toRemove.add(i)
        } else {
            seen.add(fingerprint)
        }
    }

    return messages.filter((_, i) => !toRemove.has(i))
}

/**
 * DCP purge-errors: for tool calls whose result is an error, remove the large
 * string inputs once the message is at least `turns` positions behind the end
 * of the conversation. Error messages themselves are preserved.
 */
export function purgeStaleToolErrors(messages: any[], turns: number): void {
    const n = messages.length
    if (n === 0) return

    const erroredCallIds = new Set<string>()
    for (const msg of messages) {
        for (const part of msg?.content ?? msg?.parts ?? []) {
            if (part?.type !== "tool-result") continue
            if (part.result?.type !== "error") continue
            const callId = part.toolCallID ?? part.callID
            if (callId) erroredCallIds.add(String(callId))
        }
    }
    if (erroredCallIds.size === 0) return

    const turnsEffective = Math.max(1, Math.floor(turns) || 1)
    for (let i = 0; i < n; i++) {
        if (i > n - turnsEffective - 1) continue // too recent — keep
        const msg = messages[i]
        for (const part of msg?.content ?? msg?.parts ?? []) {
            if (part?.type !== "tool-call") continue
            const callId = part.toolCallID ?? part.callID
            if (!callId || !erroredCallIds.has(String(callId))) continue
            const input = part.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string" && input[key].length > 80) {
                        input[key] = "[input removed due to failed tool call]"
                    }
                }
            }
        }
    }
}

/** In-place dedup over raw outgoing messages; returns the keep count. */
export function pruneInPlace(messages: any[], config: SlimConfig): void {
    if (!config.strategies.deduplication.enabled) return

    const protectedTools = config.strategies.deduplication.protectedTools
    const seen = new Set<string>()
    const toRemove = new Set<number>()

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as any
        const content = msg?.content ?? msg?.parts ?? []

        // Protected tools (and messages carrying them) are never deduplicated.
        let toolName: string | null = null
        for (const part of content) {
            if (part?.type === "tool-call") {
                toolName = toolName ?? part.name ?? null
            }
        }
        if (toolName && protectedTools.includes(toolName)) continue

        // Exact full-content fingerprint — only truly identical messages are
        // removed. Truncated fingerprints would eat distinct messages that share
        // a common prefix.
        const fingerprint = `${msg?.role}:${JSON.stringify(content)}`
        if (seen.has(fingerprint)) {
            toRemove.add(i)
        } else {
            seen.add(fingerprint)
        }
    }

    if (toRemove.size === 0) return
    const kept = messages.filter((_, i) => !toRemove.has(i))
    messages.splice(0, messages.length, ...kept)
}

// ─── DCP limit rules → anchored nudges ─────────────────────────────────────

export function messageHasCompress(msg: any): boolean {
    const content = msg?.content ?? msg?.parts ?? []
    return content.some(
        (part: any) => part?.type === "tool-call" && part?.name === "compress",
    )
}

export function findLastUserMessage(messages: any[]): any | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") return messages[i]
    }
    return undefined
}

function getNudgeFrequency(config: SlimConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

function getIterationThreshold(config: SlimConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

function addAnchor(
    anchors: string[],
    messageId: string | undefined,
    index: number,
    messages: any[],
    interval: number,
): boolean {
    if (!messageId || index < 0) return false

    let latestAnchorIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any
        const id = m?.id ?? m?.info?.id
        if (typeof id === "string" && anchors.includes(id)) {
            latestAnchorIndex = i
            break
        }
    }

    const shouldAdd = latestAnchorIndex < 0 || index - latestAnchorIndex >= interval
    if (!shouldAdd) return false

    if (!anchors.includes(messageId)) {
        anchors.push(messageId)
        return true
    }
    return false
}

function addSpecificAnchor(anchors: string[], messageId: string | undefined): void {
    if (messageId && !anchors.includes(messageId)) {
        anchors.push(messageId)
    }
}

function messageHasNudge(msg: any, marker: string): boolean {
    const content = msg?.content ?? msg?.parts ?? []
    return content.some(
        (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.includes(marker),
    )
}

function appendToMessage(msg: any, nudgeText: string): void {
    const content = (msg?.content ?? msg?.parts ?? []) as any[]
    for (const part of content) {
        if (part?.type === "text") {
            part.text = `${part.text}\n\n${nudgeText}`
            return
        }
    }
    content.push({ type: "text", text: nudgeText })
}

/**
 * DCP limit rules: compare current usage against maxContextLimit /
 * minContextLimit and anchor nudges so the model is pushed to compress at most
 * once per nudgeFrequency messages. If the last assistant turn already ran the
 * compress tool, all anchors are cleared.
 */
export function injectLimitNudges(
    state: SessionState,
    config: SlimConfig,
    messages: any[],
    currentTokens: number,
    limits: { max: number; min: number },
): void {
    if (config.compress.permission === "deny") return
    if (state.manualMode) return
    if (messages.length === 0) return

    const nudges = state.nudges ?? {
        contextLimitAnchors: [],
        turnNudgeAnchors: [],
        iterationNudgeAnchors: [],
    }

    const lastAssistant = [...messages].reverse().find((m) => (m as any)?.role === "assistant")
    if (lastAssistant && messageHasCompress(lastAssistant)) {
        nudges.contextLimitAnchors = []
        nudges.turnNudgeAnchors = []
        nudges.iterationNudgeAnchors = []
        state.nudges = nudges
        return
    }

    const overMax = limits.max > 0 && currentTokens > limits.max
    const overMin = limits.min > 0 && currentTokens >= limits.min

    if (!overMin) {
        if (nudges.turnNudgeAnchors.length > 0 || nudges.iterationNudgeAnchors.length > 0) {
            nudges.turnNudgeAnchors = []
            nudges.iterationNudgeAnchors = []
        }
    }

    const lastIndex = messages.length - 1
    const lastMessage = messages[lastIndex] as any
    const lastMessageId = lastMessage?.id ?? lastMessage?.info?.id

    if (overMax) {
        addAnchor(
            nudges.contextLimitAnchors,
            lastMessageId,
            lastIndex,
            messages,
            getNudgeFrequency(config),
        )
    } else if (overMin) {
        // Turn nudge: fire at a user/assistant turn boundary.
        if (lastMessage?.role === "user" && lastAssistant) {
            addSpecificAnchor(nudges.turnNudgeAnchors, lastMessageId)
            const lastAssistantId = lastAssistant?.id ?? lastAssistant?.info?.id
            addSpecificAnchor(nudges.turnNudgeAnchors, lastAssistantId)
        }

        // Iteration nudge: too many messages since the last user request.
        const lastUserIndex = messages.findIndex((m) => (m as any)?.role === "user")
        if (lastUserIndex >= 0 && lastIndex > lastUserIndex) {
            const sinceUser = lastIndex - lastUserIndex
            if (sinceUser >= getIterationThreshold(config)) {
                addAnchor(
                    nudges.iterationNudgeAnchors,
                    lastMessageId,
                    lastIndex,
                    messages,
                    getNudgeFrequency(config),
                )
            }
        }
    }

    const percent = limits.max > 0 ? Math.round((currentTokens / limits.max) * 100) : 0
    // DCP nudgeForce: "soft" anchors the turn nudge on the assistant message,
    // "strong" on the user message.
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

    const injectForAnchors = (anchors: string[], marker: string, text: string, roleFilter?: string) => {
        if (!text) return
        for (const anchorId of anchors) {
            const msg = messages.find((m) => {
                const id = (m as any)?.id ?? (m as any)?.info?.id
                return id === anchorId
            })
            if (!msg) continue
            if (roleFilter && (msg as any)?.role !== roleFilter) continue
            // Idempotency via stable marker: the dynamic part of the nudge
            // (percentages) changes every request, so match on the marker only.
            if (messageHasNudge(msg, marker)) continue
            appendToMessage(msg, text)
        }
    }

    injectForAnchors(
        nudges.contextLimitAnchors,
        NUDGE_MARKERS.contextLimit,
        contextLimitNudge(percent, limits.max),
    )
    injectForAnchors(
        nudges.turnNudgeAnchors,
        NUDGE_MARKERS.turn,
        turnNudge(percent),
        targetRole,
    )
    injectForAnchors(
        nudges.iterationNudgeAnchors,
        NUDGE_MARKERS.iteration,
        iterationNudge(percent),
    )

    state.nudges = nudges
}