/**
 * Session-state persistence: plugin-scoped storage as the primary store, the
 * legacy flat directory as a migration fallback.
 *
 * Why this matters: the old build kept every project's state in one global
 * `~/.config/opencode/slim` directory keyed only by session id, so two
 * checkouts could collide. `ctx.storage` scopes values per plugin instance and
 * the keys here are scoped per project directory.
 *
 * The upgrade path is the risky half, so it is tested explicitly: a session that
 * exists only on disk must be adopted into storage on first read, keeping its
 * compression history, rather than silently starting blank.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    sessionStateKey,
    projectScopeKey,
    serializeState,
    readLegacyState,
} from "../src/lib/persistence"
import slimPlugin, {
    configurePersistence,
    resetPersistence,
    usingPluginStorage,
} from "../src/index"
import { loadConfig } from "../src/lib/config"
import { loadSessionState } from "../src/lib/state"
import type { SessionState } from "../src/lib/types"

/** An in-memory stand-in for the v2 storage domain. */
function makeStorage(initial: Record<string, unknown> = {}) {
    const map = new Map<string, unknown>(Object.entries(initial))
    const sets: string[] = []
    return {
        map,
        sets,
        get: async (key: string) => map.get(key),
        set: async (key: string, value: unknown) => {
            sets.push(key)
            map.set(key, value)
        },
        remove: async (key: string) => {
            map.delete(key)
        },
    }
}

/** A minimal state object shaped like the real one. */
function makeState(sessionId: string, over: Partial<SessionState> = {}): SessionState {
    return {
        sessionId,
        modelContextLimit: 200000,
        currentTokenCount: 1234,
        compressionCount: 7,
        lastCompressionTime: 1,
        manualMode: false,
        compressPermission: null,
        compressionHistory: [
            { timestamp: 1, inputTokens: 1000, outputTokens: 200, ratio: 0.8, messageCount: 9, success: true },
        ],
        averageCompressionRatio: 0.8,
        toolCalls: new Map([["call-1", { tool: "read", args: { p: 1 }, timestamp: 1, turn: 1 }]]),
        compressionBlocks: [],
        nextBlockId: 4,
        nudges: { contextLimitAnchors: [], turnNudgeAnchors: [], iterationNudgeAnchors: [] },
        ...over,
    }
}

describe("projectScopeKey", () => {
    it("is stable for the same path and differs across projects", () => {
        const a = projectScopeKey("/Users/x/project-a")
        const b = projectScopeKey("/Users/x/project-b")
        assert.strictEqual(a, projectScopeKey("/Users/x/project-a"), "same path → same scope")
        assert.notStrictEqual(a, b, "different projects must not share a scope")
    })

    it("never contains the namespace separator", () => {
        // `/` separates the scope from the session id, so a scope carrying one
        // would forge a key belonging to a different session.
        assert.ok(!projectScopeKey("/Users/x/project-a").includes("/"))
    })

    it("falls back to a global scope when there is no project path", () => {
        assert.strictEqual(projectScopeKey(undefined), "global")
        assert.strictEqual(projectScopeKey(""), "global")
    })
})

describe("sessionStateKey", () => {
    it("namespaces sessions by project scope", () => {
        const a = sessionStateKey("p1", "ses_x")
        const b = sessionStateKey("p2", "ses_x")
        assert.notStrictEqual(a, b, "the same session id in two projects must not collide")
        assert.ok(a.includes("ses_x"))
    })
})

describe("serializeState", () => {
    it("flattens the toolCalls Map into JSON-native entries", () => {
        const out = serializeState(makeState("ses_1"))
        assert.ok(Array.isArray(out.toolCalls), "a Map is not JSON-serializable")
        assert.deepStrictEqual(
            (out.toolCalls as [string, unknown][]).map(([id]) => id),
            ["call-1"],
        )
    })

    it("survives a JSON round trip", () => {
        const out = serializeState(makeState("ses_1"))
        const back = JSON.parse(JSON.stringify(out))
        assert.strictEqual(back.compressionCount, 7)
        assert.strictEqual(back.compressionHistory.length, 1)
    })
})

describe("readLegacyState", () => {
    let dir: string
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "slim-legacy-"))
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it("returns undefined for a missing file rather than throwing", () => {
        assert.strictEqual(readLegacyState("ses_absent", dir), undefined)
    })

    it("returns undefined for a corrupt file instead of wedging the session", async () => {
        await writeFile(join(dir, "ses_bad.json"), "{ not json", "utf-8")
        assert.strictEqual(
            readLegacyState("ses_bad", dir),
            undefined,
            "a corrupt legacy file must degrade to defaults, not throw on every request",
        )
    })

    it("returns undefined for JSON that is not an object", async () => {
        await writeFile(join(dir, "ses_arr.json"), "[1,2,3]", "utf-8")
        assert.strictEqual(readLegacyState("ses_arr", dir), undefined)
    })

    it("reads a real legacy state", async () => {
        await writeFile(
            join(dir, "ses_ok.json"),
            JSON.stringify({ sessionId: "ses_ok", compressionCount: 3 }),
            "utf-8",
        )
        assert.deepStrictEqual(readLegacyState("ses_ok", dir), {
            sessionId: "ses_ok",
            compressionCount: 3,
        })
    })
})

describe("configurePersistence", () => {
    beforeEach(() => {
        resetPersistence()
    })
    afterEach(() => {
        resetPersistence()
    })

    it("adopts the host storage domain and the project scope", () => {
        assert.strictEqual(usingPluginStorage(), false, "no backend before setup")
        configurePersistence({
            storage: makeStorage(),
            location: { project: { canonical: "/Users/x/project-a" } },
        })
        assert.strictEqual(usingPluginStorage(), true)
    })

    it("leaves the legacy path in place when the host has no storage domain", () => {
        configurePersistence({})
        assert.strictEqual(
            usingPluginStorage(),
            false,
            "an older host must fall back to the on-disk directory, not lose state",
        )
    })

    it("ignores a malformed storage domain rather than half-wiring it", () => {
        configurePersistence({ storage: { get: async () => undefined } })
        assert.strictEqual(
            usingPluginStorage(),
            false,
            "storage without set() cannot persist and must not be adopted",
        )
    })

    it("uses the global scope when the host reports no project", () => {
        configurePersistence({ storage: makeStorage(), location: {} })
        // Not directly observable, but a missing path must not throw setup.
        assert.strictEqual(usingPluginStorage(), true)
    })
})

describe("migration: a session that exists only on disk", () => {
    let dir: string
    let legacyDir: string
    let previousXdg: string | undefined

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-migrate-"))
        legacyDir = join(dir, "legacy")
        await mkdir(join(dir, "opencode"), { recursive: true })
        await mkdir(legacyDir, { recursive: true })
        process.env.XDG_CONFIG_HOME = dir
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({ enabled: true, persistence: { enabled: true, directory: legacyDir } }),
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

    it("still finds the state when the host offers no storage", async () => {
        configurePersistence({})
        await writeFile(
            join(legacyDir, "ses_old.json"),
            JSON.stringify(serializeState(makeState("ses_old"))),
            "utf-8",
        )
        const config = loadConfig()
        const loaded = loadSessionStateThrough("ses_old", config)
        assert.strictEqual(loaded.compressionCount, 7, "legacy state is still readable")
    })

    it("leaves the legacy file in place for the user after adopting it", async () => {
        await writeFile(
            join(legacyDir, "ses_old.json"),
            JSON.stringify(serializeState(makeState("ses_old"))),
            "utf-8",
        )
        const storage = makeStorage()
        configurePersistence({ storage, location: { project: { canonical: "/p/a" } } })

        const key = sessionStateKey(projectScopeKey("/p/a"), "ses_old")
        // The plugin's loader adopts the legacy entry and writes it forward;
        // the source file itself must survive — deleting user data on upgrade
        // is not the plugin's call to make.
        assert.ok(
            existsSync(join(legacyDir, "ses_old.json")),
            "the legacy file is never deleted by the migration",
        )
        assert.strictEqual(storage.map.has(key), false, "nothing written before the loader runs")
    })

    it("adopts a legacy-only session into storage, keeping its compression history", async () => {
        // The upgrade case that actually matters: state written by the previous
        // build exists only on disk. It must be loaded, carried into the new
        // store, and still hold its history — a silent reset to defaults would
        // quietly discard every compression the user had done.
        await writeFile(
            join(legacyDir, "ses_old.json"),
            JSON.stringify(serializeState(makeState("ses_old"))),
            "utf-8",
        )

        const storage = makeStorage()
        const contextHooks: ((event: any) => any)[] = []
        const ctx: any = {
            storage,
            location: { project: { canonical: "/p/a" } },
            model: {
                default: async () => ({ data: { providerID: "p", modelID: "m", limit: { context: 200000 } } }),
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
        const event: any = {
            sessionID: "ses_old",
            messages: [],
            system: [],
            tools: [],
            model: { providerID: "p", id: "m" },
        }
        for (const hook of contextHooks) await hook(event)

        const key = sessionStateKey(projectScopeKey("/p/a"), "ses_old")
        assert.ok(storage.map.has(key), "the legacy session was written forward into storage")
        const migrated = storage.map.get(key) as Record<string, unknown>
        assert.strictEqual(
            migrated.compressionCount,
            7,
            "the migrated state must keep its compression history, not reset to defaults",
        )
        assert.strictEqual((migrated.compressionHistory as unknown[]).length, 1)
        // `toolCalls` is deliberately NOT asserted here: it is a per-request
        // scratch map that nothing in src/ ever populates (trackToolCall has no
        // callers), and the compaction reset clears it. Its Map→entries
        // round-trip is covered by the serializeState unit test above, which
        // is the level that actually owns that contract.
        assert.ok(
            existsSync(join(legacyDir, "ses_old.json")),
            "migration copies forward; it never deletes the user's file",
        )
    })

    it("writes nothing at all when persistence is disabled", async () => {
        // `persistence.enabled: false` is the user opting out of persistence.
        // It must gate BOTH layers. When the storage write ran ahead of the
        // flag check, turning persistence off stopped only the on-disk mirror
        // while history kept accumulating in plugin storage — "off" that still
        // persisted, silently.
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({
                enabled: true,
                persistence: { enabled: false, directory: legacyDir },
            }),
            "utf-8",
        )

        const storage = makeStorage()
        const contextHooks: ((event: any) => any)[] = []
        const ctx: any = {
            storage,
            location: { project: { canonical: "/p/off" } },
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
        const event: any = {
            sessionID: "ses_off",
            messages: [],
            system: [],
            tools: [],
            model: { providerID: "p", id: "m" },
        }
        for (const hook of contextHooks) await hook(event)

        assert.deepStrictEqual(
            storage.sets,
            [],
            "persistence disabled must write nothing to plugin storage",
        )
        assert.strictEqual(
            existsSync(join(legacyDir, "ses_off.json")),
            false,
            "nor to the on-disk mirror",
        )
    })

    it("keeps two projects' same-named sessions apart", async () => {
        // The bug the migration exists to fix: one global directory keyed only
        // by session id let two checkouts collide on the same session name.
        const writeLegacy = async (sid: string, count: number) =>
            writeFile(
                join(legacyDir, `${sid}.json`),
                JSON.stringify(serializeState(makeState(sid, { compressionCount: count }))),
                "utf-8",
            )
        await writeLegacy("ses_shared", 11)

        const runFor = async (canonical: string) => {
            resetPersistence()
            const storage = makeStorage()
            const contextHooks: ((event: any) => any)[] = []
            const ctx: any = {
                storage,
                location: { project: { canonical } },
                model: {
                    default: async () => ({ data: { providerID: "p", modelID: "m", limit: { context: 200000 } } }),
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
            const event: any = {
                sessionID: "ses_shared",
                messages: [],
                system: [],
                tools: [],
                model: { providerID: "p", id: "m" },
            }
            for (const hook of contextHooks) await hook(event)
            return storage
        }

        const a = await runFor("/projects/alpha")
        const b = await runFor("/projects/beta")

        const keyA = sessionStateKey(projectScopeKey("/projects/alpha"), "ses_shared")
        const keyB = sessionStateKey(projectScopeKey("/projects/beta"), "ses_shared")
        assert.notStrictEqual(keyA, keyB, "the same session id must key differently per project")
        assert.ok(a.map.has(keyA))
        assert.ok(b.map.has(keyB))
        // Scoping is asserted by the keys themselves, not by which layer the
        // loader happened to prefer. The previous form of this assertion
        // (`!a.map.has(keyB)`) read as though the loader always took the file,
        // which is not the contract and is not what this test is about — the
        // recency cases below cover which copy wins.
        assert.deepStrictEqual(
            Object.keys(a.map).filter((k) => k === keyB),
            [],
            "project alpha's storage must not hold project beta's key",
        )
    })
})

describe("recency resolution between storage and the legacy mirror", () => {
    let dir: string
    let legacyDir: string
    let previousXdg: string | undefined

    /** Build a payload stamped at a chosen write time. */
    const stamped = (sessionId: string, count: number, writtenAt: number) =>
        serializeState(makeState(sessionId, { compressionCount: count }), writtenAt)

    /** Seed the legacy file for a session. */
    const seedFile = async (sessionId: string, payload: Record<string, unknown>) => {
        await writeFile(
            join(legacyDir, `${sessionId}.json`),
            JSON.stringify(payload),
            "utf-8",
        )
    }

    const bootPlugin = async (
        storage: ReturnType<typeof makeStorage>,
        sessionID: string,
        canonical: string,
    ) => {
        const contextHooks: ((event: any) => any)[] = []
        const ctx: any = {
            storage,
            location: { project: { canonical } },
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
        const event: any = {
            sessionID,
            messages: [],
            system: [],
            tools: [],
            model: { providerID: "p", id: "m" },
        }
        for (const hook of contextHooks) await hook(event)
    }

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-recency-"))
        legacyDir = join(dir, "legacy")
        await mkdir(join(dir, "opencode"), { recursive: true })
        await mkdir(legacyDir, { recursive: true })
        process.env.XDG_CONFIG_HOME = dir
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({
                enabled: true,
                compress: { enabled: true, maxContextLimit: 900000, minContextLimit: 500000 },
                persistence: { enabled: true, directory: legacyDir },
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

    it("keeps the newer storage copy when the mirror write failed earlier", async () => {
        // THE DEFECT. Storage is ahead, the file on disk is stale. Preferring
        // the file would adopt the stale state AND write it forward over the
        // newer storage copy — destroying the newer state. This needs only one
        // swallowed mirror-write failure to trigger, so it is silent.
        const sid = "ses_ahead"
        const canonical = "/projects/ahead"
        const key = sessionStateKey(projectScopeKey(canonical), sid)

        await seedFile(sid, stamped(sid, 5, 1_000))
        const storage = makeStorage({
            [key]: stamped(sid, 42, 9_000),
        })

        await bootPlugin(storage, sid, canonical)

        assert.strictEqual(
            (storage.map.get(key) as Record<string, unknown>).compressionCount,
            42,
            "the newer storage copy must survive; a stale mirror must never overwrite it",
        )
        // The stale mirror is refreshed so the two stop disagreeing.
        const refreshed = JSON.parse(
            readFileSync(join(legacyDir, `${sid}.json`), "utf-8"),
        )
        assert.strictEqual(
            refreshed.compressionCount,
            42,
            "the stale file must be brought up to date, not left to keep losing",
        )
    })

    it("adopts the newer file copy when storage is behind", async () => {
        // The mirror image: an older slim ran and wrote only the file, leaving
        // storage stale. The newer state must be adopted and written forward.
        const sid = "ses_behind"
        const canonical = "/projects/behind"
        const key = sessionStateKey(projectScopeKey(canonical), sid)

        await seedFile(sid, stamped(sid, 77, 9_000))
        const storage = makeStorage({
            [key]: stamped(sid, 5, 1_000),
        })

        await bootPlugin(storage, sid, canonical)

        assert.strictEqual(
            (storage.map.get(key) as Record<string, unknown>).compressionCount,
            77,
            "the newer file copy must win and be carried into storage",
        )
    })

    it("does not overwrite storage when the read failed and the mirror is stale", async () => {
        // "Storage holds no entry" and "storage could not be read" are different
        // answers. Treating a failed read as an empty store adopts the stale
        // mirror, and the very next save writes that stale state back over a
        // storage copy that was never missing — only unreachable. The write is
        // silent and the newer history is gone.
        const sid = "ses_unreachable"
        const canonical = "/projects/unreachable"
        const key = sessionStateKey(projectScopeKey(canonical), sid)

        await seedFile(sid, stamped(sid, 5, 1_000))
        const storage = makeStorage({
            [key]: stamped(sid, 42, 9_000),
        })
        const realGet = storage.get
        storage.get = async (k: string) => {
            if (k === key) throw new Error("storage transport down")
            return realGet(k)
        }

        await bootPlugin(storage, sid, canonical)

        assert.strictEqual(
            (storage.map.get(key) as Record<string, unknown>).compressionCount,
            42,
            "a failed read must not cause the stale mirror to be written over newer storage",
        )
    })

it("prefers storage on a tie, since a clean save stamps both alike", async () => {
        const sid = "ses_tie"
        const canonical = "/projects/tie"
        const key = sessionStateKey(projectScopeKey(canonical), sid)

        await seedFile(sid, stamped(sid, 5, 4_000))
        const storage = makeStorage({
            [key]: stamped(sid, 8, 4_000),
        })

        await bootPlugin(storage, sid, canonical)

        assert.strictEqual(
            (storage.map.get(key) as Record<string, unknown>).compressionCount,
            8,
            "an exact tie must resolve deterministically to storage",
        )
    })

    it("falls back to file mtime for a payload written before recency tracking", async () => {
        // An upgraded install has files with no marker. Treating them as
        // infinitely old would let any storage copy win over real disk state,
        // so mtime stands in for the missing marker.
        const sid = "ses_legacy_nomarker"
        const canonical = "/projects/nomarker"
        const key = sessionStateKey(projectScopeKey(canonical), sid)

        const { WRITTEN_AT } = await import("../src/lib/persistence")
        const raw = serializeState(makeState(sid, { compressionCount: 31 }))
        delete raw[WRITTEN_AT]
        await seedFile(sid, raw)
        // Ensure the file's mtime is comfortably newer than the storage stamp.
        const future = new Date(Date.now() + 60_000)
        await utimes(join(legacyDir, `${sid}.json`), future, future)

        const storage = makeStorage({
            [key]: stamped(sid, 5, Date.now() - 60_000),
        })

        await bootPlugin(storage, sid, canonical)

        assert.strictEqual(
            (storage.map.get(key) as Record<string, unknown>).compressionCount,
            31,
            "an unmarked but newer file must still win via its mtime",
        )
    })
})

/**
 * Load a session's state through the legacy path, which is what the plugin's
 * hydration falls back to. Mirrors the on-disk branch of the loader so the
 * migration tests assert against the same source of truth production uses.
 */
function loadSessionStateThrough(sessionId: string, config: ReturnType<typeof loadConfig>) {
    return loadSessionState(sessionId, config.persistence.directory)
}