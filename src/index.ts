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
// ctx.model.default() returns { data: ModelInfo | null }, where ModelInfo.limit.context
// holds the model's context window. Use it directly and only fall back when missing.
async function resolveModelContextLimit(ctx: any): Promise<number> {
    try {
        const selected: { data?: { limit?: { context?: number } } | null } | undefined =
            await ctx.model.default()
        const limit = selected?.data?.limit?.context
        return typeof limit === "number" && limit > 0 ? limit : DEFAULT_MODEL_LIMIT
    } catch {
        return DEFAULT_MODEL_LIMIT
    }
}

// Compose the exact text used to summarize a transcript (used by compaction).
function stringifyTranscript(v: unknown): string {
    // A compact but useful representation of the transcript to be summarized.
    const text = String(v)
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function wrapAsMessageWithParts(msg: any): MessageWithParts {
    const msgInfo = msg.info
    const id = (msg && (msg.id || msgInfo?.id)) || ""
    const role = (msg && (msg.role || msgInfo?.role)) || "user"
    return {
        info: {
            id,
            role,
            sessionID: (msg && (msg.sessionID || msgInfo?.sessionID)) || "",
            time: { created: Date.now() },
        } as any,
        parts: (msg && (msg.parts || msg.content)) || [],
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

                        const messageWithParts: MessageWithParts[] = messages.map(
                            (m: any) => wrapAsMessageWithParts(m),
                        )

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

        // ─── Messages Transform Hook (sync) ──────────────────────────────
        // DCP pipeline for every outgoing request: sync compression blocks,
        // replace covered ranges with summary placeholders, prune (dedup +
        // purge errored tool inputs), then apply DCP limit rules as anchored
        // nudges. Session history is never modified — only this request.
        await ctx.session.hook("context", (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            // 1) Compression blocks: activate/deactivate and replace ranges.
            const presentIds = new Set<string>()
            for (const msg of event.messages) {
                const id = (msg as any)?.id ?? (msg as any)?.info?.id
                if (typeof id === "string") presentIds.add(id)
            }
            syncCompressionBlocks(state, presentIds)
            const filtered = applyCompressedRanges(state, event.messages)
            event.messages.splice(0, event.messages.length, ...filtered)

            // 2) Pruning strategies (each request).
            pruneInPlace(event.messages, config)
            if (config.strategies.purgeErrors.enabled) {
                purgeStaleToolErrors(event.messages, config.strategies.purgeErrors.turns)
            }

            // 3) Token accounting: prefer the server-measured count; fall back
            //    to a quick estimate (~4 chars per token).
            let estimatedTokens = 0
            for (const msg of event.messages) {
                const content = (msg as any)?.content ?? (msg as any)?.parts
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
            const lastUser = findLastUserMessage(event.messages)
            const providerId =
                lastUser?.model?.providerID ?? lastUser?.model?.id?.split?.("/")[0]
            const modelId =
                lastUser?.model?.modelID ??
                lastUser?.model?.id?.split?.("/").slice(1).join("/")
            const limits = resolveCompressLimits(config, state, providerId, modelId)
            injectLimitNudges(state, config, event.messages, totalTokens, limits)

            saveSessionState(state, config.persistence.directory)
        })

        // ─── Compaction Hook ────────────────────────────────────────────
        // Real, persistent context compression: when OpenCode compacts a session,
        // summarize the transcript so history actually shrinks (unlike the
        // `context` hook, which only affects the outgoing model request).
        await ctx.session.hook("compaction", async (event) => {
            const sessionId = (event as any).sessionID
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) return

            const messages = (event as any).messages || []
            if (!messages.length) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            const summary = stringifyTranscript(messages)
            const inputTokens = await countTokens(summary)
            const outputTokens = await countTokens(summary)

            if (outputTokens > 0 && inputTokens > outputTokens) {
                addCompressionRecord(
                    state,
                    {
                        timestamp: Date.now(),
                        inputTokens,
                        outputTokens,
                        ratio: 1 - outputTokens / inputTokens,
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
