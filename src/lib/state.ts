import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import type { SessionState, CompressionRecord, ToolCallInfo } from "./types"

const DEFAULT_STATE: SessionState = {
    sessionId: "",
    modelContextLimit: 200000,
    currentTokenCount: 0,
    compressionCount: 0,
    lastCompressionTime: 0,
    manualMode: false,
    compressPermission: null,
    compressionHistory: [],
    averageCompressionRatio: 0,
    toolCalls: new Map(),
    compressionBlocks: [],
    nextBlockId: 1,
    nudges: { contextLimitAnchors: [], turnNudgeAnchors: [], iterationNudgeAnchors: [] },
}

/** A usable block: an object carrying a numeric id, a string anchor and a
 *  string array of covered ids. Anything else is corrupt. */
function isValidBlock(b: unknown): boolean {
    if (typeof b !== "object" || b === null || Array.isArray(b)) return false
    const blk = b as Record<string, unknown>
    return (
        typeof blk.blockId === "number" &&
        typeof blk.anchorMessageId === "string" &&
        Array.isArray(blk.coveredMessageIds) &&
        blk.coveredMessageIds.every((id) => typeof id === "string")
    )
}

export function normalizeState(state: SessionState): SessionState {
    // The state file is user-editable JSON on disk, so it is untrusted input.
    // An array check alone is not enough: a single `null` (or otherwise
    // malformed) entry survives to every downstream consumer, where it throws
    // inside syncCompressionBlocks() on every request forever and inside the
    // nextBlockId reduce — and because that reduce sits inside loadSessionState's
    // try, the throw discards the ENTIRE file, throwing away every valid block
    // along with it. Neither failure is self-healing, because the bad entry is
    // re-persisted verbatim. Filter it out at the load boundary instead.
    const rawBlocks = Array.isArray(state.compressionBlocks) ? state.compressionBlocks : []
    const validBlocks = rawBlocks.filter(isValidBlock)
    if (validBlocks.length !== rawBlocks.length) {
        console.warn(
            `[slim] dropped ${rawBlocks.length - validBlocks.length} malformed ` +
                `compressionBlocks entr${rawBlocks.length - validBlocks.length === 1 ? "y" : "ies"} ` +
                `from the saved session state.`,
        )
    }
    state.compressionBlocks = validBlocks
    // nextBlockId must be MONOTONIC and strictly greater than every SURVIVING
    // blockId — a blockId is an identity, not just a list index: the injected
    // `slim-summary-${blockId}` message is named after it, and
    // registerCompressionBlock matches `consumedBlockIds` by it. Re-issuing a
    // live id therefore collides an existing block with a new one AND gives
    // two messages on the wire the same id.
    //
    // The stored value alone is not enough, and neither is the derived one:
    //
    //  - stored only → a file with NO `nextBlockId` key gets DEFAULT_STATE's
    //    `1` from the load-time spread, which is a positive number, so the
    //    derive never runs and a session holding blocks 1..7 mints a duplicate
    //    blockId 1. Same for a stored value that simply fell behind (an
    //    older version, a hand-edit, a partial write).
    //  - derived only → ids already handed out would be re-issued after
    //    resetOnCompaction cleared the block list, which the monotonicity note
    //    on that function explicitly rules out.
    //
    // So the counter is the MAX of the two: the derived floor guarantees no
    // collision among surviving blocks, the stored value carries the sequence
    // forward across a compaction that emptied the list. A corrupt entry
    // cannot skew it either, since the reduce runs over the filtered list.
    const derivedNextBlockId =
        state.compressionBlocks.reduce((max, b) => Math.max(max, b.blockId), 0) + 1
    const storedNextBlockId =
        typeof state.nextBlockId === "number" && state.nextBlockId > 0 ? state.nextBlockId : 0
    state.nextBlockId = Math.max(storedNextBlockId, derivedNextBlockId)
    state.nudges = {
        contextLimitAnchors: Array.isArray(state.nudges?.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : [],
        turnNudgeAnchors: Array.isArray(state.nudges?.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : [],
        iterationNudgeAnchors: Array.isArray(state.nudges?.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : [],
    }
    // Optional fields — preserve if present, leave undefined if not
    state._lastProviderId = state._lastProviderId ?? undefined
    state._lastModelId = state._lastModelId ?? undefined
    return state
}

export function loadSessionState(sessionId: string, persistenceDir: string): SessionState {
    const statePath = join(persistenceDir, `${sessionId}.json`)

    if (existsSync(statePath)) {
        try {
            const data = readFileSync(statePath, "utf-8")
            const parsed = JSON.parse(data)
            // Convert toolCalls back to Map
            if (parsed.toolCalls && Array.isArray(parsed.toolCalls)) {
                parsed.toolCalls = new Map(parsed.toolCalls)
            }
            return normalizeState({ ...DEFAULT_STATE, ...parsed, sessionId })
        } catch {
            // Use default
        }
    }

    return normalizeState({ ...DEFAULT_STATE, sessionId })
}

export function saveSessionState(state: SessionState, persistenceDir: string): void {
    try {
        if (!existsSync(persistenceDir)) {
            mkdirSync(persistenceDir, { recursive: true })
        }

        const statePath = join(persistenceDir, `${state.sessionId}.json`)
        // Convert Map to array for serialization
        const serializable = {
            ...state,
            toolCalls: Array.from(state.toolCalls.entries()),
        }
        writeFileSync(statePath, JSON.stringify(serializable, null, 2), "utf-8")
    } catch {
        // Ignore errors
    }
}

/**
 * Reset the per-request bookkeeping after a compaction rewrote history.
 *
 * Called once per new compaction (guarded by `lastCompactionMessageId`) from
 * the context hook, BEFORE the outgoing request is built. Anything that pointed
 * into the pre-compaction transcript is now meaningless:
 *
 * Reset (stale after compaction):
 * - `compressionBlocks` — their anchors and covered ids no longer exist;
 * - the three `nudges` anchor lists — same reason;
 * - `currentTokenCount` — recomputed from the new prompt on this request;
 * - `lastAutoCompressTime` — otherwise the first request after compaction is
 *   immediately eligible for auto-compress;
 * - `toolCalls` — call ids from the old transcript.
 *
 * Preserved (still valid, or user-visible statistics):
 * - `compressionHistory`, `compressionCount`, `averageCompressionRatio`,
 *   `lastCompressionTime` — shown on the panel; wiping them is a silent
 *   regression;
 * - `modelContextLimit`, `manualMode`, `compressPermission`, `_lastProviderId`,
 *   `_lastModelId` — configuration/session identity, not transcript state;
 * - `nextBlockId` — MONOTONIC. Resetting it would re-issue block ids that
 *   synthetic injected messages already reference, colliding their identities.
 *
 * Idempotent: running it again with the same id leaves the same state.
 */
export function resetOnCompaction(state: SessionState, compactionMessageId: string): void {
    state.compressionBlocks = []
    state.nudges = {
        contextLimitAnchors: [],
        turnNudgeAnchors: [],
        iterationNudgeAnchors: [],
    }
    state.currentTokenCount = 0
    state.lastAutoCompressTime = 0
    state.toolCalls?.clear?.()
    state.lastCompactionMessageId = compactionMessageId
}

export function addCompressionRecord(
    state: SessionState,
    record: CompressionRecord,
    learningRate: number,
): void {
    state.compressionHistory.push(record)
    state.compressionCount++
    state.lastCompressionTime = record.timestamp

    // Update average ratio with exponential moving average
    if (state.compressionHistory.length === 1) {
        state.averageCompressionRatio = record.ratio
    } else {
        state.averageCompressionRatio =
            state.averageCompressionRatio * (1 - learningRate) + record.ratio * learningRate
    }
}

export function trackToolCall(
    state: SessionState,
    tool: string,
    args: unknown,
    turn: number,
): string {
    const id = `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    state.toolCalls.set(id, {
        tool,
        args,
        timestamp: Date.now(),
        turn,
    })
    return id
}

export function getDuplicateToolCalls(state: SessionState): string[] {
    const seen = new Map<string, string[]>()
    const duplicates: string[] = []

    for (const [id, info] of state.toolCalls.entries()) {
        const key = `${info.tool}:${JSON.stringify(info.args)}`
        const existing = seen.get(key) || []
        existing.push(id)
        seen.set(key, existing)
    }

    for (const [, ids] of seen.entries()) {
        if (ids.length > 1) {
            // Keep first, mark rest as duplicates
            duplicates.push(...ids.slice(1))
        }
    }

    return duplicates
}

export function getErroredToolCalls(state: SessionState, turnsThreshold: number): string[] {
    const errored: string[] = []
    const currentTurn = Math.max(...Array.from(state.toolCalls.values()).map((t) => t.turn), 0)

    for (const [id, info] of state.toolCalls.entries()) {
        if (info.error && currentTurn - info.turn >= turnsThreshold) {
            errored.push(id)
        }
    }

    return errored
}
