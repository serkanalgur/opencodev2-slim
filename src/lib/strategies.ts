import type { MessageWithParts, SlimConfig, SessionState, CompressionBlock } from "./types"
import { getToolName, getMessageText, getToolResultContent, countTokens } from "./compress"
import { contextLimitNudge, turnNudge, iterationNudge, NUDGE_MARKERS } from "./prompts"
import { addCompressionRecord } from "./state"

// ─── DCP-style Compression Blocks ───────────────────────────────────────────
//
// A compression block replaces a contiguous range of messages with a summary
// placeholder on every outgoing request. The summary is injected as a synthetic
// user message at the block's *anchor* message (the first message after the
// range, or the last message when the range reaches the end). The covered
// messages are removed from the outgoing request only — session history is
// never modified. Newer blocks "consume" older ones (nested compression).

// ─── Stable message keys ───────────────────────────────────────────────────
//
// OpenCode v2's `context` hook hands us Prompt.Message objects that carry NO
// message-level `id` (SessionContext.messages: Array<Message> — BaseMessage is
// { role, options } plus role-specific content). Anything keyed on `msg.id`
// therefore resolves to nothing in production, which used to make every block
// look orphaned. stableMessageKey() gives every message a deterministic,
// request-after-request reproducible key so blocks can actually be matched.

/**
 * FNV-1a, 32 bit. Small, dependency-free and fully deterministic: the same
 * input always yields the same 8-char hex digest on every platform.
 */
function fnv1a32(input: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * Deterministic JSON: object keys are sorted and `undefined`/function/symbol
 * values are dropped, so two structurally equal messages serialise to byte-
 * identical strings no matter in which order their properties were assigned.
 */
function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) return "null"
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        // JSON.stringify maps NaN/Infinity to "null", keeping the output total.
        return JSON.stringify(value)
    }
    if (typeof value === "bigint") return JSON.stringify(value.toString())
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
        return `{${entries.join(",")}}`
    }
    return "null" // functions / symbols carry no content worth hashing
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) return candidate
    }
    return undefined
}

/**
 * Produces a stable key for a message.
 *
 * Priority:
 *   1. `msg.id`            → `id:<id>`   (raw Message format)
 *   2. `msg.info.id`       → `id:<id>`   (transcript / SessionMessageInfo)
 *   3. otherwise           → `k:<role>:<contentHash>:<index>`
 *
 * The fallback embeds the message index so two identical payloads (e.g. the
 * same tool result repeated) still get distinct keys — a key must identify ONE
 * message or it is not a key. Pure: depends only on its arguments.
 */
export function stableMessageKey(message: unknown, index: number): string {
    const msg = (message ?? {}) as {
        id?: unknown
        role?: unknown
        content?: unknown
        parts?: unknown
        info?: { id?: unknown; role?: unknown }
    }

    const id = firstNonEmptyString(msg.id, msg.info?.id)
    if (id !== undefined) return `id:${id}`

    const role = firstNonEmptyString(msg.role, msg.info?.role) ?? "unknown"
    const content = msg.content ?? msg.parts ?? message
    return `k:${role}:${fnv1a32(canonicalJson(content))}:${index}`
}

/**
 * Keys that occur more than once in a request — ambiguous by definition: two
 * different messages produced the same key (duplicate id or hash collision).
 * Such keys must never drive a removal decision ("lock, never guess").
 */
export function findAmbiguousKeys(keys: readonly string[]): Set<string> {
    const counts = new Map<string, number>()
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)

    const ambiguous = new Set<string>()
    for (const [key, count] of counts) {
        if (count > 1) ambiguous.add(key)
    }
    return ambiguous
}

/**
 * Canonical key space for block references. Request keys from
 * stableMessageKey() are already prefixed (`id:` / `k:`); raw ids registered by
 * other paths (the compress tool, persisted legacy blocks) are lifted into the
 * `id:` space so both worlds resolve to the same message.
 */
function canonicalBlockKey(key: string): string {
    return key.startsWith("id:") || key.startsWith("k:") ? key : `id:${key}`
}

/**
 * Activates/deactivates blocks based on which messages are present in the
 * current outgoing request. A block is active while both its origin message
 * (compressMessageId) and its anchor message are still present. A newer active
 * block deactivates any older block whose anchor falls inside its covered range.
 *
 * References are compared in one canonical key space (see canonicalBlockKey):
 * `presentIds` carries stable message keys (`id:` / `k:` prefixes) while blocks
 * registered by the compress tool or loaded from older state carry raw ids —
 * both must resolve to the same message or a live block would look orphaned
 * and be dropped.
 *
 * `ambiguousIds` (optional) are keys produced by more than one message. A Set
 * alone cannot reveal that, so the caller passes them when it has them: a block
 * whose anchor (or origin) resolves ambiguously is never activated, because the
 * insertion point would be a guess. Such a block is still kept alive by the
 * orphan filter below (its key IS present in this request — just twice), so
 * ambiguity costs compression, never data. applyCompressedRanges() enforces the
 * same lock on its own, so callers without the extra Set stay safe too.
 */
export function syncCompressionBlocks(
    state: SessionState,
    presentIds: Set<string>,
    ambiguousIds?: Set<string>,
): void {
    const blocks = state.compressionBlocks ?? []
    if (blocks.length === 0) return

    const present = new Set<string>()
    for (const id of presentIds) present.add(canonicalBlockKey(id))
    const ambiguous = new Set<string>()
    for (const id of ambiguousIds ?? []) ambiguous.add(canonicalBlockKey(id))

    const isPresent = (id: string) => present.has(canonicalBlockKey(id))
    const isAmbiguous = (id: string) => ambiguous.has(canonicalBlockKey(id))

    for (const block of blocks) {
        const hasOrigin =
            block.compressMessageId.length > 0
                ? isPresent(block.compressMessageId) && !isAmbiguous(block.compressMessageId)
                : true
        // Safety lock: an ambiguous anchor could point at more than one
        // message, so the block is not activated this request.
        block.active =
            hasOrigin && isPresent(block.anchorMessageId) && !isAmbiguous(block.anchorMessageId)
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
            const blockCoveredKeys = new Set(block.coveredMessageIds.map(canonicalBlockKey))
            for (const older of sorted) {
                if (older.blockId >= block.blockId || !older.active) continue
                if (blockCoveredKeys.has(canonicalBlockKey(older.anchorMessageId))) {
                    older.active = false
                    for (const id of older.coveredMessageIds) {
                        const key = canonicalBlockKey(id)
                        if (!blockCoveredKeys.has(key)) {
                            block.coveredMessageIds.push(id)
                            blockCoveredKeys.add(key)
                            changed = true
                        }
                    }
                }
            }
        }
    }

    // Orphaned blocks: inactive and none of their referenced messages survive
    // (e.g. after OpenCode compaction) — safe to forget, otherwise dead entries
    // accumulate in persisted state forever. An ambiguously-keyed message still
    // IS in this request, so its key is present and the block stays alive until
    // the ambiguity clears rather than be thrown away with it.
    const alive = blocks.filter((b) => {
        if (b.active) return true
        const refs = [b.anchorMessageId, b.compressMessageId, ...(b.coveredMessageIds ?? [])]
        return refs.some(
            (id) => typeof id === "string" && (isPresent(id) || isAmbiguous(id)),
        )
    })
    if (alive.length !== blocks.length) {
        state.compressionBlocks = alive
    }
}

/**
 * Produces the outgoing message list: active blocks inject their summary at the
 * anchor and drop every covered message. Returns a new array; the caller should
 * splice it back into the event.
 *
 * Handles both Message[] (hook format) and SessionMessageInfo[] (transcript format).
 *
 * `keys` (optional) is the pre-mutation key array produced by
 * stableMessageKey() over the SAME `messages` array — one key per message.
 * When it is omitted the legacy `msg.id ?? msg.info?.id` lookup is used
 * unchanged, so existing callers keep their exact behaviour.
 *
 * Safety lock: a key produced by more than one message is ambiguous, and an
 * ambiguous message is never removed and never used as an injection point; a
 * block whose anchor cannot be resolved unambiguously is skipped entirely
 * (its covered messages stay too — no summary, no removal).
 */
export function applyCompressedRanges(
    state: SessionState,
    messages: any[],
    keys?: string[],
): any[] {
    const blocks = (state.compressionBlocks ?? []).filter((b) => b.active)
    if (blocks.length === 0 || messages.length === 0) return messages

    // A key array that does not line up with the message array cannot be
    // trusted to identify anything — lock instead of guessing.
    if (keys !== undefined && keys.length !== messages.length) return messages

    // Effective key per message, canonicalised into the same key space as the
    // block references so both raw-id and key-based blocks resolve.
    const canonicalKeys: (string | undefined)[] = messages.map((msg, i) => {
        if (keys !== undefined) return canonicalBlockKey(keys[i])
        const id = (msg as any)?.id ?? (msg as any)?.info?.id
        return typeof id === "string" ? canonicalBlockKey(id) : undefined
    })

    const ambiguousKeys = findAmbiguousKeys(
        canonicalKeys.filter((k): k is string => k !== undefined),
    )
    const presentKeys = new Set(
        canonicalKeys.filter((k): k is string => k !== undefined),
    )

    const covered = new Set<string>()
    const byAnchor = new Map<string, CompressionBlock>()
    for (const block of blocks) {
        const anchorKey = canonicalBlockKey(block.anchorMessageId)
        // No resolvable insertion point (missing or ambiguous anchor) → the
        // summary cannot be placed, so this block contributes nothing this
        // request: neither the summary nor the removal of its range.
        if (ambiguousKeys.has(anchorKey) || !presentKeys.has(anchorKey)) continue
        if (block.summary) byAnchor.set(anchorKey, block)
        for (const id of block.coveredMessageIds) covered.add(canonicalBlockKey(id))
    }

    const result: any[] = []
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const key = canonicalKeys[i]
        if (key !== undefined && !ambiguousKeys.has(key)) {
            const block = byAnchor.get(key)
            if (block && block.summary) {
                // Detect format: if messages have 'role', it's Message format.
                // If they have 'type', it's SessionMessageInfo format.
                const isHookFormat = messages.length > 0 && "role" in (messages[0] ?? {})
                if (isHookFormat) {
                    // Hook format: inject as a synthetic user message
                    result.push({
                        role: "user",
                        id: `slim-summary-${block.blockId}`,
                        content: [{ type: "text", text: block.summary }],
                    })
                } else {
                    // Transcript / SessionMessageInfo format
                    result.push({
                        type: "user",
                        id: `slim-summary-${block.blockId}`,
                        text: block.summary,
                        time: { created: Date.now() },
                    })
                }
            }
            if (covered.has(key)) {
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

    // Compare in one canonical key space: stable keys ("id:"/"k:") and raw ids
    // (legacy blocks, the compress tool) must resolve to the same message, or a
    // newer block would fail to consume an older one anchored inside its range.
    const coveredKeys = new Set(opts.coveredIds.map(canonicalBlockKey))
    const consumed = blocks
        .filter((b) => b.active && coveredKeys.has(canonicalBlockKey(b.anchorMessageId)))
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
            // hidden behind the newer summary (nested compression). Dedup in
            // canonical form so raw ids and stable keys do not both survive.
            const seen = new Set(block.coveredMessageIds.map(canonicalBlockKey))
            for (const id of target.coveredMessageIds) {
                const key = canonicalBlockKey(id)
                if (!seen.has(key)) {
                    block.coveredMessageIds.push(id)
                    seen.add(key)
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
 * Handles both hook format (content with tool-call/tool-result parts) and
 * SessionMessageInfo format (content with tool parts).
 */
export function purgeStaleToolErrors(messages: any[], turns: number): void {
    const n = messages.length
    if (n === 0) return

    // Collect errored call IDs from all message formats
    const erroredCallIds = new Set<string>()
    for (const msg of messages) {
        const contentArr = msg?.content ?? msg?.parts ?? []
        if (!Array.isArray(contentArr)) continue

        for (const part of contentArr) {
            // Format 1: tool-result with result.type === "error"
            if (part?.type === "tool-result") {
                if (part.result?.type === "error") {
                    const callId = part.toolCallID ?? part.callID
                    if (callId) erroredCallIds.add(String(callId))
                }
            }
            // Format 2: tool with state.status === "error"
            if (part?.type === "tool" && part?.state?.status === "error") {
                const callId = part.callID
                if (callId) erroredCallIds.add(String(callId))
            }
        }
    }
    if (erroredCallIds.size === 0) return

    const turnsEffective = Math.max(1, Math.floor(turns) || 1)
    for (let i = 0; i < n; i++) {
        if (i > n - turnsEffective - 1) continue // too recent — keep
        const msg = messages[i]
        const contentArr = msg?.content ?? msg?.parts ?? []
        if (!Array.isArray(contentArr)) continue

        for (const part of contentArr) {
            // Format 1: tool-call part
            if (part?.type === "tool-call") {
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
            // Format 2: tool part with state containing input
            if (part?.type === "tool") {
                const callId = part.callID
                if (!callId || !erroredCallIds.has(String(callId))) continue
                const state = part.state
                if (state?.input && typeof state.input === "object") {
                    for (const key of Object.keys(state.input)) {
                        if (typeof state.input[key] === "string" && state.input[key].length > 80) {
                            state.input[key] = "[input removed due to failed tool call]"
                        }
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

/**
 * Detects whether a message contains a compress tool call.
 * Handles both the hook format (content array with tool-call parts) and the
 * SessionMessageInfo format (assistant content with tool parts).
 */
export function messageHasCompress(msg: any): boolean {
    // Format 1: Hook format — content array with tool-call parts
    const content1 = msg?.content ?? msg?.parts ?? []
    const hasInContent = content1.some(
        (part: any) => part?.type === "tool-call" && part?.name === "compress",
    )
    if (hasInContent) return true

    // Format 2: SessionMessageInfo / transcript format — content array with tool parts
    const content2 = msg?.content ?? []
    if (Array.isArray(content2)) {
        for (const part of content2) {
            if (part?.type === "tool" && part?.name === "compress") return true
            // Some formats store tool name inside state or as text
            if (part?.type === "tool" && typeof part?.text === "string" && part.text.includes('"compress"')) return true
        }
    }

    return false
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
    providerId?: string,
    modelId?: string,
): void {
    if (config.compress.permission === "deny") return
    if (state.manualMode) return
    if (messages.length === 0) return

    // Store provider/model info on state for external access
    if (providerId) state._lastProviderId = providerId
    if (modelId) state._lastModelId = modelId

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

// ─── Auto-compress: directly compress when over limit ───────────────────────

/**
 * Automatically compresses old messages when context exceeds the max limit.
 * Called from the context hook when overMax is true — no model cooperation needed.
 * Registers a compression block so future requests use the summary instead.
 *
 * `keys` (optional) are the per-message stable keys computed on the raw
 * request BEFORE any mutation (see stableMessageKey). They are what the block
 * stores as anchorMessageId / coveredMessageIds, which is how a later request
 * recognises the same messages again — production messages carry no `id`.
 */
export async function autoCompress(
    state: SessionState,
    config: SlimConfig,
    messages: any[],
    currentTokens: number,
    limits: { max: number; min: number },
    keys?: string[],
): Promise<{ compressed: boolean; messageCount?: number; tokensSaved?: number }> {
    if (config.compress.permission === "deny") return { compressed: false }
    if (state.manualMode) return { compressed: false }
    if (limits.max <= 0) return { compressed: false }
    if (currentTokens <= limits.max) return { compressed: false }

    // Throttle: don't auto-compress more than once every 5 minutes
    const now = Date.now()
    const lastAuto = (state as any).lastAutoCompressTime ?? 0
    if (now - lastAuto < 5 * 60 * 1000) return { compressed: false }

    // Don't auto-compress if the model just compressed in the last assistant turn
    const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant")
    if (lastAssistant && messageHasCompress(lastAssistant)) return { compressed: false }

    const keepRecent = Math.max(2, config.compress.keepRecent ?? 5)

    // Message keys drive which messages a block covers, so they MUST be the
    // caller's pre-mutation keys: prune/purge/nudge rewrite message content
    // inside the request, and the persisted blocks never see those edits —
    // keys derived after them would not match on the next request.
    // Without `keys` we fall back to the legacy message-level ids. A `keys`
    // array that does not line up with `messages` is unusable, so every key
    // becomes undefined and the anchor lookup below fails → safe lock.
    const keysAligned = keys === undefined || keys.length === messages.length
    const messageKeys: (string | undefined)[] = messages.map((m: any, i: number) => {
        if (keys !== undefined) return keysAligned ? keys[i] : undefined
        const legacyId = m?.id ?? m?.info?.id
        return typeof legacyId === "string" && legacyId.length > 0 ? legacyId : undefined
    })
    // Ambiguous key (two messages, one key) → never let it cover or anchor
    // anything: the wrong message must not be closed on a guess.
    const ambiguousKeys = findAmbiguousKeys(
        messageKeys.filter((k): k is string => k !== undefined),
    )

    const messageWithParts: MessageWithParts[] = messages.map((m: any, i: number) => ({
        info: {
            id: messageKeys[i] ?? "",
            role: m?.role ?? m?.info?.role ?? "user",
            sessionID: m?.sessionID ?? m?.info?.sessionID ?? "",
            time: { created: Date.now() },
        } as any,
        parts: m?.parts ?? m?.content ?? [],
    }))

    // Select messages to compress: all except recent ones, with >100 tokens
    const targetIndices: number[] = []
    let inputTokens = 0
    for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
        const msg = messageWithParts[i]
        const text = getMessageText(msg) + getToolResultContent(msg)
        const tokens = await countTokens(text)
        if (tokens < 100) continue
        targetIndices.push(i)
        inputTokens += tokens
    }

    if (targetIndices.length === 0) {
        ;(state as any).lastAutoCompressTime = now
        return { compressed: false }
    }

    // Build summary
    const targetMessages = targetIndices.map((i) => messageWithParts[i])
    const summary = await buildCompressionSummary(
        targetMessages,
        "auto-compress: context limit exceeded",
        config.compress.protectedTools,
        config.compress.protectUserMessages,
    )
    const outputTokens = await countTokens(summary)

    // Register compression block
    const sorted = [...targetIndices].sort((a, b) => a - b)
    const coveredIndices = new Set(sorted)
    let anchorIndex = sorted[sorted.length - 1] + 1
    if (anchorIndex >= messageWithParts.length) {
        anchorIndex = messageWithParts.length - 1
        coveredIndices.delete(anchorIndex)
    }
    if (anchorIndex < 0 || anchorIndex >= messageWithParts.length) {
        ;(state as any).lastAutoCompressTime = now
        return { compressed: false }
    }

    const anchorId = messageKeys[anchorIndex]
    // No resolvable (or ambiguous) anchor → no safe insertion point for the
    // summary. Lock: register nothing rather than cover the wrong message.
    if (!anchorId || ambiguousKeys.has(anchorId)) {
        ;(state as any).lastAutoCompressTime = now
        return { compressed: false }
    }

    const coveredIds = [...coveredIndices]
        .map((i) => messageKeys[i])
        .filter(
            (id): id is string =>
                typeof id === "string" && id.length > 0 && !ambiguousKeys.has(id),
        )
    if (coveredIds.length === 0) {
        ;(state as any).lastAutoCompressTime = now
        return { compressed: false }
    }

    registerCompressionBlock(state, {
        coveredIds,
        anchorMessageId: anchorId,
        summary,
        topic: "auto-compress",
        summaryTokens: outputTokens,
    })

    // Record compression stats
    const ratio = inputTokens > 0 ? 1 - outputTokens / inputTokens : 0
    addCompressionRecord(
        state,
        {
            timestamp: now,
            inputTokens,
            outputTokens,
            ratio,
            messageCount: targetMessages.length,
            success: true,
        },
        config.adaptive.learningRate,
    )

    ;(state as any).lastAutoCompressTime = now
    return {
        compressed: true,
        messageCount: targetMessages.length,
        tokensSaved: inputTokens - outputTokens,
    }
}