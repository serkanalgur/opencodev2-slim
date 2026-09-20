import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
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

// ─── Plugin Entry ───────────────────────────────────────────────────────────

const server: Plugin = async (ctx) => {
    // Load and create default config if needed
    createDefaultConfig()
    const globalConfig = loadConfig()

    // ─── Compress Tool ─────────────────────────────────────────────────────
    const compressTool = tool({
        description: getCompressToolDescription(),
        args: {
            focus: z
                .string()
                .describe("What to compress (e.g., 'old exploration', 'completed tasks')"),
            mode: z
                .enum(["auto", "range", "topic"])
                .default("auto")
                .describe("Compression mode"),
            start: z.number().optional().describe("Start message index (for range mode)"),
            end: z.number().optional().describe("End message index (for range mode)"),
            topic: z.string().optional().describe("Topic to compress (for topic mode)"),
            keepRecent: z.number().default(5).describe("Number of recent messages to always keep"),
        },
        async execute(args, context) {
            const config = getConfig(context.sessionID)
            const state = getState(context.sessionID, config)

            try {
                const response = await ctx.client.session.messages({
                    path: { id: context.sessionID },
                })

                if (!response.data || response.error) {
                    return "Failed to fetch messages"
                }

                const messageList = response.data
                const messageWithParts: MessageWithParts[] = messageList.map((m) => ({
                    info: m.info,
                    parts: m.parts,
                }))

                // Determine what to compress
                let targetIndices: number[] = []
                let inputTokens = 0

                if (args.mode === "range" && args.start !== undefined && args.end !== undefined) {
                    // Range mode: compress specific range
                    const start = Math.max(0, args.start)
                    const end = Math.min(messageWithParts.length, args.end)
                    for (let i = start; i < end; i++) {
                        targetIndices.push(i)
                        const text =
                            getMessageText(messageWithParts[i]) +
                            getToolResultContent(messageWithParts[i])
                        inputTokens += await countTokens(text)
                    }
                } else if (args.mode === "topic" && args.topic) {
                    // Topic mode: compress messages matching topic
                    const topicLower = args.topic.toLowerCase()
                    for (let i = 0; i < messageWithParts.length - args.keepRecent; i++) {
                        const msg = messageWithParts[i]
                        const text = getMessageText(msg) + getToolResultContent(msg)
                        if (text.toLowerCase().includes(topicLower)) {
                            targetIndices.push(i)
                            inputTokens += await countTokens(text)
                        }
                    }
                } else {
                    // Auto mode: smart selection
                    const keepRecent = args.keepRecent
                    for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
                        const msg = messageWithParts[i]
                        const text = getMessageText(msg) + getToolResultContent(msg)
                        const tokens = await countTokens(text)

                        // Skip if too small to compress
                        if (tokens < 100) continue

                        targetIndices.push(i)
                        inputTokens += tokens
                    }
                }

                if (targetIndices.length === 0) {
                    return "Nothing to compress - context is already efficient"
                }

                // Build summary
                const targetMessages = targetIndices.map((i) => messageWithParts[i])
                const summary = buildCompressionSummary(targetMessages, args.focus)

                // Count output tokens
                const outputTokens = await countTokens(summary)
                const ratio = inputTokens > 0 ? 1 - outputTokens / inputTokens : 0

                // Record compression
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
                    title: `Compressed ${targetMessages.length} messages`,
                    output: summary,
                    metadata: {
                        inputTokens,
                        outputTokens,
                        ratio: Math.round(ratio * 100) + "%",
                        mode: args.mode,
                        focus: args.focus,
                    },
                }
            } catch (error) {
                return `Error compressing: ${error instanceof Error ? error.message : "Unknown error"}`
            }
        },
    })

    // ─── Panel Tool ────────────────────────────────────────────────────────
    const panelTool = tool({
        description: `Display a rich context usage panel showing:
- Current token usage vs model limit
- Message breakdown (user/assistant/tools)
- Token distribution by role
- Compression history and savings
- Cost estimate
- Topic distribution
- Smart recommendations`,
        args: {},
        async execute(_args, context) {
            const config = getConfig(context.sessionID)
            const state = getState(context.sessionID, config)

            try {
                const response = await ctx.client.session.messages({
                    path: { id: context.sessionID },
                })

                if (!response.data || response.error) {
                    return "Failed to fetch messages"
                }

                const messageList = response.data
                const messageWithParts: MessageWithParts[] = messageList.map((m) => ({
                    info: m.info,
                    parts: m.parts,
                }))

                // Get model ID from context if available
                const modelId = (context as any).model?.id || "unknown"

                // Build panel data
                const panelData = await buildPanelData(
                    context.sessionID,
                    messageWithParts,
                    state,
                    config,
                    modelId,
                )

                // Render panel
                const panel = renderPanel(panelData)

                return {
                    title: "Context Panel",
                    output: panel,
                    metadata: {
                        usagePercent: panelData.usagePercent,
                        status: panelData.status,
                        currentTokens: panelData.currentTokens,
                        maxTokens: panelData.maxTokens,
                    },
                }
            } catch (error) {
                return `Error generating panel: ${error instanceof Error ? error.message : "Unknown error"}`
            }
        },
    })

    // ─── Return Hooks ──────────────────────────────────────────────────────
    return {
        config: async (opencodeConfig) => {
            // Add tool permissions
            if (!opencodeConfig.permission) {
                opencodeConfig.permission = {} as any
            }
            ;(opencodeConfig.permission as any).compress = globalConfig.compress.permission
            ;(opencodeConfig.permission as any).panel = "allow"
        },

        tool: {
            compress: compressTool,
            panel: panelTool,
        },

        "experimental.chat.system.transform": async (input, output) => {
            const config = getConfig(input.sessionID || "")
            if (!config.enabled || !config.compress.enabled) {
                return
            }

            const state = getState(input.sessionID || "", config)

            // Track model context limit
            if (input.model?.limit?.context) {
                state.modelContextLimit = input.model.limit.context
            }

            // Add system prompt
            const systemPrompt = getSystemPrompt()
            if (output.system.length > 0) {
                output.system[output.system.length - 1] += "\n\n" + systemPrompt
            } else {
                output.system.push(systemPrompt)
            }
        },

        "experimental.chat.messages.transform": async (input, output) => {
            const config = getConfig("")
            if (!config.enabled) {
                return
            }

            // Get session ID from first message if available
            const sessionId = output.messages[0]?.info.sessionID || ""
            const state = getState(sessionId, config)

            // Apply pruning strategies
            const prunedMessages = pruneMessages(
                output.messages as any,
                config,
                output.messages.length,
            )

            // Replace messages
            output.messages.length = 0
            output.messages.push(...(prunedMessages as any))

            // Check if compression nudge is needed
            let totalTokens = 0
            for (const msg of output.messages) {
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
                output.messages.length,
            )

            if (shouldComp.compress && !state.manualMode) {
                // Inject nudge as a system message
                const nudgeMessage = getNudgeMessage(
                    shouldComp.reason,
                    totalTokens,
                    maxTokens,
                )
                output.messages.push({
                    info: {
                        role: "assistant",
                        sessionID: sessionId,
                    } as any,
                    parts: [{ type: "text", text: nudgeMessage }],
                } as any)
            }

            saveSessionState(state, config.persistence.directory)
        },

        event: async (input) => {
            const event = input.event
            if (event.type === "session.created") {
                const sessionId = (event as any).properties?.sessionID || ""
                const config = getConfig(sessionId)
                sessionConfigs.set(sessionId, config)
                getState(sessionId, config)
            }
        },

        dispose: async () => {
            // Save all states on dispose
            for (const [sessionId, state] of sessionStates.entries()) {
                const config = getConfig(sessionId)
                saveSessionState(state, config.persistence.directory)
            }
        },
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildCompressionSummary(messages: MessageWithParts[], focus: string): string {
    const lines: string[] = []
    lines.push(`## Compression Summary`)
    lines.push(`Focus: ${focus}`)
    lines.push(`Messages compressed: ${messages.length}`)
    lines.push("")

    // Extract key information
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

export default { id: "opencodev2-slim", server }
