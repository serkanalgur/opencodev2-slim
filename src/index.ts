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
            if (part.type === "tool") {
                const toolPart = part as any
                toolCalls.push(
                    `${toolPart.tool}: ${JSON.stringify(toolPart.state?.input || {}).slice(0, 100)}`,
                )
                if (toolPart.state?.status === "error") {
                    errors.push(toolPart.state.error?.slice(0, 200) || "Unknown error")
                }
            }
            if (part.type === "text") {
                const text = (part as any).text
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

// ─── Plugin Entry ───────────────────────────────────────────────────────────

export default Plugin.define({
    id: "opencodev2-slim",
    async setup(ctx) {
        // Load and create default config if needed
        createDefaultConfig()
        const globalConfig = loadConfig()

        // ─── Register Compress Tool ───────────────────────────────────────
        await ctx.tool.transform((editor) => {
            editor.namespace({
                name: "slim",
                description: "Smart context management tools",
            })

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

                    // Get session ID from context or fallback
                    const sessionId = (context as any).sessionID || ""
                    const config = getConfig(sessionId)
                    const state = getState(sessionId, config)

                    try {
                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        const messageWithParts: MessageWithParts[] = messages.map((m: any) => ({
                            info: m.info || m,
                            parts: m.parts || [],
                        }))

                        // Determine what to compress
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
                            // Auto mode
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
                    const sessionId = (context as any).sessionID || ""
                    const config = getConfig(sessionId)
                    const state = getState(sessionId, config)

                    try {
                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        const messageWithParts: MessageWithParts[] = messages.map((m: any) => ({
                            info: m.info || m,
                            parts: m.parts || [],
                        }))

                        const modelId = (context as any).model?.id || "unknown"

                        const panelData = await buildPanelData(
                            sessionId,
                            messageWithParts,
                            state,
                            config,
                            modelId,
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

        // ─── System Prompt Hook ──────────────────────────────────────────
        await ctx.session.hook("context", (event) => {
            const sessionId = (event as any).sessionID || ""
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) {
                return
            }

            const state = getState(sessionId, config)

            // Track model context limit
            if ((event as any).model?.limit?.context) {
                state.modelContextLimit = (event as any).model.limit.context
            }

            // Add system prompt
            const systemPrompt = getSystemPrompt()
            event.system.push({ type: "text", text: systemPrompt })
        })

        // ─── Messages Transform Hook ─────────────────────────────────────
        await ctx.session.hook("context", async (event) => {
            const config = getConfig("")
            if (!config.enabled) {
                return
            }

            const sessionId = (event as any).sessionID || ""
            const state = getState(sessionId, config)

            // Apply pruning strategies to messages
            if (event.messages && Array.isArray(event.messages)) {
                const prunedMessages = pruneMessages(
                    event.messages as any,
                    config,
                    event.messages.length,
                )

                // Replace messages
                event.messages.length = 0
                event.messages.push(...(prunedMessages as any))

                // Check if compression nudge is needed
                let totalTokens = 0
                for (const msg of event.messages) {
                    const text = getMessageText(msg as any) + getToolResultContent(msg as any)
                    totalTokens += await countTokens(text)
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
                        info: {
                            role: "assistant",
                            sessionID: sessionId,
                        } as any,
                        parts: [{ type: "text", text: nudgeMessage }],
                    } as any)
                }

                saveSessionState(state, config.persistence.directory)
            }
        })

        // ─── Event Subscription ──────────────────────────────────────────
        const eventController = new AbortController()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
                if (event.type === "session.created") {
                    const properties = (event as any).properties || {}
                    const sessionId = properties.sessionID || ""
                    const config = getConfig(sessionId)
                    sessionConfigs.set(sessionId, config)
                    getState(sessionId, config)
                }
            }
        })()

        // ─── Cleanup ─────────────────────────────────────────────────────
        return () => {
            eventController.abort()
            // Save all states on dispose
            for (const [sessionId, state] of sessionStates.entries()) {
                const config = getConfig(sessionId)
                saveSessionState(state, config.persistence.directory)
            }
        }
    },
})
