import { Plugin } from "@opencode/plugin"
import {
    loadConfig,
    createDefaultConfig,
    resolveCompressLimits,
} from "./lib/config"
import { loadSessionState, saveSessionState, addCompressionRecord, resetOnCompaction } from "./lib/state"
import { countTokens, getMessageText, getToolResultContent } from "./lib/compress"
import {
    estimatePromptTokens,
    findLastCompactionIndex,
    measuredUsageFromTokens,
    readMeasuredUsage,
    recordUsage,
    resolveTriggerTokens,
    type MeasuredUsage,
    type UsageCache,
} from "./lib/usage"
import {
    syncCompressionBlocks,
    applyCompressedRanges,
    registerCompressionBlock,
    buildCompressionSummary,
    purgeStaleToolErrors,
    pruneInPlace,
    injectLimitNudges,
    findLastUserMessage,
    autoCompress,
    stableMessageKey,
    findAmbiguousKeys,
} from "./lib/strategies"
import { getSystemPrompt, getCompressToolDescription } from "./lib/prompts"
import { buildPrunePlan, applyPrunePlan, type PruneStats } from "./lib/prune"
import { buildPanelData, renderPanel } from "./lib/tui"
import type { SlimConfig, SessionState, MessageWithParts, CompressionBlock } from "./lib/types"

// ─── State Management ───────────────────────────────────────────────────────

const DEFAULT_MODEL_LIMIT = 200000

const sessionStates = new Map<string, SessionState>()
const sessionConfigs = new Map<string, SlimConfig>()
// Resolved context limit for the active model, per session
const sessionModelLimits = new Map<string, number>()
// Last MEASURED usage per session, fed by the `session.step.ended` event and
// seeded once per session from the transcript (see src/lib/usage.ts).
const sessionUsage: UsageCache = new Map()
// Sessions whose next request must re-read the transcript to learn a new
// compaction's message id (the compaction event itself carries no id). Kept as
// a set so the transcript is not serialized on every request.
const sessionsAwaitingCompactionCheck = new Set<string>()
// Tool-output pruning stats from the LAST outgoing request, per session. Pruning
// is rebuilt and re-applied on every request, so this is a per-request figure —
// never a cumulative saving. Overwritten each request (including with zeros when
// the feature is off) and read only by the panel tool.
const sessionPruneStats = new Map<string, PruneStats>()

function getState(sessionId: string, config: SlimConfig): SessionState {
    if (!sessionStates.has(sessionId)) {
        const state = loadSessionState(sessionId, config.persistence.directory)
        // Give every fresh state a real model limit when we know it
        const knownLimit = sessionModelLimits.get(sessionId) || DEFAULT_MODEL_LIMIT
        state.modelContextLimit = knownLimit
        sessionStates.set(sessionId, state)
    }
    return sessionStates.get(sessionId)!
}

function getConfig(sessionId: string): SlimConfig {
    return sessionConfigs.get(sessionId) || loadConfig()
}

/** Subset of v2 `ModelInfo` that matters for context-window resolution. */
type ModelLimitEntry = {
    providerID?: string
    modelID?: string
    limit?: { context?: number }
}

const isValidContextLimit = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0

const contextLimitOf = (model: ModelLimitEntry | undefined): number | undefined => {
    const context = model?.limit?.context
    return isValidContextLimit(context) ? context : undefined
}

/**
 * v2 `model.list()` resolves to `ModelListOutput = { location, data: ModelInfo[] }`
 * (verified in @opencode/client/dist/promise/generated/types.d.ts), so the array
 * lives under `.data`. Older callers and the test harness hand back the bare
 * collection instead — unwrap both shapes here rather than at every call site.
 */
function unwrapModelList(raw: unknown): ModelLimitEntry[] {
    if (Array.isArray(raw)) return raw as ModelLimitEntry[]
    if (raw && typeof raw === "object") {
        const data = (raw as { data?: unknown }).data
        if (Array.isArray(data)) return data as ModelLimitEntry[]
    }
    return []
}

// Resolve the active model's real context limit instead of hard-coding 200k.
//
// v2 signatures (verified against the installed .d.ts files):
//   ctx.model.default(): Promise<ModelDefaultOutput> = { location, data: ModelInfo | null }
//   ctx.model.list():    Promise<ModelListOutput>    = { location, data: ModelInfo[] }
// The model reference (providerID/modelID) and its `limit.context` therefore
// live under `.data`, NOT on the envelope itself, and `list()` must be awaited
// before it can be searched.
//
// Resolution order:
//   1. the active model found in `list().data` by providerID/modelID from
//      `default().data` — the exact window this session runs against;
//   2. `default().data.limit.context` — the active model's own window, used when
//      the list is empty or unavailable;
//   3. DEFAULT_MODEL_LIMIT (200000) — safety net with a warning, never the
//      normal path.
//
// There is deliberately NO "any other listed model" step: borrowing an
// unrelated model's window makes every percentage describe a model we are not
// running (GitHub issue #11 — a 128k model measured against another provider's
// 1M window). A wrong-but-plausible window is worse than a loud default.
//
// Why it matters: percent thresholds resolve as `pct/100 * contextLimit`
// (resolveThreshold → resolveCompressLimits). A 1M-window model now yields
// "80%" = 800000 instead of 160000.
export async function resolveModelContextLimit(ctx: any): Promise<number> {
    let providerID: string | undefined
    let modelID: string | undefined
    let defaultLimit: number | undefined
    let defaultError: unknown
    let sawDefault = false

    if (ctx?.model && typeof ctx.model.default === "function") {
        try {
            sawDefault = true
            // v2: the reference is `default().data` — reading it off the envelope
            // always yielded undefined and disabled the exact-match branch.
            const info: ModelLimitEntry | null | undefined = (await ctx.model.default())?.data
            providerID = info?.providerID
            modelID = info?.modelID
            defaultLimit = contextLimitOf(info ?? undefined)
        } catch (err) {
            defaultError = err
        }
    }

    // v2 returns a Promise<{ location, data }>; without `await` the search ran on
    // a Promise and threw ("models.find is not a function"), silently collapsing
    // every model to DEFAULT_MODEL_LIMIT.
    let models: ModelLimitEntry[] = []
    let listError: unknown
    let sawList = false
    if (ctx?.model && typeof ctx.model.list === "function") {
        try {
            sawList = true
            models = unwrapModelList(await ctx.model.list())
        } catch (err) {
            listError = err
        }
    }

    // 1) The active model, matched exactly against the full list.
    if (providerID && modelID) {
        const found = models.find((m) => m?.providerID === providerID && m?.modelID === modelID)
        const limit = contextLimitOf(found)
        if (limit !== undefined) return limit
    }

    // 2) The active model's own window straight from `default().data`.
    if (defaultLimit !== undefined) return defaultLimit

    // 3) Safety net — say so instead of pretending 200k is the real window.
    warnContextLimitFallback(defaultError, listError, sawDefault, sawList, models.length)
    return DEFAULT_MODEL_LIMIT
}

let warnedContextLimitFallback = false

/** Clear the warn-once guard (test hook). */
export function resetContextLimitFallbackWarning(): void {
    warnedContextLimitFallback = false
}

/** One-shot notice: percent thresholds are meaningless while we run on the fake window. */
function warnContextLimitFallback(
    defaultError: unknown,
    listError: unknown,
    sawDefault: boolean,
    sawList: boolean,
    modelCount: number,
): void {
    if (warnedContextLimitFallback) return
    warnedContextLimitFallback = true
    const describe = (called: boolean, err: unknown): string => {
        if (!called) return "not available"
        if (err instanceof Error) return `failed: ${err.message}`
        return "returned no usable limit"
    }
    console.warn(
        `[slim] could not read the model context window (default: ${describe(sawDefault, defaultError)}; list: ${describe(sawList, listError)}; ${modelCount} models listed) — using ${DEFAULT_MODEL_LIMIT}, percent thresholds are approximate`,
    )
}

// ─── State Management ───────────────────────────────────────────────────────

// Register a DCP-style compression block for the selected range. The range is
// covered (removed from future outgoing requests) and the summary is injected
// at the anchor: the first message after the range, or the latest message when
// the range reaches the end (the active user turn is never replaced).
function registerBlockForRange(
    state: SessionState,
    topic: string,
    messageWithParts: MessageWithParts[],
    targetIndices: number[],
    summary: string,
    summaryTokens: number,
): CompressionBlock | null {
    if (targetIndices.length === 0 || messageWithParts.length === 0) return null

    const sorted = [...targetIndices].sort((a, b) => a - b)
    const coveredIndices = new Set(sorted)

    let anchorIndex = sorted[sorted.length - 1] + 1
    if (anchorIndex >= messageWithParts.length) {
        anchorIndex = messageWithParts.length - 1
        coveredIndices.delete(anchorIndex)
    }
    if (anchorIndex < 0 || anchorIndex >= messageWithParts.length) return null

    const anchorId = messageWithParts[anchorIndex].info?.id
    if (!anchorId) return null

    const coveredIds = [...coveredIndices]
        .map((i) => messageWithParts[i].info?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    if (coveredIds.length === 0) return null

    return registerCompressionBlock(state, {
        coveredIds,
        anchorMessageId: anchorId,
        summary,
        topic,
        summaryTokens,
    })
}

/**
 * Wraps any message format into MessageWithParts for internal processing.
 * Handles both:
 * - Raw Message format (from context hook): { id, role, parts/content }
 * - SessionMessageInfo format (from session.context()): { id, type, text/content }
 * - Transcript format (from TUI): { type, text, content }
 */
function wrapAsMessageWithParts(msg: any): MessageWithParts {
    // Determine the role from various possible fields
    let role = "assistant"
    if (msg?.role) {
        role = msg.role
    } else if (msg?.type) {
        // SessionMessageInfo / transcript format: type -> role mapping
        const type = msg.type as string
        if (type === "user" || type === "shell" || type === "synthetic") {
            role = "user"
        } else if (type === "assistant") {
            role = "assistant"
        } else if (type === "compaction" || type === "agent" || type === "model" || type === "skill") {
            role = "system"
        } else {
            role = "assistant"
        }
    }

    // Extract ID
    const id = msg?.id ?? msg?.info?.id ?? ""

    // Build parts array from whatever format we receive
    const parts: any[] = []

    if (role === "user") {
        // User messages: text can be in msg.text, msg.content, or msg.parts
        if (typeof msg.text === "string" && msg.text) {
            parts.push({ type: "text", text: msg.text })
        } else if (Array.isArray(msg.parts)) {
            for (const p of msg.parts) {
                if (p?.type === "text" && p.text) {
                    parts.push({ type: "text", text: p.text })
                }
            }
        } else if (Array.isArray(msg.content)) {
            for (const p of msg.content) {
                if (p?.type === "text" && p.text) {
                    parts.push({ type: "text", text: p.text })
                }
            }
        }
    } else if (role === "assistant") {
        // Assistant messages: content can be an array of parts
        const contentArr = msg.content ?? msg.parts ?? []
        if (Array.isArray(contentArr)) {
            for (const p of contentArr) {
                if (p?.type === "text") {
                    parts.push({ type: "text", text: p.text || "" })
                } else if (p?.type === "tool") {
                    // SessionMessageAssistantTool format: has callID, name, state
                    const state = p.state
                    if (state?.status === "completed") {
                        parts.push({
                            type: "tool-result",
                            toolCallID: p.callID,
                            result: { value: state.content ?? state.output ?? "" },
                        })
                    } else if (state?.status === "error") {
                        parts.push({
                            type: "tool-result",
                            toolCallID: p.callID,
                            result: { type: "error", value: state.error ?? "Unknown error" },
                        })
                    }
                    // Tool call part
                    parts.push({
                        type: "tool-call",
                        name: p.name || p.tool || "",
                        input: state?.input ?? {},
                        toolCallID: p.callID,
                    })
                } else if (p?.type === "tool-call") {
                    parts.push(p)
                } else if (p?.type === "tool-result") {
                    parts.push(p)
                }
            }
        }
    } else if (role === "system") {
        // System / compaction messages
        if (typeof msg.summary === "string" && msg.summary) {
            parts.push({ type: "text", text: msg.summary })
        } else if (typeof msg.text === "string" && msg.text) {
            parts.push({ type: "text", text: msg.text })
        }
    }

    return {
        info: {
            id,
            role,
            sessionID: msg?.sessionID ?? msg?.info?.sessionID ?? "",
            time: { created: Date.now() },
        } as any,
        parts,
    }
}

// ─── Plugin Entry ───────────────────────────────────────────────────────────

export default Plugin.define({
    id: "opencodev2-slim",
    async setup(ctx) {
        createDefaultConfig()

        // Resolve the active model's real context limit once.
        // This drives accurate percentage-based thresholds instead of a hard-coded 200k.
        const initialModelLimit = await resolveModelContextLimit(ctx)

        // ─── Measured Usage Source ─────────────────────────────────────────
        // Token accounting needs the real billing of the last completed
        // request, but calling `session.context()` on every request would
        // serialize the whole transcript (megabytes in long sessions) once per
        // turn. Instead the `session.step.ended` event keeps a per-session
        // cache fresh with the exact `TokenUsageInfo` of the step that just
        // finished, and the transcript is read exactly ONCE per session to
        // seed it (cold start: plugin loaded into an already-running
        // session). Compaction invalidates the entry, because a measurement
        // taken before compaction describes a prompt that no longer exists.
        const measuredUsageFor = async (sessionID: string): Promise<MeasuredUsage | null> => {
            const cached = sessionUsage.get(sessionID)
            if (cached) return cached.usage

            try {
                const messages = await ctx.session.context({ sessionID })
                const usage = readMeasuredUsage(messages, findLastCompactionIndex(messages))
                // The "no measurement" answer is cached too — otherwise a fresh
                // session would re-read the transcript on every single request.
                recordUsage(sessionUsage, sessionID, usage)
                if (getConfig(sessionID).debug) {
                    console.log(`[slim] usage cold start: session=${sessionID}, measured=${usage?.tokens ?? "none"}`)
                }
                return usage
            } catch (err) {
                // Estimation covers us: a failed cold start must never break the request.
                if (getConfig(sessionID).debug) {
                    console.log(`[slim] usage cold start failed:`, err)
                }
                return null
            }
        }

        // ─── Register Compress Tool ───────────────────────────────────────
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "compress",
                description: getCompressToolDescription(),
                input: {
                    type: "object",
                    properties: {
                        focus: {
                            type: "string",
                            description: "What to compress (e.g., 'old exploration', 'completed tasks')",
                        },
                        mode: {
                            type: "string",
                            enum: ["auto", "range", "topic"],
                            default: "auto",
                            description: "Compression mode",
                        },
                        start: {
                            type: "number",
                            description: "Start message index (for range mode)",
                        },
                        end: {
                            type: "number",
                            description: "End message index (for range mode)",
                        },
                        topic: {
                            type: "string",
                            description: "Topic to compress (for topic mode)",
                        },
                        keepRecent: {
                            type: "number",
                            default: 5,
                            description: "Number of recent messages to always keep",
                        },
                    },
                    required: ["focus"],
                    additionalProperties: false,
                },
                options: { codemode: false },
                execute: async (input, context) => {
                    const args = input as {
                        focus: string
                        mode?: string
                        start?: number
                        end?: number
                        topic?: string
                        keepRecent?: number
                    }
                    const mode = args.mode || "auto"
                    const keepRecent = args.keepRecent || 5
                    const sessionId = context.sessionID
                    const config = getConfig(sessionId)
                    const state = getState(sessionId, config)

                    try {
                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        if (config.debug) {
                            const first = messages[0] as any
                            console.log(`[slim] compress: received ${messages.length} messages from session.context()`)
                            console.log(`[slim] compress: first message type: ${first?.type}, has text: ${typeof first?.text}, has content: ${Array.isArray(first?.content)}`)
                        }

                        const messageWithParts: MessageWithParts[] = messages.map(
                            (m: any) => wrapAsMessageWithParts(m),
                        )

                        if (config.debug) {
                            const partsCounts = messageWithParts.map((m) => m.parts.length)
                            console.log(`[slim] compress: parts per message: [${partsCounts.join(", ")}]`)
                        }

                        let targetIndices: number[] = []
                        let inputTokens = 0

                        if (mode === "range" && args.start !== undefined && args.end !== undefined) {
                            const start = Math.max(0, args.start)
                            const end = Math.min(messageWithParts.length, args.end)
                            for (let i = start; i < end; i++) {
                                targetIndices.push(i)
                                const text =
                                    getMessageText(messageWithParts[i]) +
                                    getToolResultContent(messageWithParts[i])
                                inputTokens += await countTokens(text)
                            }
                        } else if (mode === "topic" && args.topic) {
                            const topicLower = args.topic.toLowerCase()
                            for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
                                const msg = messageWithParts[i]
                                const text = getMessageText(msg) + getToolResultContent(msg)
                                if (text.toLowerCase().includes(topicLower)) {
                                    targetIndices.push(i)
                                    inputTokens += await countTokens(text)
                                }
                            }
                        } else {
                            for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
                                const msg = messageWithParts[i]
                                const text = getMessageText(msg) + getToolResultContent(msg)
                                const tokens = await countTokens(text)
                                if (tokens < 100) continue
                                targetIndices.push(i)
                                inputTokens += tokens
                            }
                        }

                        if (targetIndices.length === 0) {
                            return { content: "Nothing to compress - context is already efficient" }
                        }

                        const targetMessages = targetIndices.map((i) => messageWithParts[i])
                        const summary = await buildCompressionSummary(
                            targetMessages,
                            args.focus,
                            config.compress.protectedTools,
                            config.compress.protectUserMessages,
                        )
                        const outputTokens = await countTokens(summary)
                        const ratio = inputTokens > 0 ? 1 - outputTokens / inputTokens : 0

                        // DCP: register a compression block so future outgoing
                        // requests replace this range with the summary.
                        let blockNote = ""
                        try {
                            const block = registerBlockForRange(
                                state,
                                args.focus,
                                messageWithParts,
                                targetIndices,
                                summary,
                                outputTokens,
                            )
                            if (block) {
                                blockNote = `\n\n_Block #${block.blockId}: ${block.coveredMessageIds.length} messages will collapse into this summary on future requests (${Math.round((1 - outputTokens / Math.max(1, inputTokens)) * 100)}% smaller)._\n_To restore them: ask to reset context._`
                            }
                        } catch {
                            // Best-effort: the summary is still returned to the model.
                        }

                        addCompressionRecord(
                            state,
                            {
                                timestamp: Date.now(),
                                inputTokens,
                                outputTokens,
                                ratio,
                                messageCount: targetMessages.length,
                                success: true,
                            },
                            config.adaptive.learningRate,
                        )

                        saveSessionState(state, config.persistence.directory)

                        return {
                            content: `## Compressed ${targetMessages.length} messages\n\n${summary}\n\n---\n**Stats:** ${inputTokens} → ${outputTokens} tokens (${Math.round(ratio * 100)}% saved) | Mode: ${mode} | Focus: ${args.focus}${blockNote}`,
                        }
                    } catch (error) {
                        return {
                            content: `Error compressing: ${error instanceof Error ? error.message : "Unknown error"}`,
                        }
                    }
                },
            })

            editor.add({
                name: "panel",
                description: `Display a rich context usage panel showing:
- Current token usage vs model limit
- Measurement source (server-reported vs estimated/approximate)
- Message breakdown (user/assistant/tools)
- Token distribution by role
- Compression history and savings
- Tool-output pruning stats for the last request (when enabled)
- Cost estimate
- Topic distribution
- Smart recommendations`,
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: false },
                execute: async (_input, context) => {
                    const sessionId = context.sessionID
                    const config = getConfig(sessionId)
                    const state = getState(sessionId, config)

                    try {
                        // Pull the real, server-measured context usage for this session.
                        let measured: import("./lib/tui").MeasuredContext | undefined
                        try {
                            const info = await ctx.session.get({ sessionID: sessionId })
                            const tokens = info.tokens as any
                            // ⚠️ `info.tokens` is the session's LIFETIME CUMULATIVE
                            // counter: the v2 projector adds input/output/reasoning/
                            // cache.read/cache.write on every usage event, and
                            // cache.read re-reads the whole context each turn, so this
                            // sum grows without bound (issue #30649: 56.1M tokens in a
                            // single session, 41M of them cache.read). Valid as a cost
                            // figure, invalid as "how full is the window right now".
                            const tokenCount =
                                (tokens?.input ?? 0) +
                                (tokens?.output ?? 0) +
                                (tokens?.reasoning ?? 0) +
                                (tokens?.cache?.read ?? 0) +
                                (tokens?.cache?.write ?? 0)
                            measured = {
                                tokens: tokenCount,
                                cost: typeof info.cost === "number" ? info.cost : 0,
                                contextLimit:
                                    state.modelContextLimit || (await resolveModelContextLimit(ctx)),
                                model: (info.model && (info.model as any).id) || "unknown",
                            }
                            // Keep the model window aligned with reality.
                            state.modelContextLimit = measured.contextLimit
                            // Deliberately NOT `state.currentTokenCount = measured.tokens`:
                            // that field feeds the auto-compress trigger in the context
                            // hook below, and writing a monotonically growing cumulative
                            // total there made `totalTokens > limits.max` stay true
                            // forever — auto-compress fired on every request and the
                            // inflated value was persisted to disk. The cumulative total
                            // stays local to this panel call (shown as "Lifetime").
                        } catch {
                            // Fall through to estimation if session.get fails.
                        }

                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        // Context fullness for the panel: the last assistant turn's
                        // `input + cache.read + cache.write` is the prompt size of ONE
                        // real request (cache.read is deliberately not accumulated across
                        // turns), so it — not the cumulative counter — answers "how full
                        // is the window". buildPanelData falls back to its own
                        // transcript estimate (labelled "estimated") when the
                        // transcript carries no token info — never to
                        // `measured.tokens`, the lifetime spend counter.
                        //
                        // Same function as the request pipeline (usage.ts), so the panel
                        // and the auto-compress trigger can never disagree: backwards
                        // scan for the last `assistant` message with real usage, starting
                        // after the last COMPLETED compaction (usage recorded before a
                        // compaction describes a prompt that no longer exists).
                        if (measured) {
                            const usage = readMeasuredUsage(messages, findLastCompactionIndex(messages))
                            if (usage) {
                                measured.promptTokens = usage.promptTokens
                            }
                        }

                        const messageWithParts: MessageWithParts[] = messages.map(
                            (m: any) => wrapAsMessageWithParts(m),
                        )

                        const panelData = await buildPanelData(
                            sessionId,
                            messageWithParts,
                            state,
                            config,
                            measured?.model,
                            measured,
                            sessionPruneStats.get(sessionId),
                        )

                        const panel = renderPanel(panelData)
                        saveSessionState(state, config.persistence.directory)
                        return { content: panel }
                    } catch (error) {
                        return {
                            content: `Error generating panel: ${error instanceof Error ? error.message : "Unknown error"}`,
                        }
                    }
                },
            })
        })

        // ─── System Prompt Hook (sync) ───────────────────────────────────
        await ctx.session.hook("context", (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) return

            const state = getState(sessionId, config)
            // Use the resolved real model limit, falling back to a sane default.
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            event.system.push({ type: "text", text: getSystemPrompt() })
        })

        // ─── Messages Transform Hook (sync → async) ─────────────────────────
        // DCP pipeline for every outgoing request: sync compression blocks,
        // replace covered ranges with summary placeholders, prune (dedup +
        // purge errored tool inputs + prune stale tool outputs), then apply DCP
        // limit rules as anchored nudges. Session history is never modified —
        // only this request.
        await ctx.session.hook("context", async (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            if (config.debug) {
                console.log(`[slim] context hook: session=${sessionId}, messages=${event.messages.length}, modelLimit=${state.modelContextLimit}`)
            }

            // 0) Compaction reset (before token accounting): a fresh compaction
            //    rewrote history, so every block anchor and nudge we held points
            //    into messages that no longer exist and must be dropped before
            //    this request is built. The compaction event carries no message
            //    id, so the id can only be learned from the transcript — read it
            //    only when there is something new to learn (cold start, usage
            //    cache empty, or a compaction event observed). `session.context()`
            //    serializes the whole transcript, so this must never run on every
            //    request.
            if (
                state.lastCompactionMessageId === undefined ||
                !sessionUsage.has(sessionId) ||
                sessionsAwaitingCompactionCheck.has(sessionId)
            ) {
                let transcript: unknown[] = []
                let transcriptRead = false
                try {
                    transcript = await ctx.session.context({ sessionID: sessionId })
                    transcriptRead = true
                } catch (err) {
                    if (config.debug) {
                        console.log(`[slim] compaction check: transcript read failed`, err)
                    }
                }

                if (transcriptRead) {
                    const compactionIndex = findLastCompactionIndex(transcript)
                    const compactionMessageId =
                        compactionIndex >= 0
                            ? String((transcript[compactionIndex] as { id?: unknown })?.id ?? "")
                            : ""
                    if (compactionMessageId !== state.lastCompactionMessageId) {
                        resetOnCompaction(state, compactionMessageId)
                        // A measurement taken before compaction describes a
                        // prompt that no longer exists — drop the cached usage.
                        sessionUsage.delete(sessionId)
                        // The id is now visible, so this check is settled. If it
                        // was still unchanged the pending flag stays set and the
                        // next request retries (the write may have raced us).
                        sessionsAwaitingCompactionCheck.delete(sessionId)
                        if (config.debug) {
                            console.log(`[slim] compaction reset: id=${compactionMessageId || "none"}`)
                        }
                    }
                    // Cold start / post-compaction: seed the measured usage from
                    // the read already paid for, so the trigger path below does
                    // not serialize the transcript a second time.
                    if (!sessionUsage.has(sessionId)) {
                        recordUsage(sessionUsage, sessionId, readMeasuredUsage(transcript, compactionIndex))
                    }
                }
            }

            // 1) Compression blocks: activate/deactivate and replace ranges.
            //    Keys are computed HERE, on the untouched request: the steps
            //    below rewrite message content (dedup, purge, nudges) while the
            //    persisted blocks never see those edits, so keys derived after
            //    a mutation would not match on the next request. Production
            //    Prompt.Message objects carry no `id`, so stableMessageKey
            //    falls back to role + content hash + index.
            const keys: string[] = []
            // message object -> its pre-mutation key. Consumed at step 2b, where
            // the auto-compress key array is captured over the filtered list
            // BEFORE pruning clones message objects, so every surviving message
            // keeps the stable key it had at step 1 (which is what the persisted
            // compression block must store to match again on the next request).
            const keyByMessage = new Map<object, string>()
            for (let i = 0; i < event.messages.length; i++) {
                const msg = event.messages[i] as any
                const key = stableMessageKey(msg, i)
                keys.push(key)
                if (msg && typeof msg === "object") keyByMessage.set(msg, key)
            }
            //    An ambiguous key (two messages, one key) is still *present*,
            //    so its block survives the orphan filter; the lock itself is
            //    enforced twice: syncCompressionBlocks() never activates a
            //    block on an ambiguous anchor, and applyCompressedRanges()
            //    never removes an ambiguous message and never injects at an
            //    ambiguous anchor.
            const ambiguousKeys = findAmbiguousKeys(keys)
            const presentIds = new Set(keys)
            syncCompressionBlocks(state, presentIds, ambiguousKeys)
            const beforeCount = event.messages.length
            const filtered = applyCompressedRanges(state, event.messages, keys)
            event.messages.splice(0, event.messages.length, ...filtered)

            if (config.debug && beforeCount !== filtered.length) {
                console.log(`[slim] compressed ranges: ${beforeCount} -> ${filtered.length} messages`)
            }
            if (config.debug && ambiguousKeys.size > 0) {
                console.log(`[slim] ambiguous message keys: ${ambiguousKeys.size} — compression locked for them`)
            }

            // 2) Pruning strategies (each request).
            pruneInPlace(event.messages, config)
            if (config.strategies.purgeErrors.enabled) {
                purgeStaleToolErrors(event.messages, config.strategies.purgeErrors.turns)
            }

            // 2b) Tool-output pruning (DCP pruneOutputs) — strictly AFTER
            //     deduplication. Deduplication compares exact content; if output
            //     pruning ran first, two distinct tool results would both become
            //     the same placeholder and dedup would then drop a whole turn.
            //     The plan is read-only over this request and application only
            //     shrinks payloads (never removes a message, never a tool-call
            //     part, never changes result.type). It runs BEFORE token
            //     accounting so the prompt size we measure is the size we send.
            //
            //     Capture the auto-compress keys HERE, before applyPrunePlan:
            //     applyPrunePlan replaces every pruned message with a
            //     structuredClone()d copy (prune.ts), which destroys the object
            //     identity `keyByMessage` is keyed on. Deriving the keys after
            //     prune would miss every clone and fall back to
            //     stableMessageKey() over ALREADY-MUTATED content and a shifted
            //     index — keys a later request can never match, leaving the
            //     auto-compress block inert. Prune swaps array slots but never
            //     adds or removes one, and nudges only mutate existing messages,
            //     so the array captured here stays index-aligned with the array
            //     autoCompress receives below.
            const autoKeys = event.messages.map((m, i) =>
                keyByMessage.get(m as object) ?? stableMessageKey(m, i),
            )

            const prunePlan = buildPrunePlan(event.messages, config)
            applyPrunePlan(event.messages, prunePlan)
            // Remember this request's pruning for the panel. Overwritten every
            // request (zeros when pruning is off), because the figure describes
            // the request we just built — it is not cumulative.
            sessionPruneStats.set(sessionId, prunePlan.stats)
            if (config.debug) {
                console.log(
                    `[slim] prune outputs: enabled=${config.strategies.pruneOutputs?.enabled === true}, pruned=${prunePlan.stats.prunedOutputs}, charsSaved=${prunePlan.stats.charsSaved}`,
                )
            }

            // 3) Token accounting: `totalTokens` MUST describe the size of the
            //    prompt we are about to send — it drives the nudge thresholds and
            //    the auto-compress check in step 5.
            //
            //    Two numbers are combined (src/lib/usage.ts):
            //    - `estimated`: EVERYTHING on the wire for this request — text,
            //      reasoning, tool-call inputs, tool results (string and v2
            //      content-block arrays), compaction summaries, the system
            //      prompt and the tool schemas. The old text-parts-only loop
            //      below missed all of that and under-reported 2-5x, which is
            //      why auto-compress never fired in production.
            //    - `measured`: the provider's real billing of the last completed
            //      request, kept fresh by the `session.step.ended` event (never
            //      `Session.Info.tokens` — a LIFETIME cumulative counter that
            //      never comes back down, issue #30649: 56.1M tokens in one
            //      session; preferring it made `totalTokens > limits.max` stay
            //      true forever and fired auto-compress on every request).
            //
            //    `resolveTriggerTokens` merges them with clamping in both
            //    directions, so a stale or broken number can neither disable
            //    nor spam the trigger. The result is written back to
            //    `state.currentTokenCount`, which also heals state files
            //    already carrying a cumulative total.
            const estimatedTokens = estimatePromptTokens(event.messages, event.system, event.tools)
            const measured = await measuredUsageFor(sessionId)
            const accounting = resolveTriggerTokens(measured, estimatedTokens, config.usage)
            const totalTokens = accounting.tokens
            state.currentTokenCount = totalTokens

            if (config.debug) {
                console.log(`[slim] token accounting: source=${accounting.source}, measured=${accounting.measured}, estimated=${accounting.estimated}, clamped=${accounting.clamped}, totalTokens=${totalTokens}, messages=${event.messages.length}, persistedCurrentTokenCount=${state.currentTokenCount}`)
            }

            // 4) DCP limit rules → anchored nudges (max 100k / min 50k by
            //    default, model overrides supported via modelMax/MinLimits).
            //    Extract provider/model from the last user message for per-model limits.
            const lastUser = findLastUserMessage(event.messages)
            const providerId =
                lastUser?.model?.providerID ??
                state._lastProviderId ??
                (typeof lastUser?.model?.id === "string" ? lastUser.model.id.split("/")[0] : undefined)
            const modelId =
                lastUser?.model?.modelID ??
                state._lastModelId ??
                (typeof lastUser?.model?.id === "string" ? lastUser.model.id.split("/").slice(1).join("/") : undefined)
            const limits = resolveCompressLimits(config, state, providerId, modelId)

            if (config.debug) {
                console.log(`[slim] limits: max=${limits.max} min=${limits.min}, totalTokens=${totalTokens}, overMax=${totalTokens > limits.max}, overMin=${totalTokens >= limits.min}`)
            }

            injectLimitNudges(state, config, event.messages, totalTokens, limits, providerId, modelId)

            if (config.debug) {
                const nudgeState = state.nudges ?? { contextLimitAnchors: [], turnNudgeAnchors: [], iterationNudgeAnchors: [] }
                console.log(`[slim] nudges: contextLimit=${nudgeState.contextLimitAnchors.length}, turn=${nudgeState.turnNudgeAnchors.length}, iteration=${nudgeState.iterationNudgeAnchors.length}`)
            }

            // 5) Auto-compress: when over the max limit, directly compress old
            //    messages without waiting for the model to call the compress tool.
            //    Registers a compression block so future requests use the summary.
            //    `totalTokens` is this request's prompt size (step 3), never the
            //    session's lifetime cumulative counter — otherwise every long
            //    session would compress on every single request.
            if (totalTokens > limits.max) {
                if (config.debug) {
                    console.log(`[slim] auto-compress triggered: ${totalTokens} > ${limits.max} (max)`)
                }
                try {
                    // `autoKeys` was captured before tool-output pruning (step
                    // 2b), using the pre-mutation keys for every surviving
                    // message and the id/hash fallback for freshly created ones
                    // (summary placeholders). Prune and nudges never change the
                    // array's length or order, so the array is still aligned with
                    // `event.messages` here — this is the key fix: recomputing
                    // after prune would miss the structuredClone()d copies.
                    const result = await autoCompress(
                        state,
                        config,
                        event.messages,
                        totalTokens,
                        limits,
                        autoKeys,
                    )
                    if (config.debug && result.compressed) {
                        console.log(`[slim] auto-compress: compressed ${result.messageCount} messages, saved ~${result.tokensSaved} tokens`)
                    }
                } catch (err) {
                    if (config.debug) {
                        console.log(`[slim] auto-compress failed:`, err)
                    }
                    // Best-effort: auto-compress failure should never break the request.
                }
            }

            if (config.debug) {
                console.log(`[slim] final messages: ${event.messages.length}, tokens: ${totalTokens}, limits: max=${limits.max} min=${limits.min}`)
            }

            saveSessionState(state, config.persistence.directory)
        })

        // ─── Compaction Hook ────────────────────────────────────────────
        // Real, persistent context compression: when OpenCode compacts a session,
        // provide a structured summary so history actually shrinks (unlike the
        // `context` hook, which only affects the outgoing model request).
        await ctx.session.hook("compaction", async (event) => {
            const sessionId = (event as any).sessionID
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) return

            const messages = (event as any).messages || []
            if (!messages.length) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            // Build a structured summary instead of just stringifying.
            const lines: string[] = []
            lines.push("## Session Summary (Compacted)")
            lines.push("")

            const summaryParts: string[] = []
            const toolCallsSummary: string[] = []
            const keyDecisions: string[] = []
            let userMessageCount = 0
            let assistantMessageCount = 0

            for (const msg of messages) {
                const type = msg?.type ?? msg?.role ?? ""
                if (type === "user" || type === "shell" || type === "synthetic") {
                    userMessageCount++
                    const text = msg.text ?? ""
                    if (text.trim().length > 0) {
                        summaryParts.push(`[User]: ${text.slice(0, 300)}`)
                    }
                } else if (type === "assistant") {
                    assistantMessageCount++
                    const content = msg.content ?? msg.parts ?? []
                    if (Array.isArray(content)) {
                        for (const part of content) {
                            if (part?.type === "text" && part.text) {
                                const t = part.text
                                if (t.length > 0) {
                                    summaryParts.push(`[Assistant]: ${t.slice(0, 300)}`)
                                }
                                // Capture decisions
                                if (t.includes("decided") || t.includes("implemented") || t.includes("created")) {
                                    keyDecisions.push(t.slice(0, 200))
                                }
                            } else if (part?.type === "tool" || part?.type === "tool-call") {
                                const name = part.name ?? part.tool ?? "unknown"
                                toolCallsSummary.push(name)
                            }
                        }
                    }
                } else if (type === "compaction") {
                    // Previous compaction summary — include verbatim
                    if (msg.summary) {
                        summaryParts.push(`[Previous summary]: ${msg.summary.slice(0, 500)}`)
                    }
                }
            }

            // Compose summary
            lines.push(`Messages: ${userMessageCount} user, ${assistantMessageCount} assistant`)
            if (toolCallsSummary.length > 0) {
                const uniqueTools = [...new Set(toolCallsSummary)]
                lines.push(`Tools used: ${uniqueTools.join(", ")}`)
            }
            lines.push("")

            // Key exchanges (first few and last few, skip middle)
            const keepFirst = Math.min(3, summaryParts.length)
            const keepLast = Math.min(3, summaryParts.length)
            if (keepFirst + keepLast < summaryParts.length) {
                lines.push("### Key exchanges")
                for (const s of summaryParts.slice(0, keepFirst)) {
                    lines.push(s)
                }
                lines.push("...")
                for (const s of summaryParts.slice(-keepLast)) {
                    lines.push(s)
                }
            } else {
                lines.push("### Conversation")
                for (const s of summaryParts) {
                    lines.push(s)
                }
            }

            if (keyDecisions.length > 0) {
                lines.push("")
                lines.push("### Key decisions")
                for (const d of keyDecisions.slice(0, 5)) {
                    lines.push(`- ${d}`)
                }
            }

            const summary = lines.join("\n")
            const inputTokens = await countTokens(messages.map((m: any) => m.text ?? "").join("\n"))
            const outputTokens = await countTokens(summary)

            if (outputTokens > 0 && inputTokens > 0) {
                addCompressionRecord(
                    state,
                    {
                        timestamp: Date.now(),
                        inputTokens,
                        outputTokens,
                        ratio: inputTokens > outputTokens ? 1 - outputTokens / inputTokens : 0,
                        messageCount: messages.length,
                        success: true,
                    },
                    config.adaptive.learningRate,
                )
                saveSessionState(state, config.persistence.directory)
            }

            // Record our own summary so OpenCode uses it instead of running the model.
            ;(event as any).result = { summary }
        })

        // ─── Event Subscription ──────────────────────────────────────────
        // A compaction rewrote history: the cached measurement describes a prompt
        // that no longer exists, and the per-request state (blocks, nudge
        // anchors, tool calls) points at messages that are gone. Drop the cache
        // and ask the next context hook to read the transcript once to learn the
        // new compaction's message id and reset on it. `session.compacted` is
        // emitted by the server but is absent from the generated V2Event union,
        // so it is matched through a cast — inference is not an option here.
        const invalidateAfterCompaction = (sessionId: string | undefined): void => {
            if (typeof sessionId !== "string" || sessionId.length === 0) return
            sessionUsage.delete(sessionId)
            sessionsAwaitingCompactionCheck.add(sessionId)
        }
        const eventController = new AbortController()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
                if (event.type === "session.created") {
                    const props = (event as any).properties || {}
                    const sessionId = props.sessionID || ""
                    const config = getConfig(sessionId)
                    sessionConfigs.set(sessionId, config)
                    sessionModelLimits.set(sessionId, initialModelLimit)
                    getState(sessionId, config)
                } else if (event.type === "session.step.ended") {
                    // Real API billing for the step that just finished:
                    // { sessionID, assistantMessageID, finish, cost, tokens }.
                    // This is the "measured" side of the token accounting — it
                    // arrives here instead of being re-read from
                    // `session.context()` on every request (long transcripts
                    // serialize to megabytes). Steps that produced nothing are
                    // dropped by measuredUsageFromTokens, so they cannot
                    // overwrite a good measurement.
                    const usage = measuredUsageFromTokens(
                        event.data.tokens,
                        event.data.assistantMessageID,
                    )
                    if (usage) {
                        recordUsage(sessionUsage, event.data.sessionID, usage)
                    }
                } else if (event.type === "session.compaction.ended") {
                    invalidateAfterCompaction(event.data.sessionID)
                } else if ((event as { type: string }).type === "session.compacted") {
                    const data = (event as { data?: { sessionID?: string } }).data
                    invalidateAfterCompaction(data?.sessionID)
                }
            }
        })()

        // ─── Cleanup ─────────────────────────────────────────────────────
        return () => {
            eventController.abort()
            for (const [sessionId, state] of sessionStates.entries()) {
                const config = getConfig(sessionId)
                saveSessionState(state, config.persistence.directory)
            }
        }
    },
})
