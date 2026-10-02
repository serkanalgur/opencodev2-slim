/**
 * Plugin options via the `plugins` array in opencode.jsonc:
 *
 *   "plugins": [{ "package": "@serkanalgur/opencodev2-slim",
 *                 "options": { "compress": { "maxContextLimit": "80%" } } }]
 *
 * The point of the feature is project-local configuration: a per-project or
 * per-checkout override that does not require editing a machine-wide
 * `slim.jsonc`. Precedence is defaults < slim.jsonc < options, and the whole
 * thing must be opt-in — with no `options` key, behaviour is byte-identical to
 * what it was before.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import slimPlugin, {
    configurePluginOptions,
    resetPluginOptions,
    resetPersistence,
} from "../src/index"
import {
    loadConfig,
    resetThresholdWarnings,
    DEFAULT_MAX_CONTEXT_LIMIT,
} from "../src/lib/config"

describe("loadConfig with plugin options", () => {
    let dir: string
    let previousXdg: string | undefined

    /** Write the machine-wide slim.jsonc used as the fallback layer. */
    const writeFileConfig = async (body: unknown) =>
        writeFile(join(dir, "opencode", "slim.jsonc"), JSON.stringify(body), "utf-8")

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-options-"))
        await mkdir(join(dir, "opencode"), { recursive: true })
        process.env.XDG_CONFIG_HOME = dir
        resetPluginOptions()
        resetThresholdWarnings()
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
        resetPluginOptions()
        resetPersistence()
    })

    it("uses the built-in defaults when there is no file and no options", () => {
        const config = loadConfig()
        assert.strictEqual(config.compress.maxContextLimit, DEFAULT_MAX_CONTEXT_LIMIT)
    })

    it("reads settings from slim.jsonc when no options are given", async () => {
        await writeFileConfig({ compress: { maxContextLimit: 123456 } })
        assert.strictEqual(loadConfig().compress.maxContextLimit, 123456)
    })

    it("applies options when there is no slim.jsonc at all", () => {
        // The primary use case: configure a project without touching the
        // machine-wide file at all.
        const config = loadConfig({ compress: { maxContextLimit: "80%" } })
        assert.strictEqual(config.compress.maxContextLimit, "80%")
    })

    it("lets options override slim.jsonc", async () => {
        await writeFileConfig({ compress: { maxContextLimit: 123456 } })
        const config = loadConfig({ compress: { maxContextLimit: 654321 } })
        assert.strictEqual(
            config.compress.maxContextLimit,
            654321,
            "the more specific, project-local statement wins over the machine-wide file",
        )
    })

    it("falls back to slim.jsonc for keys the options do not mention", async () => {
        // A partial override must not blank out the rest of the file config —
        // this is the merge, not a replacement, and getting it wrong would
        // silently reset every other tuned setting.
        await writeFileConfig({
            compress: { maxContextLimit: 123456, keepRecent: 9 },
            adaptive: { learningRate: 0.4 },
        })
        const config = loadConfig({ compress: { maxContextLimit: 654321 } })
        assert.strictEqual(config.compress.maxContextLimit, 654321, "the overridden key")
        assert.strictEqual(
            config.compress.keepRecent,
            9,
            "an untouched sibling key must survive a partial options override",
        )
        assert.strictEqual(
            config.adaptive.learningRate,
            0.4,
            "an untouched top-level section must survive too",
        )
    })

    it("keeps nested defaults for a partially specified section", () => {
        // deepMerge must not replace a whole sub-object with the partial one.
        const config = loadConfig({ compress: { maxContextLimit: 777 } })
        assert.strictEqual(config.compress.maxContextLimit, 777)
        assert.strictEqual(
            config.compress.minContextLimit > 0,
            true,
            "the rest of compress must still carry its defaults",
        )
    })

    it("merges per-model limit maps per key instead of replacing them", async () => {
        // The regression: these two maps were taken from the higher layer
        // wholesale, so an override naming ONE model silently discarded every
        // other model's entry. The override looked like it applied while the
        // rest vanished — and because resolveCompressLimits falls back to the
        // global threshold for a missing key, the effect was a model quietly
        // measured against the wrong limit rather than an obvious failure.
        await writeFileConfig({
            compress: {
                modelMaxLimits: {
                    "anthropic/claude-a": 150000,
                    "openai/gpt-b": 90000,
                    "google/gemini-c": 70000,
                },
                modelMinLimits: {
                    "anthropic/claude-a": 80000,
                    "openai/gpt-b": 40000,
                },
            },
        })

        const config = loadConfig({
            compress: {
                modelMaxLimits: { "openai/gpt-b": 120000 },
                modelMinLimits: { "openai/gpt-b": 55000 },
            },
        })

        assert.deepStrictEqual(
            config.compress.modelMaxLimits,
            {
                "anthropic/claude-a": 150000,
                "openai/gpt-b": 120000,
                "google/gemini-c": 70000,
            },
            "the overridden key takes the new value; the unmentioned keys must survive intact",
        )
        assert.deepStrictEqual(
            config.compress.modelMinLimits,
            { "anthropic/claude-a": 80000, "openai/gpt-b": 55000 },
            "modelMinLimits must merge per key on exactly the same terms",
        )
    })

    it("merges per-model limits across the slim.jsonc layer too", async () => {
        // The same defect existed between defaults and the file, so it is not
        // specific to the options layer.
        await writeFileConfig({
            compress: { modelMaxLimits: { "a/one": 10, "b/two": 20 } },
        })
        const config = loadConfig()
        assert.deepStrictEqual(config.compress.modelMaxLimits, {
            "a/one": 10,
            "b/two": 20,
        })
    })

    it("leaves per-model limits undefined when no layer sets them", () => {
        // Merging must not manufacture an empty object where there was no map
        // at all: `undefined` and `{}` behave the same on read, but only one of
        // them is honest about a config that never configured this.
        assert.strictEqual(loadConfig().compress.modelMaxLimits, undefined)
        assert.strictEqual(loadConfig().compress.modelMinLimits, undefined)
    })

    it("takes the map wholesale when the base has none", () => {
        const config = loadConfig({
            compress: { modelMaxLimits: { "only/model": 4242 } },
        })
        assert.deepStrictEqual(config.compress.modelMaxLimits, { "only/model": 4242 })
    })

    it("ignores non-object options instead of corrupting the config", () => {
        for (const bad of ["a string", 42, true, ["an", "array"]]) {
            const config = loadConfig(bad as unknown as Record<string, unknown>)
            assert.strictEqual(
                config.compress.maxContextLimit,
                DEFAULT_MAX_CONTEXT_LIMIT,
                `options of type ${typeof bad} must be ignored, not merged`,
            )
        }
    })

    it("treats null and undefined options as no options", () => {
        assert.strictEqual(loadConfig(null).compress.maxContextLimit, DEFAULT_MAX_CONTEXT_LIMIT)
        assert.strictEqual(
            loadConfig(undefined).compress.maxContextLimit,
            DEFAULT_MAX_CONTEXT_LIMIT,
        )
    })
})

describe("configurePluginOptions", () => {
    beforeEach(() => {
        resetPluginOptions()
    })
    afterEach(() => {
        resetPluginOptions()
    })

    it("captures a plain object of options", () => {
        configurePluginOptions({ options: { debug: true } })
        // Reaching it back through loadConfig is the contract that matters.
        assert.strictEqual(loadConfig().debug, true)
    })

    it("clears the captured options when the host supplies none", () => {
        configurePluginOptions({ options: { debug: true } })
        configurePluginOptions({})
        assert.strictEqual(
            loadConfig().debug,
            false,
            "a reload with no options must not inherit the previous load's options",
        )
    })

    it("ignores a malformed options value rather than half-capturing it", () => {
        configurePluginOptions({ options: "not an object" })
        assert.strictEqual(loadConfig().debug, false)
    })
})

describe("the plugin reads ctx.options at setup", () => {
    let dir: string
    let previousXdg: string | undefined

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-options-hook-"))
        await mkdir(join(dir, "opencode"), { recursive: true })
        process.env.XDG_CONFIG_HOME = dir
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({
                enabled: true,
                compress: { enabled: true, maxContextLimit: 900000, minContextLimit: 500000 },
                persistence: { enabled: true, directory: join(dir, "state") },
            }),
            "utf-8",
        )
        resetPluginOptions()
        resetPersistence()
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
        resetPluginOptions()
        resetPersistence()
    })

    it("honours options passed through the plugin context", async () => {
        // The end-to-end wiring: the value in opencode.jsonc must actually
        // reach the running pipeline, not just loadConfig in isolation.
        const contextHooks: ((event: any) => any)[] = []
        const ctx: any = {
            options: { debug: true },
            model: {
                default: async () => ({
                    data: { providerID: "p", modelID: "m", limit: { context: 200000 } },
                }),
                list: async () => ({ data: [] }),
            },
            tool: { transform: async (r: any) => r({ add: () => {} }) },
            session: {
                hook: async (name: string, cb: any) => {
                    if (name === "context") contextHooks.push(cb)
                    return { dispose: async () => {} }
                },
                context: async () => [],
                get: async () => null,
            },
            event: { subscribe: async function* () {} },
        }

        await (slimPlugin as any).setup(ctx)

        const logs: string[] = []
        const originalLog = console.log
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "))
        }
        const event: any = {
            sessionID: "ses_opt",
            messages: [],
            system: [],
            tools: [],
            model: { providerID: "p", id: "m" },
        }
        try {
            for (const hook of contextHooks) await hook(event)
        } finally {
            console.log = originalLog
        }

        assert.ok(
            logs.some((l) => l.includes("[slim]")),
            `debug:true from ctx.options must enable the plugin's debug logging; logs: ${JSON.stringify(logs)}`,
        )
    })

    it("stays on the slim.jsonc settings when the host passes no options", async () => {
        const contextHooks: ((event: any) => any)[] = []
        const ctx: any = {
            model: {
                default: async () => ({
                    data: { providerID: "p", modelID: "m", limit: { context: 200000 } },
                }),
                list: async () => ({ data: [] }),
            },
            tool: { transform: async (r: any) => r({ add: () => {} }) },
            session: {
                hook: async (name: string, cb: any) => {
                    if (name === "context") contextHooks.push(cb)
                    return { dispose: async () => {} }
                },
                context: async () => [],
                get: async () => null,
            },
            event: { subscribe: async function* () {} },
        }

        await (slimPlugin as any).setup(ctx)
        // slim.jsonc sets no `debug`, so the default (false) must hold and the
        // pipeline must stay quiet.
        const logs: string[] = []
        const originalLog = console.log
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "))
        }
        const event: any = {
            sessionID: "ses_noopt",
            messages: [],
            system: [],
            tools: [],
            model: { providerID: "p", id: "m" },
        }
        try {
            for (const hook of contextHooks) await hook(event)
        } finally {
            console.log = originalLog
        }

        assert.strictEqual(
            logs.filter((l) => l.includes("[slim]")).length,
            0,
            "without options, debug stays off exactly as before",
        )
    })
})