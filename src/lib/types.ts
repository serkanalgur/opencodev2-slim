import type { Message } from "@opencode-ai/sdk/v2"

// ─── Config Types ───────────────────────────────────────────────────────────

export interface SlimConfig {
    enabled: boolean
    debug: boolean

    // Compression settings (DCP-compatible semantics)
    compress: {
        enabled: boolean
        /** DCP mode: "range" (contiguous spans) or "message" (surgical, single messages) */
        mode?: "range" | "message"
        permission: "allow" | "ask" | "deny"
        /**
         * Compression trigger threshold. Either an absolute token count
         * (e.g. `200000` — fires once the session reaches that many tokens) or a
         * percent string of the model context window (e.g. `"80%"`, and with a
         * decimal comma for locale-typed configs, `"80,5%"`). Unusable
         * values fall back to the built-in default, never 0. (DCP default: 100000)
         */
        maxContextLimit: number | string
        /**
         * Lower (nudge floor) threshold, same dual form as `maxContextLimit`:
         * absolute token count (`50000`) or percent string (`"40%"` /
         * `"40,5%"` with a decimal comma). (DCP default: 50000)
         */
        minContextLimit: number | string
        /**
         * Per-model overrides, keyed "providerId/modelId" (DCP: compress.modelMaxLimits).
         * Each entry accepts the same dual form: absolute token count or percent string.
         */
        modelMaxLimits?: Record<string, number | string>
        /**
         * Per-model overrides, keyed "providerId/modelId" (DCP: compress.modelMinLimits).
         * Each entry accepts the same dual form: absolute token count or percent string.
         */
        modelMinLimits?: Record<string, number | string>
        /** At most one limit-nudge per this many messages (DCP default: 5) */
        nudgeFrequency: number
        /** Messages since last user message before iteration nudge fires (DCP default: 15) */
        iterationNudgeThreshold?: number
        /** Where the turn nudge is anchored: "strong" -> user, "soft" -> assistant (DCP default: soft) */
        nudgeForce?: "strong" | "soft"
        protectUserMessages: boolean
        protectedTools: string[]
        /** Number of recent messages to always keep during auto-compress (default: 5) */
        keepRecent?: number
    }

    // Strategy settings
    strategies: {
        deduplication: {
            enabled: boolean
            protectedTools: string[]
        }
        purgeErrors: {
            enabled: boolean
            turns: number
            protectedTools: string[]
        }
        /**
         * DCP pruneOutputs: replace the payload of old, large, non-protected
         * tool results with a placeholder on the outgoing request only.
         *
         * OFF by default (opt-in): pruning rewrites an earlier part of the
         * prompt and therefore invalidates the provider's prefix cache, so it
         * costs a one-time full-price request per newly pruned turn.
         *
         * Every field is optional — a partial block is merged over the
         * defaults, so setting only `minChars` keeps the rest.
         */
        pruneOutputs?: {
            /** Master switch. Default: false (opt-in). */
            enabled?: boolean
            /** Minimum serialized size (chars) for an output to be eligible. Default: 2000. */
            minChars?: number
            /** At most this many outputs pruned per request. Default: 50. */
            maxPerRequest?: number
            /**
             * Tool names kept in addition to the always-protected set. Default: [].
             * `purgeErrors.protectedTools` is honoured here as well.
             */
            protectedTools?: string[]
        }
        /**
         * Never prune a tool result produced within the last `turns` turns. The
         * most important gate: the current turn's result is what the model is
         * actively working from. Optional; defaults keep it on with 4 turns.
         */
        turnProtection?: {
            /** Default: true. */
            enabled?: boolean
            /** Number of recent turns kept intact. Default: 4. */
            turns?: number
        }
    }

    /**
     * Merge tuning for the measured-vs-estimated token accounting
     * (resolveTriggerTokens). Entirely optional: every field falls back to the
     * built-in default when missing, so a partial or absent block is safe.
     */
    usage?: {
        /**
         * A measured value below this fraction of the estimate is treated as
         * stale and the estimate wins. Default: 0.5
         */
        trustRatio?: number
        /**
         * A measured value above this multiple of the estimate is treated as a
         * broken reading and capped at `capRatio * estimated`. Default: 3
         */
        capRatio?: number
    }

    // Adaptive thresholds
    adaptive: {
        enabled: boolean
        learningRate: number
        minCompressionRatio: number
    }

    // Cost awareness
    costAware: {
        enabled: boolean
        cacheBoostFactor: number
    }

    // Persistence
    persistence: {
        enabled: boolean
        directory: string
    }
}

// ─── State Types ────────────────────────────────────────────────────────────

export interface SessionState {
    sessionId: string
    modelContextLimit: number
    currentTokenCount: number
    compressionCount: number
    lastCompressionTime: number
    manualMode: boolean
    compressPermission: "allow" | "ask" | "deny" | null

    // Adaptive learning
    compressionHistory: CompressionRecord[]
    averageCompressionRatio: number

    // Tool call tracking
    toolCalls: Map<string, ToolCallInfo>

    // DCP-style compression blocks (range -> summary placeholders)
    compressionBlocks?: CompressionBlock[]
    nextBlockId?: number
    // DCP-style nudge anchors
    nudges?: NudgeState

    // Last resolved provider/model (set by injectLimitNudges)
    _lastProviderId?: string
    _lastModelId?: string

    // Id of the last compaction this state has already reset for. Optional so
    // hand-built literals (tests, tui.tsx) stay valid; absent means "unknown".
    lastCompactionMessageId?: string
    // Timestamp of the last auto-compress run, used to throttle it. Optional:
    // strategies reads it defensively via `(state as any).lastAutoCompressTime`.
    lastAutoCompressTime?: number
}

/**
 * A DCP-style compression block. When active, the covered messages are
 * removed from every outgoing request and replaced by a synthetic summary
 * message injected at the anchor message (the message right after the range).
 */
export interface CompressionBlock {
    blockId: number
    topic: string
    summary: string
    /** Message id where the summary is injected (first message after the range, or the last message when the range reaches the end). */
    anchorMessageId: string
    /** The assistant message that executed the compress call; used to deactivate blocks when the source is gone. */
    compressMessageId: string
    /** Original message ids covered (excluded) by this block. */
    coveredMessageIds: string[]
    /** Older blocks swallowed by this block (nested compression). */
    consumedBlockIds: number[]
    active: boolean
    createdAt: number
    summaryTokens: number
}

export interface NudgeState {
    contextLimitAnchors: string[]
    turnNudgeAnchors: string[]
    iterationNudgeAnchors: string[]
}

export interface CompressionRecord {
    timestamp: number
    inputTokens: number
    outputTokens: number
    ratio: number
    messageCount: number
    success: boolean
}

export interface ToolCallInfo {
    tool: string
    args: unknown
    timestamp: number
    turn: number
    error?: string
}

// ─── Message Types ──────────────────────────────────────────────────────────

export interface MessageWithParts {
    info: Message
    parts: any[]
}

export interface CompressionRange {
    start: number
    end: number
    messages: MessageWithParts[]
}

export interface CompressionResult {
    success: boolean
    summary: string
    inputTokens: number
    outputTokens: number
    ratio: number
    compressedIds: string[]
}

// ─── Cost Types ─────────────────────────────────────────────────────────────

export interface CostProfile {
    inputPricePer1k: number
    outputPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
}

export const COST_PROFILES: Record<string, CostProfile> = {
    // Anthropic
    "anthropic/claude-sonnet-4-20250514": {
        inputPricePer1k: 0.003,
        outputPricePer1k: 0.015,
        cacheReadPricePer1k: 0.0003,
        cacheWritePricePer1k: 0.00375,
    },
    "anthropic/claude-3-5-sonnet-20241022": {
        inputPricePer1k: 0.003,
        outputPricePer1k: 0.015,
        cacheReadPricePer1k: 0.0003,
        cacheWritePricePer1k: 0.00375,
    },
    // OpenAI
    "openai/gpt-4o": {
        inputPricePer1k: 0.0025,
        outputPricePer1k: 0.01,
        cacheReadPricePer1k: 0.00125,
        cacheWritePricePer1k: 0.0025,
    },
    "openai/gpt-4o-mini": {
        inputPricePer1k: 0.00015,
        outputPricePer1k: 0.0006,
        cacheReadPricePer1k: 0.000075,
        cacheWritePricePer1k: 0.00015,
    },
    // Default
    default: {
        inputPricePer1k: 0.003,
        outputPricePer1k: 0.015,
        cacheReadPricePer1k: 0.0003,
        cacheWritePricePer1k: 0.00375,
    },
}
