/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { loadConfig, resolveCompressLimits } from "./lib/config"
// Reused, not reimplemented (DRY): the request pipeline and the `panel` tool
// both derive "current prompt size" from the transcript with these helpers, so
// the TUI surface cannot drift from them.
import { findLastCompactionIndex, readMeasuredUsage } from "./lib/usage"
// Shared formatter, not a mirrored copy: src/lib/tui.ts owns the `panel` tool
// renderer and is already on this module's dependency graph's leaf side (it
// imports nothing from src/tui.tsx), so importing it here adds no cycle.
import { fitValue, formatTokens } from "./lib/tui"
import type { SessionState } from "./lib/types"
import { PLUGIN_VERSION } from "./lib/version"

/**
 * The TUI plugin context. It exposes the v2 `client` (an `OpenCodeClient`)
 * and the local read-only `data` store, but neither a `session` namespace nor
 * a plugin-level `ctx` — so every session read below goes through
 * `context.client.session.*`, which is the same v2 surface `ctx.session.*`
 * resolves to on the main plugin side (see src/index.ts).
 */
type PluginContext = Plugin.Context

// Rough token estimate: ~4 chars per token.
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
}

interface PanelStats {
    totalMessages: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    systemMessages: number
    compactionCount: number
    totalTokens: number
    tokensByRole: { user: number; assistant: number; system: number }
}

function emptyStats(): PanelStats {
    return {
        totalMessages: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        systemMessages: 0,
        compactionCount: 0,
        totalTokens: 0,
        tokensByRole: { user: 0, assistant: 0, system: 0 },
    }
}

// Derives context-usage stats from the session transcript.
//
// F11: unknown message types (`agent-switched`, `model-switched`,
// `location-switched`, `idle`, …) are metadata events, not assistant output.
// They used to fall through to `assistant`, which silently inflated the
// assistant bucket. The explicit `default` below counts them as `system` so
// `user + assistant + system` always equals `totalMessages` — skipping them
// instead would break that invariant.
export function deriveStats(messages: readonly unknown[]): PanelStats {
    const stats = emptyStats()
    for (const raw of messages) {
        const m = raw as {
            type?: string
            content?: Array<{ type?: string; text?: string }>
            summary?: string
        }
        let text = ""
        let role: "user" | "assistant" | "system"

        const t = m?.type
        switch (t) {
            case "user":
            case "synthetic":
            case "shell":
                role = "user"
                break
            case "assistant":
                role = "assistant"
                break
            case "system":
            case "skill":
                role = "system"
                break
            case "compaction":
                role = "system"
                stats.compactionCount++
                text = m.summary || ""
                break
            default:
                role = "system"
        }

        // User/system messages carry their text on a top-level `text` field
        // (not inside a `content` array). Capture it too so their tokens count.
        if (role !== "assistant" && typeof (m as any).text === "string") {
            text += (m as any).text
        }

        if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part?.type === "text" && typeof part.text === "string") {
                    text += part.text
                } else if (part?.type === "tool") {
                    stats.toolCalls++
                    if (typeof part.text === "string") text += part.text
                }
            }
        }

        const tokens = estimateTokens(text)
        switch (role) {
            case "user":
                stats.userMessages++
                stats.tokensByRole.user += tokens
                break
            case "assistant":
                stats.assistantMessages++
                stats.tokensByRole.assistant += tokens
                break
            case "system":
                stats.systemMessages++
                stats.tokensByRole.system += tokens
                break
        }
        stats.totalTokens += tokens
    }
    stats.totalMessages = messages.length
    return stats
}

// Compression thresholds resolved against the model context window — the same
// numbers the request pipeline enforces (see resolveCompressLimits).
interface ResolvedThresholds {
    max: number
    min: number
}

// Resolves the configured compression thresholds (global + per-model
// overrides) against the measured window, using the exact code path the
// pipeline uses so the panel never advertises a threshold that will not fire.
function resolveThresholds(real?: MeasuredReal | null): ResolvedThresholds {
    const state: SessionState = {
        sessionId: "",
        modelContextLimit: real?.contextLimit ?? 0,
        // Occupancy, never spend: the lifetime counter has no business here.
        // (resolveCompressLimits itself only reads modelContextLimit, so this is
        // about not leaving a lifetime figure in a field named "current".)
        currentTokenCount: real?.promptTokens ?? 0,
        compressionCount: 0,
        lastCompressionTime: 0,
        manualMode: false,
        compressPermission: null,
        compressionHistory: [],
        averageCompressionRatio: 0,
        toolCalls: new Map(),
    }
    const config = loadConfig()
    const providerID = real?.providerID || undefined
    const modelID = real?.model && real.model !== "unknown" ? real.model : undefined
    return resolveCompressLimits(config, state, providerID, modelID)
}

// Same lines as `renderPanel` in src/lib/tui.ts so the TUI slash panel and the
// `panel` tool report the trigger identically — threshold and its window on one
// line, the floor on a continuation line, because the three facts together
// overrun the 63-column frame at worst-case magnitudes.
function renderTriggerLines(thresholds: ResolvedThresholds, contextLimit: number): string[] {
    const window =
        contextLimit > 0
            ? `${((thresholds.max / contextLimit) * 100).toFixed(1)}% of ${formatTokens(contextLimit)} window`
            : "window unknown"
    const floor =
        contextLimit > 0
            ? `${formatTokens(thresholds.min)} (${((thresholds.min / contextLimit) * 100).toFixed(1)}%)`
            : formatTokens(thresholds.min)
    return [`│ Trigger: ${formatTokens(thresholds.max)} tokens (${window})`, `│   floor ${floor}`]
}

// Builds a human-readable panel as plain text. The result is only ever shown
// to the user (modal/toast) — it is never written into the session transcript.
//
// Scope (F4): the numbers come from `client.session.context`, which the v2 API
// documents as "all messages after the last compaction" — it is NOT the whole
// session. The `Scope:` line states that up front so `Messages:` and the
// estimates read as window counts instead of session totals. The `Messages:`
// label itself is kept verbatim because tests/ asserts on it.
function renderPanelText(
    sessionID: string,
    stats: PanelStats,
    real?: MeasuredReal | null,
    thresholds?: ResolvedThresholds | null,
): string {
    const limit = real?.contextLimit ?? 0
    const pct = real?.usagePercent ?? 0
    // Occupancy is only known when the transcript carried per-message usage;
    // without it `usagePercent` is 0, which would read as a confident "healthy".
    const hasPrompt = !!real && real.promptTokens !== undefined && real.promptTokens !== null
    // The STATUS is derived from a clamped copy of the percent (mirroring
    // `buildPanelData` in src/lib/tui.ts): `usagePercent` is left unclamped as
    // real information, but "critical" must only ever mean "the window is
    // full", never "some non-window quantity is large". Without a measurement
    // there is nothing to derive from, so the status is "n/a" — the branch that
    // would render it is only taken when `hasPrompt` is true anyway.
    const statusPct = Math.min(100, Math.max(0, pct))
    const status = !real
        ? "n/a"
        : !hasPrompt
          ? "unknown"
          : statusPct >= 90
            ? "critical"
            : statusPct >= 70
              ? "warning"
              : "healthy"
    // F5: README promises the resolved threshold (token count + % of window).
    const trigger = thresholds ? renderTriggerLines(thresholds, limit) : null
    const lines: string[] = []
    lines.push("┌─────────────────────────────────────────────────────────────┐")
    lines.push("│                    SLIM CONTEXT PANEL                       │")
    lines.push("├─────────────────────────────────────────────────────────────┤")
    lines.push(`│ Session: ${sessionID.slice(0, 40)}`)
    lines.push(`│ Scope: messages since the last compaction (session.context)`)
    lines.push(`│ Messages: ${stats.totalMessages}`)
    lines.push(
        `│   User: ${stats.userMessages}  Assistant: ${stats.assistantMessages}  System: ${stats.systemMessages}`,
    )
    lines.push(`│   Tool calls: ${stats.toolCalls}  Compactions in scope: ${stats.compactionCount}`)
    lines.push(`│ Tokens (est): User ${stats.tokensByRole.user} | Assistant ${stats.tokensByRole.assistant} | System ${stats.tokensByRole.system}`)
    lines.push(`│ Total token estimate: ${stats.totalTokens}`)
    if (trigger && !real) lines.push(...trigger)
    if (real) {
        lines.push("├─────────────────────────────────────────────────────────────┤")
        // Two different quantities, never mixed (mirrors `renderPanel` in
        // src/lib/tui.ts): Context = the current prompt size, Lifetime = the
        // session's cumulative spend. `hasPrompt` was computed above, next to
        // the status derivation it gates.
        if (hasPrompt) {
            // Context = the last request's `input + cache.read + cache.write`
            // (readMeasuredUsage), i.e. exactly what the `panel` tool shows as
            // Context. NEVER the lifetime counter — that is what produced the
            // misleading "56.1M (100% of 200000)" this line used to print.
            lines.push(
                `│ Context: ${formatTokens(real.promptTokens as number)} / ${formatTokens(limit)} (${pct}%)  [${status}]`,
            )
            // Lifetime spend is only shown when it actually differs (cumulative
            // is always >= the prompt size) and is labelled explicitly so it is
            // never read as occupancy. Same wording as the `panel` tool.
            if (real.tokens > (real.promptTokens as number)) {
                lines.push(
                    `│ Lifetime: ${formatTokens(real.tokens)} tokens (cumulative spend, NOT context size)`,
                )
            }
        } else {
            // No per-turn usage in the transcript, so the only figure available
            // is Session.Info.tokens' LIFETIME cumulative counter. It is spend,
            // not occupancy: print NO percent and NO status next to it — `pct` is
            // 0 here because occupancy is unknown, and pairing a lifetime number
            // with a window percentage is precisely the conflation of issue #11.
            // One line says both things (what the number is, and that the fill
            // cannot be derived from it); `formatTokens` keeps it inside the
            // 63-column frame even at 56.1M.
            lines.push(
                `│ Lifetime: ${formatTokens(real.tokens)} tokens (cumulative spend, fill unknown)`,
            )
        }
        if (trigger) lines.push(...trigger)
        if (real.cost > 0) lines.push(`│ Cost: $${real.cost.toFixed(6)}`)
        // Same elision rule as the `Model:` line in `renderPanel` (src/lib/tui.ts)
        // — same helper, same "middle" mode, same budget arithmetic off the
        // shared 63-column frame. Its prefix is `│ Model: ` (9 columns, not
        // 10: this renderer uses one space of indent, not three), so its value
        // budget is 2 wider. A model id is unbounded and server-supplied, and
        // this line is the one place the TUI surface prints it.
        lines.push(`│ Model: ${fitValue(real.model, 61 - [...` Model: `].length, "middle")}`)
    }
    lines.push("└─────────────────────────────────────────────────────────────┘")
    return lines.join("\n")
}

// Resolves the "current" session: the router-focused session if any, else the most recent.
function resolveCurrentSession(context: PluginContext): string | null {
    const sessions = context.data.session.list() || []
    if (sessions.length === 0) return null
    // The TUI host exposes the active route via context.ui.router (not context.router).
    const route = context.ui?.router?.current?.()
    if (route && typeof route === "object" && "sessionID" in route) {
        return route.sessionID as string
    }
    return sessions[0].id
}

// Server-measured context numbers for a session (Session.Info.tokens + cost + model),
// mirroring what the `panel` tool in index.ts reads via ctx.session.get().
export interface MeasuredReal {
    /**
     * LIFETIME CUMULATIVE token counter (Session.Info.tokens summed across every
     * usage event). `cache.read` re-reads the whole context each turn, so this
     * grows without bound (opencode #30649: 56.1M in one session). Valid as a
     * COST statistic, never as "how full is the window".
     */
    tokens: number
    /**
     * CURRENT PROMPT SIZE for the last completed request:
     * `input + cache.read + cache.write`, read from the transcript via
     * `readMeasuredUsage` (src/lib/usage.ts) — the same figure the `panel` tool
     * shows as `Context`. Optional: only a transcript carrying per-message token
     * info provides it; when absent the panel reports `tokens` on a separately
     * labelled Lifetime line with no percent and no status, so the cumulative
     * counter is never read as occupancy.
     */
    promptTokens?: number
    cost: number
    contextLimit: number
    model: string
    /** Provider id of the selected model — needed for per-model threshold overrides. */
    providerID: string
    usagePercent: number
}

/**
 * Exported for tests only. The rendered surfaces all gate the occupancy
 * figure on `hasPrompt`, so the `contextTokens` fallback below is
 * unobservable from outside: a test that only reads /panel, /status or
 * /compress cannot tell `promptTokens ?? 0` from `promptTokens ?? lifetime`.
 * Exporting the function lets the fallback be pinned directly. Not used by
 * any production code path.
 */
export async function measureSession(
    context: PluginContext,
    sessionID: string,
    messages?: readonly unknown[],
): Promise<MeasuredReal | null> {
    try {
        // v2 session read, same call shape as `ctx.session.get({ sessionID })`
        // in src/index.ts. Read-only: never mutates the session.
        const info: any = await context.client.session.get({ sessionID })
        if (!info) return null
        const tokens: any = info.tokens ?? {}
        // ⚠️ `info.tokens` is the session's LIFETIME CUMULATIVE counter: the v2
        // projector adds input/output/reasoning/cache.read/cache.write on every
        // usage event, and cache.read re-reads the whole context each turn, so
        // this sum grows without bound. It measures spend, NOT window fill.
        const lifetimeTokens =
            (typeof tokens.input === "number" ? tokens.input : 0) +
            (typeof tokens.output === "number" ? tokens.output : 0) +
            (typeof tokens.reasoning === "number" ? tokens.reasoning : 0) +
            (typeof tokens.cache?.read === "number" ? tokens.cache.read : 0) +
            (typeof tokens.cache?.write === "number" ? tokens.cache.write : 0)

        // Resolve context limit: try model.list() first, then session info, then default.
        let contextLimit = 200000
        const modelID: string = info.model?.id || ""
        const providerID: string = info.model?.providerID || ""

        try {
            const modelList: any = await context.client.model.list()
            const models: any[] = modelList?.data ?? modelList ?? []
            // EXACT providerID+modelID only. A modelID-only fallback still
            // borrows another model's window whenever two providers expose the
            // same modelID (issue #11), and any "first model with a limit" pick
            // is worse still — the default below is honest about not knowing.
            const found = models.find(
                (m: any) => m.providerID === providerID && m.modelID === modelID,
            )
            if (found?.limit?.context && found.limit.context > 0) {
                contextLimit = found.limit.context
            }
        } catch {
            // Fall through to session info or default
        }

        // Fallback: session info might have model.limit.context
        if (contextLimit === 200000 && info.model?.limit?.context && info.model.limit.context > 0) {
            contextLimit = info.model.limit.context
        }

        // Current prompt size: the last completed assistant turn's `tokens`
        // (`input + cache.read + cache.write`), derived with the SAME helpers
        // the request pipeline and the `panel` tool use (src/lib/usage.ts).
        // `afterIndex` is the last COMPLETED compaction — usage recorded before
        // it describes a prompt that no longer exists. Available only when the
        // caller hands us the transcript (the /panel, /status and /compress
        // commands all do); without it, and when the transcript carries no
        // per-message usage, occupancy is unknown — `usagePercent` is 0 and the
        // renderers say so rather than substituting the lifetime counter.
        let promptTokens: number | undefined
        if (messages) {
            const usage = readMeasuredUsage(messages, findLastCompactionIndex(messages))
            if (usage) promptTokens = usage.promptTokens
        }

        // Occupancy is the prompt size, and ONLY the prompt size. There is no
        // `?? lifetimeTokens` fallback: a session-wide spend counter has no
        // business filling the window, and using one is what made issue #11
        // report 100% on a nearly empty session. With no per-turn usage in the
        // transcript the honest answer is "unknown" (0), which the renderers
        // label as such.
        const contextTokens = promptTokens ?? 0
        const usagePercent =
            contextLimit > 0 ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : 0
        return {
            tokens: lifetimeTokens,
            promptTokens,
            cost: typeof info.cost === "number" ? info.cost : 0,
            contextLimit,
            model: modelID || "unknown",
            providerID,
            usagePercent,
        }
    } catch {
        return null
    }
}

export default Plugin.define({
    id: "opencodev2-slim.cli",
    setup(context) {
        // Register commands inside the "app" slot render, where the keymap
        // provider is available (consistent with OpenCode V2 CLI plugins).
        context.ui.slot({
            append: "app",
            render: () => {
                context.keymap.layer(() => ({
                    mode: "global",
                    priority: 10,
                    commands: [
                        // ─── /panel ────────────────────────────────────
                        {
                            id: "opencodev2-slim.panel",
                            title: "Show Slim Context Panel",
                            group: "Slim",
                            palette: true,
                            slash: { name: "panel", aliases: ["slim-panel"] },
                            enabled: true,
                            suggested: true,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Panel",
                                        message: "No active session found. Open a session first.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    // Read-only v2 reads: transcript via the v2
                                    // session API (no local-store sync) and token
                                    // usage via session.get. Nothing is written
                                    // back to the session.
                                    //
                                    // F4 decision — stay on session.context rather than
                                    // message.list: this endpoint is officially "all
                                    // messages after the last compaction", i.e. exactly
                                    // the active context a context panel should describe,
                                    // so the honest fix is scoping the labels (see
                                    // renderPanelText) instead of swapping the source.
                                    // message.list also returns MessageWithParts
                                    // (info + parts), a different shape than the
                                    // SessionMessageInfo deriveStats consumes, so it
                                    // would need an adapter and would re-introduce
                                    // messages compaction already dropped.
                                    const messages = await context.client.session.context({
                                        sessionID,
                                    })
                                    // Hand the transcript to measureSession so it can
                                    // derive the current PROMPT size (Context) instead
                                    // of showing the lifetime cumulative counter.
                                    const real = await measureSession(
                                        context,
                                        sessionID,
                                        messages ?? [],
                                    )
                                    const stats = deriveStats(messages ?? [])
                                    const thresholds = resolveThresholds(real)
                                    const text = renderPanelText(
                                        sessionID,
                                        stats,
                                        real,
                                        thresholds,
                                    )

                                    // The panel is long-form, so it goes to a modal
                                    // instead of a toast — and never into the
                                    // session transcript.
                                    await context.ui.dialog.alert({
                                        title: "Slim Context Panel",
                                        message: text,
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Panel",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /compress ─────────────────────────────────
                        {
                            id: "opencodev2-slim.compress",
                            title: "Compress Context",
                            group: "Slim",
                            palette: true,
                            slash: {
                                name: "compress",
                                aliases: ["slim-compress"],
                                args: [
                                    {
                                        name: "focus",
                                        description: "What to compress (e.g., 'old exploration')",
                                        required: false,
                                    },
                                    {
                                        name: "mode",
                                        description: "Compression mode: auto, range, or topic",
                                        required: false,
                                    },
                                    {
                                        name: "keepRecent",
                                        description: "Number of recent messages to keep (default: 5)",
                                        required: false,
                                    },
                                ],
                            },
                            enabled: true,
                            suggested: true,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    const args = (input as any) || {}
                                    const focus = args.focus || "user-requested compression"
                                    const mode = args.mode || "auto"
                                    const keepRecent = args.keepRecent ?? 5

                                    // Measure current state first. Read the transcript
                                    // too so the "Current state" line reports the
                                    // current PROMPT size (Context) — the same
                                    // semantics /panel and the `panel` tool use —
                                    // rather than the lifetime cumulative counter.
                                    let messages: unknown[] = []
                                    try {
                                        messages =
                                            (await context.client.session.context({
                                                sessionID,
                                            })) ?? []
                                    } catch {
                                        // Transcript unavailable: report from the
                                        // empty transcript, so occupancy comes back
                                        // UNKNOWN rather than being guessed at.
                                    }
                                    const real = await measureSession(
                                        context,
                                        sessionID,
                                        messages,
                                    )

                                    const hasPrompt =
                                        real?.promptTokens !== undefined &&
                                        real?.promptTokens !== null
                                    const statusLine = real
                                        ? hasPrompt
                                            ? `Context ${real.promptTokens!.toLocaleString()} tokens (${real.usagePercent}% of ${real.contextLimit.toLocaleString()}) · Lifetime ${real.tokens.toLocaleString()} tokens (cumulative spend, NOT context size)`
                                            : `${real.tokens.toLocaleString()} tokens — lifetime cumulative spend, NOT context size (window fill unknown without per-turn usage)`
                                        : "unknown"

                                    const text = [
                                        `**Slim Compress**`,
                                        ``,
                                        `**Current state:** ${statusLine}`,
                                        ``,
                                        `Ready to compress with:`,
                                        `- **Focus:** ${focus}`,
                                        `- **Mode:** ${mode}`,
                                        `- **Keep recent:** ${keepRecent} messages`,
                                        ``,
                                        `> The assistant will now call the compress tool.`,
                                        `> Or type: \`compress({ focus: "${focus}", mode: "${mode}", keepRecent: ${keepRecent} })\``,
                                    ].join("\n")

                                    // ── /compress delivery decision ─────────────────────────
                                    // This command is guidance for the model ("the assistant
                                    // will now call the compress tool"), so writing it into the
                                    // transcript is intentional — unlike /status and /slim-debug,
                                    // which only report state. `delivery` is stated explicitly
                                    // because the server would otherwise silently default it:
                                    //   - "steer" (chosen): the item is delivered immediately,
                                    //     interrupting an in-flight turn if one is running, and
                                    //     `Session.synthetic` wakes an idle session (resume stays
                                    //     at its default true). It matches the server default
                                    //     (`delivery ?? "steer"`) and the TUI's own prompt
                                    //     default, so /compress behaves like typing a message.
                                    //   - "queue" (rejected): SessionRunner.drain stops before a
                                    //     queued item while a turn is active, so the compress
                                    //     instruction would wait for the next user turn — the
                                    //     opposite of "compress now".
                                    await context.client.session.synthetic({
                                        sessionID,
                                        text,
                                        description: "slim-compress",
                                        delivery: "steer",
                                    })

                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: `Compression ready: "${focus}". Assistant will process it.`,
                                        variant: "success",
                                        duration: 3000,
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /status ──────────────────────────────────
                        {
                            id: "opencodev2-slim.status",
                            title: "Show Compact Status",
                            group: "Slim",
                            palette: true,
                            slash: { name: "status", aliases: ["slim-status"] },
                            enabled: true,
                            suggested: false,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Status",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    // Read the transcript so the report can show the
                                    // current PROMPT size (Context) rather than the
                                    // lifetime cumulative counter — consistent with
                                    // /panel and the `panel` tool.
                                    let messages: unknown[] = []
                                    try {
                                        messages =
                                            (await context.client.session.context({
                                                sessionID,
                                            })) ?? []
                                    } catch {
                                        // Transcript unavailable: report from the
                                        // empty transcript, so the status comes back
                                        // UNKNOWN rather than being guessed at.
                                    }
                                    const real = await measureSession(
                                        context,
                                        sessionID,
                                        messages,
                                    )
                                    if (!real) {
                                        context.ui.toast.show({
                                            title: "Slim Status",
                                            message: "Could not measure session.",
                                            variant: "warning",
                                        })
                                        return
                                    }

                                    // Occupancy is only knowable when the transcript
                                    // carried per-message usage. `measureSession`
                                    // derives usagePercent from the prompt size and
                                    // reports 0 when there is no measurement at all,
                                    // so deriving a status from it unconditionally
                                    // printed a false "🟢 HEALTHY" on a session whose
                                    // real occupancy is simply unknown — as bad as the
                                    // false "🔴 CRITICAL" the lifetime fallback used to
                                    // produce, and worse: a false all-clear. Derive the
                                    // status from hasPrompt instead.
                                    const hasPrompt =
                                        real.promptTokens !== undefined &&
                                        real.promptTokens !== null
                                    // Three states, matching /panel and /compress:
                                    //   - measured  → thresholds on the clamped percent.
                                    //   - no measurement → UNKNOWN; never a confident
                                    //     HEALTHY/WARNING/CRITICAL we cannot support.
                                    // (There is no third "estimate available" state
                                    // here: /status reports only server-side figures.)
                                    // Clamped copy, same rule as `renderPanelText`
                                    // and `buildPanelData`: the raw percent stays
                                    // unclamped as real information, the status must
                                    // only mean "the window is full".
                                    const statusPct = Math.min(100, Math.max(0, real.usagePercent))
                                    const status = !hasPrompt
                                        ? "⚪ UNKNOWN"
                                        : statusPct >= 90
                                          ? "🔴 CRITICAL"
                                          : statusPct >= 70
                                            ? "🟡 WARNING"
                                            : "🟢 HEALTHY"

                                    // Context = prompt, Lifetime = cumulative spend.
                                    // The no-prompt fallback keeps the `**Usage:**`
                                    // label callers/tests key on, but explicitly
                                    // qualifies the number as lifetime cumulative.
                                    const usageLines = hasPrompt
                                        ? [
                                              `**Context:** ${real.promptTokens!.toLocaleString()} / ${real.contextLimit.toLocaleString()} tokens (${real.usagePercent}%)`,
                                              ...(real.tokens > real.promptTokens!
                                                  ? [
                                                        `**Lifetime:** ${real.tokens.toLocaleString()} tokens (cumulative spend, NOT context size)`,
                                                    ]
                                                  : []),
                                          ]
                                        : [
                                              // No per-turn usage, so occupancy is unknown:
                                              // never print the lifetime counter against the window.
                                              `**Usage:** ${real.tokens.toLocaleString()} tokens — lifetime cumulative, NOT context size`,
                                          ]

                                    const text = [
                                        `**Context Status:** ${status}`,
                                        ...usageLines,
                                        `**Model:** ${real.model}`,
                                        real.cost > 0 ? `**Cost:** $${real.cost.toFixed(4)}` : "",
                                    ]
                                        .filter(Boolean)
                                        .join("\n")

                                    // Read-only report: shown in a dialog like /panel and
                                    // deliberately never written to the session transcript
                                    // (no client.session.synthetic here).
                                    await context.ui.dialog.alert({
                                        title: "Slim Status",
                                        message: text,
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Status",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /slim-debug ──────────────────────────────
                        {
                            id: "opencodev2-slim.debug",
                            title: "Toggle Slim Debug Mode",
                            group: "Slim",
                            palette: true,
                            slash: { name: "slim-debug", aliases: ["debug-slim"] },
                            enabled: true,
                            suggested: false,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Debug",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    // Read current config
                                    const configPath = `${process.env.HOME || "~"}/.config/opencode/slim.jsonc`
                                    const fs = await import("fs")
                                    let debug = false
                                    if (fs.existsSync(configPath)) {
                                        const content = fs.readFileSync(configPath, "utf-8")
                                        const match = content.match(/"debug"\s*:\s*(true|false)/)
                                        if (match) debug = match[1] === "true"
                                    }

                                    // Toggle
                                    debug = !debug

                                    // Write back
                                    const { parse } = await import("jsonc-parser")
                                    let config: any = {}
                                    if (fs.existsSync(configPath)) {
                                        config = parse(fs.readFileSync(configPath, "utf-8")) || {}
                                    }
                                    config.debug = debug

                                    const dir = `${process.env.HOME || "~"}/.config/opencode`
                                    if (!fs.existsSync(dir)) {
                                        fs.mkdirSync(dir, { recursive: true })
                                    }
                                    fs.writeFileSync(
                                        configPath,
                                        JSON.stringify(config, null, 2),
                                        "utf-8",
                                    )

                                    const text = `**Slim Debug Mode:** ${debug ? "ON 🔴" : "OFF ⚪"}\n\nDebug logs will ${debug ? "now" : "no longer"} appear in the console.`

                                    // Toggle result is reported to the user only — the config
                                    // file above is the single side effect, the session transcript
                                    // is never appended to.
                                    await context.ui.dialog.alert({
                                        title: "Slim Debug",
                                        message: text,
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Debug",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },
                    ],
                }))
                return null
            },
        })

        context.ui.toast.show({
            title: `Slim Plugin v${PLUGIN_VERSION}`,
            message: "Commands: /panel, /compress, /status, /slim-debug",
            variant: "success",
            duration: 4000,
        })

        return () => {}
    },
})