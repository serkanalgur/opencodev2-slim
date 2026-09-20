import type { MessageWithParts } from "./types"

// ─── Token Counting ─────────────────────────────────────────────────────────

let tokenizer: any = null

async function getTokenizer() {
    if (!tokenizer) {
        try {
            const mod = await import("@anthropic-ai/tokenizer")
            tokenizer = mod
        } catch {
            return null
        }
    }
    return tokenizer
}

export async function countTokens(text: string): Promise<number> {
    if (!text) return 0

    const tok = await getTokenizer()
    if (tok && tok.encode) {
        try {
            return tok.encode(text).length
        } catch {
            // Fallback to estimation
        }
    }

    // Rough estimation: ~4 chars per token for English
    return Math.ceil(text.length / 4)
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
    }

    return results.join("\n")
}

export function getToolName(msg: MessageWithParts): string | null {
    for (const part of msg.parts) {
        // v1 SDK format
        if (part.type === "tool") {
            return part.tool || null
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
