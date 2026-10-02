import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { SlimConfig, SessionState } from "./types"

/**
 * DCP defaults: absolute token counts (not percentages). Also the safe
 * fallbacks used when a configured threshold cannot be resolved — a broken
 * value must never silently degrade to 0 (which would disable triggering).
 */
export const DEFAULT_MAX_CONTEXT_LIMIT = 100000
export const DEFAULT_MIN_CONTEXT_LIMIT = 50000

const DEFAULT_CONFIG: SlimConfig = {
    enabled: true,
    debug: false,
    compress: {
        enabled: true,
        mode: "range",
        permission: "allow",
        maxContextLimit: DEFAULT_MAX_CONTEXT_LIMIT,
        minContextLimit: DEFAULT_MIN_CONTEXT_LIMIT,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectUserMessages: false,
        protectedTools: ["task", "skill", "todowrite", "todoread"],
        keepRecent: 5,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            // OFF by default, and it was not a matter of taste: until the id
            // lookup was fixed this read only `toolCallID`/`callID`, which do
            // not exist on the v2 hook part (`id` is the id there), so the
            // strategy could never match a call to its errored result and did
            // nothing on every request. It now works, but it rewrites the
            // `input` of errored tool calls, so it stays opt-in rather than
            // changing every existing user's prompt in a patch release.
            enabled: false,
            turns: 4,
            protectedTools: [],
        },
        // On by default: a strategy that drops whole messages (compression
        // blocks, dedup) must not leave a tool result without its call, which
        // the provider rejects. Escape hatch for a user who has reason to
        // disable it; the plugin treats anything other than an explicit
        // `false` as "guard on".
        guardToolPairs: true,
        // Opt-in: `enabled: false` keeps the feature off unless the user asks.
        // Defaults here are the built-in fallbacks used when a field is absent,
        // so an omitted value and an explicit one behave identically.
        pruneOutputs: {
            enabled: false,
            minChars: 2000,
            maxPerRequest: 50,
            protectedTools: [],
        },
        turnProtection: {
            enabled: true,
            turns: 4,
        },
    },
    // Measured-vs-estimated token accounting (see resolveTriggerTokens).
    // Defaults match the built-in fallbacks so an explicit value and an
    // omitted value behave identically.
    usage: {
        trustRatio: 0.5,
        capRatio: 3,
    },
    adaptive: {
        enabled: true,
        learningRate: 0.1,
        minCompressionRatio: 0.3,
    },
    costAware: {
        enabled: true,
        cacheBoostFactor: 0.5,
    },
    persistence: {
        enabled: true,
        directory: join(homedir(), ".config", "opencode", "slim"),
    },
}

/**
 * Merge two per-model limit maps key by key.
 *
 * These are the only maps in the config, and the only ones that must merge
 * per key rather than being taken from the higher-precedence layer wholesale.
 * A user with limits for three models who adds an override for ONE of them —
 * via `slim.jsonc`, or via the plugin `options` object — must not silently
 * lose the other two. Replacing the whole map made a partial override look
 * like it applied while quietly discarding everything it did not mention.
 *
 * `undefined` is preserved when neither layer has the key, so a config that
 * never mentions per-model limits stays free of an empty object rather than
 * gaining one.
 */
function mergePerModelLimits(
    base?: Record<string, number | string>,
    override?: Record<string, number | string>,
): Record<string, number | string> | undefined {
    if (!base) return override
    if (!override) return base
    return { ...base, ...override }
}

function deepMerge(base: SlimConfig, override: Partial<SlimConfig>): SlimConfig {
    return {
        ...base,
        ...override,
        compress: {
            ...base.compress,
            ...override.compress,
            // Merged per model key — see mergePerModelLimits.
            modelMaxLimits: mergePerModelLimits(
                base.compress.modelMaxLimits,
                override.compress?.modelMaxLimits,
            ),
            modelMinLimits: mergePerModelLimits(
                base.compress.modelMinLimits,
                override.compress?.modelMinLimits,
            ),
        },
        strategies: {
            deduplication: { ...base.strategies.deduplication, ...override.strategies?.deduplication },
            purgeErrors: { ...base.strategies.purgeErrors, ...override.strategies?.purgeErrors },
            // Not a sub-object, but a top-level `strategies` key, so it needs
            // its own merge line: without it a user's `guardToolPairs: false`
            // would be silently dropped by the whitelist above.
            guardToolPairs: override.strategies?.guardToolPairs ?? base.strategies.guardToolPairs,
            // Sub-object merges: a partial `pruneOutputs` override must keep the
            // other defaults (setting only `minChars` must not drop
            // `maxPerRequest`), and the keys must survive deepMerge at all or a
            // user's partial config would be dropped silently.
            pruneOutputs: {
                ...(base.strategies.pruneOutputs ?? {}),
                ...(override.strategies?.pruneOutputs ?? {}),
            },
            turnProtection: {
                ...(base.strategies.turnProtection ?? {}),
                ...(override.strategies?.turnProtection ?? {}),
            },
        },
        // Sub-object merge, not a replacement: a config that sets only
        // `usage.capRatio` must keep the default `trustRatio`, otherwise the
        // spread of a partial override would silently drop it.
        usage: { ...base.usage, ...override.usage },
        adaptive: { ...base.adaptive, ...override.adaptive },
        costAware: { ...base.costAware, ...override.costAware },
        persistence: { ...base.persistence, ...override.persistence },
    }
}

/**
 * Options captured from the plugin context, held here rather than in the
 * plugin entry point so that EVERY `loadConfig()` caller resolves the same
 * values — the server pipeline and the TUI panel included.
 *
 * `null` when the user configured no options, which makes `loadConfig` behave
 * exactly as it did before this existed.
 */
let pluginOptions: Record<string, unknown> | null = null

/** Capture the options from the plugin context. Called once per plugin load. */
export function setPluginOptions(options: unknown): void {
    pluginOptions =
        options && typeof options === "object" && !Array.isArray(options)
            ? (options as Record<string, unknown>)
            : null
}

/** Forget the captured options (test hook, and a reload with no options). */
export function resetPluginOptions(): void {
    pluginOptions = null
}

/**
 * Load the effective configuration.
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults
 *   2. `slim.jsonc` in the global config directory
 *   3. plugin options from the `plugins` array in opencode.jsonc
 *
 * `options` wins over the file because it is the more specific, more local
 * statement of intent: it is written per project and per plugin entry, while
 * `slim.jsonc` is a single machine-wide file. This is also what makes the
 * object form in opencode.jsonc useful —
 *
 *   "plugins": [{ "package": "@serkanalgur/opencodev2-slim",
 *                 "options": { "compress": { "maxContextLimit": "80%" } } }]
 *
 * `slim.jsonc` therefore remains the fallback for anything the options object
 * does not mention, and the whole feature is opt-in.
 *
 * `options` defaults to whatever the plugin context supplied, so callers that
 * have no options of their own still pick them up — that is what keeps the
 * panel and the pipeline reporting the same limits.
 */
export function loadConfig(options?: Record<string, unknown> | null): SlimConfig {
    const effective = options === undefined ? pluginOptions : options
    let config = { ...DEFAULT_CONFIG }

    const globalDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")

    const globalPath = join(globalDir, "slim.jsonc")
    const globalPathJson = join(globalDir, "slim.json")

    const configPath = existsSync(globalPath)
        ? globalPath
        : existsSync(globalPathJson)
          ? globalPathJson
          : null

    if (configPath) {
        try {
            const content = readFileSync(configPath, "utf-8")
            const parsed = parse(content)
            if (parsed) {
                config = deepMerge(config, parsed)
            }
        } catch {
            // Use defaults
        }
    }

    // Plugin options from opencode.jsonc, layered over the file. Anything that
    // is not a plain object is ignored rather than merged: a malformed options
    // value must not corrupt an otherwise valid config.
    if (effective && typeof effective === "object" && !Array.isArray(effective)) {
        try {
            config = deepMerge(config, effective as Partial<SlimConfig>)
        } catch {
            // A malformed options object falls back to the file config.
        }
    }

    return config
}

export function createDefaultConfig(): void {
    const globalDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")

    const configPath = join(globalDir, "slim.jsonc")

    if (!existsSync(configPath)) {
        try {
            mkdirSync(globalDir, { recursive: true })
            writeFileSync(
                configPath,
                `{
    // Slim Configuration (DCP-compatible limit rules)
    "enabled": true,
    "compress": {
        "enabled": true,
        "mode": "range",
        "permission": "allow",
        // Thresholds accept an absolute token count (200000) or a percent of the
        // model context window ("80%"). Invalid values fall back to the default.
        "maxContextLimit": 100000,
        "minContextLimit": 50000,
        "nudgeFrequency": 5,
        "iterationNudgeThreshold": 15,
        "nudgeForce": "soft"
    }
}`,
                "utf-8",
            )
        } catch {
            // Ignore errors
        }
    }
}

/**
 * Reasons a configured threshold could not be used as-is. Reported through the
 * optional `onIssue` observer of {@link resolveThreshold} so callers can warn
 * exactly once instead of failing silently.
 */
export type ThresholdIssue =
    /** No value configured at all. */
    | "missing"
    /** Unparsable, non-finite or negative value → falls back. */
    | "invalid-number"
    /** Percent configured but the model context window is unknown → falls back. */
    | "unknown-context-limit"
    /** Percent outside 0-100 → clamped to the context window. */
    | "percent-out-of-range"
    /** Absolute token count above the context window → clamped to the window. */
    | "above-context-limit"

/**
 * Resolve a configured threshold to absolute tokens.
 *
 * Accepted forms (both are valid for maxContextLimit / minContextLimit and the
 * per-model overrides):
 * - `number` — absolute token count (e.g. `200000`), used verbatim.
 * - `"80%"`  — percentage of `contextLimit` (the model context window).
 *   A decimal comma is accepted for locale-typed configs: `"80,5%"` = 80.5%.
 *
 * Safety rules (a bad value must never become 0, which would disable triggering):
 * - missing / unparsable / non-finite / negative → `fallback`.
 * - percent while `contextLimit` is unknown (<= 0) → `fallback` (the ratio is unknowable).
 * - percent above 100 → clamped to the window; absolute above the window → clamped to
 *   the window so the threshold stays reachable instead of never firing.
 *
 * Pure: the returned value depends only on the arguments. `onIssue` is an
 * optional observer for diagnostics and never influences the result.
 */
export function resolveThreshold(
    value: number | string | null | undefined,
    contextLimit: number,
    fallback: number,
    onIssue?: (issue: ThresholdIssue) => void,
): number {
    const degrade = (issue: ThresholdIssue, resolved: number = fallback): number => {
        onIssue?.(issue)
        return resolved
    }

    // Config files are parsed loosely, so `null`/`undefined` are both "missing".
    if (value === undefined || value === null) {
        return degrade("missing")
    }

    const windowKnown = Number.isFinite(contextLimit) && contextLimit > 0
    const clampToWindow = (tokens: number): number =>
        windowKnown && tokens > contextLimit ? degrade("above-context-limit", contextLimit) : tokens

    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
            return degrade("invalid-number")
        }
        return clampToWindow(value)
    }

    if (typeof value !== "string") {
        return degrade("invalid-number")
    }

    const raw = value.trim()
    if (raw === "") {
        return degrade("invalid-number")
    }

    // Strings are always percentages of the window: "80%" explicitly, and bare
    // numeric strings ("80") keep their historic percent meaning so existing
    // configs do not change behaviour. Absolute counts must be JSON numbers.
    const hasPercentSign = raw.endsWith("%")
    const numeric = hasPercentSign ? raw.slice(0, -1).trim() : raw
    if (numeric === "") {
        return degrade("invalid-number")
    }
    // Locale decimal comma: "80,5%" (TR and other locales type decimals with a
    // comma) parses as NaN on the plain path, so retry with every comma
    // reinterpreted as the decimal separator. Still NaN → fall back + warn.
    let parsed = Number(numeric)
    if (!Number.isFinite(parsed)) {
        parsed = Number(numeric.replace(",", "."))
    }
    if (!Number.isFinite(parsed) || parsed < 0) {
        return degrade("invalid-number")
    }

    if (!windowKnown) {
        return degrade("unknown-context-limit")
    }
    // A percent above 100 (or a bare number above 100) can only mean a mistaken
    // absolute count — clamp to the window instead of silently firing at 100%.
    if (parsed > 100) {
        onIssue?.("percent-out-of-range")
    }
    return Math.round((Math.min(100, parsed) / 100) * contextLimit)
}

// NOTE: `resolveTokenLimit` used to live here as a thin wrapper over
// resolveThreshold, but nothing ever called it (only src/index.ts imported it,
// and that import was unused too). Per YAGNI it was removed instead of being
// kept as dead code — resolveThreshold is the public entry point.

/**
 * Dedupe cache for threshold warnings: one warning per (config key, issue,
 * offending value).
 *
 * Why the value is part of the key: resolveCompressLimits runs on every
 * request, so re-reporting the SAME broken value each time would be noise —
 * but a user who repairs `"bogus"` and later breaks the key again with a
 * different bad value must be told about the new problem. With a
 * `${label}:${issue}` key that second, distinct problem would stay silent
 * forever.
 *
 * The Set is module-level, so entries persist for the lifetime of the plugin
 * process — across requests AND across config reloads (a fixed value keeps its
 * old key and correctly stays quiet; a new bad value gets a fresh key and warns
 * again). This permanence is also a test hazard: a warning emitted by an
 * earlier test would suppress the same warning in a later one, which is what
 * {@link resetThresholdWarnings} is for.
 */
const warnedLimitIssues = new Set<string>()

/**
 * Clear the threshold-warning dedupe cache (test hook).
 *
 * `warnedLimitIssues` is module-level state that survives for the whole
 * process, so tests asserting on `console.warn` output must call this first —
 * otherwise a warning already emitted by a previous test case would be
 * swallowed and the count assertion would fail spuriously.
 */
export function resetThresholdWarnings(): void {
    warnedLimitIssues.clear()
}

const THRESHOLD_ISSUE_HINTS: Record<ThresholdIssue, string> = {
    missing: "no value configured; using the default",
    "invalid-number": "is not a valid threshold (expected a token count or \"80%\" / \"80,5%\" percent); using the default",
    "unknown-context-limit": "is a percent threshold but the model context window is unknown; using the default absolute token count",
    "percent-out-of-range": "is outside 0-100; clamped to the model context window (use a JSON number for an absolute token count)",
    "above-context-limit": "exceeds the model context window; clamped to the window so it can still trigger",
}

function warnLimitIssueOnce(
    label: string,
    issue: ThresholdIssue,
    value: number | string | undefined,
): void {
    // Value is part of the key: a repaired-then-rebroken value must warn again
    // (see the doc comment on `warnedLimitIssues` above).
    const key = `${label}:${issue}:${String(value)}`
    if (warnedLimitIssues.has(key)) return
    warnedLimitIssues.add(key)
    console.warn(
        `[slim] config ${label}: ${JSON.stringify(value)} ${THRESHOLD_ISSUE_HINTS[issue]}`,
    )
}

/**
 * DCP limit resolution. Prefers per-model overrides (compress.modelMinLimits /
 * compress.modelMaxLimits keyed by "providerId/modelId"), then falls back to the
 * global max/min limit. Limits accept an absolute token count (200000) or a
 * percent string ("80%") of the model's context window; unusable values fall
 * back to the built-in defaults (never 0) with a one-time console warning.
 *
 * Global limits are resolved LAZILY — only when they are actually needed:
 * - a valid per-model override never reads the global, so a broken global
 *   stays silent for models that never use it (no warning noise) and a valid
 *   global is not resolved/clamped for nothing;
 * - a missing override, or an override resolveThreshold had to fall back from,
 *   resolves the global (at most once per call, cached below).
 * The historic fallback chain is unchanged: broken override → configured
 * global → built-in default.
 */
export function resolveCompressLimits(
    config: SlimConfig,
    state: SessionState,
    providerId?: string,
    modelId?: string,
): { max: number; min: number } {
    const contextLimit = state.modelContextLimit

    const parseLimit = (
        value: number | string | undefined,
        fallback: number,
        label: string,
    ): number =>
        resolveThreshold(value, contextLimit, fallback, (issue) =>
            warnLimitIssueOnce(label, issue, value),
        )

    // Sentinel for "the override was unusable": resolveThreshold only ever
    // returns finite numbers (valid values, clamped values, or its `fallback`),
    // so NaN unambiguously means "had to fall back" — and only then is the
    // global resolved to serve as that fallback. A clamped-but-usable value
    // (e.g. an override above the window) is finite and keeps the override.
    const UNRESOLVED = Number.NaN

    // Lazy, per-call cache: each global resolves at most once per call, and
    // never at all when a valid per-model override makes it irrelevant.
    let cachedGlobalMax: number | undefined
    let cachedGlobalMin: number | undefined
    const globalMax = (): number => {
        if (cachedGlobalMax === undefined) {
            cachedGlobalMax = parseLimit(
                config.compress.maxContextLimit,
                DEFAULT_MAX_CONTEXT_LIMIT,
                "compress.maxContextLimit",
            )
        }
        return cachedGlobalMax
    }
    const globalMin = (): number => {
        if (cachedGlobalMin === undefined) {
            cachedGlobalMin = parseLimit(
                config.compress.minContextLimit,
                DEFAULT_MIN_CONTEXT_LIMIT,
                "compress.minContextLimit",
            )
        }
        return cachedGlobalMin
    }

    const providerModel = providerId && modelId ? `${providerId}/${modelId}` : undefined

    const modelMin = providerModel ? config.compress.modelMinLimits?.[providerModel] : undefined
    const modelMax = providerModel ? config.compress.modelMaxLimits?.[providerModel] : undefined

    const withGlobalFallback = (overrideTokens: number, resolveGlobal: () => number): number =>
        Number.isNaN(overrideTokens) ? resolveGlobal() : overrideTokens

    return {
        max:
            modelMax != null
                ? withGlobalFallback(
                      parseLimit(modelMax, UNRESOLVED, `compress.modelMaxLimits["${providerModel}"]`),
                      globalMax,
                  )
                : globalMax(),
        min:
            modelMin != null
                ? withGlobalFallback(
                      parseLimit(modelMin, UNRESOLVED, `compress.modelMinLimits["${providerModel}"]`),
                      globalMin,
                  )
                : globalMin(),
    }
}
