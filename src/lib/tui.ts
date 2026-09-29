import type { MessageWithParts, SessionState, SlimConfig, CompressionRecord } from "./types"
import type { PruneStats } from "./prune"
import { getMessageText, getToolResultContent, getToolName, countTokens } from "./compress"
import { COST_PROFILES } from "./types"
import { resolveCompressLimits } from "./config"

/**
 * Where the panel's headline `currentTokens` figure actually came from.
 * - `"measured"`  — the server's own report: the last assistant turn's usage
 *   (session.step.ended / per-message `tokens`), or the session's reported
 *   token counter when no per-message figure exists. Exact for that request.
 * - `"estimated"` — our character-count approximation of the prompt (system
 *   prompt + tool schemas + message content). A magnitude, NOT an exact count.
 */
export type PanelTokenSource = "measured" | "estimated"

// ─── Panel Data Types ──────────────────────────────────────────────────────

/**
 * Resolved compression trigger thresholds, shown both as absolute token counts
 * and as a percentage of the model context window.
 */
export interface PanelThreshold {
    /** Absolute token count at which compression triggers (maxContextLimit resolved). */
    tokens: number
    /** `tokens` as a percentage of `contextLimit`; null when the window is unknown. */
    percent: number | null
    /** Absolute token count of the nudge floor (minContextLimit resolved). */
    minTokens: number
    /** `minTokens` as a percentage of `contextLimit`; null when the window is unknown. */
    minPercent: number | null
    /** Context window the percentages are relative to (0 when unknown). */
    contextLimit: number
}

export interface PanelData {
    sessionId: string
    timestamp: number
    
    // Context usage
    /**
     * Headline figure for the usage bar: the CURRENT PROMPT SIZE (how full the
     * context window is right now), never the lifetime cumulative counter.
     */
    currentTokens: number
    /**
     * Lifetime cumulative token counter (Session.Info.tokens summed across every
     * usage event) when the server supplied one. It measures total spend — and
     * because `cache.read` re-reads the whole context each turn it grows without
     * bound — so it is displayed separately and must never drive `usagePercent`.
     */
    cumulativeTokens?: number
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
    
    /** Resolved trigger thresholds (absolute tokens + % of the context window). */
    threshold?: PanelThreshold

    /**
     * Where the headline `currentTokens` figure came from. Optional so
     * hand-built PanelData (and older callers) keep rendering; when absent the
     * renderer omits the line rather than guessing.
     */
    tokenSource?: PanelTokenSource

    /**
     * Tool-output pruning activity from the LAST outgoing request
     * (`strategies.pruneOutputs`). Deliberately NOT a cumulative or permanent
     * saving: the prune plan is rebuilt and re-applied on every request, so
     * this describes what the most recent request removed. Absent when the
     * feature is off and nothing was pruned, so the default-off case renders
     * no line at all.
     */
    prune?: {
        /** `strategies.pruneOutputs.enabled` as resolved for this session. */
        enabled: boolean
        /** Tool outputs whose payload the last request replaced. */
        prunedOutputs: number
        /** Characters removed by the last request (never negative). */
        charsSaved: number
    }
}

// ─── Panel Builder ─────────────────────────────────────────────────────────

export interface MeasuredContext {
    /**
     * LIFETIME CUMULATIVE token counter for this session: the v2 projector adds
     * `tokens_input + tokens_output + tokens_reasoning + tokens_cache_read +
     * tokens_cache_write` on every usage event. `cache.read` re-reads the whole
     * context on every turn, so this sum outgrows the context window many times
     * over (opencode issue #30649: 56.1M tokens — 41M of them cache.read — in a
     * single session). Valid as a COST statistic, invalid as "how full is the
     * window": prefer `promptTokens` for anything occupancy-related.
     */
    tokens: number
    /**
     * CURRENT PROMPT SIZE: `input + cache.read + cache.write` of the latest
     * assistant turn, i.e. exactly what that one request sent. Optional because
     * only a transcript carrying per-message token info can provide it; when it
     * is missing the panel falls back to `tokens` (cumulative) and the renderer
     * clamps the bar, so a stale/absent prompt measurement can never crash.
     */
    promptTokens?: number
    /** Real total spend for this session (Session.Info.cost). */
    cost: number
    /** Real model context window (Model.Info.limit.context). */
    contextLimit: number
    /** Real model id. */
    model: string
}

/**
 * Split a "providerId/modelId" model reference (as reported by the server) so
 * per-model limit overrides can be applied when building panel data.
 */
function splitModelRef(ref?: string): { providerId?: string; modelId?: string } {
    if (!ref) return {}
    const separator = ref.indexOf("/")
    if (separator <= 0 || separator === ref.length - 1) return {}
    return { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) }
}

export async function buildPanelData(
    sessionId: string,
    messages: MessageWithParts[],
    state: SessionState,
    config: SlimConfig,
    modelId?: string,
    measured?: MeasuredContext,
    pruneStats?: PruneStats,
): Promise<PanelData> {
    // Prefer the real model context window from the server; fall back to state/default.
    const modelContextLimit = measured?.contextLimit || state.modelContextLimit || 200000
    // Resolve the configured thresholds against the same effective window the panel
    // displays, including per-model overrides (compress.modelMaxLimits / modelMinLimits),
    // so the shown trigger is the one the request pipeline actually enforces.
    const modelRef = splitModelRef(measured?.model ?? modelId)
    const limits = resolveCompressLimits(
        config,
        { ...state, modelContextLimit },
        modelRef.providerId ?? state._lastProviderId,
        modelRef.modelId ?? state._lastModelId,
    )
    const maxTokens = limits.max
    const threshold: PanelThreshold = {
        tokens: limits.max,
        percent: modelContextLimit > 0 ? (limits.max / modelContextLimit) * 100 : null,
        minTokens: limits.min,
        minPercent: modelContextLimit > 0 ? (limits.min / modelContextLimit) * 100 : null,
        contextLimit: modelContextLimit,
    }
    
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
    //
    // Headline priority — "context fullness" must describe the prompt we are
    // about to send, not everything ever spent:
    //   1. `measured.promptTokens` — last assistant turn's input + cache.read +
    //      cache.write: the true size of one outgoing request.
    //   2. `measured.tokens` — Session.Info.tokens' LIFETIME CUMULATIVE total.
    //      Fallback for callers that only supply it (it is still better than
    //      nothing when the transcript has no token info), but it is a cost
    //      counter and can exceed the window by orders of magnitude, which is
    //      why renderPanel clamps the bar to 0..100 before String.repeat().
    //   3. Our own per-message estimate from the transcript.
    const effectiveTokens = measured?.promptTokens ?? measured?.tokens ?? currentTokens

    // Label the headline with its provenance. Kept in lockstep with the
    // `effectiveTokens` expression directly above: a measurement is used
    // whenever the caller supplied a non-null prompt size OR a reported total,
    // and only then is the figure "measured". Anything else is our transcript
    // estimate — a magnitude the user must not read as exact.
    //
    // Scope note: this describes where the PANEL's own headline figure came
    // from, NOT which branch `resolveTriggerTokens` (src/lib/usage.ts) chose for
    // the trigger. The trigger merges a different quantity — the measured
    // TOTAL (input+output+reasoning+cache) against the outgoing-prompt
    // estimate — and may fall back to the estimate via its trustRatio/capRatio
    // rules. So "measured" here can coexist with an estimate-driven trigger;
    // the README states exactly this rather than promising they always agree.
    const hasPromptMeasurement = measured?.promptTokens !== undefined && measured?.promptTokens !== null
    const hasReportedTotal = measured?.tokens !== undefined && measured?.tokens !== null
    const tokenSource: PanelTokenSource =
        hasPromptMeasurement || hasReportedTotal ? "measured" : "estimated"
    
    // Usage % shown to the user is relative to the real model context window
    // (e.g. 220k / 1M = 22%), matching what OpenCode's own UI displays. The
    // configured maxTokens (a percentage of that same window) drives nudge/compress.
    // Deliberately NOT clamped to 100 here: >100% is real information (a
    // cumulative or over-window figure) that callers may want to inspect.
    // renderPanel clamps before rendering the bar. Non-finite inputs (e.g. a
    // zero window) are normalised to 0 so status/recommendations stay sane.
    const rawPercent = modelContextLimit > 0 ? (effectiveTokens / modelContextLimit) * 100 : 0
    const usagePercent = Number.isFinite(rawPercent) ? rawPercent : 0
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
    
    // Tool-output pruning trace. Surfaced only when the feature is on OR the
    // last request actually pruned something; with the default (off) and no
    // stats there is no line to show, so the panel stays exactly as before.
    const pruneEnabled = config.strategies?.pruneOutputs?.enabled === true
    const prunedOutputs = pruneStats?.prunedOutputs ?? 0
    const prune =
        pruneEnabled || prunedOutputs > 0
            ? {
                  enabled: pruneEnabled,
                  prunedOutputs,
                  charsSaved: Math.max(0, pruneStats?.charsSaved ?? 0),
              }
            : undefined

    return {
        sessionId,
        timestamp: Date.now(),
        currentTokens: effectiveTokens,
        // Only reported when it is a distinct, larger number than the headline;
        // the renderer labels it as lifetime spend so the two are never confused.
        cumulativeTokens: measured?.tokens,
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
        threshold,
        tokenSource,
        prune,
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
    
    // Context usage bar.
    // `usagePercent` can legitimately exceed 100 when the source figure is a
    // lifetime cumulative counter or a prompt larger than the window, and
    // String.prototype.repeat() throws RangeError on negative counts — so
    // clamp BOTH the percentage and the computed segment lengths (Math.min /
    // Math.max) before repeating. +Infinity renders as a full bar, NaN and
    // -Infinity as an empty one (never "NaN%"). The raw token counts stay
    // visible on the next line, so an over-window figure is still readable.
    const barLength = 30
    const rawPercent = data.usagePercent
    const finitePercent = rawPercent === Infinity ? 100 : Number.isFinite(rawPercent) ? rawPercent : 0
    const displayPercent = Math.min(100, Math.max(0, finitePercent))
    const filledLength = Math.min(
        barLength,
        Math.max(0, Math.round((displayPercent / 100) * barLength)),
    )
    const emptyLength = barLength - filledLength
    const bar = "█".repeat(filledLength) + "░".repeat(emptyLength)
    lines.push(`│ Context: [${bar}] ${displayPercent.toFixed(1)}%`)
    lines.push(`│          ${formatTokens(data.currentTokens)} / ${formatTokens(data.maxTokens)} tokens`)
    // Provenance of the figure above. "measured" is the server's own report
    // (exact for that request); "estimated" is our character-count
    // approximation, so the user knows it is not exact. Omitted for hand-built
    // PanelData that predates the field.
    if (data.tokenSource) {
        lines.push(
            data.tokenSource === "measured"
                ? "│ Source: measured (server-reported)"
                : "│ Source: estimated (approximate)",
        )
    }
    // Lifetime cumulative spend — a different number with a different meaning
    // than the "Context" line above (spend, not occupancy). Shown only when the
    // server reported one and it actually differs from the prompt-size figure.
    if (data.cumulativeTokens !== undefined && data.cumulativeTokens > data.currentTokens) {
        lines.push(
            `│ Lifetime: ${formatTokens(data.cumulativeTokens)} tokens · cumulative spend, NOT context size`,
        )
    }
    if (data.threshold) {
        const { tokens, percent, minTokens, minPercent, contextLimit } = data.threshold
        const window =
            percent === null
                ? "window unknown"
                : `${percent.toFixed(1)}% of ${formatTokens(contextLimit)} window`
        const floor =
            minPercent === null
                ? formatTokens(minTokens)
                : `${formatTokens(minTokens)} (${minPercent.toFixed(1)}%)`
        lines.push(`│ Trigger: ${formatTokens(tokens)} tokens (${window}) · floor ${floor}`)
    }
    // Tool-output pruning trace. The plan is rebuilt and re-applied on EVERY
    // request, so this is the saving of the last outgoing request only — never
    // presented as a cumulative or permanent gain. Absent (and therefore not
    // rendered) while the default-off feature has never pruned anything.
    if (data.prune) {
        const chars = formatTokens(data.prune.charsSaved)
        const approxTokens = formatTokens(Math.round(data.prune.charsSaved / 4))
        lines.push(
            `│ Prune: ${data.prune.prunedOutputs} outputs · ~${chars} chars (~${approxTokens} tokens) saved on last request`,
        )
    }
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
