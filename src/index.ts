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

const sessionStates = new Map<string, SessionState>()
const sessionConfigs = new Map<string, SlimConfig>()

function getState(sessionId: string, config: SlimConfig): SessionState {
    if (!sessionStates.has(sessionId)) {
        const state = loadSessionState(sessionId, config.persistence.directory)
        sessionStates.set(sessionId, state)
    }
    return sessionStates.get(sessionId)!
}

function getConfig(sessionId: string): SlimConfig {
    return sessionConfigs.get(sessionId) || loadConfig()
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
        const globalConfig = loadConfig()

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
            state.modelContextLimit = 200000 // default; updated by tool calls

            event.system.push({ type: "text", text: getSystemPrompt() })
        })

        // ─── Messages Transform Hook (sync) ──────────────────────────────
        await ctx.session.hook("context", (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = getState(sessionId, config)

            // Apply pruning strategies
            const pruned = pruneMessages(
                event.messages.map((m: any) => wrapAsMessageWithParts(m)),
                config,
                event.messages.length,
            )

            // Replace messages in-place
            event.messages.length = 0
            for (const msg of pruned) {
                event.messages.push(msg as any)
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

        // ─── Event Subscription ──────────────────────────────────────────
        const eventController = new AbortController()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
                if (event.type === "session.created") {
                    const props = (event as any).properties || {}
                    const sessionId = props.sessionID || ""
                    const config = getConfig(sessionId)
                    sessionConfigs.set(sessionId, config)
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
