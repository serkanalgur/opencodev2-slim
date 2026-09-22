import type { MessageWithParts } from "./types"

// ─── Token Counting ─────────────────────────────────────────────────────────

let anthropicTokenizer: any = null
let tiktokenTokenizer: any = null

async function getAnthropicTokenizer() {
    if (!anthropicTokenizer) {
        try {
            const mod = await import("@anthropic-ai/tokenizer")
            anthropicTokenizer = mod
        } catch {
            return null
        }
    }
    return anthropicTokenizer
}

async function getTiktoken() {
    if (!tiktokenTokenizer) {
        try {
            const mod = await import("tiktoken")
            tiktokenTokenizer = mod
        } catch {
            return null
        }
    }
    return tiktokenTokenizer
}

/**
 * Count tokens for the given text. Tries providers in order:
 * 1. Anthropic tokenizer (if available) — most accurate for Claude models
 * 2. tiktoken (if available) — accurate for OpenAI models
 * 3. Rough estimation: ~4 chars per token (best guess for mixed content)
 */
export async function countTokens(text: string): Promise<number> {
    if (!text) return 0

    // Try Anthropic tokenizer first
    const anth = await getAnthropicTokenizer()
    if (anth && anth.encode) {
        try {
            return anth.encode(text).length
        } catch {
            // Fall through
        }
    }

    // Try tiktoken
    const tk = await getTiktoken()
    if (tk && tk.encoding_for_model) {
        try {
            const enc = tk.encoding_for_model("gpt-4")
            const tokens = enc.encode(text)
            enc.free()
            return tokens.length
        } catch {
            // Fall through
        }
    }

    // Rough estimation: ~4 chars per token for English, ~2-3 for CJK
    // Count non-ASCII characters for a slightly better estimate
    const nonAsciiCount = (text.match(/[^\x00-\x7F]/g) || []).length
    const asciiLen = text.length - nonAsciiCount
    const estimatedTokens = Math.ceil(asciiLen / 4) + Math.ceil(nonAsciiCount / 2)
    return Math.max(1, estimatedTokens)
}

// ─── Message Text Extraction ────────────────────────────────────────────────

export function getMessageText(msg: MessageWithParts): string {
    const texts: string[] = []

    for (const part of msg.parts) {
        if (part.type === "text") {
            if (part.text) {
                texts.push(part.text)
            }
        }
    }

    return texts.join("\n")
}

export function getToolResultContent(msg: MessageWithParts): string {
    const results: string[] = []

    for (const part of msg.parts) {
        // v1 SDK format: type === "tool"
        if (part.type === "tool" && part.state?.type === "result" && part.state?.output) {
            results.push(String(part.state.output).slice(0, 500))
        }
        // v2 AI format: type === "tool-result"
        if (part.type === "tool-result" && part.result) {
            const val = part.result.value
            if (val !== undefined && val !== null) {
                results.push(String(val).slice(0, 500))
            }
        }
        // SessionMessageInfo format: tool with state.status === "completed"
        if (part.type === "tool" && part.state?.status === "completed") {
            const output = part.state.content ?? part.state.output
            if (output !== undefined && output !== null) {
                results.push(String(output).slice(0, 500))
            }
        }
    }

    return results.join("\n")
}

export function getToolName(msg: MessageWithParts): string | null {
    for (const part of msg.parts) {
        // v1 SDK format
        if (part.type === "tool") {
            return part.tool || part.name || null
        }
        // v2 AI format
        if (part.type === "tool-call") {
            return part.name || null
        }
    }
    return null
}

// ─── Compression Decision ───────────────────────────────────────────────────

export function shouldCompress(
    currentTokens: number,
    maxTokens: number,
    minTokens: number,
    lastCompressionTime: number,
    nudgeFrequency: number,
    messageCount: number,
): { compress: boolean; reason: string } {
    const usagePercent = (currentTokens / maxTokens) * 100
    const timeSinceLastCompression = Date.now() - lastCompressionTime
    const minutesSinceLast = timeSinceLastCompression / (1000 * 60)

    // Hard limit: must compress
    if (currentTokens >= maxTokens) {
        return { compress: true, reason: "Context limit reached" }
    }

    // Soft limit: recommend compression
    if (currentTokens >= minTokens) {
        if (minutesSinceLast >= nudgeFrequency) {
            return {
                compress: true,
                reason: `Context at ${usagePercent.toFixed(0)}% (${currentTokens}/${maxTokens} tokens)`,
            }
        }
    }

    // Very high usage: always recommend
    if (usagePercent > 90) {
        return {
            compress: true,
            reason: `Context critically high at ${usagePercent.toFixed(0)}%`,
        }
    }

    return { compress: false, reason: "" }
}
