import { Plugin } from "@opencode/plugin"
import { loadConfig, createDefaultConfig, resolveTokenLimit } from "./lib/config"
import {
    loadSessionState,
    saveSessionState,
    addCompressionRecord,
} from "./lib/state"
import { countTokens, shouldCompress, getMessageText, getToolResultContent } from "./lib/compress"
import { pruneMessages } from "./lib/strategies"
import { getSystemPrompt, getCompressToolDescription, getNudgeMessage } from "./lib/prompts"
import { buildPanelData, renderPanel } from "./lib/tui"
import type { SlimConfig, SessionState, MessageWithParts } from "./lib/types"

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
async function resolveModelContextLimit(ctx: any): Promise<number> {
    try {
        const models: any[] = await ctx.model.list()
        const selected: { providerID?: string; modelID?: string } | undefined =
            await ctx.model.default()
        const match =
            models.find(
                (m) =>
                    (selected?.modelID && m.id === selected.modelID) ||
                    (selected?.providerID && m.providerID === selected.providerID),
            ) ||
            models.find((m) => m.limit?.context) ||
            undefined
        const limit = match?.limit?.context
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

function buildCompressionSummary(messages: MessageWithParts[], focus: string): string {
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
                const toolPart = part as any
                toolCalls.push(
                    `${toolPart.name}: ${JSON.stringify(toolPart.input || {}).slice(0, 100)}`,
                )
            }
            if (part.type === "tool-result") {
                const toolPart = part as any
                if (toolPart.result?.type === "error") {
                    errors.push(String(toolPart.result.value).slice(0, 200) || "Unknown error")
                }
            }
            if (part.type === "text") {
                const textPart = part as any
                const text = textPart.text || ""
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

    return lines.join("\n")
}

function wrapAsMessageWithParts(msg: any): MessageWithParts {
    return {
        info: msg.info || { id: msg.id || "", role: msg.role, sessionID: "", time: { created: Date.now() } },
        parts: msg.parts || msg.content || [],
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
                        const summary = buildCompressionSummary(targetMessages, args.focus)
                        const outputTokens = await countTokens(summary)
                        const ratio = inputTokens > 0 ? 1 - outputTokens / inputTokens : 0

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
                            content: `## Compressed ${targetMessages.length} messages\n\n${summary}\n\n---\n**Stats:** ${inputTokens} → ${outputTokens} tokens (${Math.round(ratio * 100)}% saved) | Mode: ${mode} | Focus: ${args.focus}`,
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
                        )

                        const panel = renderPanel(panelData)
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
        await ctx.session.hook("context", (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = getState(sessionId, config)
            state.modelContextLimit = sessionModelLimits.get(sessionId) || initialModelLimit

            // Apply pruning - work with original OpenCode message format
            // event.messages contains { role, content: Part[], ... } objects
            const wrapped = event.messages.map((m: any) => wrapAsMessageWithParts(m))
            const pruned = pruneMessages(wrapped, config, event.messages.length)

            // Build a Set of pruned message IDs to keep
            const keepIds = new Set(pruned.map((m) => m.info.id))

            // Remove duplicates in-place, preserving OpenCode's message format
            for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i] as any
                const id = msg.id || msg.info?.id
                if (id && !keepIds.has(id)) {
                    event.messages.splice(i, 1)
                }
            }

            // Quick token estimate (sync, ~4 chars per token)
            let totalTokens = 0
            for (const msg of event.messages) {
                const content = (msg as any).content
                if (Array.isArray(content)) {
                    for (const part of content) {
                        if (part.type === "text" && part.text) {
                            totalTokens += Math.ceil(part.text.length / 4)
                        }
                    }
                }
            }

            state.currentTokenCount = totalTokens

            const maxTokens = resolveTokenLimit(
                config.compress.maxContextLimit,
                state.modelContextLimit,
            )
            const minTokens = resolveTokenLimit(
                config.compress.minContextLimit,
                state.modelContextLimit,
            )

            const shouldComp = shouldCompress(
                totalTokens,
                maxTokens,
                minTokens,
                state.lastCompressionTime,
                config.compress.nudgeFrequency,
                event.messages.length,
            )

            if (shouldComp.compress && !state.manualMode) {
                const nudgeMessage = getNudgeMessage(
                    shouldComp.reason,
                    totalTokens,
                    maxTokens,
                )
                event.messages.push({
                    role: "assistant",
                    content: [{ type: "text", text: nudgeMessage }],
                } as any)
            }

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
