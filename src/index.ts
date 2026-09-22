import { Plugin } from "@opencode/plugin"
import {
    loadConfig,
    createDefaultConfig,
    resolveTokenLimit,
    resolveCompressLimits,
} from "./lib/config"
import { loadSessionState, saveSessionState, addCompressionRecord } from "./lib/state"
import { countTokens, getMessageText, getToolResultContent } from "./lib/compress"
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
} from "./lib/strategies"
import { getSystemPrompt, getCompressToolDescription } from "./lib/prompts"
import { buildPanelData, renderPanel } from "./lib/tui"
import type { SlimConfig, SessionState, MessageWithParts, CompressionBlock } from "./lib/types"

// ─── State Management ───────────────────────────────────────────────────────

const DEFAULT_MODEL_LIMIT = 200000

const sessionStates = new Map<string, SessionState>()
const sessionConfigs = new Map<string, SlimConfig>()
// Resolved context limit for the active model, per session
const sessionModelLimits = new Map<string, number>()

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

// Resolve the active model's real context limit instead of hard-coding 200k.
// ctx.model.default() only returns { providerID, modelID } — no limit info.
// Use ctx.model.list() to find the full Model.Info which includes limit.context.
export async function resolveModelContextLimit(ctx: any): Promise<number> {
    try {
        const defaultRef: { providerID?: string; modelID?: string } | undefined =
            typeof ctx.model.default === "function" ? await ctx.model.default() : undefined
        const providerID = defaultRef?.providerID
        const modelID = defaultRef?.modelID

        if (providerID && modelID && typeof ctx.model.list === "function") {
            const models: Array<{ providerID: string; modelID: string; limit?: { context?: number } }> =
                ctx.model.list()
            const found = models.find(
                (m) => m.providerID === providerID && m.modelID === modelID,
            )
            const limit = found?.limit?.context
            if (typeof limit === "number" && limit > 0) return limit
        }

        // Fallback: try model.list() for any model with a limit
        if (typeof ctx.model.list === "function") {
            const models: Array<{ limit?: { context?: number } }> = ctx.model.list()
            for (const m of models) {
                const limit = m.limit?.context
                if (typeof limit === "number" && limit > 0) return limit
            }
        }
    } catch {
        // Fall through to default
    }
    return DEFAULT_MODEL_LIMIT
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
                options: { codemode: true },
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
- Message breakdown (user/assistant/tools)
- Token distribution by role
- Compression history and savings
- Cost estimate
- Topic distribution
- Smart recommendations`,
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: true },
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
                            // Keep state's headline figure aligned with reality.
                            state.modelContextLimit = measured.contextLimit
                            state.currentTokenCount = measured.tokens
                        } catch {
                            // Fall through to estimation if session.get fails.
                        }

                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
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
        // purge errored tool inputs), then apply DCP limit rules as anchored
        // nudges. Session history is never modified — only this request.
        await ctx.session.hook("context", async (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            if (config.debug) {
                console.log(`[slim] context hook: session=${sessionId}, messages=${event.messages.length}, modelLimit=${state.modelContextLimit}`)
            }

            // 1) Compression blocks: activate/deactivate and replace ranges.
            const presentIds = new Set<string>()
            for (const msg of event.messages) {
                const id = (msg as any)?.id ?? (msg as any)?.info?.id
                if (typeof id === "string") presentIds.add(id)
            }
            syncCompressionBlocks(state, presentIds)
            const beforeCount = event.messages.length
            const filtered = applyCompressedRanges(state, event.messages)
            event.messages.splice(0, event.messages.length, ...filtered)

            if (config.debug && beforeCount !== filtered.length) {
                console.log(`[slim] compressed ranges: ${beforeCount} -> ${filtered.length} messages`)
            }

            // 2) Pruning strategies (each request).
            pruneInPlace(event.messages, config)
            if (config.strategies.purgeErrors.enabled) {
                purgeStaleToolErrors(event.messages, config.strategies.purgeErrors.turns)
            }

            // 3) Token accounting: prefer the server-measured count; fall back
            //    to a quick estimate (~4 chars per token).
            let estimatedTokens = 0
            for (const msg of event.messages) {
                const content = (msg as any)?.content ?? (msg as any)?.parts ?? []
                if (Array.isArray(content)) {
                    for (const part of content) {
                        if (part?.type === "text" && part.text) {
                            estimatedTokens += Math.ceil(part.text.length / 4)
                        }
                    }
                }
            }
            const totalTokens =
                state.currentTokenCount > 0 ? state.currentTokenCount : estimatedTokens
            state.currentTokenCount = totalTokens

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
            injectLimitNudges(state, config, event.messages, totalTokens, limits, providerId, modelId)

            // 5) Auto-compress: when over the max limit, directly compress old
            //    messages without waiting for the model to call the compress tool.
            //    Registers a compression block so future requests use the summary.
            if (totalTokens > limits.max) {
                if (config.debug) {
                    console.log(`[slim] auto-compress triggered: ${totalTokens} > ${limits.max} (max)`)
                }
                try {
                    const result = await autoCompress(state, config, event.messages, totalTokens, limits)
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
