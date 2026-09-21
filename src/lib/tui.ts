import type { MessageWithParts, SessionState, SlimConfig, CompressionRecord } from "./types"
import { getMessageText, getToolResultContent, getToolName, countTokens } from "./compress"
import { COST_PROFILES } from "./types"
import { resolveTokenLimit } from "./config"

// ─── Panel Data Types ──────────────────────────────────────────────────────

export interface PanelData {
    sessionId: string
    timestamp: number
    
    // Context usage
    currentTokens: number
    maxTokens: number
    usagePercent: number
    status: "healthy" | "warning" | "critical"
    
    // Message breakdown
    messageCount: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    toolResults: number
    
    // Token breakdown
    tokensByRole: {
        user: number
        assistant: number
        tools: number
        system: number
    }
    
    // Compression stats
    compressionCount: number
    averageRatio: number
    totalTokensSaved: number
    lastCompression: CompressionRecord | null
    
    // Cost estimate
    estimatedCost: number
    costSaved: number
    model: string
    
    // Topic distribution
    topics: { topic: string; count: number; tokens: number }[]
    
    // Recommendations
    recommendations: string[]
}

// ─── Panel Builder ─────────────────────────────────────────────────────────

export interface MeasuredContext {
    /** Real context input tokens for this session (Session.Info.tokens.input). */
    tokens: number
    /** Real total spend for this session (Session.Info.cost). */
    cost: number
    /** Real model context window (Model.Info.limit.context). */
    contextLimit: number
    /** Real model id. */
    model: string
}

export async function buildPanelData(
    sessionId: string,
    messages: MessageWithParts[],
    state: SessionState,
    config: SlimConfig,
    modelId?: string,
    measured?: MeasuredContext,
): Promise<PanelData> {
    // Prefer the real model context window from the server; fall back to state/default.
    const modelContextLimit = measured?.contextLimit || state.modelContextLimit || 200000
    const maxTokens = resolveTokenLimit(config.compress.maxContextLimit, modelContextLimit)
    
    // Count tokens (estimation for role breakdown; real total used for usage %).
    let currentTokens = 0
    const tokensByRole = { user: 0, assistant: 0, tools: 0, system: 0 }
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let toolResults = 0
    
    for (const msg of messages) {
        const role = msg.info.role
        const text = getMessageText(msg)
        const toolContent = getToolResultContent(msg)
        const msgTokens = await countTokens(text + toolContent)
        currentTokens += msgTokens
        
        if (role === "user") {
            tokensByRole.user += msgTokens
            userMessages++
        } else if (role === "assistant") {
            tokensByRole.assistant += msgTokens
            assistantMessages++
        } else if (role === "tool") {
            tokensByRole.tools += msgTokens
        }
        
        // Count tool parts
        for (const part of msg.parts) {
            if (part.type === "tool") {
                const toolPart = part as any
                if (toolPart.state?.status === "completed") {
                    toolResults++
                } else {
                    toolCalls++
                }
            }
        }
    }
    
    // Tools token bucket: captured separately above; keep it consistent.
    tokensByRole.tools = Math.max(tokensByRole.tools, 0)
    tokensByRole.system = Math.max(0, currentTokens - tokensByRole.user - tokensByRole.assistant - tokensByRole.tools)
    
    // Prefer the server-measured real token count for the headline usage figure.
    // Role buckets remain our estimate for breakdown detail.
    const effectiveTokens = measured?.tokens ?? currentTokens
    
    // Usage % shown to the user is relative to the real model context window
    // (e.g. 220k / 1M = 22%), matching what OpenCode's own UI displays. The
    // configured maxTokens (a percentage of that same window) drives nudge/compress.
    const usageBase = measured?.contextLimit ? modelContextLimit : modelContextLimit
    const usagePercent = (effectiveTokens / modelContextLimit) * 100
    let status: "healthy" | "warning" | "critical" = "healthy"
    if (usagePercent > 90) status = "critical"
    else if (usagePercent > 70) status = "warning"
    
    // Compression stats
    const compressionCount = state.compressionCount
    const averageRatio = state.averageCompressionRatio
    let totalTokensSaved = 0
    for (const record of state.compressionHistory) {
        if (record.success) {
            totalTokensSaved += record.inputTokens - record.outputTokens
        }
    }
    const lastCompression = state.compressionHistory.length > 0
        ? state.compressionHistory[state.compressionHistory.length - 1]
        : null
    
    // Cost: prefer the server-measured real spend; else estimate from tokens.
    const profile = COST_PROFILES[modelId || "default"] || COST_PROFILES.default
    const estimatedCost = measured?.cost ?? (currentTokens / 1000) * profile.inputPricePer1k
    const costSaved = (totalTokensSaved / 1000) * profile.inputPricePer1k
    
    // Topic distribution
    const topicMap = new Map<string, { count: number; tokens: number }>()
    for (const msg of messages) {
        const text = getMessageText(msg)
        const topics = extractTopics(text)
        for (const topic of topics) {
            const existing = topicMap.get(topic) || { count: 0, tokens: 0 }
            existing.count++
            existing.tokens += await countTokens(text)
            topicMap.set(topic, existing)
        }
    }
    const topics = Array.from(topicMap.entries())
        .map(([topic, data]) => ({ topic, ...data }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 10)
    
    // Recommendations
    const recommendations = generateRecommendations(
        usagePercent,
        compressionCount,
        averageRatio,
        messages.length,
        config,
    )
    
    return {
        sessionId,
        timestamp: Date.now(),
        currentTokens: effectiveTokens,
        maxTokens,
        usagePercent,
        status,
        messageCount: messages.length,
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        tokensByRole,
        compressionCount,
        averageRatio,
        totalTokensSaved,
        lastCompression,
        estimatedCost,
        costSaved,
        model: measured?.model || modelId || "unknown",
        topics,
        recommendations,
    }
}

// ─── Topic Extraction ──────────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
    "authentication": ["auth", "login", "password", "token", "session", "jwt"],
    "database": ["database", "db", "sql", "query", "migration", "schema"],
    "api": ["api", "endpoint", "route", "request", "response", "http"],
    "testing": ["test", "spec", "assert", "expect", "describe", "jest"],
    "configuration": ["config", "settings", "env", "environment", "variable"],
    "deployment": ["deploy", "docker", "kubernetes", "ci", "cd", "pipeline"],
    "ui": ["ui", "component", "render", "display", "style", "css"],
    "error": ["error", "exception", "catch", "throw", "debug", "fix"],
    "performance": ["performance", "optimize", "cache", "speed", "slow"],
    "security": ["security", "encrypt", "decrypt", "hash", "sanitize"],
}

function extractTopics(text: string): string[] {
    const lower = text.toLowerCase()
    const topics: string[] = []
    
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
        if (keywords.some((kw) => lower.includes(kw))) {
            topics.push(topic)
        }
    }
    
    return topics.length > 0 ? topics : ["general"]
}

// ─── Recommendations ───────────────────────────────────────────────────────

function generateRecommendations(
    usagePercent: number,
    compressionCount: number,
    averageRatio: number,
    messageCount: number,
    config: SlimConfig,
): string[] {
    const recs: string[] = []
    
    if (usagePercent > 80) {
        recs.push("Context usage is high. Consider compressing older messages.")
    }
    
    if (usagePercent > 90) {
        recs.push("Context nearly full! Run compress immediately to avoid truncation.")
    }
    
    if (compressionCount === 0 && messageCount > 20) {
        recs.push("No compressions yet with many messages. Consider running compress.")
    }
    
    if (averageRatio < 0.3 && compressionCount > 0) {
        recs.push("Compression ratio is low. Summaries may be too verbose.")
    }
    
    if (messageCount > 50 && usagePercent < 50) {
        recs.push("Many messages but low usage. Deduplication may help further.")
    }
    
    if (recs.length === 0) {
        recs.push("Context is healthy. No action needed.")
    }
    
    return recs
}

// ─── Panel Renderer ────────────────────────────────────────────────────────

export function renderPanel(data: PanelData): string {
    const lines: string[] = []
    
    // Header
    lines.push("┌─────────────────────────────────────────────────────────────┐")
    lines.push("│                    SLIM CONTEXT PANEL                       │")
    lines.push("├─────────────────────────────────────────────────────────────┤")
    
    // Status indicator
    const statusIcon = data.status === "healthy" ? "🟢" : data.status === "warning" ? "🟡" : "🔴"
    lines.push(`│ Status: ${statusIcon} ${data.status.toUpperCase().padEnd(10)} │`)
    lines.push("")
    
    // Context usage bar
    const barLength = 30
    const filledLength = Math.round((data.usagePercent / 100) * barLength)
    const emptyLength = barLength - filledLength
    const bar = "█".repeat(filledLength) + "░".repeat(emptyLength)
    lines.push(`│ Context: [${bar}] ${data.usagePercent.toFixed(1)}%`)
    lines.push(`│          ${formatTokens(data.currentTokens)} / ${formatTokens(data.maxTokens)} tokens`)
    lines.push("")
    
    // Message breakdown
    lines.push("│ Messages:")
    lines.push(`│   User: ${data.userMessages}  Assistant: ${data.assistantMessages}`)
    lines.push(`│   Tool calls: ${data.toolCalls}  Results: ${data.toolResults}`)
    lines.push("")
    
    // Token breakdown
    lines.push("│ Token Distribution:")
    lines.push(`│   User: ${formatTokens(data.tokensByRole.user)}`)
    lines.push(`│   Assistant: ${formatTokens(data.tokensByRole.assistant)}`)
    lines.push("")
    
    // Compression stats
    lines.push("│ Compression Stats:")
    lines.push(`│   Count: ${data.compressionCount}`)
    lines.push(`│   Avg ratio: ${(data.averageRatio * 100).toFixed(1)}%`)
    lines.push(`│   Tokens saved: ${formatTokens(data.totalTokensSaved)}`)
    if (data.lastCompression) {
        const ago = Date.now() - data.lastCompression.timestamp
        lines.push(`│   Last: ${formatTimeAgo(ago)} ago`)
    }
    lines.push("")
    
    // Cost
    lines.push("│ Cost Estimate:")
    lines.push(`│   Current: $${data.estimatedCost.toFixed(4)}`)
    lines.push(`│   Saved: $${data.costSaved.toFixed(4)}`)
    lines.push(`│   Model: ${data.model}`)
    lines.push("")
    
    // Topics
    if (data.topics.length > 0) {
        lines.push("│ Top Topics:")
        for (const topic of data.topics.slice(0, 5)) {
            lines.push(`│   ${topic.topic}: ${topic.count} msgs (${formatTokens(topic.tokens)})`)
        }
        lines.push("")
    }
    
    // Recommendations
    lines.push("│ Recommendations:")
    for (const rec of data.recommendations) {
        lines.push(`│   • ${rec}`)
    }
    
    lines.push("└─────────────────────────────────────────────────────────────┘")
    
    return lines.join("\n")
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`
    }
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`
    }
    return String(tokens)
}

function formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h`
}
