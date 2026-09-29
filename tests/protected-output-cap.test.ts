import { describe, it } from "node:test"
import assert from "node:assert"
import { buildCompressionSummary } from "../src/lib/strategies"
import { countTokens, getMessageText, getToolResultContent } from "../src/lib/compress"
import type { MessageWithParts } from "../src/lib/types"

// ─── The "### Protected Tool Outputs" cap ───────────────────────────────────
//
// Regression class this section exists for: an UNCAPPED section, on the
// DEFAULT path. Every other section of `buildCompressionSummary` is bounded by
// construction (Tool Calls 10, Errors 5, Decisions 5), but the protected-output
// section took one entry per protected tool call, each carrying up to 1000
// chars of input PLUS up to 2000 chars of output — and both the entry count
// and the per-entry size are set by the transcript, not by the caller.
//
// The section only became reachable recently. Before the `pairingIdOf` id fix
// the result was matched by a legacy key that does not exist on the v2 hook
// shape, so no `output:` half was ever emitted and the section was effectively
// empty. Fixing the id therefore REVIVED the section — and reviving it
// uncapped made a summary as large as (or larger than) the range it replaces: a
// net context INCREASE in a plugin whose purpose is context reduction, and
// unlike the purge change it is gated behind no feature flag at all.
//
// Two bounds, because either alone is insufficient:
//   - MAX_LINES (20) bounds the entry COUNT. Without it a 200-pair range emits
//     200 entries, and the count alone dominates the summary.
//   - MAX_CHARS (8000) bounds the section's LENGTH. A count cap cannot help on
//     its own: one 2000-char output is 100x a header line, so a handful of
//     entries already exceed any sane per-section budget.
//
// Every test below asserts its own preconditions (the fixture really does
// carry the protected calls, the summary really does contain the section) so
// that a test cannot pass because the section was never emitted at all.

/** The section header `buildCompressionSummary` writes. */
const HEADER = "### Protected Tool Outputs"

/**
 * The bound on the whole section, mirrored here rather than imported: the
 * constants are module-private, and a test that imported them could not detect
 * someone RAISING them. Re-declaring the intended value is what makes the
 * mutation in the verification pass fail.
 */
const SECTION_MAX_LINES = 20
const SECTION_MAX_CHARS = 8000

/** The per-entry output slice, which is what stops one fat entry starving the rest. */
const OUTPUT_SLICE = 2000

/** The per-entry input slice. */
const INPUT_SLICE = 1000

function mwp(id: string, role: string, parts: any[]): any {
    return { info: { id, role, sessionID: "s1", time: { created: 0 } }, parts }
}

/**
 * A transcript carrying `n` protected `bash` pairs, each with an output of
 * `outLen` chars. Every pair is on the v2 hook shape: the call and the result
 * share one `id` and carry no legacy key, which is the shape production
 * actually delivers and the one `pairingIdOf` pairs on.
 */
function protectedTranscript(n: number, outLen = 40): any[] {
    const messages: any[] = [mwp("u", "user", [{ type: "text", text: "run them" }])]
    for (let i = 0; i < n; i++) {
        messages.push(
            mwp(`c${i}`, "assistant", [
                { type: "tool-call", id: `call_${i}`, name: "bash", input: { command: `echo ${i}` } },
            ]),
        )
        messages.push(
            mwp(`r${i}`, "tool", [
                {
                    type: "tool-result",
                    id: `call_${i}`,
                    name: "bash",
                    result: { type: "text", value: String(i % 10).repeat(outLen) },
                },
            ]),
        )
    }
    return messages
}

/**
 * A transcript of protected pairs with a per-entry output size, given in
 * order. Lets a test place a fat entry at a chosen position rather than
 * assuming the entries are uniform.
 */
function sizedTranscript(outLens: number[]): any[] {
    const messages: any[] = [mwp("u", "user", [{ type: "text", text: "run them" }])]
    outLens.forEach((len, i) => {
        messages.push(
            mwp(`c${i}`, "assistant", [
                { type: "tool-call", id: `call_${i}`, name: "bash", input: { command: `echo ${i}` } },
            ]),
        )
        messages.push(
            mwp(`r${i}`, "tool", [
                {
                    type: "tool-result",
                    id: `call_${i}`,
                    name: "bash",
                    result: { type: "text", value: String(i % 10).repeat(len) },
                },
            ]),
        )
    })
    return messages
}

/** Just the protected section of a summary, or "" when it is absent. */
function sectionOf(summary: string): string {
    const at = summary.indexOf(HEADER)
    return at === -1 ? "" : summary.slice(at)
}

/** The `- [tool]` entry lines in a section (the omission notice is not one). */
function entryLines(section: string): string[] {
    return section.split("\n").filter((line) => line.startsWith("- ["))
}

/**
 * The count in the omission notice, or 0 when there is none. A singular
 * "output" and a plural "outputs" are both accepted so a test fails on the
 * NUMBER being wrong, not on a wording choice.
 */
function omittedCount(section: string): number {
    const m = section.match(/…\s*(\d+)\s+more protected tool outputs? omitted/)
    return m ? Number(m[1]) : 0
}

/** The unique payload markers of the outputs that actually made it in. */
function includedOutputMarkers(section: string): string[] {
    // Each entry's `output:` half begins with a distinct digit (the value is
    // `String(i % 10).repeat(len)`), so the first char of the output half
    // identifies the entry without depending on the exact slice length.
    const found: string[] = []
    for (const line of section.split("\n")) {
        const m = line.match(/^\s+output:\s(.)/)
        if (m) found.push(m[1])
    }
    return found
}

// ─── The line cap: exactly 20 entries in, 21 entries one short ──────────────

describe("buildCompressionSummary: the protected-output line cap", () => {
    it("includes all 20 entries and writes no omission notice at exactly the cap", async () => {
        const summary = await buildCompressionSummary(
            protectedTranscript(SECTION_MAX_LINES) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        // Precondition: the section is actually present, so "20 entries, no
        // notice" cannot be satisfied by the section being missing entirely.
        assert.ok(
            summary.includes(HEADER),
            `precondition: the section must be present at the cap:\n${summary}`,
        )
        const section = sectionOf(summary)
        assert.strictEqual(
            entryLines(section).length,
            SECTION_MAX_LINES,
            `all ${SECTION_MAX_LINES} entries fit and every one must be kept:\n${section}`,
        )
        assert.strictEqual(
            omittedCount(section),
            0,
            `nothing was dropped, so an omission notice would be a lie:\n${section}`,
        )
        assert.ok(
            !section.includes("omitted"),
            `the notice line must be absent entirely when the count is honest at zero:\n${section}`,
        )
    })

    it("keeps 20 and omits exactly 1 at one entry over the cap", async () => {
        const total = SECTION_MAX_LINES + 1
        const summary = await buildCompressionSummary(
            protectedTranscript(total) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`)
        assert.strictEqual(
            entryLines(section).length,
            SECTION_MAX_LINES,
            `the cap must hold at ${total} entries:\n${section}`,
        )
        assert.strictEqual(
            omittedCount(section),
            1,
            `the notice must report the ONE entry that was actually dropped:\n${section}`,
        )
    })

    it("reports an accurate omission count at every size past the cap", async () => {
        // The count is derived by the same loop that drops the entries, so it
        // must equal `total - included` at EVERY size, not just at total+1.
        for (const total of [SECTION_MAX_LINES + 1, SECTION_MAX_LINES + 2, SECTION_MAX_LINES + 9]) {
            const summary = await buildCompressionSummary(
                protectedTranscript(total) as MessageWithParts[],
                "the build",
                ["bash"],
            )
            const section = sectionOf(summary)
            const included = entryLines(section).length
            assert.ok(
                included <= SECTION_MAX_LINES,
                `precondition at total=${total}: the cap must hold, got ${included}`,
            )
            assert.strictEqual(
                omittedCount(section),
                total - included,
                `at total=${total} the notice must account for every dropped entry ` +
                    `(${total} - ${included} kept), not just the ones past the cap`,
            )
        }
    })
})

// ─── The char budget: length is bounded independently of the count ─────────

describe("buildCompressionSummary: the protected-output char budget", () => {
    it("keeps the whole section while the entries stay under the char budget", async () => {
        // 6 entries x 1000-char outputs: well under the count cap AND under
        // the char budget, so neither cap may fire. Establishes that truncation
        // is not unconditional — a section that genuinely fits is untouched.
        const outLens = new Array(6).fill(1000)
        const summary = await buildCompressionSummary(
            sizedTranscript(outLens) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`)
        assert.strictEqual(
            entryLines(section).length,
            outLens.length,
            `every entry fits under the budget and must survive:\n${section}`,
        )
        assert.strictEqual(omittedCount(section), 0, `nothing may be dropped:\n${section}`);
        // And the fixture really was under the budget, so this is not passing
        // because the cap was too lax to notice.
        const bodyLength = section.split("\n").join("\n").length
        assert.ok(
            bodyLength < SECTION_MAX_CHARS,
            `precondition: the section must genuinely fit the budget, got ${bodyLength}`,
        )
    })

    it("truncates the section once fat outputs exceed the char budget, with an honest count", async () => {
        // 30 entries x 2000-char outputs: far past the char budget while the
        // count is still under the LINE cap's reach, so only the char budget
        // can be responsible for the truncation.
        const outLens = new Array(30).fill(OUTPUT_SLICE)
        const summary = await buildCompressionSummary(
            sizedTranscript(outLens) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`)
        const included = entryLines(section).length
        assert.ok(
            included < outLens.length,
            `precondition: the char budget must actually have truncated (${included}/${outLens.length} kept)`,
        );
        // The budget is what keeps the section a summary; a length assertion
        // alone would pass on any cap, so the count is checked too.
        const bodyLength = section.split("\n").filter((l) => !l.startsWith("…")).join("\n").length
        assert.ok(
            bodyLength <= SECTION_MAX_CHARS,
            `the section body must fit the char budget, got ${bodyLength}:\n${section}`,
        )
        assert.strictEqual(
            omittedCount(section),
            outLens.length - included,
            `the notice must report every entry the char budget dropped, not just the ` +
                `ones past the line cap`,
        )
    })

    it("keeps the section under the char budget when a 2000-char output is added", async () => {
        // The specific case named in the cap's rationale: one large output is
        // 100x a header line, so a handful of entries can already exceed any
        // reasonable per-section budget. Without the char cap the section grows
        // with the transcript's fat outputs.
        const outLens = [...new Array(11).fill(900), OUTPUT_SLICE]
        const summary = await buildCompressionSummary(
            sizedTranscript(outLens) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        const included = entryLines(section).length
        const bodyLength = section.split("\n").filter((l) => !l.startsWith("…")).join("\n").length
        assert.ok(
            bodyLength <= SECTION_MAX_CHARS,
            `the char budget must hold with a ${OUTPUT_SLICE}-char output in it, got ${bodyLength}:\n${section}`,
        )
        assert.strictEqual(
            omittedCount(section),
            outLens.length - included,
            `the notice must stay honest once a fat output has been dropped:\n${section}`,
        )
    })
})

// ─── Both caps together: the count must reflect everything dropped ──────────

describe("buildCompressionSummary: both protected-output caps together", () => {
    it("counts entries dropped by the char budget AND the line cap in one total", async () => {
        // Five 2000-char entries first (which exhaust the char budget partway
        // through) then 30 small ones (which then overflow the line cap). Both
        // caps drop entries, and the notice must report BOTH sets — a counter
        // that only tracked one cap would under-report.
        const outLens = [...new Array(5).fill(OUTPUT_SLICE), ...new Array(30).fill(10)]
        const total = outLens.length
        const summary = await buildCompressionSummary(
            sizedTranscript(outLens) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`)
        const included = entryLines(section).length

        // Preconditions that BOTH caps engaged, so the test is not passing on
        // one cap alone:
        assert.strictEqual(
            included,
            SECTION_MAX_LINES,
            `precondition: the LINE cap must be what bounds the count here (${included} kept)`,
        );
        const charBudgetAlone = outLens.filter((l) => l <= 40).length
        assert.ok(
            charBudgetAlone > SECTION_MAX_LINES,
            `precondition: the char budget must have dropped fat entries before the ` +
                `line cap was reached, else only one cap is under test`,
        );
        assert.strictEqual(
            omittedCount(section),
            total - included,
            `the notice must account for the ${total - included} entries dropped by BOTH caps`,
        )
    })
})

// ─── One fat entry must not starve the rest ────────────────────────────────

describe("buildCompressionSummary: a single fat output cannot monopolise the section", () => {
    it("keeps the entries after a 2000-char output instead of dropping them", async () => {
        // The per-entry output slice is the mechanism: without it the fat entry
        // alone would exceed the whole budget, be dropped, and — because the
        // budget is spent as entries are walked — starve every later entry.
        const outLens = [OUTPUT_SLICE, ...new Array(5).fill(50)]
        const summary = await buildCompressionSummary(
            sizedTranscript(outLens) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`);
        // Entry 0 is the fat one (its payload marker is "0"); entries 1..5 are
        // the small ones that must not be starved.
        const included = includedOutputMarkers(section);
        assert.strictEqual(
            included.length,
            outLens.length,
            `no entry may be starved by the fat one; kept ${JSON.stringify(included)}:\n${section}`,
        );
        for (const marker of ["1", "2", "3", "4", "5"]) {
            assert.ok(
                included.includes(marker),
                `the small entry ${marker} after the fat entry must survive:\n${section}`,
            )
        }
    })

    it("slices a single oversized output to the per-entry bound", async () => {
        // A 20 000-char output is 10x the per-entry slice. The section must
        // carry the SLICED output, not the whole thing, and must still fit the
        // char budget on its own.
        const summary = await buildCompressionSummary(
            sizedTranscript([20_000]) as MessageWithParts[],
            "the build",
            ["bash"],
        )

        const section = sectionOf(summary)
        assert.ok(section.includes(HEADER), `precondition: the section must be present:\n${section}`);
        const outputHalf = section.split("\n").find((l) => l.trimStart().startsWith("output:"))
        assert.ok(outputHalf, `precondition: the entry must carry an output half:\n${section}`)
        const outputText = outputHalf!.replace(/^\s*output:\s/, "")
        assert.ok(
            outputText.length <= OUTPUT_SLICE,
            `a single output must be sliced to ${OUTPUT_SLICE} chars, got ${outputText.length}`,
        );
        // And the section as a whole stays inside the budget even though the
        // raw output was 20 000 chars.
        const bodyLength = section.split("\n").filter((l) => !l.startsWith("…")).join("\n").length
        assert.ok(
            bodyLength <= SECTION_MAX_CHARS,
            `a single 20k output must not blow the char budget, got ${bodyLength}:\n${section}`,
        )
    })

    it("slices a single oversized input to the per-entry bound", async () => {
        // The input half has its own slice for the same reason. A 5000-char
        // command must not consume the budget the other entries need.
        const messages: any[] = [
            mwp("u", "user", [{ type: "text", text: "go" }]),
            mwp("c0", "assistant", [
                { type: "tool-call", id: "call_0", name: "bash", input: { command: "z".repeat(5000) } },
            ]),
            mwp("r0", "tool", [
                { type: "tool-result", id: "call_0", name: "bash", result: { type: "text", value: "small" } },
            ]),
        ]
        const summary = await buildCompressionSummary(messages as MessageWithParts[], "the build", ["bash"])

        const section = sectionOf(summary)
        const inputHalf = entryLines(section)[0].match(/input: (.*)$/)
        assert.ok(inputHalf, `precondition: the entry must carry an input half:\n${section}`)
        assert.ok(
            inputHalf[1].length <= INPUT_SLICE,
            `a single input must be sliced to ${INPUT_SLICE} chars, got ${inputHalf[1].length}`,
        )
    })
})

// ─── No protected tools: no section ─────────────────────────────────────────

describe("buildCompressionSummary: no protected tools means no section", () => {
    it("emits no protected section when protectedTools is empty", async () => {
        // Precondition: the SAME transcript DOES produce the section when the
        // tool is protected. Without this control the test would also pass if
        // the fixtures were simply not producing protected entries at all.
        const transcript = protectedTranscript(3) as MessageWithParts[]
        const protectedSummary = await buildCompressionSummary(transcript, "the build", ["bash"])
        assert.ok(
            protectedSummary.includes(HEADER),
            `control: the fixture must produce the section when the tool IS protected:\n${protectedSummary}`,
        )

        // A distinctive payload: the CALL INPUTS legitimately appear in the
        // separate "### Tool Calls" section regardless of `protectedTools`
        // (that section is about what was invoked, not what was preserved), so
        // the marker here is the tool OUTPUT, which only the protected section
        // can carry.
        const marker = "PROTECTEDPAYLOADMARKER"
        const withMarker: any[] = [
            mwp("u", "user", [{ type: "text", text: "go" }]),
            mwp("c0", "assistant", [
                { type: "tool-call", id: "call_0", name: "bash", input: { command: "echo hi" } },
            ]),
            mwp("r0", "tool", [
                {
                    type: "tool-result",
                    id: "call_0",
                    name: "bash",
                    result: { type: "text", value: marker },
                },
            ]),
        ]
        const protectedWithMarker = await buildCompressionSummary(
            withMarker as MessageWithParts[],
            "the build",
            ["bash"],
        )
        assert.ok(
            protectedWithMarker.includes(marker),
            `control: the payload must appear when the tool IS protected:\n${protectedWithMarker}`,
        )

        const summary = await buildCompressionSummary(
            withMarker as MessageWithParts[],
            "the build",
            [],
        )

        assert.ok(
            !summary.includes(HEADER),
            `an empty protectedTools list must yield no section at all:\n${summary}`,
        );
        // The protected output must not leak into the summary by another route.
        assert.ok(
            !summary.includes(marker),
            `with nothing protected the tool output must not be preserved verbatim:\n${summary}`,
        )
    })
})

// ─── End-to-end: the summary must be SMALLER than what it replaces ──────────
//
// This is the regression assertion for the whole class. Every other test above
// checks the cap's mechanics; this one checks the property the cap exists to
// protect, and it is the only assertion that would have caught the original
// defect on its own terms: a context-reduction plugin whose summary is bigger
// than the range it replaces is a net context INCREASE.

describe("buildCompressionSummary: a heavy protected-tool transcript still compresses", () => {
    it("produces fewer output tokens than the input tokens it replaces", async () => {
        // A `todoread`-heavy range: 60 protected pairs, each with a ~2.4k-char
        // output. This is the shape that made the uncapped section as large as
        // the range it summarised.
        const messages: any[] = []
        for (let i = 0; i < 60; i++) {
            messages.push(
                mwp(`c${i}`, "assistant", [
                    { type: "tool-call", id: `call_${i}`, name: "todoread", input: { i } },
                ]),
            )
            messages.push(
                mwp(`r${i}`, "tool", [
                    {
                        type: "tool-result",
                        id: `call_${i}`,
                        name: "todoread",
                        result: { type: "text", value: "abcdefgh ".repeat(300) },
                    },
                ]),
            )
        }

        // The input is measured exactly as `autoCompress` and the compress tool
        // measure it: per-message text + tool-result content, summed.
        let inputTokens = 0
        for (const msg of messages) {
            const m = msg as MessageWithParts
            inputTokens += await countTokens(getMessageText(m) + getToolResultContent(m))
        }
        const summary = await buildCompressionSummary(
            messages as MessageWithParts[],
            "old exploration",
            ["todoread"],
        )
        const outputTokens = await countTokens(summary)

        // Preconditions: the fixture is genuinely heavy on both sides, so a
        // small ratio here means real compression rather than a trivial range.
        assert.ok(
            inputTokens > 1000,
            `precondition: the range must be substantial, got ${inputTokens} input tokens`,
        );
        assert.ok(
            outputTokens > 0,
            `precondition: the summary must be non-empty, got ${outputTokens} tokens`,
        );

        // THE assertion. Uncapped, the section alone would carry 60 x ~2k chars
        // and the summary would EXCEED the range — a net context increase in a
        // plugin whose only job is to reduce context.
        assert.ok(
            outputTokens < inputTokens,
            `the summary must be smaller than the range it replaces: ` +
                `${outputTokens} output tokens vs ${inputTokens} input tokens`,
        )
    })
})
