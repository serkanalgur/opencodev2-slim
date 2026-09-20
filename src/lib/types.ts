import type { Message } from "@opencode-ai/sdk/v2"

// ─── Config Types ───────────────────────────────────────────────────────────

export interface SlimConfig {
    enabled: boolean
    debug: boolean

    // Compression settings
    compress: {
        enabled: boolean
        permission: "allow" | "ask" | "deny"
        maxContextLimit: number | string // number or "80%"
        minContextLimit: number | string // number or "40%"
        nudgeFrequency: number
        protectUserMessages: boolean
        protectedTools: string[]
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
