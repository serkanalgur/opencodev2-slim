import { describe, it } from "node:test"
import assert from "node:assert"
import { renderPanel, buildPanelData } from "../src/lib/tui"
import type { PanelData } from "../src/lib/tui"
import type { SessionState, SlimConfig } from "../src/lib/types"

// ─── Does the width sweep actually reach the branches it claims? ───────────
//
// `ALLOWED_OVERFLOW` in tests/test.ts is EMPTY: every line the panel can emit
// now fits the 63-column frame. That is true of the three rendered from
// unbounded server- or user-supplied strings (a model id, a topic name, free
// text) because each is now ELIDED through `fitValue` — a visible marker in
// the middle for the model id, which a reader recognises by both the provider
// and the model name, and at the end for topic names and recommendations — and
// true of every NUMERIC magnitude, which was always inside the frame. An empty
// allowlist is only
// an honest claim if the sweep that produces it really renders every line the
// panel can emit. A sweep that silently skips a branch proves nothing about that
// branch: the guard would be green while the line it never rendered overflowed
// freely.
//
// This file does not re-assert the width. It asserts COVERAGE — that the
// fixtures driving the sweep reach each conditional line in `renderPanel` — so
// the no-overflow claim is a statement about the whole panel rather than about
// whichever lines the sweep happened to construct.
//
// The conditional lines in `renderPanel`, each guarded by a field:
//   Source:            data.tokenSource
//   Lifetime:          data.cumulativeTokens > data.currentTokens
//   Trigger:           data.threshold
//   Prune:             data.prune
//   Top Topics:        data.topics.length > 0
//   Recommendations:   always rendered (the header), entries per data.recommendations
//   Last:              data.lastCompression
// plus the `window unknown` branch of the Trigger line, which is the one
// shape where the percentage is omitted and a loose matcher would not notice.

/** Display width in terminal cells; every glyph the panel uses is single-width. */
function displayWidth(line: string): number {
    return [...line].length
}

const FRAME = 63

function panelData(overrides: Partial<PanelData> = {}): PanelData {
    return {
        sessionId: "coverage",
        timestamp: 0,
        currentTokens: 1_000,
        maxTokens: 200_000,
        usagePercent: 50,
        status: "healthy",
        messageCount: 2,
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        tokensByRole: { user: 100, assistant: 200, tools: 0, system: 0 },
        compressionCount: 0,
        averageRatio: 0,
        totalTokensSaved: 0,
        lastCompression: null,
        estimatedCost: 0,
        costSaved: 0,
        model: "test-model",
        topics: [{ topic: "general", count: 1, tokens: 10 }],
        recommendations: [],
        threshold: {
            tokens: 150_000,
            percent: 75,
            minTokens: 100_000,
            minPercent: 50,
            contextLimit: 200_000,
        },
        ...overrides,
    }
}

describe("Panel width sweep: the fixture reaches every conditional line", () => {
    it("renders the Source, Lifetime, Trigger, Prune, Topics, Last and Recommendations lines", () => {
        // One fixture with EVERY conditional field populated. If any of these
        // lines is missing from the render, the field name that gates it is
        // wrong, renamed, or the branch is unreachable — and in every one of
        // those cases the width sweep in tests/test.ts is blind to that line,
        // so any over-wide line beyond the three allowlisted unbounded-text
        // sections would not be caught by that guard.
        const data = panelData({
            tokenSource: "measured",
            cumulativeTokens: 56_100_000,
            prune: { enabled: true, prunedOutputs: 50, charsSaved: 1_200_000 },
            lastCompression: { timestamp: 0, ratio: 0.5, tokensSaved: 1_000 },
            recommendations: ["Context is healthy. No action needed."],
        })
        const lines = renderPanel(data).split("\n");

        const expected: [string, string][] = [
            ["Source:", "data.tokenSource gates the provenance line"],
            ["Lifetime:", "data.cumulativeTokens > currentTokens gates the lifetime line"],
            ["Trigger:", "data.threshold gates the threshold block"],
            ["floor", "the floor is part of the threshold block"],
            ["Prune:", "data.prune gates the prune block"],
            ["Top Topics:", "data.topics.length > 0 gates the topics block"],
            ["Recommendations:", "the recommendations header is unconditional"],
            ["Last:", "data.lastCompression gates the 'last compression' line"],
        ]
        for (const [label, why] of expected) {
            assert.ok(
                lines.some((line) => line.includes(label)),
                `the fully-populated fixture must render a ${label} line — ${why}. If it does not, ` +
                    `the width sweep never measures that line:\n${lines}`,
            )
        }
    })

    it("renders the trigger's 'window unknown' branch, the one shape a percentage matcher would miss", () => {
        // `percent: null` is a real state — a model with no reported context
        // limit — and it renders a DIFFERENT sentence ("window unknown" instead
        // of "N% of M window"). A sweep that only ever set `percent` would never
        // measure this branch, and the `· floor` split is exactly the line whose
        // width differs between the two shapes.
        const withWindow = renderPanel(panelData())
        const withoutWindow = renderPanel(
            panelData({
                threshold: {
                    tokens: 8_000_000,
                    percent: null,
                    minTokens: 4_000_000,
                    minPercent: null,
                    contextLimit: 0,
                },
            }),
        )

        assert.ok(
            withWindow.includes("% of") && withWindow.includes("window)"),
            `precondition: the windowed branch must render a percentage and a window size:\n${withWindow}`,
        )
        for (const [label, rendered] of [
            ["windowed", withWindow],
            ["windowless", withoutWindow],
        ] as const) {
            assert.ok(
                rendered.includes("Trigger:"),
                `precondition: the ${label} branch must render a Trigger line:\n${rendered}`,
            );
            assert.ok(
                rendered.includes("floor"),
                `precondition: the ${label} branch must render the floor continuation line:\n${rendered}`,
            );
            for (const line of rendered.split("\n")) {
                assert.ok(
                    displayWidth(line) <= FRAME,
                    `the ${label} trigger branch overflows: ${displayWidth(line)} columns: ` +
                        `${JSON.stringify(line)}`,
                )
            }
        }

        assert.ok(
            withoutWindow.includes("window unknown"),
            `the windowless branch must say so, or this test is measuring one shape twice:\n${withoutWindow}`,
        )
        assert.ok(
            !withoutWindow.includes("% of"),
            "the windowless branch must omit the percentage, or it is the same shape as the windowed one",
        )
    })

    it("keeps the allowlist honest: no swept numeric line overflows across every conditional branch at worst-case magnitudes", () => {
        // A coverage-complete sweep, not a re-run of the one in tests/test.ts.
        // Each entry turns ON a different conditional line while pushing every
        // magnitude to the widest value `formatTokens` can return, so a line
        // that only appears under, say, `lastCompression` is measured at the
        // magnitude that would break it rather than at a comfortable one.
        const worst = Number.MAX_SAFE_INTEGER;
        const branches: [string, Partial<PanelData>][] = [
            ["bare", {}],
            ["Source: estimated", { tokenSource: "estimated" }],
            [
                "Source + Lifetime",
                {
                    tokenSource: "measured",
                    // The lifetime line is gated on cumulative > current, so the
                    // current figure must be pushed BELOW it or the branch is
                    // never taken and the line is never measured.
                    currentTokens: 1_000,
                    cumulativeTokens: worst,
                    totalTokensSaved: worst,
                },
            ],
            [
                "threshold, widest",
                {
                    threshold: {
                        tokens: worst,
                        percent: 1234.5,
                        minTokens: worst,
                        minPercent: 1234.4,
                        contextLimit: worst,
                    },
                    cumulativeTokens: worst,
                },
            ],
            ["threshold, no window", {
                threshold: { tokens: worst, percent: null, minTokens: worst, minPercent: null, contextLimit: 0 },
            }],
            [
                "prune, widest",
                { prune: { enabled: true, prunedOutputs: 999_999, charsSaved: worst } },
            ],
            [
                "topics, widest",
                {
                    topics: Array.from({ length: 5 }, (_, i) => ({
                        topic: `topic${i}`,
                        count: 999_999,
                        tokens: worst,
                    })),
                },
            ],
            [
                "last compression, widest",
                { lastCompression: { timestamp: 0, ratio: 0, tokensSaved: worst } },
            ],
            [
                "every recommendation, widest",
                { recommendations: ["Context is healthy. No action needed."] },
            ],
        ]

        const rendered: string[] = []
        for (const [label, overrides] of branches) {
            const data = panelData({
                currentTokens: worst,
                usagePercent: 99.9,
                status: "critical",
                ...overrides,
            })
            for (const line of renderPanel(data).split("\n")) {
                if (displayWidth(line) > FRAME) {
                    assert.fail(
                        `the ${label} branch overflows the ${FRAME}-column frame: ` +
                            `${displayWidth(line)} columns: ${JSON.stringify(line)}`,
                    )
                }
                rendered.push(line)
            }
        }

        // Coverage, asserted on the OUTPUT rather than on the fixture: a branch
        // whose field name was renamed would render nothing here, and the width
        // assertion above would pass over an unmeasured panel.
        const output = rendered.join("\n");
        for (const label of [
            "Source:",
            "Lifetime:",
            "Trigger:",
            "Prune:",
            "Top Topics:",
            "Last:",
            "Recommendations:",
            "Compression Stats:",
            "Cost Estimate:",
            "Token Distribution:",
        ]) {
            assert.ok(
                output.includes(label),
                `the sweep must actually render a ${label} line somewhere, or the overflow ` +
                    `allowlist is only honest about the branches it happened to reach`,
            )
        }
    })
})

// ─── generateRecommendations: what the width test does and does not pin ─────
//
// The four recommendation strings were shortened this session so that the
// `Recommendations` lines fit the frame WITHOUT relying on elision — the
// wording production emits is expected to fit on its own, and elision is the
// safety net for input that does not (an unbounded free-text value from
// anywhere else). The ONLY assertions
// on their length are
// fragment regexes in the width test (`/Consider compressing/`,
// `/truncation/`, `/Deduplication/`, `/No compressions yet/`). That is enough
// to catch a line growing too long. It is NOT enough to catch a reword that
// keeps the meaning and drops a fact, because the dropped word is exactly the
// word the fragment does not mention.
//
// These tests pin the full strings, so the honest statement about coverage is
// "the wording is pinned verbatim" rather than "a reword would be caught".

function recConfig(): SlimConfig {
    return {
        enabled: true,
        debug: false,
        compress: {
            enabled: true,
            mode: "range",
            permission: "allow",
            maxContextLimit: 150_000,
            minContextLimit: 80_000,
            nudgeFrequency: 5,
            protectUserMessages: false,
            protectedTools: [],
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
            turnProtection: { enabled: true, turns: 4 },
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: true, directory: "/tmp/slim-rec-test" },
    }
}

/**
 * A minimal SessionState, field-for-field the shape the rest of the suite uses
 * (`makeState` in tests/test.ts). `buildPanelData` reads the compression
 * history and the tool-call map, so both must be real containers — a partial
 * stand-in throws rather than reporting, which would make the test fail for the
 * wrong reason.
 */
function recState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: "rec",
        modelContextLimit: 200_000,
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
        ...overrides,
    }
}

/** A transcript of `n` tiny messages — cheap, and enough to move the counts. */
function transcript(n: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
        info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant" },
        parts: [{ type: "text", text: "hi" }],
    })) as any[]
}

/**
 * One message carrying a large body, so the estimated prompt size is big
 * relative to a deliberately small window. `buildPanelData` derives occupancy
 * from a real token count over the transcript, so reaching >90% needs EITHER a
 * large prompt or a tiny window; a 1000-token window against two short
 * messages is nowhere near enough on its own.
 */
function hugeTranscript(): any[] {
    return [
        { info: { id: "big", role: "user" }, parts: [{ type: "text", text: "x".repeat(4_000) }] },
    ] as any[]
}

describe("generateRecommendations: the full wording, not just the width fragments", () => {
    it("states every recommendation verbatim, so a meaning-preserving reword that drops a fact fails", async () => {
        // The gap this closes. The width test matches fragments, so this
        // sequence of four rewords would all pass it while each drops a fact a
        // reader relies on:
        //
        //   "Consider compressing OLD messages" -> "…messages"   (loses WHICH)
        //   "to avoid truncation"               -> dropped       (loses WHY)
        //   "No compressions yet"               -> kept, but the "many messages"
        //                                            condition is gone from the text
        //   "Deduplication may help"            -> "may help further" dropped
        //
        // Pinning the full string makes any reword a deliberate, visible change
        // rather than a silent one, which is the same standard the README-drift
        // test applies to the panel lines above.
        // Occupancy is the estimated prompt size over the model window, so
        // reaching >90% needs a prompt that is genuinely large against a
        // deliberately small window. This is the same technique the width test
        // in tests/test.ts uses, and the precondition below asserts the
        // scenario really crossed the line rather than assuming it did.
        const highUsage = await buildPanelData(
            "high",
            hugeTranscript(),
            recState({ modelContextLimit: 500 }),
            recConfig(),
            "test-model",
        )
        assert.ok(
            highUsage.usagePercent > 90,
            `precondition: this scenario must really be over 90%, got ${highUsage.usagePercent}`,
        )

        // 51 messages, not 60: the threshold is `> 50`, and the margin over it
        // costs nothing here. The transcript is short per message, so the real
        // tokenizer's O(chars) cost stays small. 4000 characters over a 1000-token
        // the high-usage scenario above tokenizes 8k characters, and dropping
        // that below the "Context usage is high" threshold is what would make it
        // fast enough to skip the check entirely.
        const manyMessages = await buildPanelData(
            "many",
            transcript(51) as any,
            recState(),
            recConfig(),
            "test-model",
        )
        assert.strictEqual(
            manyMessages.messageCount,
            51,
            "precondition: the many-messages scenario must carry 51 messages",
        )
        assert.ok(
            manyMessages.usagePercent < 50,
            `precondition: this scenario must be under 50% occupancy, got ${manyMessages.usagePercent}`,
        )
        assert.ok(
            manyMessages.messageCount > 50,
            `precondition: this transcript must clear the 50-message threshold, or the ` +
                "deduplication line is not reachable and this asserts the wrong set (got " +
                `${manyMessages.messageCount})`,
        )

        // A precondition on the SCENARIO, so the expectation below is a fact
        // about these two strings rather than about whatever a one-message
        // transcript happens to trigger.
        assert.ok(
            highUsage.messageCount <= 20,
            `precondition: the high-usage transcript must stay under the 20-message threshold, ` +
                `or the no-compression line joins these and this asserts the wrong set (got ` +
                `${highUsage.messageCount})`,
        )
        assert.deepStrictEqual(
            highUsage.recommendations.slice().sort(),
            [
                "Context nearly full! Run compress to avoid truncation.",
                "Context usage is high. Consider compressing old messages.",
            ].sort(),
            "the high-usage wording is pinned verbatim: WHICH messages to compress ('old', not " +
                "just 'messages') and the truncation consequence must both survive a reword",
        )
        // Exactly TWO, and no "healthy" fallback: the fallback only appears when
        // `recs` is empty, so including it here would assert a fourth string
        // that this scenario cannot produce. It is pinned in the next test.
        assert.deepStrictEqual(
            manyMessages.recommendations.slice().sort(),
            [
                "Many messages but low usage. Deduplication may help.",
                "No compressions yet. Consider running compress.",
            ].sort(),
            "the low-usage wording is pinned verbatim too: the deduplication hint is a distinct " +
                "recommendation from the no-compression one and must not be merged into or dropped " +
                "alongside it",
        )
    })

    it("emits no recommendation at all for a small, uncompressed, low-usage transcript", async () => {
        // The `Context is healthy.` fallback is the fifth string, and the only
        // one the width test does not reach. It is the line a user sees most
        // often, so it is pinned here rather than left to the fragment regexes.
        const panel = await buildPanelData(
            "small",
            transcript(2) as any,
            recState(),
            recConfig(),
            "test-model",
        )
        assert.ok(
            panel.messageCount <= 20,
            `precondition: this transcript must be under the 20-message threshold, got ` +
                `${panel.messageCount}`,
        )
        assert.ok(
            panel.usagePercent < 80,
            `precondition: occupancy must be under 80%, got ${panel.usagePercent}`,
        )
        assert.deepStrictEqual(
            panel.recommendations,
            ["Context is healthy. No action needed."],
            "with nothing to flag the panel says exactly that, and nothing else",
        )
    })
})
