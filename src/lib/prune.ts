import type { SlimConfig } from "./types"
import { pairingIdOf } from "./strategies"

// ─── Tool-output pruning (DCP pruneOutputs) ─────────────────────────────────
//
// Tool output is the single largest contributor to a long session's prompt: one
// `read`, `grep` or `bash` result can be hundreds of thousands of characters
// and is only useful for the turn that produced it. This module replaces the
// *payload* of old, large, non-protected tool results with a short placeholder
// on the outgoing request only — session history is never touched.
//
// Hard invariants (violating any of these corrupts the session):
//
//   1. NO MESSAGE IS EVER REMOVED *BY THIS STAGE*. Dropping a role:"tool"
//      message is a 400 and kills the session. Only the payload
//      (`result.value` / `state.content`) shrinks. The rule is deliberately
//      scoped to this stage: other stages (compression blocks, dedup) DO remove
//      whole messages, which is the entire point of them, and they guard
//      themselves against invariant 5.
//   2. NO tool-call part is ever removed — the call/result pairing would break.
//   3. `result.type` is NEVER changed. Turning a `json` result's value into a
//      string is a type lie the provider can reject; the value becomes a small
//      object instead and the type stays `json`.
//   4. When in doubt, LOCK: leave the output untouched rather than guess.
//   5. PAIRING INVARIANT (applies to every stage that removes messages): a
//      surviving role:"tool" result must never lose the assistant tool_calls
//      part that produced it. The constraint is ONE-DIRECTIONAL, not "one result
//      per call": the host synthesises a missing result for a surviving call
//      (`normalizeToolHistory` → "Tool result missing"), but a missing CALL for
//      a surviving result is not repaired and is emitted as an orphan
//      `tool_call_id`. So removing a call is allowed exactly when its result is
//      removed by the same pass (or the result was never there). See
//      `filterPairSafeIndices` in strategies.ts.
//
// ─── Shape (verified, never guessed) ────────────────────────────────────────
//
// v2 `@opencode/ai` `Message` (node_modules/@opencode/ai/dist/schema/messages.d.ts):
//
//   { role, content: ContentPart[] }
//   tool-result part:  { type:"tool-result", id, name, result }
//   result: { type:"json"|"text"|"error", value: unknown }
//         | { type:"content",
//             value: Array<{ type:"text", text }
//                        | { type:"file", uri, mime, name? }> }
//
// A tool result is a content BLOCK array, never a bare string. The older
// `SessionMessageInfo` transcript shape (`content[]` with `type:"tool"` parts,
// `state.status === "completed"`) is handled too, because a plan may be built
// from `session.context()`.
//
// ─── Turn-granular frontier (architectural rule) ────────────────────────────
//
// Prompt caching is prefix-based. If a different set of messages were pruned on
// every request, the cache prefix would fall out each time and the next request
// would be billed at full price. Therefore:
//
//   - eligibility is decided per TURN, never per message index;
//   - the prune frontier only moves FORWARD: a turn becomes eligible once it is
//     `turnProtection.turns` turns old and stays eligible forever after;
//   - a turn is never partially pruned because of the per-request cap.
//
// The already-pruned outputs form a growing prefix of the request, so the bytes
// before the frontier stay byte-identical (and cached) across requests.

/** Marker every pruned payload starts with; doubles as the idempotency check. */
export const PRUNE_MARKER = "[[slim:pruned]]"

/**
 * Tools whose output is *always* kept, regardless of size or age. These carry
 * the session's working state: if the model later sees a pruned placeholder
 * instead of what it wrote, it may repeat an edit against stale content — a
 * silent, hard-to-detect defect. `task`/`skill`/`todowrite`/`todoread` are DCP's
 * protected set; the write/edit family is added because pruning an edit's own
 * result invites a duplicate edit.
 */
export const PRUNE_ALWAYS_PROTECTED: readonly string[] = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
    "patch",
    "multiedit",
]

export interface PruneStats {
    /** Number of tool outputs the plan replaces on this request. */
    prunedOutputs: number
    /** Total characters removed by the plan (never negative). */
    charsSaved: number
}

/**
 * A read-only description of what to prune. `buildPrunePlan` produces it
 * without touching the transcript; `applyPrunePlan` writes it onto a request.
 */
export interface PrunePlan {
    /** callID -> placeholder text written over the result payload. */
    outputs: Map<string, string>
    stats: PruneStats
}

export interface PrunePlanOptions {
    /**
     * Turn index of the newest message. When omitted it is derived from the
     * transcript as the number of preceding user messages of the last message.
     */
    currentTurn?: number
}

// ─── Config resolution ──────────────────────────────────────────────────────

const DEFAULT_MIN_CHARS = 2000
const DEFAULT_MAX_PER_REQUEST = 50
const DEFAULT_TURNS = 4

interface ResolvedPruneConfig {
    enabled: boolean
    minChars: number
    maxPerRequest: number
    protectedTools: Set<string>
    turnEnabled: boolean
    turns: number
}

function nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback
}

function resolvePruneConfig(config: SlimConfig): ResolvedPruneConfig {
    const prune = config?.strategies?.pruneOutputs
    const turn = config?.strategies?.turnProtection

    const protectedTools = new Set<string>(PRUNE_ALWAYS_PROTECTED)
    for (const tool of prune?.protectedTools ?? []) protectedTools.add(tool)
    // `strategies.purgeErrors.protectedTools` was a dead key until now. It is
    // read here so a tool a user protected from errored-input purging is not
    // silently pruned on its output side either. The prune step is the only
    // strategy reader we may extend without editing strategies.ts.
    for (const tool of config?.strategies?.purgeErrors?.protectedTools ?? []) {
        protectedTools.add(tool)
    }

    return {
        // Opt-in: only an explicit `true` enables pruning. An absent block (the
        // common case, and every existing test) must stay off, so the feature
        // never changes the prompt — and never breaks the prefix cache — unless
        // the user asked for it.
        enabled: prune?.enabled === true,
        minChars: nonNegativeInt(prune?.minChars, DEFAULT_MIN_CHARS),
        maxPerRequest: Math.max(1, nonNegativeInt(prune?.maxPerRequest, DEFAULT_MAX_PER_REQUEST)),
        protectedTools,
        turnEnabled: turn?.enabled !== false,
        turns: Math.max(1, nonNegativeInt(turn?.turns, DEFAULT_TURNS)),
    }
}

// ─── Generic helpers ────────────────────────────────────────────────────────

/**
 * Serialized size of a result payload. Strings are measured by length; anything
 * else by its JSON form (which is how it reaches the API). A cyclic payload
 * cannot be sent anyway, so it measures as 0 and is therefore never selected —
 * lock, never guess.
 */
export function serializedToolResultSize(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === "string") return value.length
    try {
        const json = JSON.stringify(value)
        return typeof json === "string" ? json.length : 0
    } catch {
        return 0
    }
}

function roleOf(message: any): string {
    if (typeof message?.role === "string") return message.role
    if (typeof message?.type === "string") return message.type
    return ""
}

function contentOf(message: any): any[] {
    const content = message?.content ?? message?.parts ?? []
    return Array.isArray(content) ? content : []
}

/**
 * Turn index of every message = number of `role:"user"` messages before it. A
 * parallel batch of N tool results shares one assistant message and therefore
 * one turn, so protection is counted in turns, not messages.
 */
function computeTurnIndices(messages: readonly any[]): number[] {
    const indices: number[] = []
    let userCount = 0
    for (const message of messages) {
        indices.push(userCount)
        if (roleOf(message) === "user") userCount++
    }
    return indices
}

/**
 * The call key for a tool part — deliberately the SAME precedence as
 * `pairingIdOf` in ../strategies.ts, and it delegates to it rather than
 * re-deriving the rule. A local `part?.id ?? part?.toolCallID ?? part?.callID`
 * would be the one site in the tree that reads `id` first, which is wrong for
 * the v1 split shape: there `id` is the PART id and differs between the
 * assistant-side call and the tool-side result, so a result would never match
 * its call and its output would never be replaced.
 */
function callIdOf(part: any): string | undefined {
    return pairingIdOf(part)
}

function startsWithMarker(value: unknown): boolean {
    return typeof value === "string" && value.startsWith(PRUNE_MARKER)
}

function isSlimPrunedValue(value: unknown): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { slim_pruned?: unknown }).slim_pruned === true
    )
}

/** Any text block already carrying the marker means the payload was pruned. */
function contentAlreadyPruned(blocks: unknown): boolean {
    return (
        Array.isArray(blocks) &&
        blocks.some((block) => block?.type === "text" && startsWithMarker(block.text))
    )
}

/**
 * Drops the text blocks and puts one placeholder in their place. File blocks
 * are KEPT: their `uri` is a reference to an attachment, and discarding it
 * loses the file the model was asked to look at. Unknown block types are kept
 * too — preserving is always safer than dropping.
 */
function collapseContentBlocks(blocks: any[], placeholder: string): any[] {
    const kept = blocks.filter((block) => block?.type !== "text")
    return [{ type: "text", text: placeholder }, ...kept]
}

function resolveToolName(part: any, callID: string, byCall: Map<string, string>): string | null {
    const direct = typeof part?.name === "string" && part.name.length > 0 ? part.name : undefined
    const resolved = direct ?? byCall.get(callID)
    return resolved ?? null
}

function collectToolNames(messages: readonly any[]): Map<string, string> {
    const names = new Map<string, string>()
    for (const message of messages) {
        for (const part of contentOf(message)) {
            const name =
                typeof part?.name === "string" && part.name.length > 0 ? part.name : undefined
            if (!name) continue
            if (part?.type === "tool-call" || part?.type === "tool") {
                const id = callIdOf(part)
                if (id) names.set(id, name)
            }
        }
    }
    return names
}

/** A tool-role part that carries a completed output payload. */
function isCompletedOutputPart(part: any): boolean {
    if (part?.type === "tool-result") return true
    if (part?.type === "tool") {
        const state = part.state
        return state?.status === "completed" || state?.type === "result"
    }
    return false
}

function isErroredOutputPart(part: any): boolean {
    if (part?.type === "tool-result") return part?.result?.type === "error"
    if (part?.type === "tool") {
        const state = part.state
        return state?.status === "error" || state?.type === "error"
    }
    return false
}

// ─── Placeholder ────────────────────────────────────────────────────────────

/**
 * The placeholder text. The tool name is carried so the model can decide to
 * re-run it, the size is carried so it can judge whether it matters, and the
 * sentence names the action (re-run the tool). The marker makes idempotency a
 * one-line check.
 */
export function renderPrunePlaceholder(tool: string, chars: number, turnAge: number): string {
    return (
        `${PRUNE_MARKER} ${tool} ciktisi kisaltildi (${chars} karakter, ` +
        `${turnAge} turn once). Bu detaya ihtiyacin varsa ${tool}'u yeniden calistir.`
    )
}

// ─── Plan building (read-only) ──────────────────────────────────────────────

interface Candidate {
    callID: string
    tool: string
    turn: number
    size: number
    newSize: number
    placeholder: string
}

type ReplacementKind = "text" | "json" | "content"

/**
 * Builds (but never applies) the pruning plan for this request. Pure: the
 * transcript is only read, so a plan can be computed once and applied to an
 * equivalent message list.
 */
export function buildPrunePlan(
    transcript: readonly any[],
    config: SlimConfig,
    opts: PrunePlanOptions = {},
): PrunePlan {
    const plan: PrunePlan = { outputs: new Map(), stats: { prunedOutputs: 0, charsSaved: 0 } }
    if (!Array.isArray(transcript) || transcript.length === 0) return plan

    const prune = resolvePruneConfig(config)
    if (!prune.enabled) return plan

    const turnIndices = computeTurnIndices(transcript)
    const currentTurn = opts.currentTurn ?? turnIndices[turnIndices.length - 1] ?? 0
    const toolNameByCall = collectToolNames(transcript)

    const candidates: Candidate[] = []
    for (let i = 0; i < transcript.length; i++) {
        const turn = turnIndices[i]
        const age = currentTurn - turn
        // Turn gate FIRST — the most important one. The last `turns` turns are
        // never candidates: that is the working set the model is using right
        // now, and DCP's syncToolCache never admits them either.
        if (prune.turnEnabled && age < prune.turns) continue

        for (const part of contentOf(transcript[i])) {
            if (!isCompletedOutputPart(part) || isErroredOutputPart(part)) continue
            const candidate = candidateForPart(part, {
                prune,
                turn,
                age,
                toolNameByCall,
            })
            if (candidate) candidates.push(candidate)
        }
    }

    for (const candidate of capCandidates(candidates, prune.maxPerRequest)) {
        plan.outputs.set(candidate.callID, candidate.placeholder)
        plan.stats.prunedOutputs += 1
        plan.stats.charsSaved += Math.max(0, candidate.size - candidate.newSize)
    }
    return plan
}

interface CandidateContext {
    prune: ResolvedPruneConfig
    turn: number
    age: number
    toolNameByCall: Map<string, string>
}

function candidateForPart(part: any, ctx: CandidateContext): Candidate | null {
    const callID = callIdOf(part)
    if (!callID) return null // no pair: we cannot key the call → lock

    const tool = resolveToolName(part, callID, ctx.toolNameByCall)
    // An unresolved name means the protected list cannot be checked → lock.
    if (!tool || ctx.prune.protectedTools.has(tool)) return null

    if (part.type === "tool-result") return candidateFromResult(part, callID, tool, ctx)
    return candidateFromToolState(part, callID, tool, ctx)
}

function candidateFromResult(
    part: any,
    callID: string,
    tool: string,
    ctx: CandidateContext,
): Candidate | null {
    const result = part.result
    if (!result || typeof result !== "object") return null

    // An errored result is locked regardless of whether any other strategy is
    // running. The lock is not about ownership: a failure's output is the ONLY
    // record of what went wrong, and rewriting it to a placeholder destroys
    // that record permanently — the next request (and the next attempt) would
    // see a successful-looking result. This holds whether or not
    // `strategies.purgeErrors` is enabled, and it is not up for negotiation.
    if (result.type === "error") return null
    if (result.type === "text") {
        if (startsWithMarker(result.value)) return null
        return makeCandidate(callID, tool, ctx, result.value, "text")
    }
    if (result.type === "json") {
        if (isSlimPrunedValue(result.value)) return null
        return makeCandidate(callID, tool, ctx, result.value, "json")
    }
    if (result.type === "content") {
        if (!Array.isArray(result.value)) return null // unexpected shape → lock
        if (contentAlreadyPruned(result.value)) return null
        return makeCandidate(callID, tool, ctx, result.value, "content")
    }
    return null // unknown result type → lock, never guess
}

function candidateFromToolState(
    part: any,
    callID: string,
    tool: string,
    ctx: CandidateContext,
): Candidate | null {
    const state = part.state
    if (!state || typeof state !== "object") return null

    if (Array.isArray(state.content)) {
        if (contentAlreadyPruned(state.content)) return null
        return makeCandidate(callID, tool, ctx, state.content, "content")
    }
    if (typeof state.output === "string") {
        if (startsWithMarker(state.output)) return null
        return makeCandidate(callID, tool, ctx, state.output, "text")
    }
    return null
}

function makeCandidate(
    callID: string,
    tool: string,
    ctx: CandidateContext,
    value: unknown,
    kind: ReplacementKind,
): Candidate | null {
    const size = serializedToolResultSize(value)
    // Size gate. Below the threshold a placeholder would save little while
    // still costing a one-time cache invalidation, so it is not worth it.
    if (size < ctx.prune.minChars) return null

    const placeholder = renderPrunePlaceholder(tool, size, ctx.age)
    const newValue = replacementValue(value, kind, placeholder, size, tool)
    const newSize = serializedToolResultSize(newValue)
    return { callID, tool, turn: ctx.turn, size, newSize, placeholder }
}

function replacementValue(
    value: unknown,
    kind: ReplacementKind,
    placeholder: string,
    size: number,
    tool: string,
): unknown {
    if (kind === "text") return placeholder
    if (kind === "json") return { slim_pruned: true, chars: size, tool }
    return collapseContentBlocks(value as any[], placeholder)
}

/**
 * Applies the per-request cap WITHOUT splitting a turn: pruning is a whole-turn
 * decision, and half-pruning a turn ("tool #37 yes, #38 no") would make the
 * frontier jitter. Candidates are chronological, so once the cap lands inside a
 * turn we roll back to that turn's first candidate. If that turn is the first
 * candidate overall, the cap wins — pruning some is better than none.
 */
function capCandidates(candidates: Candidate[], maxPerRequest: number): Candidate[] {
    if (candidates.length <= maxPerRequest) return candidates

    const lastIncludedTurn = candidates[maxPerRequest - 1].turn
    const firstExcludedTurn = candidates[maxPerRequest].turn
    if (firstExcludedTurn !== lastIncludedTurn) {
        return candidates.slice(0, maxPerRequest)
    }
    const turnStart = candidates.findIndex((candidate) => candidate.turn === lastIncludedTurn)
    return turnStart > 0 ? candidates.slice(0, turnStart) : candidates.slice(0, maxPerRequest)
}

// ─── Applying the plan ──────────────────────────────────────────────────────

/**
 * Writes the plan onto the outgoing request.
 *
 * Messages the plan touches are CLONED (`structuredClone`, which preserves
 * media `Uint8Array`s) and the clone replaces the array slot, so no live object
 * shared with the session store is ever mutated. A message that cannot be
 * cloned is skipped (lock) rather than mutated in place.
 *
 * Only payloads change: no message is removed, no tool-call part is removed and
 * no `result.type` is changed.
 */
export function applyPrunePlan(messages: any[], plan: PrunePlan): void {
    if (!Array.isArray(messages) || plan.outputs.size === 0) return

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (!messageHasPlannedOutput(message, plan.outputs)) continue

        let clone: any
        try {
            clone = structuredClone(message)
        } catch {
            continue // cannot clone safely → never mutate the live object
        }

        applyPlaceholders(clone, plan.outputs, collectToolNames([clone]))
        messages[i] = clone
    }
}

function messageHasPlannedOutput(message: any, outputs: Map<string, string>): boolean {
    for (const part of contentOf(message)) {
        if (!isCompletedOutputPart(part)) continue
        const callID = callIdOf(part)
        if (callID && outputs.has(callID)) return true
    }
    return false
}

function applyPlaceholders(
    message: any,
    outputs: Map<string, string>,
    toolNameByCall: Map<string, string>,
): void {
    for (const part of contentOf(message)) {
        const callID = callIdOf(part)
        if (!callID) continue
        const placeholder = outputs.get(callID)
        if (placeholder === undefined) continue

        if (part.type === "tool-result") {
            applyResultPlaceholder(part, placeholder, toolNameByCall.get(callID) ?? part.name)
        } else if (part.type === "tool") {
            applyToolStatePlaceholder(part, placeholder)
        }
    }
}

function applyResultPlaceholder(part: any, placeholder: string, tool: unknown): void {
    const result = part.result
    if (!result || typeof result !== "object") return

    if (result.type === "text") {
        result.value = placeholder
        return
    }
    if (result.type === "json") {
        // `type` is preserved; the value becomes a small marker object so the
        // result is still valid JSON for the provider.
        result.value = {
            slim_pruned: true,
            chars: serializedToolResultSize(result.value),
            tool: typeof tool === "string" ? tool : "tool",
        }
        return
    }
    if (result.type === "content" && Array.isArray(result.value)) {
        result.value = collapseContentBlocks(result.value, placeholder)
    }
    // error / unknown type: untouched — the plan never contained them anyway.
}

function applyToolStatePlaceholder(part: any, placeholder: string): void {
    const state = part.state
    if (!state || typeof state !== "object") return

    if (Array.isArray(state.content)) {
        state.content = collapseContentBlocks(state.content, placeholder)
    } else if (typeof state.output === "string") {
        state.output = placeholder
    }
}
