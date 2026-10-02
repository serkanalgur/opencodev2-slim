/**
 * Hook registration lifetime.
 *
 * `ctx.session.hook()` returns a `Registration` that must be disposed on
 * unload. The previous build discarded all three, so a plugin reload (config
 * change, watched-directory edit, `service restart`) left the old callbacks
 * attached to the host and stacked a second copy of the whole compression
 * pipeline onto the same hooks — after N reloads, every request ran the DCP
 * pipeline N times, compressing and pruning repeatedly against the same
 * messages.
 *
 * These tests drive the real plugin and count LIVE hooks, which is the symptom
 * that actually matters: a disposed hook must stop firing.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import slimPlugin, { resetPersistence } from "../src/index"

/**
 * A fake host that tracks which hook registrations are still live.
 *
 * `live` is the honest model of the host's hook table: a callback fires only
 * while its registration is undisposed.
 */
function makeHost() {
    const live = new Set<(event: any) => any>()
    const disposals: string[] = []
    const registrationCounts: Record<string, number> = {}

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
                live.add(cb)
                registrationCounts[name] = (registrationCounts[name] ?? 0) + 1
                return {
                    dispose: async () => {
                        if (live.delete(cb)) disposals.push(name)
                    },
                }
            },
            context: async () => [],
            get: async () => null,
        },
        event: {
            subscribe: async function* () {
                // no host events
            },
        },
    }

    return {
        ctx,
        liveCount: () => live.size,
        disposals,
        registrationCounts,
        /** Fire every currently-live context hook, as the host would. */
        runContextHooks: async (event: any) => {
            for (const cb of [...live]) await cb(event)
        },
    }
}

describe("hook registration lifetime", () => {
    let dir: string
    let previousXdg: string | undefined

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-hook-life-"))
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
        resetPersistence()
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
        resetPersistence()
    })

    it("registers three hooks and disposes every one on unload", async () => {
        const host = makeHost()
        const cleanup = await (slimPlugin as any).setup(host.ctx)

        assert.strictEqual(
            host.registrationCounts.context,
            2,
            "the plugin registers two context hooks (system prompt + DCP pipeline)",
        )
        assert.strictEqual(host.registrationCounts.compaction, 1, "and one compaction hook")
        assert.strictEqual(host.liveCount(), 3, "all three are live once setup returns")

        await cleanup()

        assert.strictEqual(
            host.liveCount(),
            0,
            "cleanup must dispose every registration, or the callbacks stay attached to the host",
        )
        assert.deepStrictEqual(
            host.disposals.sort(),
            ["compaction", "context", "context"],
            "each registration is disposed exactly once",
        )
    })

    it("does not stack a second pipeline copy across a reload", async () => {
        // The bug this guards: after a reload the host still fires the OLD
        // callbacks plus the new ones, so one request runs the pipeline twice.
        const host = makeHost()

        const cleanup1 = await (slimPlugin as any).setup(host.ctx)
        assert.strictEqual(host.liveCount(), 3)
        await cleanup1()
        assert.strictEqual(host.liveCount(), 0, "first unload leaves nothing attached")

        // Reload: a fresh setup re-registers, and must again land at exactly 3.
        await (slimPlugin as any).setup(host.ctx)
        assert.strictEqual(
            host.liveCount(),
            3,
            "a reload must not leave the previous generation attached alongside the new one",
        )
    })

    it("survives repeated reload cycles without accumulating hooks", async () => {
        const host = makeHost()
        for (let i = 0; i < 5; i++) {
            const cleanup = await (slimPlugin as any).setup(host.ctx)
            assert.strictEqual(host.liveCount(), 3, `cycle ${i}: exactly one generation live`)
            await cleanup()
            assert.strictEqual(host.liveCount(), 0, `cycle ${i}: nothing left attached`)
        }
    })

    it("disposes the remaining hooks even when one dispose throws", async () => {
        // A throwing dispose must not strand the others: they would stay
        // attached for the life of the host process.
        const host = makeHost()
        const originalHook = host.ctx.session.hook
        let call = 0
        host.ctx.session.hook = async (name: string, cb: any) => {
            const reg = await originalHook(name, cb)
            call++
            if (call === 1) {
                return {
                    dispose: async () => {
                        throw new Error("dispose failed")
                    },
                }
            }
            return reg
        }

        const cleanup = await (slimPlugin as any).setup(host.ctx)
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            await cleanup()
        } finally {
            console.warn = originalWarn
            host.ctx.session.hook = originalHook
        }

        // The first registration's dispose threw, so it stays in the host's
        // table by construction — but the OTHER two must still be detached.
        assert.strictEqual(
            host.liveCount(),
            1,
            "one failed dispose must not strand the other two registrations",
        )
        assert.ok(
            warnings.some((w) => w.includes("failed to dispose a session hook registration")),
            `the failure must be reported, got: ${JSON.stringify(warnings)}`,
        )
    })
})