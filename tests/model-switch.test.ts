/**
 * Regression: the model context window must follow the model the request is
 * ACTUALLY running, not the default model resolved once at setup.
 *
 * Before the fix, `resolveModelContextLimit()` ran once in `setup()` and its
 * result was pinned per session for the session's whole life. Switching from a
 * 200k model to a 1M model mid-session therefore left every percent threshold
 * (`"80%"`) resolving against the 200k window — firing at 160k against a model
 * that could hold 800k. The same family of error as issue #11, reached through
 * a different door: borrowing the window of a model this session is not running.
 *
 * The suite drives the real plugin's registered hooks against a fake host, so it
 * covers the wiring and not just the helpers.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import slimPlugin, {
    modelRefKey,
    resolveModelContextLimitForRef,
    syncModelLimitForSession,
    resetContextLimitFallbackWarning,
} from "../src/index"

/** The two windows this suite switches between. */
const SMALL = { providerID: "anthropic", modelID: "claude-small", limit: { context: 200_000 } }
const LARGE = { providerID: "openai", modelID: "gpt-big", limit: { context: 1_000_000 } }

const modelCtx = () => ({
    // The host's DEFAULT model is the small one — which is exactly what the old
    // code latched onto and never let go of.
    default: async () => ({ data: { ...SMALL } }),
    list: async () => ({ data: [{ ...SMALL }, { ...LARGE }] }),
})

describe("modelRefKey", () => {
    it("normalises both the hook event's Model.Ref and a ModelInfo entry", () => {
        // The hook event carries `{ id }`, the model list carries `{ modelID }`.
        assert.strictEqual(modelRefKey({ providerID: "openai", id: "gpt-big" }), "openai/gpt-big")
        assert.strictEqual(
            modelRefKey({ providerID: "openai", modelID: "gpt-big" }),
            "openai/gpt-big",
        )
    })

    it("ignores the variant — a variant changes reasoning effort, not the window", () => {
        assert.strictEqual(
            modelRefKey({ providerID: "openai", id: "gpt-big", variant: "high" }),
            modelRefKey({ providerID: "openai", id: "gpt-big" }),
        )
    })

    it("returns undefined for an incomplete or non-object ref", () => {
        assert.strictEqual(modelRefKey(undefined), undefined)
        assert.strictEqual(modelRefKey(null), undefined)
        assert.strictEqual(modelRefKey("openai/gpt-big"), undefined)
        assert.strictEqual(modelRefKey({ providerID: "openai" }), undefined)
        assert.strictEqual(modelRefKey({ id: "gpt-big" }), undefined)
    })
})

describe("resolveModelContextLimitForRef", () => {
    it("resolves the named model's own window", async () => {
        const ctx = { model: { list: async () => ({ data: [{ ...SMALL }, { ...LARGE }] }) } }
        assert.strictEqual(
            await resolveModelContextLimitForRef(ctx, { providerID: "openai", id: "gpt-big" }),
            1_000_000,
        )
        assert.strictEqual(
            await resolveModelContextLimitForRef(ctx, {
                providerID: "anthropic",
                id: "claude-small",
            }),
            200_000,
        )
    })

    it("never borrows an unrelated model's window for an unknown ref", async () => {
        // Same rule as issue #11: a model absent from the list has no honest
        // answer, so return undefined and let the caller keep what it had.
        const ctx = { model: { list: async () => ({ data: [{ ...SMALL }, { ...LARGE }] }) } }
        assert.strictEqual(
            await resolveModelContextLimitForRef(ctx, { providerID: "x", id: "unknown" }),
            undefined,
        )
    })

    it("resolves a model id that itself contains slashes", async () => {
        // OpenRouter-style ids embed the vendor and quantisation:
        // `openrouter/meta-llama/llama-3-70b-instruct`. Splitting the composed
        // key on "/" and keeping only two parts truncates the id to
        // `meta-llama`, which matches nothing — so such a model silently fell
        // back to the stale window instead of its own 32k.
        const nested = {
            providerID: "openrouter",
            modelID: "meta-llama/llama-3-70b-instruct",
            limit: { context: 32_000 },
        }
        const ctx = { model: { list: async () => ({ data: [nested] }) } }
        assert.strictEqual(
            await resolveModelContextLimitForRef(ctx, {
                providerID: "openrouter",
                id: "meta-llama/llama-3-70b-instruct",
            }),
            32_000,
            "a nested model id must match its own list entry, not be truncated",
        )
    })

    it("returns undefined when the list is unavailable rather than throwing", async () => {
        const ctx = {
            model: {
                list: async () => {
                    throw new Error("server gone")
                },
            },
        }
        assert.strictEqual(
            await resolveModelContextLimitForRef(ctx, { providerID: "openai", id: "gpt-big" }),
            undefined,
        )
    })
})

describe("syncModelLimitForSession", () => {
    it("re-resolves when the session switches model", async () => {
        const ctx = { model: { list: async () => ({ data: [{ ...SMALL }, { ...LARGE }] }) } }
        const sid = "sync-switch"

        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "anthropic", id: "claude-small" }, 999),
            200_000,
        )
        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "openai", id: "gpt-big" }, 999),
            1_000_000,
            "switching to the 1M model must move the window off the 200k one",
        )
        // Switching back returns to the small window — the map is keyed by ref,
        // not latched one-way.
        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "anthropic", id: "claude-small" }, 999),
            200_000,
        )
    })

    it("keeps the previous limit when the new ref cannot be resolved", async () => {
        const ctx = { model: { list: async () => ({ data: [{ ...SMALL }, { ...LARGE }] }) } }
        const sid = "sync-unknown"
        await syncModelLimitForSession(ctx, sid, { providerID: "anthropic", id: "claude-small" }, 999)
        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "x", id: "mystery" }, 999),
            200_000,
            "an unresolvable switch keeps the last honest window, not a neighbour's",
        )
    })

    it("retries a failed lookup on the next request instead of latching the fallback", async () => {
        // The list fails once, then recovers. If a failed resolution were
        // recorded as settled, request 2 would short-circuit on the cached ref
        // and keep the 200k fallback forever — the exact staleness this whole
        // change exists to remove.
        let fail = true
        const ctx = {
            model: {
                list: async () => {
                    if (fail) throw new Error("server gone")
                    return { data: [{ ...SMALL }, { ...LARGE }] }
                },
            },
        }
        const sid = "sync-retry"

        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "openai", id: "gpt-big" }, 999),
            999,
            "with no usable window and nothing cached yet, the fallback is used",
        )

        fail = false
        assert.strictEqual(
            await syncModelLimitForSession(ctx, sid, { providerID: "openai", id: "gpt-big" }, 999),
            1_000_000,
            "once model.list() recovers, the same ref must re-resolve instead of staying latched",
        )
    })

    it("does not re-read the model list while the ref is unchanged", async () => {
        let reads = 0
        const ctx = {
            model: {
                list: async () => {
                    reads++
                    return { data: [{ ...SMALL }, { ...LARGE }] }
                },
            },
        }
        const sid = "sync-cache"
        const ref = { providerID: "openai", id: "gpt-big" }
        await syncModelLimitForSession(ctx, sid, ref, 999)
        const afterFirst = reads
        await syncModelLimitForSession(ctx, sid, { ...ref }, 999)
        await syncModelLimitForSession(ctx, sid, { ...ref }, 999)
        assert.strictEqual(reads, afterFirst, "steady-state requests must not re-read model.list()")
    })
})

describe("mid-session model switch through the real context hook", () => {
    let dir: string
    let previousXdg: string | undefined
    let contextHooks: ((event: any) => any)[]

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-model-switch-"))
        process.env.XDG_CONFIG_HOME = dir
        await mkdir(join(dir, "opencode"), { recursive: true })
        // Percent thresholds are the thing that goes stale, so pin the config
        // to "80%" — the assertion below reads the window those resolve against.
        // `debug: true` makes the hook report the window it resolved.
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({
                enabled: true,
                debug: true,
                compress: { enabled: true, maxContextLimit: "80%", minContextLimit: "40%" },
                persistence: { enabled: true, directory: join(dir, "state") },
            }),
            "utf-8",
        )
        contextHooks = []
        resetContextLimitFallbackWarning()
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
    })

    it("moves the threshold from 80% of 200k to 80% of 1M after a switch", async () => {
        const ctx: any = {
            model: modelCtx(),
            tool: { transform: async (register: any) => register({ add: () => {} }) },
            session: {
                hook: async (name: string, cb: any) => {
                    if (name === "context") contextHooks.push(cb)
                    return { dispose: async () => {} }
                },
                context: async () => [],
                get: async () => null,
            },
            event: {
                subscribe: async function* () {
                    // no host events: the switch must work on a cold session
                },
            },
        }
        await (slimPlugin as any).setup(ctx)
        assert.ok(contextHooks.length >= 2, "the plugin registers its context hooks")

        // The window the context hook resolved, read from the hook's own debug
        // output. This is the plugin reporting the value it will use for the
        // request — the same value resolveCompressLimits reads.
        const windowFor = async (model: { providerID: string; id: string }): Promise<number> => {
            const logs: string[] = []
            const originalLog = console.log
            console.log = (...args: unknown[]) => {
                logs.push(args.map(String).join(" "))
            }
            const event: any = {
                sessionID: "ses_switch",
                messages: [],
                system: [],
                tools: [],
                model,
            }
            try {
                for (const hook of contextHooks) await hook(event)
            } finally {
                console.log = originalLog
            }
            const line = logs.find((l) => l.includes("context hook:") && l.includes("modelLimit="))
            assert.ok(line, `the context hook must report the window it resolved; logs: ${JSON.stringify(logs)}`)
            const match = /modelLimit=(\d+)/.exec(line!)
            assert.ok(match, `could not parse the reported window from: ${line}`)
            return Number(match[1])
        }

        const sid = "ses_switch"
        // Both requests deliberately share ONE session id. A fresh session per
        // request would pass trivially and prove nothing.
        const small = await windowFor({ providerID: "anthropic", id: "claude-small" })
        assert.strictEqual(small, 200_000, "the first request runs the 200k model")

        const large = await windowFor({ providerID: "openai", id: "gpt-big" })
        assert.strictEqual(
            large,
            1_000_000,
            "after switching to the 1M model the window must follow the request, not the setup-time default",
        )
        assert.strictEqual(sid, "ses_switch")
    })
})