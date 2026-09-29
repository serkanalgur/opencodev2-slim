/**
 * Token accounting for the outgoing request.
 *
 * Two independent measurement paths exist here, and they are deliberately kept
 * separate until {@link resolveTriggerTokens} merges them:
 *
 * 1. **Measured** — what the provider actually billed for the LAST completed
 *    request. Fed from the `session.step.ended` event
 *    (`data.tokens`: input + output + reasoning + cache.read + cache.write),
 *    with a single cold-start `session.context()` read while the cache is
 *    still empty. Never `Session.Info.tokens`: that field is a LIFETIME
 *    cumulative counter (issue #30649: 56.1M tokens in one session) that never
 *    comes back down.
 *
 * 2. **Estimated** — a character count of everything that goes on the wire for
 *    THIS request (system prompt, text, reasoning, tool-call inputs, tool
 *    results, compaction summaries, tool schemas) divided once by ~4 chars per
 *    token. No tokenizer is invoked: a real tokenizer costs real time on every
 *    single request for a number the merge rules below only ever use as a
 *    magnitude.
 *
 * Neither path is safe alone — the measurement describes the previous request
 * (stale the moment pruning/blocks shrink the prompt), the estimate cannot see
 * provider-side overhead. The merge clamps in BOTH directions so a bad number
 * can neither disable auto-compress nor fire it on every request.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** One real API call's usage, flattened into the two figures we actually need. */
export interface MeasuredUsage {
    /** input + output + reasoning + cache.read + cache.write of a single request. */
    tokens: number
    /** input + cache.read + cache.write — the portion that IS the prompt. */
    promptTokens: number
    /** Assistant message the measurement was read from (diagnostics). */
    messageID?: string
}

export type UsageSource = "measured" | "estimated" | "none"

/** The merged number that drives nudges and the auto-compress check. */
export interface TokenAccounting {
    tokens: number
    source: UsageSource
    /** Sanitised measured value (0 when there was none). */
    measured: number
    /** Sanitised estimate (0 when there was none). */
    estimated: number
    /** True when a clamping rule replaced one of the inputs. */
    clamped: boolean
}

/**
 * Cache entry. `usage` may be null: "we looked and the transcript carried no
 * measurement" is a real, cacheable answer — without it every request of a
 * fresh session would re-read the whole transcript.
 */
export interface UsageEntry {
    usage: MeasuredUsage | null
    updatedAt: number
}

export type UsageCache = Map<string, UsageEntry>

export interface TriggerTokenOptions {
    /** Measured below this fraction of the estimate → trust the estimate. Default 0.5. */
    trustRatio?: number
    /** Measured above this multiple of the estimate → cap at that multiple. Default 3. */
    capRatio?: number
    /** Observer for the "suspicious measurement" clamp; defaults to a warn-once. */
    onSuspiciousMeasurement?: (detail: SuspiciousMeasurement) => void
}

export interface SuspiciousMeasurement {
    measured: number
    estimated: number
    /** capRatio * estimated — the value actually used. */
    capped: number
    capRatio: number
}

// ─── Guards ─────────────────────────────────────────────────────────────────

/**
 * Config files are parsed loosely and transcripts are `any`-shaped, so every
 * numeric read goes through here: a NaN, Infinity or negative field is a broken
 * reading, and a broken reading must count as 0 — never as a huge number that
 * would trip the trigger.
 */
const asCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null

/** A configured ratio is only usable as a positive finite number; anything else is the default. */
const asRatio = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

// ─── Measurement ────────────────────────────────────────────────────────────

/**
 * Flatten a provider `TokenUsageInfo` ({ input, output, reasoning, cache: { read, write } })
 * into a single billable number. Broken/absent fields count as 0.
 */
export function totalTokens(t: unknown): number {
    const record = asRecord(t)
    if (!record) return 0
    const cache = asRecord(record.cache)
    return (
        asCount(record.input) +
        asCount(record.output) +
        asCount(record.reasoning) +
        asCount(cache?.read) +
        asCount(cache?.write)
    )
}

/** The prompt-shaped part of a usage record: input + cache.read + cache.write. */
export function promptTokens(t: unknown): number {
    const record = asRecord(t)
    if (!record) return 0
    const cache = asRecord(record.cache)
    return asCount(record.input) + asCount(cache?.read) + asCount(cache?.write)
}

/**
 * Turn one `TokenUsageInfo` into a measurement, or null when it cannot
 * describe a real request:
 * - `output <= 0` is skipped (DCP evidence: steps that produced nothing carry
 *   no usable measurement — an aborted/phantom step must not become "the last
 *   request");
 * - an empty prompt side is skipped too, because `promptTokens` is what
 *   answers "how full is the window" for both the trigger and the panel.
 */
export function measuredUsageFromTokens(tokens: unknown, messageID?: string): MeasuredUsage | null {
    const record = asRecord(tokens)
    if (!record) return null
    if (asCount(record.output) <= 0) return null

    const total = totalTokens(record)
    const prompt = promptTokens(record)
    if (total <= 0 || prompt <= 0) return null

    return messageID !== undefined ? { tokens: total, promptTokens: prompt, messageID } : { tokens: total, promptTokens: prompt }
}

/**
 * Index of the last COMPLETED compaction in the transcript, or -1.
 *
 * v2 marks compaction messages `{ type: "compaction", status: "running" |
 * "completed" | "failed" }`. DCP's v1 signal (`summary === true`) does not
 * exist in v2 — using it would find nothing and silently scan history that a
 * compaction already replaced, i.e. report a prompt size the model never sees.
 */
export function findLastCompactionIndex(messages: readonly unknown[]): number {
    if (!Array.isArray(messages)) return -1
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = asRecord(messages[i])
        if (message?.type === "compaction" && message.status === "completed") return i
    }
    return -1
}

/**
 * Scan the transcript backwards for the most recent usable measurement: the
 * last `type === "assistant"` message after `afterIndex` whose usage reports a
 * positive output (and a non-empty prompt side). Returns null — not 0 — when
 * nothing qualifies: "measured zero" and "could not measure" must stay
 * distinguishable, because only the latter falls back to the estimate.
 *
 * Pass `findLastCompactionIndex(messages)` as `afterIndex`: usage recorded
 * before the last compaction describes a prompt that no longer exists.
 */
export function readMeasuredUsage(
    messages: readonly unknown[],
    afterIndex = -1): MeasuredUsage | null {
    if (!Array.isArray(messages)) return null

    for (let i = messages.length - 1; i > afterIndex; i--) {
        const message = asRecord(messages[i])
        if (message?.type !== "assistant") continue
        const id = typeof message.id === "string" ? message.id : undefined
        const usage = measuredUsageFromTokens(message.tokens, id)
        if (usage) return usage
    }
    return null
}

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Chars per token used for the single final division. */
const CHARS_PER_TOKEN = 4

/**
 * Character length of anything that ends up on the wire, counted without
 * running a tokenizer:
 * - a string is counted verbatim;
 * - a content block array (`{type:"text",text}` | `{type:"file",uri,mime}`)
 *   counts its text blocks; file blocks carry no text (uri only) and are
 *   skipped;
 * - media counts `data` when it is a data-URI string (the bytes really are
 *   sent), and not at all when it is a binary blob;
 * - any other value is JSON, which is exactly how a tool input/result reaches
 *   the API.
 */
function contentChars(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) {
        let chars = 0
        for (const block of value) {
            const record = asRecord(block)
            if (record) {
                if (record.type === "file") continue // uri/name/mime are metadata, not prompt text
                if (typeof record.text === "string") {
                    chars += record.text.length
                    continue
                }
                // data-URI media payload (binary Uint8Array cannot be counted as text)
                if (typeof record.data === "string") {
                    chars += record.data.length
                    continue
                }
                chars += contentChars(JSON.stringify(record) ?? "")
                continue
            }
            chars += contentChars(block)
        }
        return chars
    }
    if (typeof value === "object") {
        const json = JSON.stringify(value)
        return typeof json === "string" ? json.length : 0
    }
    return String(value).length
}

/** One content part of an outgoing message. */
function partChars(part: unknown): number {
    const record = asRecord(part)
    if (!record) return contentChars(part)

    switch (record.type) {
        case "text":
        case "reasoning":
        case "compaction":
            return typeof record.text === "string" ? record.text.length : contentChars(record.text)
        case "media":
            // Only a data-URI payload is actually transmitted as characters.
            return typeof record.data === "string" ? record.data.length : 0
        case "file":
            return 0
        case "tool-call": {
            // `params` (v1-ish) and `input` (v2) are the same thing: the JSON arguments.
            const args = record.params !== undefined ? record.params : record.input
            const name = typeof record.name === "string" ? record.name.length : 0
            return name + contentChars(args)
        }
        case "tool-result":
            // `{ type, value }` envelope (json | text | error | content blocks) or a raw value.
            const result = asRecord(record.result)
            return contentChars(result && "value" in result ? result.value : record.result)
        default:
            // Unknown part types still travel as JSON — count them instead of dropping them.
            return contentChars(record)
    }
}

/**
 * Estimate the size of the request we are about to send, in tokens.
 *
 * Covers every component of the real prompt: system prompt blocks, text and
 * reasoning parts, tool-call arguments, tool results (string AND v2 content
 * block arrays), compaction summaries, and the tool schema bundle (names,
 * descriptions, input schemas) — the last one is tens of thousands of tokens
 * that a text-parts-only estimate never saw, and is the main reason the old
 * number sat 2-5x below reality.
 *
 * Media/file blocks contribute nothing unless they carry a data-URI payload.
 */
export function estimatePromptTokens(messages: unknown, system?: unknown, tools?: unknown): number {
    let chars = 0

    const addSystem = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const entry of value) addSystem(entry)
            return
        }
        const record = asRecord(value)
        if (record) {
            if (typeof record.text === "string") chars += record.text.length
            else chars += contentChars(record)
            return
        }
        if (typeof value === "string") chars += value.length
    }

    addSystem(system)

    if (Array.isArray(messages)) {
        for (const raw of messages) {
            const message = asRecord(raw)
            if (!message) {
                chars += contentChars(raw)
                continue
            }

            const content = message.content ?? message.parts
            if (Array.isArray(content)) {
                for (const part of content) chars += partChars(part)
            } else {
                // Transcript-shaped messages (user/compaction) carry the text at
                // the top level instead of a parts array.
                if (typeof message.text === "string") chars += message.text.length
                else if (typeof message.summary === "string") chars += message.summary.length
                else chars += contentChars(content)
            }

            // A compaction message's summary is injected into the next prompt and
            // never mirrors itself into `content`.
            if (message.type === "compaction" && typeof message.summary === "string") {
                chars += message.summary.length
            }
        }
    }

    // Tool schemas: name + description + JSON input schema, per registered tool.
    if (tools !== null && typeof tools === "object") {
        const entries: unknown[] = Array.isArray(tools)
            ? tools
            : Object.values(tools as Record<string, unknown>)
        for (const entry of entries) {
            const record = asRecord(entry)
            if (!record) {
                chars += contentChars(entry)
                continue
            }
            if (typeof record.name === "string") chars += record.name.length
            if (typeof record.description === "string") chars += record.description.length
            chars += contentChars(record.input ?? record.inputSchema)
        }
    }

    // One division at the end: rounding per part would inflate every tiny block.
    return Math.ceil(chars / CHARS_PER_TOKEN)
}

// ─── Merge ──────────────────────────────────────────────────────────────────

const DEFAULT_TRUST_RATIO = 0.5
const DEFAULT_CAP_RATIO = 3

/**
 * Warn-once guard for the "measurement is impossibly large" clamp. Kept here
 * (not per call site) so no caller can accidentally re-emit it every request.
 */
let warnedSuspiciousMeasurement = false

/** Clear the warn-once guard (test hook). */
export function resetSuspiciousMeasurementWarning(): void {
    warnedSuspiciousMeasurement = false
}

/**
 * Merge the measured value with the estimate into the number that decides
 * whether auto-compress fires. Rules, in order:
 *
 * 1. nothing measurable at all → 0 / `"none"`;
 * 2. no usable measurement → the estimate (`"estimated"`);
 * 3. no usable estimate → the measurement untouched (`"measured"`) — an empty
 *    request's estimate of 0 must not zero out a real reading;
 * 4. measurement below `trustRatio` of the estimate → the estimate, flagged:
 *    the measurement describes the PREVIOUS request, so when this request's
 *    blocks/pruning made it much smaller the measurement is stale and sits on
 *    the big side. Preferring the estimate makes "auto-compress fired on every
 *    request" physically impossible;
 * 5. measurement above `capRatio` × the estimate → cap at `capRatio` × the
 *    estimate, warn once: a reading several times larger than any possible
 *    prompt is a broken reading, and an inflated number is exactly the bug
 *    this merge exists to remove;
 * 6. otherwise the measurement.
 */
export function resolveTriggerTokens(
    measured: MeasuredUsage | null,
    estimated: number,
    opts: TriggerTokenOptions = {},
): TokenAccounting {
    const trustRatio = asRatio(opts.trustRatio, DEFAULT_TRUST_RATIO)
    const capRatio = asRatio(opts.capRatio, DEFAULT_CAP_RATIO)

    const measuredTokens = measured ? asCount(measured.tokens) : 0
    const estimatedTokens = asCount(estimated)

    const base = { measured: measuredTokens, estimated: estimatedTokens }

    // Rule 1: neither path produced a number.
    if (measuredTokens <= 0 && estimatedTokens <= 0) {
        return { ...base, tokens: 0, source: "none", clamped: false }
    }
    // Rule 2: no measurement → estimate.
    if (measuredTokens <= 0) {
        return { ...base, tokens: estimatedTokens, source: "estimated", clamped: false }
    }
    // Rule 3: no estimate → measurement, untouched.
    if (estimatedTokens <= 0) {
        return { ...base, tokens: measuredTokens, source: "measured", clamped: false }
    }
    // Rule 4: stale, too-small measurement → estimate.
    if (measuredTokens < trustRatio * estimatedTokens) {
        return { ...base, tokens: estimatedTokens, source: "estimated", clamped: true }
    }
    // Rule 5: impossibly large measurement → cap.
    if (measuredTokens > capRatio * estimatedTokens) {
        const capped = Math.round(capRatio * estimatedTokens)
        const detail: SuspiciousMeasurement = {
            measured: measuredTokens,
            estimated: estimatedTokens,
            capped,
            capRatio,
        }
        const observer = opts.onSuspiciousMeasurement ?? defaultSuspiciousObserver
        observer(detail)
        return { ...base, tokens: capped, source: "measured", clamped: true }
    }

    return { ...base, tokens: measuredTokens, source: "measured", clamped: false }
}

function defaultSuspiciousObserver(detail: SuspiciousMeasurement): void {
    if (warnedSuspiciousMeasurement) return
    warnedSuspiciousMeasurement = true
    console.warn(
        `[slim] measured token usage ${detail.measured} is over ${detail.capRatio}x the estimated prompt size (~${detail.estimated}); using ${detail.capped} instead — a reading that large is usually a bad one`,
    )
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

/**
 * Store (or clear) the usage for a session. Passing null records "seeded but
 * unmeasurable", which is what stops a fresh session from re-reading the
 * transcript on every request.
 */
export function recordUsage(
    cache: UsageCache,
    sessionID: string,
    usage: MeasuredUsage | null,
    now: number = Date.now(),
): void {
    cache.set(sessionID, { usage, updatedAt: now })
}
