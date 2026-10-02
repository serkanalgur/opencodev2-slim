import { Plugin } from "@opencode/plugin"
import {
    loadConfig,
    createDefaultConfig,
    resolveCompressLimits,
    setPluginOptions,
} from "./lib/config"
import {
    loadSessionState,
    addCompressionRecord,
    resetOnCompaction,
    normalizeState,
} from "./lib/state"
import {
    projectScopeKey,
    sessionStateKey,
    serializeState,
    writtenAtOf,
    readLegacyEntry,
    writeLegacyPayload,
    type SlimStorage,
} from "./lib/persistence"
import { countTokens, getMessageText, getToolResultContent } from "./lib/compress"
import {
    estimatePromptTokens,
    findLastCompactionIndex,
    measuredUsageFromTokens,
    readMeasuredUsage,
    recordUsage,
    resolveTriggerTokens,
    type MeasuredUsage,
    type UsageCache,
} from "./lib/usage"
import {
    syncCompressionBlocks,
    applyCompressedRanges,
    registerCompressionBlock,
    buildCompressionSummary,
    purgeStaleToolErrors,
    pruneInPlace,
    injectLimitNudges,
    findLastUserMessage,
    autoCompress,
    stableMessageKey,
    findAmbiguousKeys,
} from "./lib/strategies"
import { getSystemPrompt, getCompressToolDescription } from "./lib/prompts"
import { buildPrunePlan, applyPrunePlan, type PruneStats } from "./lib/prune"
import { buildPanelData, renderPanel } from "./lib/tui"
import type {
    SlimConfig,
    SessionState,
    MessageWithParts,
    CompressionBlock,
    ToolCallInfo,
} from "./lib/types"

// ─── State Management ───────────────────────────────────────────────────────

const DEFAULT_MODEL_LIMIT = 200000

const sessionStates = new Map<string, SessionState>()
const sessionConfigs = new Map<string, SlimConfig>()
// Resolved context limit for the active model, per session
const sessionModelLimits = new Map<string, number>()
// Last MEASURED usage per session, fed by the `session.step.ended` event and
// seeded once per session from the transcript (see src/lib/usage.ts).
const sessionUsage: UsageCache = new Map()
// Sessions whose next request must re-read the transcript to learn a new
// compaction's message id (the compaction event itself carries no id). Kept as
// a set so the transcript is not serialized on every request.
const sessionsAwaitingCompactionCheck = new Set<string>()
// Tool-output pruning stats from the LAST outgoing request, per session. Pruning
// is rebuilt and re-applied on every request, so this is a per-request figure —
// never a cumulative saving. Overwritten each request (including with zeros when
// the feature is off) and read only by the panel tool.
const sessionPruneStats = new Map<string, PruneStats>()

/**
 * Persistence backend for session state.
 *
 * `ctx.storage` is the v2 plugin-scoped store, so state is isolated per plugin
 * instance and per project directory instead of sharing one global
 * `~/.config/opencode/slim` directory across every checkout on the machine.
 *
 * Null when the host exposes no storage domain (older host, or a test harness)
 * — callers then fall back to the legacy on-disk directory, which is also the
 * migration source: a session found only on disk is loaded and written into
 * storage on first use, so an upgrade keeps its compression history.
 */
let stateStorage: SlimStorage | null = null
/** Project scope for storage keys, from `ctx.location.project.canonical`. */
let projectScope = "global"

/** Wire the storage backend at setup(). Called once per plugin load. */
export function configurePersistence(ctx: any): void {
    const storage = ctx?.storage
    if (
        storage &&
        typeof storage.get === "function" &&
        typeof storage.set === "function"
    ) {
        stateStorage = storage as SlimStorage
    }
    const canonical = ctx?.location?.project?.canonical
    projectScope = projectScopeKey(typeof canonical === "string" ? canonical : undefined)
}

/** Test hook: forget the storage backend and project scope. */
export function resetPersistence(): void {
    stateStorage = null
    projectScope = "global"
}

/** True when state is being persisted through `ctx.storage`. */
export function usingPluginStorage(): boolean {
    return stateStorage !== null
}

/**
 * Sessions whose storage read has failed.
 *
 * The distinction this preserves: "storage holds no entry" and "storage could
 * not be read" are not the same answer. Collapsing them makes a transient read
 * failure look like an empty store, so the stale mirror is adopted — and the
 * next save then writes that stale state back over a storage copy that was
 * never missing, only unreachable. A session in this set is written mirror-only
 * until a read succeeds, so a failed read can never destroy newer state.
 */
const storageUnreachableSessions = new Set<string>()

/** A loaded state payload plus whether the other layer is now stale. */
interface LoadedState {
    data: Record<string, unknown>
    /**
     * True when the two layers hold different versions and the losing one
     * should be brought up to date. False when they agree, when only one layer
     * exists, or when there is no storage backend to reconcile with.
     */
    needsReconcile: boolean
}

/**
 * Load one session's state, choosing whichever copy was written LAST.
 *
 * Neither layer can be treated as authoritative on its own:
 *
 *  - Preferring the file unconditionally (the previous behaviour) loses data
 *    whenever a storage write succeeded and the mirror write did not — the
 *    stale file then wins and the write-forward overwrites the newer storage
 *    copy, destroying it. `writeLegacyPayload` swallows its own errors, so
 *    that failure is silent and self-inflicted.
 *  - Preferring storage unconditionally loses data in the mirror image: the
 *    user runs an older slim, which writes only the file.
 *
 * So both copies carry a write time and the newer one wins. Ties go to
 * storage: on a clean save both are written from one payload with the same
 * timestamp, so a tie means the two genuinely agree and either is correct.
 *
 * Returns `undefined` when neither layer has an entry, so the caller can build
 * a fresh state. A corrupt entry at EITHER layer is treated as absent — a
 * broken file must not wedge the session forever.
 */
async function loadStateFor(
    sessionId: string,
    config: SlimConfig,
): Promise<LoadedState | undefined> {
    const legacy = readLegacyEntry(sessionId, config.persistence.directory)

    let stored: { data: Record<string, unknown>; writtenAt: number } | undefined
    if (stateStorage) {
        try {
            const raw = await stateStorage.get(sessionStateKey(projectScope, sessionId))
            // A successful read — even one returning nothing — proves storage
            // is reachable, so any earlier outage is over.
            storageUnreachableSessions.delete(sessionId)
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                const data = raw as Record<string, unknown>
                // No marker means a payload written before recency tracking;
                // treat it as the oldest possible rather than as current.
                stored = { data, writtenAt: writtenAtOf(data) ?? Number.NEGATIVE_INFINITY }
            }
        } catch {
            // Unreachable is NOT the same as empty. Record it so persistState
            // skips the storage write for this session, then fall back to the
            // mirror for reading.
            storageUnreachableSessions.add(sessionId)
        }
    }

    if (!legacy) return stored ? { data: stored.data, needsReconcile: false } : undefined
    if (!stored) return { data: legacy.data, needsReconcile: false }

    // Both layers exist. Adopt the newer and report whether the loser needs
    // rewriting. A tie means the two agree (every clean save writes one
    // payload to both), so there is nothing to reconcile.
    if (legacy.writtenAt > stored.writtenAt) {
        return { data: legacy.data, needsReconcile: true }
    }
    return {
        data: stored.data,
        // Strictly-newer storage over a stale mirror: refresh the file so the
        // two stop disagreeing. This is the self-heal for a failed mirror
        // write — without it the stale file lingers and would keep re-losing.
        needsReconcile: stored.writtenAt > legacy.writtenAt,
    }
}

/** Persist one session's state to storage, mirroring to disk as a fallback. */
async function persistState(state: SessionState, config: SlimConfig): Promise<void> {
    // `persistence.enabled: false` means the user opted out of persistence
    // entirely. It has to gate BOTH layers: when the storage write ran first,
    // switching the flag off stopped only the on-disk mirror while the
    // session's compression history and tool-call map kept being written to
    // plugin storage — so "off" persisted nothing visible but still accumulated
    // state, and did so silently.
    if (!config.persistence.enabled) return

    // ONE payload for both layers, so both carry the same write time. Writing
    // them separately would give each a slightly different timestamp, and the
    // reader's recency comparison would then pick between two copies of the
    // same state purely on sub-millisecond noise.
    const payload = serializeState(state)

    if (stateStorage && !storageUnreachableSessions.has(state.sessionId)) {
        try {
            await stateStorage.set(sessionStateKey(projectScope, state.sessionId), payload)
        } catch {
            // Write failed. Record the session as unreachable so subsequent
            // saves go mirror-only instead of repeatedly attempting — and, more
            // importantly, so nothing derived from a failed read is written
            // back over a storage copy that may well be newer.
            storageUnreachableSessions.add(state.sessionId)
        }
    }

    // Kept as a safety mirror, not the primary store: it preserves the old
    // behaviour for a host with no storage domain, and keeps a pre-migration
    // copy readable rather than deleting user data on upgrade.
    writeLegacyPayload(payload, state.sessionId, config.persistence.directory)
}

/**
 * Get (and lazily hydrate) the state for a session.
 *
 * Async because hydration reads `ctx.storage`. Callers are all on async
 * hook/tool paths, and they `await` this, so a cold session is fully hydrated
 * before any of them acts on it — there is no window where a request runs
 * against a half-loaded state.
 *
 * Concurrent first-callers share one read via `stateLoads`: without it, a
 * session opened by two requests at once would fire two loads racing to
 * populate the same cache entry, and the loser's state would be discarded
 * mid-request.
 */
async function getState(sessionId: string, config: SlimConfig): Promise<SessionState> {
    const cached = sessionStates.get(sessionId)
    if (cached) return cached

    const pending = stateLoads.get(sessionId)
    if (pending) {
        // Waiters get the SAME protection as the initiator. Without this, a
        // rejecting hydrate throws out of whichever request happened to arrive
        // second, even though the initiator already handled it and installed a
        // default state — a persistence failure escalating into a hook failure.
        try {
            await pending
        } catch {
            // Fall through to the shared fallback below.
        }
        return sessionStates.get(sessionId)!
    }

    const load = (async () => {
        const loaded = await loadStateFor(sessionId, config)
        const state = hydrateState(sessionId, config, loaded?.data)
        state.modelContextLimit = sessionModelLimits.get(sessionId) || DEFAULT_MODEL_LIMIT
        sessionStates.set(sessionId, state)

        // The two layers disagreed on which was written last. The copy now in
        // memory is the newest, so write it to the other side and let them
        // converge. This runs in BOTH directions — an upgrade that left the
        // file ahead, and a failed mirror write that left storage ahead.
        if (loaded?.needsReconcile) await persistState(state, config)
    })()

    stateLoads.set(sessionId, load)
    try {
        await load
    } catch {
        // A failed hydrate must never break the request; fall back to a default
        // state so the pipeline still runs this turn.
        if (!sessionStates.has(sessionId)) {
            const fallback = loadSessionState(sessionId, config.persistence.directory)
            fallback.modelContextLimit =
                sessionModelLimits.get(sessionId) || DEFAULT_MODEL_LIMIT
            sessionStates.set(sessionId, fallback)
        }
    } finally {
        stateLoads.delete(sessionId)
    }

    return sessionStates.get(sessionId)!
}

// ─── Hook Registration Lifetime ─────────────────────────────────────────────
//
// `ctx.session.hook()` returns a `Registration` that must be disposed when the
// plugin unloads. Discarding it leaves the callbacks attached to the host
// across a reload, so a config reload would stack a second copy of the whole
// compression pipeline onto the same hooks — every request then running the
// DCP pipeline N times.
const hookRegistrations: { dispose(): Promise<void> }[] = []

/** In-flight hydrations, so concurrent first-callers await one read. */
const stateLoads = new Map<string, Promise<void>>()

/** Turn a raw stored payload into a validated, in-memory state. */
function hydrateState(
    sessionId: string,
    config: SlimConfig,
    stored: Record<string, unknown> | undefined,
): SessionState {
    if (!stored) return loadSessionState(sessionId, config.persistence.directory)

    // Start from the on-disk load so every default and the normalization rules
    // (dropping malformed blocks, the monotonic nextBlockId floor) still apply,
    // then overlay what storage holds.
    return normalizeState({
        ...loadSessionState(sessionId, config.persistence.directory),
        ...(stored as Partial<SessionState>),
        toolCalls: new Map(
            Array.isArray(stored.toolCalls) ? (stored.toolCalls as [string, ToolCallInfo][]) : [],
        ),
        sessionId,
    })
}

/**
 * Options passed through the `plugins` array in opencode.jsonc:
 *
 *   "plugins": [{ "package": "@serkanalgur/opencodev2-slim",
 *                 "options": { "compress": { "maxContextLimit": "80%" } } }]
 *
 * The captured options live in `./lib/config` so that every `loadConfig()`
 * caller resolves the same values — the TUI panel included. Storing them here
 * instead would make the panel display limits the pipeline does not enforce.
 */

/** Capture the plugin options at setup(). Called once per plugin load. */
export function configurePluginOptions(ctx: any): void {
    setPluginOptions(ctx?.options)
}

export { resetPluginOptions } from "./lib/config"

function getConfig(sessionId: string): SlimConfig {
    return sessionConfigs.get(sessionId) || loadConfig()
}

/** Subset of v2 `ModelInfo` that matters for context-window resolution. */
type ModelLimitEntry = {
    providerID?: string
    modelID?: string
    limit?: { context?: number }
}

const isValidContextLimit = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0

const contextLimitOf = (model: ModelLimitEntry | undefined): number | undefined => {
    const context = model?.limit?.context
    return isValidContextLimit(context) ? context : undefined
}

/**
 * v2 `model.list()` resolves to `ModelListOutput = { location, data: ModelInfo[] }`
 * (verified in @opencode/client/dist/promise/generated/types.d.ts), so the array
 * lives under `.data`. Older callers and the test harness hand back the bare
 * collection instead — unwrap both shapes here rather than at every call site.
 */
function unwrapModelList(raw: unknown): ModelLimitEntry[] {
    if (Array.isArray(raw)) return raw as ModelLimitEntry[]
    if (raw && typeof raw === "object") {
        const data = (raw as { data?: unknown }).data
        if (Array.isArray(data)) return data as ModelLimitEntry[]
    }
    return []
}

// Resolve the active model's real context limit instead of hard-coding 200k.
//
// v2 signatures (verified against the installed .d.ts files):
//   ctx.model.default(): Promise<ModelDefaultOutput> = { location, data: ModelInfo | null }
//   ctx.model.list():    Promise<ModelListOutput>    = { location, data: ModelInfo[] }
// The model reference (providerID/modelID) and its `limit.context` therefore
// live under `.data`, NOT on the envelope itself, and `list()` must be awaited
// before it can be searched.
//
// Resolution order:
//   1. the active model found in `list().data` by providerID/modelID from
//      `default().data` — the exact window this session runs against;
//   2. `default().data.limit.context` — the active model's own window, used when
//      the list is empty or unavailable;
//   3. DEFAULT_MODEL_LIMIT (200000) — safety net with a warning, never the
//      normal path.
//
// There is deliberately NO "any other listed model" step: borrowing an
// unrelated model's window makes every percentage describe a model we are not
// running (GitHub issue #11 — a 128k model measured against another provider's
// 1M window). A wrong-but-plausible window is worse than a loud default.
//
// Why it matters: percent thresholds resolve as `pct/100 * contextLimit`
// (resolveThreshold → resolveCompressLimits). A 1M-window model now yields
// "80%" = 800000 instead of 160000.
export async function resolveModelContextLimit(ctx: any): Promise<number> {
    let providerID: string | undefined
    let modelID: string | undefined
    let defaultLimit: number | undefined
    let defaultError: unknown
    let sawDefault = false

    if (ctx?.model && typeof ctx.model.default === "function") {
        try {
            sawDefault = true
            // v2: the reference is `default().data` — reading it off the envelope
            // always yielded undefined and disabled the exact-match branch.
            const info: ModelLimitEntry | null | undefined = (await ctx.model.default())?.data
            providerID = info?.providerID
            modelID = info?.modelID
            defaultLimit = contextLimitOf(info ?? undefined)
        } catch (err) {
            defaultError = err
        }
    }

    // v2 returns a Promise<{ location, data }>; without `await` the search ran on
    // a Promise and threw ("models.find is not a function"), silently collapsing
    // every model to DEFAULT_MODEL_LIMIT.
    let models: ModelLimitEntry[] = []
    let listError: unknown
    let sawList = false
    if (ctx?.model && typeof ctx.model.list === "function") {
        try {
            sawList = true
            models = unwrapModelList(await ctx.model.list())
        } catch (err) {
            listError = err
        }
    }

    // 1) The active model, matched exactly against the full list.
    if (providerID && modelID) {
        const found = models.find((m) => m?.providerID === providerID && m?.modelID === modelID)
        const limit = contextLimitOf(found)
        if (limit !== undefined) return limit
    }

    // 2) The active model's own window straight from `default().data`.
    if (defaultLimit !== undefined) return defaultLimit

    // 3) Safety net — say so instead of pretending 200k is the real window.
    warnContextLimitFallback(defaultError, listError, sawDefault, sawList, models.length)
    return DEFAULT_MODEL_LIMIT
}

let warnedContextLimitFallback = false

// The model ref (`providerID/modelID`) each session's limit was resolved for.
// Compared per request so a mid-session model switch re-resolves the window
// instead of inheriting the one resolved at setup.
const sessionModelRefs = new Map<string, string>()

/**
 * Normalise a model reference to a comparable `providerID/modelID` key.
 *
 * The v2 hook event carries `Model.Ref` = `{ id, providerID, variant }`, while
 * the `ModelInfo` entries in `model.list()` use `modelID`. Both are accepted so
 * one lookup path serves the event and the list, and a variant is deliberately
 * ignored: a variant changes reasoning effort, not the context window.
 */
export function modelRefKey(ref: unknown): string | undefined {
    if (!ref || typeof ref !== "object") return undefined
    const r = ref as { providerID?: unknown; id?: unknown; modelID?: unknown }
    const providerID = typeof r.providerID === "string" ? r.providerID : undefined
    const modelID =
        typeof r.id === "string"
            ? r.id
            : typeof r.modelID === "string"
              ? r.modelID
              : undefined
    if (!providerID || !modelID) return undefined
    return `${providerID}/${modelID}`
}

/**
 * Resolve the context window for a specific model ref.
 *
 * `resolveModelContextLimit` answers "what is the DEFAULT model's window",
 * which is correct once at setup and wrong forever after: a session that
 * switches models keeps every percentage threshold pointed at the window of a
 * model it is no longer running (200k → 1M still fires at 160k).
 *
 * The same exact-match rule applies — the named model's own entry, never an
 * unrelated one (issue #11) — so a miss returns `undefined` and the caller
 * keeps the limit it already had rather than borrowing a neighbour's window.
 */
export async function resolveModelContextLimitForRef(
    ctx: any,
    ref: unknown,
): Promise<number | undefined> {
    const key = modelRefKey(ref)
    if (!key) return undefined
    // Split the FIRST separator only, never with `split(sep, 2)`: a model id
    // can itself contain slashes (`openrouter/meta-llama/llama-3-70b`), and a
    // 2-element split silently truncates the tail, so such a model would never
    // match its own list entry.
    const sep = key.indexOf("/")
    const providerID = key.slice(0, sep)
    const modelID = key.slice(sep + 1)

    let models: ModelLimitEntry[] = []
    if (ctx?.model && typeof ctx.model.list === "function") {
        try {
            models = unwrapModelList(await ctx.model.list())
        } catch {
            // Unavailable list: keep the current limit rather than guessing.
            return undefined
        }
    }

    const found = models.find(
        (m) => m?.providerID === providerID && (m?.modelID ?? undefined) === modelID,
    )
    return contextLimitOf(found)
}

/**
 * Keep `sessionModelLimits` in step with the model each request actually runs
 * against. Re-resolves only when the ref changes, so the steady-state cost is
 * one string compare plus the `model.list()` read the change triggers.
 *
 * Returns the limit to use for this request. A failed re-resolution keeps the
 * previous limit: a wrong-but-plausible window is worse than the window we
 * already had.
 */
export async function syncModelLimitForSession(
    ctx: any,
    sessionId: string,
    ref: unknown,
    fallbackLimit: number,
): Promise<number> {
    const key = modelRefKey(ref)
    if (!key || sessionModelRefs.get(sessionId) === key) {
        return sessionModelLimits.get(sessionId) || fallbackLimit
    }

    const resolved = await resolveModelContextLimitForRef(ctx, ref)
    const limit = resolved ?? sessionModelLimits.get(sessionId) ?? fallbackLimit

    if (resolved !== undefined) {
        // Record the ref ONLY on success. Marking a failed lookup as settled
        // would latch the fallback in permanently: the next request would see
        // the same key, short-circuit the re-resolution, and keep the wrong
        // window for the rest of the session even after `model.list()` starts
        // answering again. Not settled means "retry on the next request".
        sessionModelRefs.set(sessionId, key)
        sessionModelLimits.set(sessionId, limit)
    }

    if (getConfig(sessionId).debug) {
        console.log(`[slim] model limit: session=${sessionId} ref=${key} limit=${limit}`)
    }
    return limit
}

/** Clear the warn-once guard (test hook). */
export function resetContextLimitFallbackWarning(): void {
    warnedContextLimitFallback = false
}

/** One-shot notice: percent thresholds are meaningless while we run on the fake window. */
function warnContextLimitFallback(
    defaultError: unknown,
    listError: unknown,
    sawDefault: boolean,
    sawList: boolean,
    modelCount: number,
): void {
    if (warnedContextLimitFallback) return
    warnedContextLimitFallback = true
    const describe = (called: boolean, err: unknown): string => {
        if (!called) return "not available"
        if (err instanceof Error) return `failed: ${err.message}`
        return "returned no usable limit"
    }
    console.warn(
        `[slim] could not read the model context window (default: ${describe(sawDefault, defaultError)}; list: ${describe(sawList, listError)}; ${modelCount} models listed) — using ${DEFAULT_MODEL_LIMIT}, percent thresholds are approximate`,
    )
}

// ─── State Management ───────────────────────────────────────────────────────

/**
 * Deep-enough snapshot of the compression blocks for rollback.
 *
 * `syncCompressionBlocks()` mutates three things before it can throw: each
 * block's `active` flag, each block's `coveredMessageIds` (nested-consumption
 * inheritance pushes onto the live array), and the `state.compressionBlocks`
 * array itself (the orphan filter reassigns it). All three are persisted by
 * `saveSessionState()` at the end of the context hook, so a throw partway
 * through the apply step would otherwise write a half-applied state to disk —
 * a block deactivated in the sync loop whose covered ids were never inherited is
 * never resurrected by any other active block, so its messages silently
 * re-enter the prompt forever with no summary to replace them.
 *
 * Deliberately a structural copy, not a reference: the point is to capture the
 * VALUES as they were, because the mutation sites write through the same array
 * objects. Deliberately not a full `structuredClone` — the only fields these
 * two functions write are the three above, and cloning whole blocks would also
 * clone any future field that must keep its object identity.
 */
type BlocksSnapshot = {
    /** The array as it was, including its exact length. */
    ref: CompressionBlock[] | undefined
    /** `active` per block, by position in the ORIGINAL array. */
    active: boolean[]
    /** `coveredMessageIds` per block, by position in the ORIGINAL array. */
    covered: string[][]
}

function snapshotCompressionBlocks(blocks: CompressionBlock[] | undefined): BlocksSnapshot {
    const ref = blocks
    if (!Array.isArray(blocks)) {
        return { ref, active: [], covered: [] }
    }
    return {
        ref,
        // A corrupt persisted state can hold a `null` entry (that is exactly how
        // the rollback path gets exercised), so nothing here may dereference a
        // block unconditionally.
        active: blocks.map((b) => (b as any)?.active === true),
        covered: blocks.map((b) => [...((b?.coveredMessageIds as string[]) ?? [])]),
    }
}

/**
 * Undoes a snapshot taken before `syncCompressionBlocks()` ran. Restores the
 * array reference (the orphan filter may have replaced it) and rewrites the two
 * mutated fields on each surviving block IN PLACE, so any other holder of a
 * block object sees the rollback too.
 */
function restoreCompressionBlocks(state: SessionState, snap: BlocksSnapshot): void {
    state.compressionBlocks = snap.ref
    if (!Array.isArray(snap.ref)) return
    for (let i = 0; i < snap.ref.length; i++) {
        const block = snap.ref[i] as any
        if (!block || typeof block !== "object") continue
        block.active = snap.active[i]
        block.coveredMessageIds = snap.covered[i]
    }
}

// Register a DCP-style compression block for the selected range. The range is
// covered (removed from future outgoing requests) and the summary is injected
// at the anchor: the first message after the range, or the latest message when
// the range reaches the end (the active user turn is never replaced).
function registerBlockForRange(
    state: SessionState,
    topic: string,
    messageWithParts: MessageWithParts[],
    targetIndices: number[],
    summary: string,
    summaryTokens: number,
): CompressionBlock | null {
    if (targetIndices.length === 0 || messageWithParts.length === 0) return null

    const sorted = [...targetIndices].sort((a, b) => a - b)
    const coveredIndices = new Set(sorted)

    let anchorIndex = sorted[sorted.length - 1] + 1
    if (anchorIndex >= messageWithParts.length) {
        anchorIndex = messageWithParts.length - 1
        coveredIndices.delete(anchorIndex)
    }
    if (anchorIndex < 0 || anchorIndex >= messageWithParts.length) return null

    const anchorId = messageWithParts[anchorIndex].info?.id
    if (!anchorId) return null

    const coveredIds = [...coveredIndices]
        .map((i) => messageWithParts[i].info?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    if (coveredIds.length === 0) return null

    return registerCompressionBlock(state, {
        coveredIds,
        anchorMessageId: anchorId,
        summary,
        topic,
        summaryTokens,
    })
}

/**
 * Wraps any message format into MessageWithParts for internal processing.
 * Handles both:
 * - Raw Message format (from context hook): { id, role, parts/content }
 * - SessionMessageInfo format (from session.context()): { id, type, text/content }
 * - Transcript format (from TUI): { type, text, content }
 */
function wrapAsMessageWithParts(msg: any): MessageWithParts {
    // Determine the role from various possible fields
    let role = "assistant"
    if (msg?.role) {
        role = msg.role
    } else if (msg?.type) {
        // SessionMessageInfo / transcript format: type -> role mapping
        const type = msg.type as string
        if (type === "user" || type === "shell" || type === "synthetic") {
            role = "user"
        } else if (type === "assistant") {
            role = "assistant"
        } else if (type === "compaction" || type === "agent" || type === "model" || type === "skill") {
            role = "system"
        } else {
            role = "assistant"
        }
    }

    // Extract ID
    const id = msg?.id ?? msg?.info?.id ?? ""

    // Build parts array from whatever format we receive
    const parts: any[] = []

    if (role === "user") {
        // User messages: text can be in msg.text, msg.content, or msg.parts
        if (typeof msg.text === "string" && msg.text) {
            parts.push({ type: "text", text: msg.text })
        } else if (Array.isArray(msg.parts)) {
            for (const p of msg.parts) {
                if (p?.type === "text" && p.text) {
                    parts.push({ type: "text", text: p.text })
                }
            }
        } else if (Array.isArray(msg.content)) {
            for (const p of msg.content) {
                if (p?.type === "text" && p.text) {
                    parts.push({ type: "text", text: p.text })
                }
            }
        }
    } else if (role === "assistant") {
        // Assistant messages: content can be an array of parts
        const contentArr = msg.content ?? msg.parts ?? []
        if (Array.isArray(contentArr)) {
            for (const p of contentArr) {
                if (p?.type === "text") {
                    parts.push({ type: "text", text: p.text || "" })
                } else if (p?.type === "tool") {
                    // SessionMessageAssistantTool format: has callID, name, state
                    const state = p.state
                    if (state?.status === "completed") {
                        parts.push({
                            type: "tool-result",
                            toolCallID: p.callID,
                            result: { value: state.content ?? state.output ?? "" },
                        })
                    } else if (state?.status === "error") {
                        parts.push({
                            type: "tool-result",
                            toolCallID: p.callID,
                            result: { type: "error", value: state.error ?? "Unknown error" },
                        })
                    }
                    // Tool call part
                    parts.push({
                        type: "tool-call",
                        name: p.name || p.tool || "",
                        input: state?.input ?? {},
                        toolCallID: p.callID,
                    })
                } else if (p?.type === "tool-call") {
                    parts.push(p)
                } else if (p?.type === "tool-result") {
                    parts.push(p)
                }
            }
        }
    } else if (role === "system") {
        // System / compaction messages
        if (typeof msg.summary === "string" && msg.summary) {
            parts.push({ type: "text", text: msg.summary })
        } else if (typeof msg.text === "string" && msg.text) {
            parts.push({ type: "text", text: msg.text })
        }
    }

    return {
        info: {
            id,
            role,
            sessionID: msg?.sessionID ?? msg?.info?.sessionID ?? "",
            time: { created: Date.now() },
        } as any,
        parts,
    }
}

// ─── Plugin Entry ───────────────────────────────────────────────────────────

export default Plugin.define({
    id: "opencodev2-slim",
    async setup(ctx) {
        createDefaultConfig()
        // Route session state through the host's plugin-scoped storage, keyed by
        // project directory, so two checkouts no longer share one global
        // ~/.config/opencode/slim directory. Falls back to that directory when
        // the host exposes no storage domain.
        configurePersistence(ctx)

        // Options from the `plugins` array in opencode.jsonc, captured once per
        // plugin load. `slim.jsonc` remains the fallback for every key the
        // options object does not set.
        configurePluginOptions(ctx)

        // Resolve the active model's real context limit once.
        // This drives accurate percentage-based thresholds instead of a hard-coded 200k.
        const initialModelLimit = await resolveModelContextLimit(ctx)

        // ─── Measured Usage Source ─────────────────────────────────────────
        // Token accounting needs the real billing of the last completed
        // request, but calling `session.context()` on every request would
        // serialize the whole transcript (megabytes in long sessions) once per
        // turn. Instead the `session.step.ended` event keeps a per-session
        // cache fresh with the exact `TokenUsageInfo` of the step that just
        // finished, and the transcript is read exactly ONCE per session to
        // seed it (cold start: plugin loaded into an already-running
        // session). Compaction invalidates the entry, because a measurement
        // taken before compaction describes a prompt that no longer exists.
        const measuredUsageFor = async (sessionID: string): Promise<MeasuredUsage | null> => {
            const cached = sessionUsage.get(sessionID)
            if (cached) return cached.usage

            try {
                const messages = await ctx.session.context({ sessionID })
                const usage = readMeasuredUsage(messages, findLastCompactionIndex(messages))
                // The "no measurement" answer is cached too — otherwise a fresh
                // session would re-read the transcript on every single request.
                recordUsage(sessionUsage, sessionID, usage)
                if (getConfig(sessionID).debug) {
                    console.log(`[slim] usage cold start: session=${sessionID}, measured=${usage?.tokens ?? "none"}`)
                }
                return usage
            } catch (err) {
                // Estimation covers us: a failed cold start must never break the request.
                if (getConfig(sessionID).debug) {
                    console.log(`[slim] usage cold start failed:`, err)
                }
                return null
            }
        }

        // ─── Register Compress Tool ───────────────────────────────────────
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "compress",
                description: getCompressToolDescription(),
                input: {
                    type: "object",
                    properties: {
                        focus: {
                            type: "string",
                            description: "What to compress (e.g., 'old exploration', 'completed tasks')",
                        },
                        mode: {
                            type: "string",
                            enum: ["auto", "range", "topic"],
                            default: "auto",
                            description: "Compression mode",
                        },
                        start: {
                            type: "number",
                            description: "Start message index (for range mode)",
                        },
                        end: {
                            type: "number",
                            description: "End message index (for range mode)",
                        },
                        topic: {
                            type: "string",
                            description: "Topic to compress (for topic mode)",
                        },
                        keepRecent: {
                            type: "number",
                            default: 5,
                            description: "Number of recent messages to always keep",
                        },
                    },
                    required: ["focus"],
                    additionalProperties: false,
                },
                options: { codemode: false },
                execute: async (input, context) => {
                    const args = input as {
                        focus: string
                        mode?: string
                        start?: number
                        end?: number
                        topic?: string
                        keepRecent?: number
                    }
                    const mode = args.mode || "auto"
                    const keepRecent = args.keepRecent || 5
                    const sessionId = context.sessionID
                    const config = getConfig(sessionId)
                    const state = await getState(sessionId, config)

                    try {
                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        if (config.debug) {
                            const first = messages[0] as any
                            console.log(`[slim] compress: received ${messages.length} messages from session.context()`)
                            console.log(`[slim] compress: first message type: ${first?.type}, has text: ${typeof first?.text}, has content: ${Array.isArray(first?.content)}`)
                        }

                        const messageWithParts: MessageWithParts[] = messages.map(
                            (m: any) => wrapAsMessageWithParts(m),
                        )

                        if (config.debug) {
                            const partsCounts = messageWithParts.map((m) => m.parts.length)
                            console.log(`[slim] compress: parts per message: [${partsCounts.join(", ")}]`)
                        }

                        let targetIndices: number[] = []
                        let inputTokens = 0

                        if (mode === "range" && args.start !== undefined && args.end !== undefined) {
                            const start = Math.max(0, args.start)
                            const end = Math.min(messageWithParts.length, args.end)
                            for (let i = start; i < end; i++) {
                                targetIndices.push(i)
                                const text =
                                    getMessageText(messageWithParts[i]) +
                                    getToolResultContent(messageWithParts[i])
                                inputTokens += await countTokens(text)
                            }
                        } else if (mode === "topic" && args.topic) {
                            const topicLower = args.topic.toLowerCase()
                            for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
                                const msg = messageWithParts[i]
                                const text = getMessageText(msg) + getToolResultContent(msg)
                                if (text.toLowerCase().includes(topicLower)) {
                                    targetIndices.push(i)
                                    inputTokens += await countTokens(text)
                                }
                            }
                        } else {
                            for (let i = 0; i < messageWithParts.length - keepRecent; i++) {
                                const msg = messageWithParts[i]
                                const text = getMessageText(msg) + getToolResultContent(msg)
                                const tokens = await countTokens(text)
                                if (tokens < 100) continue
                                targetIndices.push(i)
                                inputTokens += tokens
                            }
                        }

                        if (targetIndices.length === 0) {
                            return { content: "Nothing to compress - context is already efficient" }
                        }

                        const targetMessages = targetIndices.map((i) => messageWithParts[i])
                        const summary = await buildCompressionSummary(
                            targetMessages,
                            args.focus,
                            config.compress.protectedTools,
                            config.compress.protectUserMessages,
                        )
                        const outputTokens = await countTokens(summary)
                        // Clamped: a compression that does not shrink is 0% saved,
                        // not a negative saving. Same form as the other two
                        // record sites (strategies.ts auto-compress, and the
                        // compaction path below).
                        const ratio =
                            inputTokens > 0 && inputTokens > outputTokens
                                ? 1 - outputTokens / inputTokens
                                : 0

                        // DCP: register a compression block so future outgoing
                        // requests replace this range with the summary.
                        let blockNote = ""
                        try {
                            const block = registerBlockForRange(
                                state,
                                args.focus,
                                messageWithParts,
                                targetIndices,
                                summary,
                                outputTokens,
                            )
                            if (block) {
                                // Clamped for the same reason as `ratio`: a
                                // summary larger than its range must not be
                                // announced as "-330% smaller".
                                const smallerPct = Math.max(
                                    0,
                                    Math.round(
                                        (1 - outputTokens / Math.max(1, inputTokens)) * 100,
                                    ),
                                )
                                blockNote = `\n\n_Block #${block.blockId}: ${block.coveredMessageIds.length} messages will collapse into this summary on future requests (${smallerPct}% smaller)._\n_To restore them: ask to reset context._`
                            }
                        } catch {
                            // Best-effort: the summary is still returned to the model.
                        }

                        addCompressionRecord(
                            state,
                            {
                                timestamp: Date.now(),
                                inputTokens,
                                outputTokens,
                                ratio,
                                messageCount: targetMessages.length,
                                success: true,
                            },
                            config.adaptive.learningRate,
                        )

                        await persistState(state, config)

                        return {
                            content: `## Compressed ${targetMessages.length} messages\n\n${summary}\n\n---\n**Stats:** ${inputTokens} → ${outputTokens} tokens (${Math.round(ratio * 100)}% saved) | Mode: ${mode} | Focus: ${args.focus}${blockNote}`,
                        }
                    } catch (error) {
                        return {
                            content: `Error compressing: ${error instanceof Error ? error.message : "Unknown error"}`,
                        }
                    }
                },
            })

            editor.add({
                name: "panel",
                description: `Display a rich context usage panel showing:
- Current token usage vs model limit
- Measurement source (server-reported vs estimated/approximate)
- Message breakdown (user/assistant/tools)
- Token distribution by role
- Compression history and savings
- Tool-output pruning stats for the last request (when enabled)
- Cost estimate
- Topic distribution
- Smart recommendations`,
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: false },
                execute: async (_input, context) => {
                    const sessionId = context.sessionID
                    const config = getConfig(sessionId)
                    const state = await getState(sessionId, config)

                    try {
                        // Pull the real, server-measured context usage for this session.
                        let measured: import("./lib/tui").MeasuredContext | undefined
                        try {
                            const info = await ctx.session.get({ sessionID: sessionId })
                            const tokens = info.tokens as any
                            // ⚠️ `info.tokens` is the session's LIFETIME CUMULATIVE
                            // counter: the v2 projector adds input/output/reasoning/
                            // cache.read/cache.write on every usage event, and
                            // cache.read re-reads the whole context each turn, so this
                            // sum grows without bound (issue #30649: 56.1M tokens in a
                            // single session, 41M of them cache.read). Valid as a cost
                            // figure, invalid as "how full is the window right now".
                            const tokenCount =
                                (tokens?.input ?? 0) +
                                (tokens?.output ?? 0) +
                                (tokens?.reasoning ?? 0) +
                                (tokens?.cache?.read ?? 0) +
                                (tokens?.cache?.write ?? 0)
                            measured = {
                                tokens: tokenCount,
                                cost: typeof info.cost === "number" ? info.cost : 0,
                                contextLimit:
                                    state.modelContextLimit || (await resolveModelContextLimit(ctx)),
                                model: (info.model && (info.model as any).id) || "unknown",
                            }
                            // Keep the model window aligned with reality.
                            state.modelContextLimit = measured.contextLimit
                            // Deliberately NOT `state.currentTokenCount = measured.tokens`:
                            // that field feeds the auto-compress trigger in the context
                            // hook below, and writing a monotonically growing cumulative
                            // total there made `totalTokens > limits.max` stay true
                            // forever — auto-compress fired on every request and the
                            // inflated value was persisted to disk. The cumulative total
                            // stays local to this panel call (shown as "Lifetime").
                        } catch {
                            // Fall through to estimation if session.get fails.
                        }

                        const messages = await ctx.session.context({ sessionID: sessionId })

                        if (!messages || messages.length === 0) {
                            return { content: "No messages found in session" }
                        }

                        // Context fullness for the panel: the last assistant turn's
                        // `input + cache.read + cache.write` is the prompt size of ONE
                        // real request (cache.read is deliberately not accumulated across
                        // turns), so it — not the cumulative counter — answers "how full
                        // is the window". buildPanelData falls back to its own
                        // transcript estimate (labelled "estimated") when the
                        // transcript carries no token info — never to
                        // `measured.tokens`, the lifetime spend counter.
                        //
                        // Same function as the request pipeline (usage.ts), so the panel
                        // and the auto-compress trigger can never disagree: backwards
                        // scan for the last `assistant` message with real usage, starting
                        // after the last COMPLETED compaction (usage recorded before a
                        // compaction describes a prompt that no longer exists).
                        if (measured) {
                            const usage = readMeasuredUsage(messages, findLastCompactionIndex(messages))
                            if (usage) {
                                measured.promptTokens = usage.promptTokens
                            }
                        }

                        const messageWithParts: MessageWithParts[] = messages.map(
                            (m: any) => wrapAsMessageWithParts(m),
                        )

                        const panelData = await buildPanelData(
                            sessionId,
                            messageWithParts,
                            state,
                            config,
                            measured?.model,
                            measured,
                            sessionPruneStats.get(sessionId),
                        )

                        const panel = renderPanel(panelData)
                        await persistState(state, config)
                        return { content: panel }
                    } catch (error) {
                        return {
                            content: `Error generating panel: ${error instanceof Error ? error.message : "Unknown error"}`,
                        }
                    }
                },
            })
        })

        // ─── System Prompt Hook ───────────────────────────────────────────
        // Async because the model window is re-resolved from `event.model`; the
        // hook contract allows `Promise<void>`, and awaiting here keeps the
        // published limits consistent with the context hook below.
        hookRegistrations.push(await ctx.session.hook("context", async (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) return

            const state = await getState(sessionId, config)
            // Same model-derived window as the context hook below, so the
            // published limits never describe a model this session left behind.
            state.modelContextLimit = await syncModelLimitForSession(
                ctx,
                sessionId,
                event.model,
                initialModelLimit,
            )

            event.system.push({ type: "text", text: getSystemPrompt() })
        }))

        // ─── Messages Transform Hook (sync → async) ─────────────────────────
        // DCP pipeline for every outgoing request: sync compression blocks,
        // replace covered ranges with summary placeholders, prune (dedup +
        // purge errored tool inputs + prune stale tool outputs), then apply DCP
        // limit rules as anchored nudges. Session history is never modified —
        // only this request.
        hookRegistrations.push(await ctx.session.hook("context", async (event) => {
            const sessionId = event.sessionID
            const config = getConfig(sessionId)
            if (!config.enabled) return

            const state = await getState(sessionId, config)
            // The request itself names the model this session is running, so the
            // window is resolved from `event.model` rather than from whatever the
            // default model happened to be at setup — otherwise every percent
            // threshold stays pinned to the old model after a mid-session switch.
            state.modelContextLimit = await syncModelLimitForSession(
                ctx,
                sessionId,
                event.model,
                initialModelLimit,
            )

            if (config.debug) {
                console.log(`[slim] context hook: session=${sessionId}, messages=${event.messages.length}, modelLimit=${state.modelContextLimit}`)
            }

            // 0) Compaction reset (before token accounting): a fresh compaction
            //    rewrote history, so every block anchor and nudge we held points
            //    into messages that no longer exist and must be dropped before
            //    this request is built. The compaction event carries no message
            //    id, so the id can only be learned from the transcript — read it
            //    only when there is something new to learn (cold start, usage
            //    cache empty, or a compaction event observed). `session.context()`
            //    serializes the whole transcript, so this must never run on every
            //    request.
            if (
                state.lastCompactionMessageId === undefined ||
                !sessionUsage.has(sessionId) ||
                sessionsAwaitingCompactionCheck.has(sessionId)
            ) {
                let transcript: unknown[] = []
                let transcriptRead = false
                try {
                    transcript = await ctx.session.context({ sessionID: sessionId })
                    transcriptRead = true
                } catch (err) {
                    if (config.debug) {
                        console.log(`[slim] compaction check: transcript read failed`, err)
                    }
                }

                if (transcriptRead) {
                    const compactionIndex = findLastCompactionIndex(transcript)
                    const compactionMessageId =
                        compactionIndex >= 0
                            ? String((transcript[compactionIndex] as { id?: unknown })?.id ?? "")
                            : ""
                    if (compactionMessageId !== state.lastCompactionMessageId) {
                        resetOnCompaction(state, compactionMessageId)
                        // A measurement taken before compaction describes a
                        // prompt that no longer exists — drop the cached usage.
                        sessionUsage.delete(sessionId)
                        // The id is now visible, so this check is settled. If it
                        // was still unchanged the pending flag stays set and the
                        // next request retries (the write may have raced us).
                        sessionsAwaitingCompactionCheck.delete(sessionId)
                        if (config.debug) {
                            console.log(`[slim] compaction reset: id=${compactionMessageId || "none"}`)
                        }
                    }
                    // Cold start / post-compaction: seed the measured usage from
                    // the read already paid for, so the trigger path below does
                    // not serialize the transcript a second time.
                    if (!sessionUsage.has(sessionId)) {
                        recordUsage(sessionUsage, sessionId, readMeasuredUsage(transcript, compactionIndex))
                    }
                }
            }

            // 1) Compression blocks: activate/deactivate and replace ranges.
            //    Keys are computed HERE, on the untouched request: the steps
            //    below rewrite message content (dedup, purge, nudges) while the
            //    persisted blocks never see those edits, so keys derived after
            //    a mutation would not match on the next request. Production
            //    Prompt.Message objects carry no `id`, so stableMessageKey
            //    falls back to role + content hash + index.
            const keys: string[] = []
            // message object -> its pre-mutation key. Consumed at step 2b, where
            // the auto-compress key array is captured over the filtered list
            // BEFORE pruning clones message objects, so every surviving message
            // keeps the stable key it had at step 1 (which is what the persisted
            // compression block must store to match again on the next request).
            const keyByMessage = new Map<object, string>()
            for (let i = 0; i < event.messages.length; i++) {
                const msg = event.messages[i] as any
                const key = stableMessageKey(msg, i)
                keys.push(key)
                if (msg && typeof msg === "object") keyByMessage.set(msg, key)
            }
            //    An ambiguous key (two messages, one key) is still *present*,
            //    so its block survives the orphan filter; the lock itself is
            //    enforced twice: syncCompressionBlocks() never activates a
            //    block on an ambiguous anchor, and applyCompressedRanges()
            //    never removes an ambiguous message and never injects at an
            //    ambiguous anchor.
            const ambiguousKeys = findAmbiguousKeys(keys)
            const presentIds = new Set(keys)
            // Best-effort: the whole compression-apply step is a pure
            // optimisation of the outgoing request. Anything it throws must
            // leave BOTH `event.messages` and `state.compressionBlocks`
            // exactly as they were — a plugin error must never become a failed
            // provider request, nor a half-applied state that gets persisted.
            //
            // syncCompressionBlocks() mutates state BEFORE it can throw (it
            // writes `block.active`, pushes inherited covered ids, and
            // reassigns `state.compressionBlocks`), and `state` is written to
            // disk by saveSessionState() at the end of this hook. So the catch
            // has to roll the state back too, not just the message array: a
            // block deactivated in the sync loop whose covered ids were never
            // inherited is not resurrected by any other active block, so its
            // messages would silently re-enter the prompt with no summary to
            // replace them — unrecoverable, and invisible without this rollback.
            const before = [...event.messages]
            const blocksBefore = snapshotCompressionBlocks(state.compressionBlocks)
            let filtered: typeof event.messages = event.messages
            let beforeCount = event.messages.length
            let compressed = false
            try {
                syncCompressionBlocks(state, presentIds, ambiguousKeys)
                beforeCount = event.messages.length
                filtered = applyCompressedRanges(
                    state,
                    event.messages,
                    keys,
                    config.strategies.guardToolPairs !== false,
                )
                // MUST stay an in-place splice: the host's trigger yields the
                // callback's return value nowhere and returns the SAME event
                // object it passed in, so `event.messages = filtered` would
                // silently no-op the entire plugin.
                event.messages.splice(0, event.messages.length, ...filtered)
                compressed = true
            } catch (err) {
                // Unconditional, NOT debug-gated: a swallowed state mutation is
                // the one failure class in this file that is unrecoverable and
                // leaves no trace in the request itself — the next request
                // would just quietly carry an uncompressed prompt. Same class
                // as the context-limit fallback warning below: if the user
                // cannot see it, they cannot act on it.
                console.warn(
                    "[slim] compression skipped: the apply step threw, so this request is " +
                        "sent uncompressed and the compression state was rolled back.",
                    err,
                )
                // Best-effort: compression failure should never break the request.
                // Restored WITHOUT spread: the realistic cause of the throw is
                // argument-count overflow on a very large array, and a spread
                // here would throw identically — escaping the context hook,
                // which is the exact outcome this catch exists to prevent.
                // Clearing the length first and pushing in a loop cannot.
                event.messages.length = 0
                for (const msg of before) event.messages.push(msg)
                restoreCompressionBlocks(state, blocksBefore)
                filtered = event.messages
                beforeCount = filtered.length
            }

            if (config.debug && beforeCount !== filtered.length) {
                console.log(`[slim] compressed ranges: ${beforeCount} -> ${filtered.length} messages`)
            }
            if (config.debug && ambiguousKeys.size > 0) {
                console.log(`[slim] ambiguous message keys: ${ambiguousKeys.size} — compression locked for them`)
            }
            if (config.debug && compressed && config.strategies.guardToolPairs === false) {
                console.log(
                    `[slim] tool-pair guard: DISABLED via strategies.guardToolPairs — a covered ` +
                        `tool-call whose result survives can now reach the provider as an orphan ` +
                        `tool_call_id and 400 the next request.`,
                )
            }

            // 2) Pruning strategies (each request).
            pruneInPlace(event.messages, config)
            if (config.strategies.purgeErrors.enabled) {
                purgeStaleToolErrors(
                    event.messages,
                    config.strategies.purgeErrors.turns,
                    config.strategies.purgeErrors.protectedTools,
                )
            }

            // 2b) Tool-output pruning (DCP pruneOutputs) — strictly AFTER
            //     deduplication. Deduplication compares exact content; if output
            //     pruning ran first, two distinct tool results would both become
            //     the same placeholder and dedup would then drop a whole turn.
            //     The plan is read-only over this request and application only
            //     shrinks payloads (never removes a message, never a tool-call
            //     part, never changes result.type). It runs BEFORE token
            //     accounting so the prompt size we measure is the size we send.
            //
            //     Capture the auto-compress keys HERE, before applyPrunePlan:
            //     applyPrunePlan replaces every pruned message with a
            //     structuredClone()d copy (prune.ts), which destroys the object
            //     identity `keyByMessage` is keyed on. Deriving the keys after
            //     prune would miss every clone and fall back to
            //     stableMessageKey() over ALREADY-MUTATED content and a shifted
            //     index — keys a later request can never match, leaving the
            //     auto-compress block inert. Prune swaps array slots but never
            //     adds or removes one, and nudges only mutate existing messages,
            //     so the array captured here stays index-aligned with the array
            //     autoCompress receives below.
            const autoKeys = event.messages.map((m, i) =>
                keyByMessage.get(m as object) ?? stableMessageKey(m, i),
            )

            const prunePlan = buildPrunePlan(event.messages, config)
            applyPrunePlan(event.messages, prunePlan)
            // Remember this request's pruning for the panel. Overwritten every
            // request (zeros when pruning is off), because the figure describes
            // the request we just built — it is not cumulative.
            sessionPruneStats.set(sessionId, prunePlan.stats)
            if (config.debug) {
                console.log(
                    `[slim] prune outputs: enabled=${config.strategies.pruneOutputs?.enabled === true}, pruned=${prunePlan.stats.prunedOutputs}, charsSaved=${prunePlan.stats.charsSaved}`,
                )
            }

            // 3) Token accounting: `totalTokens` MUST describe the size of the
            //    prompt we are about to send — it drives the nudge thresholds and
            //    the auto-compress check in step 5.
            //
            //    Two numbers are combined (src/lib/usage.ts):
            //    - `estimated`: EVERYTHING on the wire for this request — text,
            //      reasoning, tool-call inputs, tool results (string and v2
            //      content-block arrays), compaction summaries, the system
            //      prompt and the tool schemas. The old text-parts-only loop
            //      below missed all of that and under-reported 2-5x, which is
            //      why auto-compress never fired in production.
            //    - `measured`: the provider's real billing of the last completed
            //      request, kept fresh by the `session.step.ended` event (never
            //      `Session.Info.tokens` — a LIFETIME cumulative counter that
            //      never comes back down, issue #30649: 56.1M tokens in one
            //      session; preferring it made `totalTokens > limits.max` stay
            //      true forever and fired auto-compress on every request).
            //
            //    `resolveTriggerTokens` merges them with clamping in both
            //    directions, so a stale or broken number can neither disable
            //    nor spam the trigger. The result is written back to
            //    `state.currentTokenCount`, which also heals state files
            //    already carrying a cumulative total.
            const estimatedTokens = estimatePromptTokens(event.messages, event.system, event.tools)
            const measured = await measuredUsageFor(sessionId)
            const accounting = resolveTriggerTokens(measured, estimatedTokens, config.usage)
            const totalTokens = accounting.tokens
            state.currentTokenCount = totalTokens

            if (config.debug) {
                console.log(`[slim] token accounting: source=${accounting.source}, measured=${accounting.measured}, estimated=${accounting.estimated}, clamped=${accounting.clamped}, totalTokens=${totalTokens}, messages=${event.messages.length}, persistedCurrentTokenCount=${state.currentTokenCount}`)
            }

            // 4) DCP limit rules → anchored nudges (max 100k / min 50k by
            //    default, model overrides supported via modelMax/MinLimits).
            //    Extract provider/model from the last user message for per-model limits.
            const lastUser = findLastUserMessage(event.messages)
            const providerId =
                lastUser?.model?.providerID ??
                state._lastProviderId ??
                (typeof lastUser?.model?.id === "string" ? lastUser.model.id.split("/")[0] : undefined)
            const modelId =
                lastUser?.model?.modelID ??
                state._lastModelId ??
                (typeof lastUser?.model?.id === "string" ? lastUser.model.id.split("/").slice(1).join("/") : undefined)
            const limits = resolveCompressLimits(config, state, providerId, modelId)

            if (config.debug) {
                console.log(`[slim] limits: max=${limits.max} min=${limits.min}, totalTokens=${totalTokens}, overMax=${totalTokens > limits.max}, overMin=${totalTokens >= limits.min}`)
            }

            injectLimitNudges(state, config, event.messages, totalTokens, limits, providerId, modelId)

            if (config.debug) {
                const nudgeState = state.nudges ?? { contextLimitAnchors: [], turnNudgeAnchors: [], iterationNudgeAnchors: [] }
                console.log(`[slim] nudges: contextLimit=${nudgeState.contextLimitAnchors.length}, turn=${nudgeState.turnNudgeAnchors.length}, iteration=${nudgeState.iterationNudgeAnchors.length}`)
            }

            // 5) Auto-compress: when over the max limit, directly compress old
            //    messages without waiting for the model to call the compress tool.
            //    Registers a compression block so future requests use the summary.
            //    `totalTokens` is this request's prompt size (step 3), never the
            //    session's lifetime cumulative counter — otherwise every long
            //    session would compress on every single request.
            if (totalTokens > limits.max) {
                if (config.debug) {
                    console.log(`[slim] auto-compress triggered: ${totalTokens} > ${limits.max} (max)`)
                }
                try {
                    // `autoKeys` was captured before tool-output pruning (step
                    // 2b), using the pre-mutation keys for every surviving
                    // message and the id/hash fallback for freshly created ones
                    // (summary placeholders). Prune and nudges never change the
                    // array's length or order, so the array is still aligned with
                    // `event.messages` here — this is the key fix: recomputing
                    // after prune would miss the structuredClone()d copies.
                    const result = await autoCompress(
                        state,
                        config,
                        event.messages,
                        totalTokens,
                        limits,
                        autoKeys,
                    )
                    if (config.debug && result.compressed) {
                        console.log(`[slim] auto-compress: compressed ${result.messageCount} messages, saved ~${result.tokensSaved} tokens`)
                    }
                } catch (err) {
                    if (config.debug) {
                        console.log(`[slim] auto-compress failed:`, err)
                    }
                    // Best-effort: auto-compress failure should never break the request.
                }
            }

            if (config.debug) {
                console.log(`[slim] final messages: ${event.messages.length}, tokens: ${totalTokens}, limits: max=${limits.max} min=${limits.min}`)
            }

            await persistState(state, config)
        }))

        // ─── Compaction Hook ────────────────────────────────────────────
        // Real, persistent context compression: when OpenCode compacts a session,
        // provide a structured summary so history actually shrinks (unlike the
        // `context` hook, which only affects the outgoing model request).
        hookRegistrations.push(await ctx.session.hook("compaction", async (event) => {
            const sessionId = (event as any).sessionID
            const config = getConfig(sessionId)
            if (!config.enabled || !config.compress.enabled) return

            const messages = (event as any).messages || []
            if (!messages.length) return

            const state = await getState(sessionId, config)
            // A compaction request names its model too, so re-sync here as well:
            // resolving thresholds during compaction against the previous
            // model's window is the same staleness bug as in the context hook.
            state.modelContextLimit = await syncModelLimitForSession(
                ctx,
                sessionId,
                (event as any).model,
                initialModelLimit,
            )

            // Build a structured summary instead of just stringifying.
            const lines: string[] = []
            lines.push("## Session Summary (Compacted)")
            lines.push("")

            const summaryParts: string[] = []
            const toolCallsSummary: string[] = []
            const keyDecisions: string[] = []
            let userMessageCount = 0
            let assistantMessageCount = 0

            for (const msg of messages) {
                const type = msg?.type ?? msg?.role ?? ""
                if (type === "user" || type === "shell" || type === "synthetic") {
                    userMessageCount++
                    const text = msg.text ?? ""
                    if (text.trim().length > 0) {
                        summaryParts.push(`[User]: ${text.slice(0, 300)}`)
                    }
                } else if (type === "assistant") {
                    assistantMessageCount++
                    const content = msg.content ?? msg.parts ?? []
                    if (Array.isArray(content)) {
                        for (const part of content) {
                            if (part?.type === "text" && part.text) {
                                const t = part.text
                                if (t.length > 0) {
                                    summaryParts.push(`[Assistant]: ${t.slice(0, 300)}`)
                                }
                                // Capture decisions
                                if (t.includes("decided") || t.includes("implemented") || t.includes("created")) {
                                    keyDecisions.push(t.slice(0, 200))
                                }
                            } else if (part?.type === "tool" || part?.type === "tool-call") {
                                const name = part.name ?? part.tool ?? "unknown"
                                toolCallsSummary.push(name)
                            }
                        }
                    }
                } else if (type === "compaction") {
                    // Previous compaction summary — include verbatim
                    if (msg.summary) {
                        summaryParts.push(`[Previous summary]: ${msg.summary.slice(0, 500)}`)
                    }
                }
            }

            // Compose summary
            lines.push(`Messages: ${userMessageCount} user, ${assistantMessageCount} assistant`)
            if (toolCallsSummary.length > 0) {
                const uniqueTools = [...new Set(toolCallsSummary)]
                lines.push(`Tools used: ${uniqueTools.join(", ")}`)
            }
            lines.push("")

            // Key exchanges (first few and last few, skip middle)
            const keepFirst = Math.min(3, summaryParts.length)
            const keepLast = Math.min(3, summaryParts.length)
            if (keepFirst + keepLast < summaryParts.length) {
                lines.push("### Key exchanges")
                for (const s of summaryParts.slice(0, keepFirst)) {
                    lines.push(s)
                }
                lines.push("...")
                for (const s of summaryParts.slice(-keepLast)) {
                    lines.push(s)
                }
            } else {
                lines.push("### Conversation")
                for (const s of summaryParts) {
                    lines.push(s)
                }
            }

            if (keyDecisions.length > 0) {
                lines.push("")
                lines.push("### Key decisions")
                for (const d of keyDecisions.slice(0, 5)) {
                    lines.push(`- ${d}`)
                }
            }

            const summary = lines.join("\n")
            const inputTokens = await countTokens(messages.map((m: any) => m.text ?? "").join("\n"))
            const outputTokens = await countTokens(summary)

            if (outputTokens > 0 && inputTokens > 0) {
                addCompressionRecord(
                    state,
                    {
                        timestamp: Date.now(),
                        inputTokens,
                        outputTokens,
                        // Clamped, and the same form as the other two record
                        // sites (strategies.ts auto-compress, and the compress
                        // tool above). A compression that does not shrink is 0%
                        // saved, not a negative saving.
                        ratio:
                            inputTokens > 0 && inputTokens > outputTokens
                                ? 1 - outputTokens / inputTokens
                                : 0,
                        messageCount: messages.length,
                        success: true,
                    },
                    config.adaptive.learningRate,
                )
                await persistState(state, config)
            }

            // Record our own summary so OpenCode uses it instead of running the model.
            ;(event as any).result = { summary }
        }))

        // ─── Event Subscription ──────────────────────────────────────────
        // A compaction rewrote history: the cached measurement describes a prompt
        // that no longer exists, and the per-request state (blocks, nudge
        // anchors, tool calls) points at messages that are gone. Drop the cache
        // and ask the next context hook to read the transcript once to learn the
        // new compaction's message id and reset on it. `session.compacted` is
        // emitted by the server but is absent from the generated V2Event union,
        // so it is matched through a cast — inference is not an option here.
        const invalidateAfterCompaction = (sessionId: string | undefined): void => {
            if (typeof sessionId !== "string" || sessionId.length === 0) return
            sessionUsage.delete(sessionId)
            sessionsAwaitingCompactionCheck.add(sessionId)
        }
        const eventController = new AbortController()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
                if (event.type === "session.created") {
                    const props = (event as any).properties || {}
                    const sessionId = props.sessionID || ""
                    const config = getConfig(sessionId)
                    sessionConfigs.set(sessionId, config)
                    // Seed only the fallback limit. The ref is deliberately left
                    // unset so the first request re-resolves from its own
                    // `event.model` — a session created while a non-default model
                    // is active must not inherit the default model's window.
                    sessionModelLimits.set(sessionId, initialModelLimit)
                    sessionModelRefs.delete(sessionId)
                    await getState(sessionId, config)
                } else if (event.type === "session.step.ended") {
                    // Real API billing for the step that just finished:
                    // { sessionID, assistantMessageID, finish, cost, tokens }.
                    // This is the "measured" side of the token accounting — it
                    // arrives here instead of being re-read from
                    // `session.context()` on every request (long transcripts
                    // serialize to megabytes). Steps that produced nothing are
                    // dropped by measuredUsageFromTokens, so they cannot
                    // overwrite a good measurement.
                    const usage = measuredUsageFromTokens(
                        event.data.tokens,
                        event.data.assistantMessageID,
                    )
                    if (usage) {
                        recordUsage(sessionUsage, event.data.sessionID, usage)
                    }
                } else if (event.type === "session.compaction.ended") {
                    invalidateAfterCompaction(event.data.sessionID)
                } else if ((event as { type: string }).type === "session.compacted") {
                    const data = (event as { data?: { sessionID?: string } }).data
                    invalidateAfterCompaction(data?.sessionID)
                }
            }
        })()

        // ─── Cleanup ─────────────────────────────────────────────────────
        // Async because persistence now writes through ctx.storage; returning a
        // promise lets the host await the final flush on reload/unload instead
        // of the process exiting mid-write.
        return async () => {
            eventController.abort()

            // Detach the hooks BEFORE flushing state: a dispose can drop the
            // last reference to the callbacks, and no request should run the
            // pipeline against a half-torn-down plugin.
            //
            // Disposed one at a time and individually guarded, so one failing
            // dispose cannot strand the other two — they would stay attached
            // for the life of the host process.
            while (hookRegistrations.length > 0) {
                const registration = hookRegistrations.pop()!
                try {
                    await registration.dispose()
                } catch (err) {
                    console.warn("[slim] failed to dispose a session hook registration:", err)
                }
            }

            for (const [sessionId, state] of sessionStates.entries()) {
                const config = getConfig(sessionId)
                await persistState(state, config)
            }
        }
    },
})
