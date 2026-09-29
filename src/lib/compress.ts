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

/**
 * Extract printable text out of a tool result payload.
 *
 * v2 does NOT hand back a string: a completed tool result is a content BLOCK
 * array (`SessionMessageToolStateCompleted.content`,
 * `ToolResultValue.content`) shaped `{ type: "text", text } | { type: "file",
 * uri, mime, name }`. Calling `String()` on that array produces
 * `"[object Object],[object Object]"` — the extraction silently destroyed the
 * very text it is supposed to measure, so token accounting was built on
 * garbage.
 *
 * Handling:
 * - string (v1 `state.output`, `text`/`json`/`error` values) → verbatim;
 * - content block array → `text` blocks joined; `file` blocks carry no prompt
 *   text (uri/mime/name only) and are skipped; a data-URI `data` field is kept;
 * - any other object → JSON, which is how it reaches the API anyway.
 */
export function extractToolResultText(value: unknown): string {
    if (value === null || value === undefined) return ""
    if (typeof value === "string") return value

    if (Array.isArray(value)) {
        const texts: string[] = []
        for (const block of value) {
            if (block !== null && typeof block === "object") {
                const record = block as Record<string, unknown>
                if (record.type === "text" && typeof record.text === "string") {
                    texts.push(record.text)
                    continue
                }
                if (record.type === "file") continue
                if (typeof record.data === "string") {
                    texts.push(record.data)
                    continue
                }
                const json = JSON.stringify(record)
                if (json) texts.push(json)
                continue
            }
            texts.push(String(block))
        }
        return texts.join("\n")
    }

    if (typeof value === "object") {
        const json = JSON.stringify(value)
        // JSON.stringify only fails on cycles; fall back rather than drop the field.
        return json ?? String(value)
    }
    return String(value)
}

export function getToolResultContent(msg: MessageWithParts): string {
    const results: string[] = []

    // The 500-char cap per result is deliberate: this text feeds the
    // compression candidate scan, where a 300k-token grep dump must not drown
    // out the rest of the message. Extract the real text FIRST, then truncate
    // — truncating a `String()`-ified block array would cut into
    // "[object Object]" and keep none of the payload.
    const push = (value: unknown): void => {
        const text = extractToolResultText(value)
        if (text) results.push(text.slice(0, 500))
    }

    for (const part of msg.parts) {
        // v1 SDK format: type === "tool"
        if (part.type === "tool" && part.state?.type === "result" && part.state?.output) {
            push(part.state.output)
        }
        // v2 AI format: type === "tool-result"
        if (part.type === "tool-result" && part.result) {
            const val = part.result.value
            if (val !== undefined && val !== null) {
                push(val)
            }
        }
        // SessionMessageInfo format: tool with state.status === "completed"
        if (part.type === "tool" && part.state?.status === "completed") {
            const output = part.state.content ?? part.state.output
            if (output !== undefined && output !== null) {
                push(output)
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
