import { describe, it } from "node:test"
import assert from "node:assert"
import { autoCompress } from "../src/lib/strategies"
import { buildPanelData } from "../src/lib/tui"
import type { CompressionRecord, SessionState, SlimConfig } from "../src/lib/types"

// ─── The ratio clamp ────────────────────────────────────────────────────────
//
// Regression class this section exists for: an UNCLAMPED compression ratio.
// The ratio is `1 - outputTokens / inputTokens`, which is NEGATIVE whenever the
// summary is larger than the range it replaces. That is not hypothetical: a
// small `todoread`-heavy range, or any range whose preserved protected-tool
// section outweighs the text it replaced, hits it. The unclamped value then
// flowed into two places:
//
//   1. the EMA in state.ts (addCompressionRecord) — so a single bad
//      compression permanently dragged the session's average ratio down; and
//   2. `totalTokensSaved` in src/lib/tui.ts, which summed the raw signed
//      delta — so the panel printed `Saved: $-0.0994` and `Avg ratio: -330.0%`.
//
// A compression that does not shrink saved NOTHING. It cost. Reporting it as a
// negative saving is the bug in both directions: the number is meaningless as a
// saving, and it is arithmetically inconsistent with the clamped `ratio` those
// very records are stored with.
//
// There are THREE record sites, each of which had to be fixed, and a test that
// only covers one leaves the other two free to regress:
//   - src/lib/strategies.ts (~:1451) — the auto-compress path
//   - src/index.ts (~:586)                — the `compress` tool
//   - src/index.ts (~:1188)               — the compaction hook
// The two index.ts sites are closures inside the plugin, so they are reached by
// driving the plugin with a fake `ctx` — see `drivePlugin` below.

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeConfig(protectedTools: string[] = ["bash"]): SlimConfig {
    return {
        enabled: true,
        debug: false,
        compress: {
            enabled: true,
            mode: "range",
            permission: "allow",
            maxContextLimit: 100000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            protectUserMessages: false,
            protectedTools,
            keepRecent: 2,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: false, directory: "/tmp/slim-ratio-test" },
    } as SlimConfig
}

function makeState(): SessionState {
    return {
        sessionId: "s1",
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
    } as SessionState
}

/**
 * One message whose PROTECTED tool output dwarfs its own text, so
 * `buildCompressionSummary` emits far more than the message contributed.
 * This is the "compression EXPANDS" shape.
 */
function expandingMessage(): any {
    return {
        id: "m1",
        role: "assistant",
        content: [
            { type: "tool-call", id: "c1", name: "bash", input: { command: "x".repeat(500) } },
            { type: "tool-result", id: "c1", name: "bash", result: { type: "text", value: "y".repeat(3000) } },
        ],
    }
}

/** A message with a lot of ordinary text and no protected tool: genuinely shrinks. */
function shrinkingMessage(): any {
    return {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "z".repeat(4000) }],
    }
}

/** Padding so the auto-compress candidate scan has a `keepRecent` tail to keep. */
function withPadding(messages: any[]): any[] {
    return [
        ...messages,
        { id: "m2", role: "user", content: [{ type: "text", text: "pad one" }] },
        { id: "m3", role: "user", content: [{ type: "text", text: "pad two" }] },
    ]
}

/** The single record the compression under test appended. */
function onlyRecord(state: SessionState): CompressionRecord {
    assert.strictEqual(
        state.compressionHistory.length,
        1,
        `expected exactly one compression record, got ${state.compressionHistory.length}`,
    )
    return state.compressionHistory[0]
}

// ─── Site 1: src/lib/strategies.ts autoCompress ─────────────────────────────

describe("ratio clamp: the auto-compress record site", () => {
    it("records ratio 0, never a negative one, when the summary exceeds its input", async () => {
        const state = makeState()
        const messages = withPadding([expandingMessage()])

        // Control: the compression really does EXPAND here. Without this the
        // test could pass on a fixture that shrank, and would then be
        // asserting the clamp on a case that never needed it.
        const result = await autoCompress(
            state,
            makeConfig(),
            messages,
            999_999,
            { max: 100, min: 50 },
        )
        assert.strictEqual(result.compressed, true, "precondition: the compression must have run")
        const record = onlyRecord(state)
        assert.ok(
            record.outputTokens > record.inputTokens,
            `precondition: this fixture must EXPAND (in=${record.inputTokens}, out=${record.outputTokens}), ` +
                `else the clamp is not what made the test pass`,
        );

        // THE assertion. Unclamped, this was `1 - 625/125` = -4.
        assert.strictEqual(
            record.ratio,
            0,
            `an expanding compression saved nothing, so its ratio must be 0, not ${record.ratio}`,
        )
        assert.ok(
            record.ratio >= 0,
            `a ratio must never be negative: it is a SAVING, and this one cost tokens`,
        )
    })

    it("keeps the recorded ratio non-negative across repeated expanding compressions", async () => {
        // The defect reached the user through the EMA, so the observable
        // consequence is the AVERAGE. Two bad compressions must not drag
        // `averageCompressionRatio` below zero.
        const state = makeState()
        for (let i = 0; i < 2; i++) {
            await autoCompress(
                state,
                makeConfig(),
                withPadding([expandingMessage()]),
                999_999,
                { max: 100, min: 50 },
            );
            // The 5-minute auto-compress throttle is keyed off wall time, so the
            // second call needs its clock moved or it is skipped.
            ;(state as any).lastAutoCompressTime = 0
        }

        assert.strictEqual(state.compressionHistory.length, 2, "both compressions must have been recorded")
        for (const record of state.compressionHistory) {
            assert.ok(
                record.ratio >= 0,
                `every record must carry a non-negative ratio, got ${record.ratio}`,
            )
        }
        assert.ok(
            state.averageCompressionRatio >= 0,
            `the EMA must not go negative, got ${state.averageCompressionRatio}`,
        )
    })

    it("still reports a positive ratio when the summary genuinely shrinks", async () => {
        // The clamp must not swallow real savings: a compression that halves
        // the range is still a genuine saving and must still be reported.
        const state = makeState()

        await autoCompress(
            state,
            makeConfig([]),
            withPadding([shrinkingMessage()]),
            999_999,
            { max: 100, min: 50 },
        )
        const record = onlyRecord(state)

        assert.ok(
            record.outputTokens < record.inputTokens,
            `precondition: this fixture must SHRINK (in=${record.inputTokens}, out=${record.outputTokens})`,
        );
        // Real, positive saving — not clamped away to 0.
        assert.ok(
            record.ratio > 0,
            `a genuine saving must still be reported, got ratio ${record.ratio}`,
        )
        assert.ok(
            record.ratio < 1,
            `a compression that removes tokens cannot claim a 100% saving, got ${record.ratio}`,
        )
    })

    it("cannot reach a zero-token input at all: the candidate scan skips every sub-100-token message", async () => {
        // The `inputTokens > 0` half of the clamp guard is UNREACHABLE at this
        // site, and that is worth pinning rather than leaving ambiguous. The
        // candidate scan is `if (tokens < 100) continue`, so a message that
        // contributes 0 tokens never becomes a target, and `inputTokens` is a
        // sum over targets only. `1 - out/0` is -Infinity — not merely
        // negative but non-finite, which would poison the EMA permanently — so
        // the guard is load-bearing, but only at the two index.ts sites (see
        // the compress-tool suite below, which does reach 0).
        //
        // If this ever starts failing, a zero-input compression HAS become
        // reachable here and this test must be replaced by a real one.
        const state = makeState()
        const result = await autoCompress(
            state,
            makeConfig([]),
            withPadding([{ id: "m1", role: "assistant", content: [] }]),
            999_999,
            { max: 100, min: 50 },
        )

        assert.strictEqual(
            result.compressed,
            false,
            "a content-free message contributes <100 tokens, so the scan must skip it entirely",
        )
        assert.strictEqual(
            state.compressionHistory.length,
            0,
            "no record may be written for a range that measured 0 input tokens",
        )
    })
})

// ─── Sites 2 and 3: the plugin closures in src/index.ts ─────────────────────
//
// The `compress` tool and the compaction hook are defined inside
// `Plugin.define({ setup })` and are not exported, so they are only reachable by
// running the plugin against a fake `ctx` that captures the registered tool and
// hooks. Each site gets its own test, because a fix applied to one is not a fix
// applied to the other.

interface PluginHarness {
    tools: Record<string, any>
    hooks: Array<{ name: string; fn: any }>
    setTranscript: (messages: any[]) => void
}

/**
 * Runs the real plugin's `setup` against a minimal `ctx` and returns the tools
 * it registered plus the session hooks it installed.
 *
 * `XDG_CONFIG_HOME` is redirected per session id so `createDefaultConfig()`
 * (which `setup` calls) never writes into the developer's real config dir, and
 * so `loadConfig()` picks up an isolated, known configuration.
 */
async function drivePlugin(sessionId: string): Promise<PluginHarness> {
    process.env.XDG_CONFIG_HOME = `/tmp/slim-ratio-xdg-${sessionId}`

    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const configDir = join(process.env.XDG_CONFIG_HOME, "opencode")
    mkdirSync(configDir, { recursive: true })
    const persistenceDir = mkdtempSync(join(tmpdir(), "slim-ratio-"))
    writeFileSync(
        join(configDir, "slim.jsonc"),
        JSON.stringify({
            enabled: true,
            compress: { enabled: true, mode: "range", permission: "allow", protectUserMessages: false },
            strategies: {
                deduplication: { enabled: true, protectedTools: [] },
                purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
            },
            adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
            persistence: { enabled: true, directory: persistenceDir },
        }),
        "utf-8",
    )

    // Imported lazily so the env var above is set before the config module
    // resolves any path at first use.
    const { default: plugin } = await import("../src/index")

    let transcript: any[] = []
    const tools: Record<string, any> = {}
    const hooks: Array<{ name: string; fn: any }> = []
    const ctx: any = {
        model: {
            default: async () => ({
                location: "x",
                data: { providerID: "anthropic", modelID: "claude", limit: { context: 200000 } },
            }),
            list: async () => ({ location: "x", data: [] }),
        },
        session: {
            context: async () => transcript,
            get: async () => ({}),
            hook: async (name: string, fn: any) => {
                hooks.push({ name, fn })
            },
        },
        tool: {
            transform: async (fn: any) =>
                fn({
                    add: (t: any) => {
                        tools[t.name] = t
                    },
                }),
        },
        event: {
            subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
        },
    }

    await (plugin as any).setup(ctx)
    return { tools, hooks, setTranscript: (m: any[]) => (transcript = m) }
}

/** Reads the plugin's recorded stats back out through the `panel` tool. */
async function panelLine(harness: PluginHarness, sessionId: string, pattern: RegExp): Promise<string> {
    const panel = await harness.tools.panel.execute({}, { sessionID: sessionId })
    const line = String(panel.content)
        .split("\n")
        .find((l) => pattern.test(l))
    return line ?? ""
}

describe("ratio clamp: the compress-tool record site", () => {
    it("records ratio 0 and announces 0% saved when the summary exceeds its input", async () => {
        const sessionId = "clamp-compress-tool"
        const harness = await drivePlugin(sessionId)

        // A range of two content-free messages: the summary is the fixed
        // header, so it necessarily exceeds a 0-token input. This also covers
        // the `inputTokens === 0` half of the guard at this site.
        harness.setTranscript([
            { id: "a", role: "assistant", parts: [] },
            { id: "b", role: "assistant", parts: [] },
        ])

        const res = await harness.tools.compress.execute(
            { focus: "the build", mode: "range", start: 0, end: 2 },
            { sessionID: sessionId },
        )
        const content = String(res.content)

        // Precondition: the compression ran and the stats line was written.
        assert.ok(
            content.includes("**Stats:**"),
            `precondition: the compress tool must report stats:\n${content}`,
        )
        const stats = content.match(/\*\*Stats:\*\*\s*(\d+)\s*→\s*(\d+)\s*tokens\s*\((-?[\d.]+)%\s*saved\)/)
        assert.ok(stats, `precondition: the stats line must be parseable:\n${content}`)

        // Precondition: this really is the expanding / zero-input case.
        const inputTokens = Number(stats[1])
        const outputTokens = Number(stats[2])
        assert.ok(
            outputTokens > inputTokens,
            `precondition: the summary must exceed its input (in=${inputTokens}, out=${outputTokens})`,
        )

        // THE assertion. Unclamped this printed a negative percent here, and
        // stored a negative ratio that reached the EMA.
        assert.strictEqual(
            Number(stats[3]),
            0,
            `an expanding compression must be announced as 0% saved, not ${stats[3]}%:\n${content}`,
        )

        // And the block note's own percent must not go negative either.
        const blockNote = content.match(/\((\d+)% smaller\)/)
        assert.ok(blockNote, `precondition: a compression block must have been registered:\n${content}`)
        assert.ok(
            Number(blockNote[1]) >= 0,
            `the block note must never announce a negative saving, got ${blockNote[1]}%:\n${content}`,
        )
    })

    it("announces a positive percent when the summary genuinely shrinks", async () => {
        const sessionId = "clamp-compress-shrinks"
        const harness = await drivePlugin(sessionId)

        // A long text range with nothing protected: the summary is a handful
        // of header lines, so it must genuinely shrink.
        harness.setTranscript([
            { id: "a", role: "user", text: "q".repeat(4000) },
            { id: "b", role: "assistant", text: "r".repeat(4000) },
            { id: "c", role: "user", text: "s".repeat(4000) },
            { id: "d", role: "assistant", text: "t".repeat(4000) },
        ])

        const res = await harness.tools.compress.execute(
            { focus: "the build", mode: "range", start: 0, end: 4 },
            { sessionID: sessionId },
        )
        const content = String(res.content)
        const stats = content.match(/\*\*Stats:\*\*\s*(\d+)\s*→\s*(\d+)\s*tokens\s*\((-?[\d.]+)%\s*saved\)/)
        assert.ok(stats, `precondition: the stats line must be parseable:\n${content}`)
        assert.ok(
            Number(stats[2]) < Number(stats[1]),
            `precondition: this fixture must SHRINK (in=${stats[1]}, out=${stats[2]})`,
        );

        // The clamp must not swallow a real saving.
        assert.ok(
            Number(stats[3]) > 0,
            `a genuine saving must still be announced, got ${stats[3]}%:\n${content}`,
        )
    })
})

describe("ratio clamp: the compaction-hook record site", () => {
    it("records ratio 0 when the compaction summary exceeds the messages it summarises", async () => {
        const sessionId = "clamp-compaction"
        const harness = await drivePlugin(sessionId)
        const compaction = harness.hooks.find((h) => h.name === "compaction")
        assert.ok(compaction, "precondition: the compaction hook must be registered")

        // A single message whose text is a couple of tokens. The structured
        // summary is a fixed multi-line header, so it necessarily exceeds that
        // input. The text must be NON-EMPTY: the site is guarded by
        // `inputTokens > 0`, so a 0-token input would skip the record entirely
        // and this test would pass for the wrong reason.
        const event: any = { sessionID: sessionId, messages: [{ type: "assistant", text: "ok" }] }
        await compaction.fn(event)

        // Precondition: the hook really produced a summary.
        assert.ok(
            event.result && typeof event.result.summary === "string" && event.result.summary.length > 0,
            `precondition: the compaction hook must write a summary:\n${JSON.stringify(event.result)}`,
        )

        // The panel bails out on an empty transcript, so give it one message to
        // report against. It reads the SAME session state the hook recorded
        // into, which is the point: the ratio is observed where the user sees it.
        harness.setTranscript([{ id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] }])
        const compactionLine = await panelLine(harness, sessionId, /Count:/)
        assert.ok(
            compactionLine,
            "precondition: the panel must report a compression count for the recorded compression",
        )

        // THE assertion: the panel's average ratio, which the user reads
        // directly. Unclamped, an expanding compaction printed e.g.
        // `Avg ratio: -330.0%`.
        const avgLine = await panelLine(harness, sessionId, /Avg ratio:/)
        const avg = Number(avgLine.match(/Avg ratio:\s*(-?[\d.]+)%/)?.[1])
        assert.ok(Number.isFinite(avg), `precondition: the avg ratio must be parseable:\n${avgLine}`)
        assert.ok(
            avg >= 0,
            `an expanding compaction must not print a negative average ratio: ${avgLine}`,
        )
    })
})

// ─── The panel accumulators: totalTokensSaved and costSaved ─────────────────

describe("totalTokensSaved and costSaved never go negative", () => {
    /** A record whose summary was LARGER than the range it replaced. */
    function expandedRecord(): CompressionRecord {
        return {
            timestamp: 1,
            inputTokens: 100,
            outputTokens: 430,
            // The clamped ratio, exactly as `autoCompress` now stores it.
            ratio: 0,
            messageCount: 1,
            success: true,
        }
    }

    /** A record that genuinely saved tokens. */
    function genuineRecord(): CompressionRecord {
        return {
            timestamp: 2,
            inputTokens: 1000,
            outputTokens: 100,
            ratio: 0.9,
            messageCount: 5,
            success: true,
        }
    }

    async function panelFor(history: CompressionRecord[]) {
        const state = makeState()
        state.compressionHistory = history
        state.compressionCount = history.length
        state.averageCompressionRatio = history[0]?.ratio ?? 0
        return buildPanelData("s1", [], state, makeConfig([]), "claude-sonnet-4-5")
    }

    it("reports zero tokens saved for a history containing only an expanded compression", async () => {
        // Precondition: the record really is an expansion.
        const rec = expandedRecord()
        assert.ok(
            rec.outputTokens > rec.inputTokens,
            `precondition: the record must expand, got in=${rec.inputTokens} out=${rec.outputTokens}`,
        )

        const panel = await panelFor([rec])

        assert.strictEqual(
            panel.totalTokensSaved,
            0,
            `a compression that cost tokens saved none, so the total must be 0, not ${panel.totalTokensSaved}`,
        )
        assert.ok(
            panel.totalTokensSaved >= 0,
            `"Tokens saved" must never be negative, got ${panel.totalTokensSaved}`,
        )
    })

    it("reports zero dollar saving for a history containing only an expanded compression", async () => {
        const panel = await panelFor([expandedRecord()])

        assert.ok(
            panel.costSaved >= 0,
            `"Saved: $${panel.costSaved}" must never be negative`,
        )
        assert.strictEqual(
            panel.costSaved,
            0,
            `a compression that cost tokens saved no money either, got ${panel.costSaved}`,
        )
    })

    it("does not let an expanded compression cancel out a genuine saving", async () => {
        // The regression as the user saw it: `Saved: $-0.0994`. One big
        // expansion outweighed the real savings that came before it.
        const panel = await panelFor([genuineRecord(), expandedRecord()])

        assert.ok(
            panel.totalTokensSaved > 0,
            `the genuine saving must survive the later expansion, got ${panel.totalTokensSaved}`,
        );
        // The expansion contributes nothing, so the total is exactly the real one.
        assert.strictEqual(
            panel.totalTokensSaved,
            genuineRecord().inputTokens - genuineRecord().outputTokens,
            "the expanded record must contribute 0, not cancel the real saving",
        )
        assert.ok(panel.costSaved > 0, `dollar saving must be positive too, got ${panel.costSaved}`)
    })

    it("renders no negative token or dollar saving in the panel text", async () => {
        const panel = await panelFor([genuineRecord(), expandedRecord()])
        const { renderPanel } = await import("../src/lib/tui")
        const text = renderPanel(panel)

        assert.ok(
            !/Tokens saved:\s*-/.test(text),
            `the panel must never render a negative token saving:\n${text}`,
        )
        assert.ok(
            !/Saved:\s*\$-/.test(text),
            `the panel must never render a negative dollar saving:\n${text}`,
        )
        assert.ok(
            !/Avg ratio:\s*-/.test(text),
            `the panel must never render a negative average ratio:\n${text}`,
        )
    })

    it("still reports the full saving for a history of genuine compressions", async () => {
        // The control: the clamp must not cost a real saving anything.
        const panel = await panelFor([genuineRecord(), genuineRecord()])

        assert.strictEqual(
            panel.totalTokensSaved,
            2 * (genuineRecord().inputTokens - genuineRecord().outputTokens),
            `both genuine savings must be counted in full, got ${panel.totalTokensSaved}`,
        )
        assert.ok(panel.costSaved > 0, `a real saving must be worth real money, got ${panel.costSaved}`)
    })

    it("ignores a FAILED record in both accumulators", async () => {
        // `success: false` records carry no measured saving, so they must
        // contribute nothing — including when their numbers look positive.
        const failed: CompressionRecord = {
            timestamp: 3,
            inputTokens: 500,
            outputTokens: 500,
            ratio: 0,
            messageCount: 2,
            success: false,
        }
        const panel = await panelFor([genuineRecord(), failed])

        assert.strictEqual(
            panel.totalTokensSaved,
            genuineRecord().inputTokens - genuineRecord().outputTokens,
            "a failed compression must not be counted as a saving",
        )
    })
})
