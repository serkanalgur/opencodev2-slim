import { describe, it } from "node:test"
import assert from "node:assert"
import { renderPanel, fitValue, ELISION_MARKER } from "../src/lib/tui"
import type { PanelData } from "../src/lib/tui"
import tuiPlugin from "../src/tui"

// ─── fitValue: the elision rule at the three real render sites ──────────────
//
// Three lines in `renderPanel` interpolate an unbounded server- or
// user-supplied string into a 63-column box:
//
//   │   Model: <data.model>              budget 51, mode "middle"
//   │   <topic>: <n> msgs (<tok>)        budget 45, mode "end"
//   │   • <recommendation>                budget 56, mode "end"
//
// …and a fourth in the TUI renderer (src/tui.tsx):
//
//   │ Model: <real.model>                budget 53, mode "middle"
//
// Each of those numbers is derived from the same 61-column inner frame minus
// the fixed text of its own line, and this file pins all of them AT THE RENDER
// SITE rather than only on the helper. A helper can be perfect while a caller
// hands it the wrong budget, and a caller can be right while the helper
// truncates at the boundary instead of above it — both are silent data loss,
// and neither is visible from the other side.
//
// The frame arithmetic, stated once and asserted on the rendered output below:
//   FRAME_WIDTH  63   the `┌──┐` border line
//   FRAME_INNER  61   the `─` run between the two `│` corners
// so a content line is `│` + 61 columns = 62, and each value budget is
// 61 minus its own prefix.

/** Display width in terminal cells; every glyph the panel emits is single-width. */
function displayWidth(line: string): number {
    return [...line].length
}

const FRAME = 63
/** A rendered content line: one `│` plus FRAME_INNER columns. */
const CONTENT_LINE = FRAME - 1

/** Columns available to the model id on `│   Model: ` (61 - 10). */
const MODEL_BUDGET = 51
/** Columns available to a recommendation on `│   • ` (61 - 5). */
const REC_BUDGET = 56
/** Columns available to the model id on the TUI's `│ Model: ` (61 - 8). */
const TUI_MODEL_BUDGET = 53
/**
 * The `: N msgs (X)` suffix for count=1, tokens=10 is 13 columns, so a topic
 * NAME at that count gets 61 - 3 (`│   `) - 13 = 45. The topic budget is
 * PER TOPIC, which is what makes it move with the count and token figures.
 */
const SMALL_TOPIC_SUFFIX = ": 1 msgs (10)"
const SMALL_TOPIC_BUDGET = 61 - 3 - [...SMALL_TOPIC_SUFFIX].length

/**
 * A lone surrogate is what a code-UNIT slice produces when it cuts a surrogate
 * pair in half: the half is one display column (so every width guard in this
 * suite still passes) and two `String.length` units (so anything that counts
 * code units is silently wrong), and it renders as a replacement glyph. A code
 * point spread cannot produce one. This is the check that tells the two apart.
 */
function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
            if (next < 0xdc00 || next > 0xdfff) return true
            i++
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return true
        }
    }
    return false
}

function panelData(overrides: Partial<PanelData> = {}): PanelData {
    return {
        sessionId: "elision",
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
        topics: [],
        recommendations: [],
        ...overrides,
    }
}

/** The single rendered line containing `label`, or undefined. */
function lineWith(rendered: string, label: string): string | undefined {
    return rendered.split("\n").find((line) => line.includes(label))
}

function markerCount(value: string): number {
    return [...value].filter((c) => c === ELISION_MARKER).length
}

// ─── 1. Boundary exactness: a value that EXACTLY fills its budget ───────────
//
// This is the case a `>=` bug hides. A rule written `if (chars.length < available)`
// — or a budget computed one column too tight — renders a model id of exactly 51
// columns as a 50-column head, a marker and a tail. The line still fits the
// frame, still carries a marker, and the width sweep in tests/test.ts is still
// green: the loss is invisible to every guard that exists, and it is loss the
// user cannot detect either. Only an assertion that the value appears
// VERBATIM catches it, so each site gets one at its own exact budget.

describe("boundary exactness: a value of exactly its budget is not elided", () => {
    it("renders a 51-column model id verbatim on the Model: line, with no marker", () => {
        const model = "m".repeat(MODEL_BUDGET)

        // Preconditions, so a later failure cannot be "the id was never that
        // long" or "the budget was never 51" — both would make the verbatim
        // assertion below pass for the wrong reason.
        assert.strictEqual(
            displayWidth(model),
            MODEL_BUDGET,
            "precondition: the fixture must be exactly the model budget wide",
        )
        assert.strictEqual(
            fitValue(model, MODEL_BUDGET, "middle"),
            model,
            "precondition: the helper itself must pass a value at its budget through unchanged",
        )
        const oneOver = "m".repeat(MODEL_BUDGET + 1)
        assert.notStrictEqual(
            fitValue(oneOver, MODEL_BUDGET, "middle"),
            oneOver,
            "precondition: one column over the budget MUST elide, or the boundary is untested",
        )

        const rendered = renderPanel(panelData({ model }))
        const line = lineWith(rendered, "Model:")
        assert.ok(line, `the panel must render a Model: line:\n${rendered}`)
        assert.strictEqual(
            line,
            `│   Model: ${model}`,
            `a model id that exactly fills its ${MODEL_BUDGET}-column budget must appear ` +
                `byte-for-byte: truncating AT the boundary is silent data loss that still ` +
                `fits the frame and still looks elided`,
        )
        assert.strictEqual(
            markerCount(line),
            0,
            `a value that fits must carry no elision marker, or a short model id is ` +
                `indistinguishable from a shortened one:\n${line}`,
        )
        assert.ok(
            displayWidth(line) <= CONTENT_LINE,
            `precondition/consistency: the unelided line must still fit the inner frame ` +
                `(${displayWidth(line)} columns)`,
        )
    })

    it("renders a topic name of exactly its 45-column budget verbatim, with no marker", () => {
        const topic = "t".repeat(SMALL_TOPIC_BUDGET)

        assert.strictEqual(
            displayWidth(topic),
            SMALL_TOPIC_BUDGET,
            "precondition: the fixture must be exactly the topic budget wide",
        )
        assert.strictEqual(
            fitValue(topic, SMALL_TOPIC_BUDGET, "end"),
            topic,
            "precondition: the helper must pass a value at its budget through unchanged",
        )
        const oneOver = "t".repeat(SMALL_TOPIC_BUDGET + 1)
        assert.notStrictEqual(
            fitValue(oneOver, SMALL_TOPIC_BUDGET, "end"),
            oneOver,
            "precondition: one column over the budget MUST elide",
        )

        const rendered = renderPanel(
            panelData({ topics: [{ topic, count: 1, tokens: 10 }] }),
        )
        const line = lineWith(rendered, "msgs")
        assert.ok(line, `the panel must render the topic line:\n${rendered}`)
        assert.strictEqual(
            line,
            `│   ${topic}${SMALL_TOPIC_SUFFIX}`,
            "a topic name that exactly fills its budget must appear byte-for-byte, with the " +
                "`: N msgs (X)` suffix untouched",
        )
        assert.strictEqual(markerCount(line), 0, "no marker on a value that fits")
    })

    it("renders a 56-column recommendation verbatim, with no marker", () => {
        const rec = "r".repeat(REC_BUDGET)

        assert.strictEqual(
            displayWidth(rec),
            REC_BUDGET,
            "precondition: the fixture must be exactly the recommendation budget wide",
        )
        assert.strictEqual(
            fitValue(rec, REC_BUDGET, "end"),
            rec,
            "precondition: the helper must pass a value at its budget through unchanged",
        )
        const oneOver = "r".repeat(REC_BUDGET + 1)
        assert.notStrictEqual(
            fitValue(oneOver, REC_BUDGET, "end"),
            oneOver,
            "precondition: one column over the budget MUST elide",
        )

        const rendered = renderPanel(panelData({ recommendations: [rec] }))
        const line = lineWith(rendered, "•")
        assert.ok(line, `the panel must render the recommendation line:\n${rendered}`)
        assert.strictEqual(
            line,
            `│   • ${rec}`,
            "a recommendation of exactly its budget must appear byte-for-byte",
        )
        assert.strictEqual(markerCount(line), 0, "no marker on a value that fits")
    })
})

// ─── 2. Byte-for-byte passthrough of awkward-but-legal values ───────────────
//
// `fitValue` is on the path of a value the plugin does not own. A model id from
// a self-hosted gateway can be anything: it can carry leading or trailing
// spaces, a `:` (a `provider/model:tag` id has one, and the `│ Model:` line
// already has its own), or a literal `…` (a provider can name a model with a
// Unicode ellipsis in it). None of those is a reason to reformat a value, and
// a rule that trims, normalises or normalises whitespace would be a silent
// behaviour change on the majority of lines that need no help at all.

describe("byte-for-byte passthrough: values fitValue has no reason to touch", () => {
    const awkward: [string, string][] = [
        ["leading and trailing spaces", "  openai/gpt  "],
        ["a value that is only spaces", "   "],
        ["an id that already contains a colon", "openrouter/anthropic/claude-3.5-sonnet:extended"],
        ["an id that itself contains an ellipsis", "acme/legacy…model-v1"],
        ["an id whose ellipsis is its last code point", "acme/model…"],
        ["an empty value", ""],
        ["a single code point", "x"],
        ["a value that is only the elision marker", ELISION_MARKER],
        ["a value with interior double spaces", "acme/two  spaces"],
    ]

    for (const [label, model] of awkward) {
        it(`leaves ${label} unchanged on the Model: line, with no marker`, () => {
            // Precondition: the fixture is short enough that NO rule needs to
            // elide it, which is exactly the regime under test.
            assert.ok(
                displayWidth(model) <= MODEL_BUDGET,
                `precondition: ${JSON.stringify(model)} must fit the ${MODEL_BUDGET}-column ` +
                    `model budget (it is ${displayWidth(model)})`,
            )

            const rendered = renderPanel(panelData({ model }))
            const line = lineWith(rendered, "Model:")
            assert.ok(line, `the panel must render a Model: line:\n${rendered}`)
            assert.strictEqual(
                line,
                `│   Model: ${model}`,
                `${label} must be emitted exactly as received: no trimming, no whitespace ` +
                    `normalisation, no substitution`,
            )
            // The ellipsis-bearing fixtures legitimately contain the marker
            // character, so the meaningful assertion is that fitValue added
            // nothing: the line carries the value's own count of it, no more.
            assert.strictEqual(
                markerCount(line) - markerCount(model),
                0,
                `${label} must not gain an elision marker it did not have`,
            )
        })
    }

    it("leaves a short topic name and recommendation with their own spaces intact", () => {
        const topic = "  authentication  "
        const rec = "  Context is healthy.  "
        const rendered = renderPanel(
            panelData({ topics: [{ topic, count: 1, tokens: 10 }], recommendations: [rec] }),
        )
        assert.ok(
            rendered.includes(`│   ${topic}${SMALL_TOPIC_SUFFIX}`),
            `the topic name must keep its surrounding spaces:\n${rendered}`,
        )
        assert.ok(
            rendered.includes(`│   • ${rec}`),
            `the recommendation must keep its surrounding spaces:\n${rendered}`,
        )
    })
})

// ─── 3. The 2:1 middle split ───────────────────────────────────────────────
//
// A model id reads as `provider/model`, and a reader recognises it by BOTH
// ends. Cutting the head loses the provider; cutting the tail loses the model
// and any `:tag`. So both runs survive, with the marker between them, split
// 2:1 head-to-tail.
//
// The ratio is stated in prose in the docblock AND inlined as `(budget * 2) / 3`
// in the body — two copies of one number, which is exactly the shape that
// drifts. So the test below pins the EXACT split, not merely "head is wider
// than tail": at the 51-column model budget the head is 34 and the tail is 16.
// A deliberate retune will fail this file. That is intended, and the fix is to
// change the constant and this number together.

describe("the 2:1 middle split: head and tail widths at the model budget", () => {
    it("splits the 51-column model budget into a 34-column head and a 16-column tail", () => {
        // 51 - 1 (marker) = 50 to divide; 2:1 with the remainder to the head is
        // ceil(100/3) = 34, leaving 16.
        const model = "acme/some-very-long-model-identifier-that-will-not-fit:free-beta-tag"
        const HEAD = 34
        const TAIL = 16

        assert.ok(
            displayWidth(model) > MODEL_BUDGET,
            `precondition: the fixture must exceed the ${MODEL_BUDGET}-column budget (it is ` +
                `${displayWidth(model)})`,
        )
        assert.strictEqual(
            fitValue(model, MODEL_BUDGET, "middle"),
            model.slice(0, HEAD) + ELISION_MARKER + model.slice(model.length - TAIL),
            "the middle split is LOCKED at 34 head / 16 tail for a 51-column budget. The 2:1 " +
                "ratio is restated in the docblock and inlined as (budget*2)/3 in the body; " +
                "this assertion fails if either copy moves. Change both together, on purpose.",
        )
        assert.strictEqual(
            fitValue(model, MODEL_BUDGET, "middle").length,
            MODEL_BUDGET,
            "precondition: whatever the split, the elided value must occupy the budget exactly",
        )
    })

    it("keeps both ends of a provider/model:tag id: the provider at the head, the tag at the tail", () => {
        const model = "anthropic/claude-sonnet-4-5-20250929-thinking-extended-preview:beta"
        const value = fitValue(model, MODEL_BUDGET, "middle")

        assert.ok(
            value.startsWith("anthropic/"),
            `the head is the provider half of the id and must survive whole: got ${JSON.stringify(value)}`,
        )
        assert.ok(
            value.endsWith(":beta"),
            `the tail is the version/tag half of the id and must survive whole: got ${JSON.stringify(value)}`,
        )
        assert.ok(
            value.includes("claude-sonnet"),
            "the middle of the model name is what gets dropped, not the recognisable parts",
        )
        // The tail must be the GENUINE tail, not a second copy of the head: a
        // rule that sliced from the front twice would produce a line that fits
        // the frame, carries a marker, and shows the provider twice.
        const [head, tail] = value.split(ELISION_MARKER)
        assert.notStrictEqual(
            head,
            tail,
            "the two runs must be different: a duplicated head is indistinguishable from a tail",
        );
        assert.ok(
            [...tail].at(-1) === [...model].at(-1),
            "the last code point of the tail must be the last code point of the ORIGINAL",
        )
        assert.strictEqual(
            tail,
            [...model].slice(-16).join(""),
            "the tail must be the original's final 16 code points, unmodified",
        )
    })

    it("gives the head the larger share for every budget, and never a zero tail", () => {
        // A sweep rather than one point: a ratio that only holds at 51 (e.g. a
        // hardcoded 34) would pass the test above and fail everywhere else.
        for (let available = 3; available <= 80; available++) {
            const value = "x".repeat(200)
            const out = fitValue(value, available, "middle");
            assert.ok(
                displayWidth(out) <= available,
                `precondition/consistency: budget ${available} produced ${displayWidth(out)} columns`,
            )
            if (available === 3) {
                // 3 - 1 (marker) = 2 to split 2:1 → head 2, tail 0: the tail
                // collapses and the marker is terminal, which is the only
                // honest option left. Asserted because a rule that emitted an
                // EMPTY run on each side of the marker would render "…x" and
                // read as a leading truncation, which this mode never does.
                assert.strictEqual(
                    out,
                    "xx…",
                    `at budget 3 the tail collapses to zero: the head still fills the budget and ` +
                        `the marker is terminal, never between two runs where one is empty`,
                )
                continue
            }
            const [head, tail] = out.split(ELISION_MARKER)
            assert.ok(
                [...head].length > [...tail].length,
                `budget ${available}: the head must be the larger run (head ${[...head].length}, ` +
                    `tail ${[...tail].length})`,
            )
            assert.ok(
                [...head].length >= [...tail].length,
                `budget ${available}: ratio must not invert`,
            )
        }
    })
})

// ─── 4. Marker attribution: a shortened value must LOOK shortened ──────────
//
// The whole justification for eliding rather than cutting is that the reader
// can tell. A silent cut produces a line indistinguishable from a short value,
// and the user then believes a different model is loaded than the one in use.
// So: exactly one marker, in the position the mode names, and NOTHING else
// differs from the original.

describe("marker attribution: a truncated value is distinguishable from a full one", () => {
    it("puts exactly one marker between two retained runs in 'middle' mode, changing nothing else", () => {
        const model = "acme/".padEnd(40, "p") + "tail-of-the-model-name:beta"
        const line = fitValue(model, MODEL_BUDGET, "middle")

        assert.strictEqual(
            markerCount(line),
            1,
            `exactly one marker must be emitted, not zero (silent cut) and not two (the value ` +
                `looks annotated): got ${JSON.stringify(line)}`,
        )
        const [head, tail, ...extra] = line.split(ELISION_MARKER)
        assert.strictEqual(
            extra.length,
            0,
            "the marker must appear exactly once, so the value splits into exactly two runs",
        )
        assert.ok(
            head.length > 0 && tail.length > 0,
            "both runs must be non-empty: 'middle' elision is defined as keeping a head AND a tail",
        )
        // The only difference from the original is the removed middle: the head
        // is a prefix of the original and the tail is a suffix of it.
        assert.ok(
            model.startsWith(head),
            `the head must be a verbatim prefix of the original: ${JSON.stringify(head)}`,
        )
        assert.ok(
            model.endsWith(tail),
            `the tail must be a verbatim suffix of the original: ${JSON.stringify(tail)}`,
        )
        assert.strictEqual(
            head + tail,
            line.replace(ELISION_MARKER, ""),
            "stripping the marker must leave exactly the retained runs, with nothing else changed",
        )
    })

    it("puts exactly one marker at the END in 'end' mode, changing nothing else", () => {
        const topic = "authentication-and-session-handling-refactor-with-jwt"
        const line = fitValue(topic, SMALL_TOPIC_BUDGET, "end")

        assert.strictEqual(markerCount(line), 1, "exactly one marker")
        assert.ok(
            line.endsWith(ELISION_MARKER),
            `in 'end' mode the marker is TERMINAL: the reader scans the value left to right, so ` +
                `a marker in the middle would suggest omitted interior content that was not: ` +
                `got ${JSON.stringify(line)}`,
        );
        assert.strictEqual(
            line.slice(0, -1),
            topic.slice(0, SMALL_TOPIC_BUDGET - 1),
            "everything before the marker is the original's verbatim prefix — a recommendation's " +
                "meaning lives at the front, so a rule that dropped the front would be a " +
                "content change, not a formatting one",
        )
        assert.strictEqual(
            line,
            "authentication-and-session-handling-refactor…",
            "the end-elided topic is pinned verbatim: all 44 retained columns are the original's " +
                "prefix, and the cut is at the budget",
        )
    })

    it("renders a 200-column model id through the panel as marker-between-runs, not end-elided", () => {
        const model = "m".repeat(200)
        const rendered = renderPanel(panelData({ model }))
        const line = lineWith(rendered, "Model:");
        assert.ok(line, `precondition: the Model: line must be rendered:\n${rendered}`)
        assert.strictEqual(
            markerCount(line),
            1,
            `the panel's Model: line must carry exactly one marker:\n${line}`,
        );
        assert.ok(
            !line.trimEnd().endsWith(ELISION_MARKER),
            `the panel's Model: line is MIDDLE-elided: end-eliding a model id would drop the ` +
                `model name, which is the half a reader uses to recognise it:\n${line}`,
        )
        assert.ok(
            line.indexOf(ELISION_MARKER) > "│   Model: ".length,
            "the marker must come after the prefix, not inside it",
        )
    })
})

// ─── 5. Code-point safety ──────────────────────────────────────────────────
//
// Width is measured in code points. A code-UNIT slice is the natural mistake
// and it is silent: it produces lone surrogates that are one display column
// wide, so every width guard in the suite stays green while the value renders
// as replacement glyphs. An emoji model id is the only thing that exposes it.

describe("code-point safety: astral values are never cut mid-surrogate-pair", () => {
    it("renders a 51-code-point emoji model id verbatim, and its String.length is 102", () => {
        const model = "😀".repeat(51)

        assert.strictEqual(
            [...model].length,
            MODEL_BUDGET,
            "precondition: the fixture must be exactly the model budget in CODE POINTS",
        )
        assert.strictEqual(
            model.length,
            102,
            "precondition: the same fixture must be twice that in code units — a code-unit " +
                "budget would call this value 102 wide and elide a value that fits",
        )
        assert.strictEqual(
            fitValue(model, MODEL_BUDGET, "middle"),
            model,
            "precondition: a value that fits in code points must be returned byte-for-byte even " +
                "though its String.length is double its width",
        )

        const rendered = renderPanel(panelData({ model }))
        const line = lineWith(rendered, "Model:")
        assert.ok(line, `the panel must render a Model: line:\n${rendered}`)
        assert.strictEqual(line, `│   Model: ${model}`, "the emoji id must survive whole")
        assert.strictEqual(markerCount(line), 0, "no marker on a value that fits")
        assert.ok(
            !hasLoneSurrogate(rendered),
            "no lone surrogate may reach the rendered panel",
        )
    })

    it("elides a 60-code-point emoji model id to exactly 51 code points, all whole", () => {
        const model = "😀".repeat(60)
        const value = fitValue(model, MODEL_BUDGET, "middle")

        assert.ok(
            [...model].length > MODEL_BUDGET,
            `precondition: the fixture must exceed the budget in code points (it is ${[...model].length})`,
        )
        assert.strictEqual(
            [...value].length,
            MODEL_BUDGET,
            "the elided value must occupy the budget in CODE POINTS, not in code units",
        );
        assert.ok(
            !hasLoneSurrogate(value),
            `a code-unit slice would have split a surrogate pair; got ${JSON.stringify(value)}`,
        );
        assert.ok(
            [...value].every((c) => c === "😀" || c === ELISION_MARKER),
            "every retained code point must be a whole emoji or the marker",
        );
        assert.ok(
            value.startsWith("😀".repeat(34)),
            "the head must be 34 WHOLE emoji, so the tail lands on a code point boundary",
        )
        assert.ok(
            value.endsWith("😀".repeat(16)),
            "the tail must be 16 WHOLE emoji taken from the end",
        )
    })

    it("renders an emoji model id at 51 code points as a line that fits the frame", () => {
        const rendered = renderPanel(panelData({ model: "🎉".repeat(200) }))
        for (const line of rendered.split("\n")) {
            // The 63-column border rows are the widest lines the panel emits;
            // every content line has `│` + 61 columns. One measure for both, so
            // the loop is not quietly checking only the rows it happens to know.
            assert.ok(
                displayWidth(line) <= FRAME,
                `an emoji model id must not burst the frame: ${displayWidth(line)} columns: ` +
                    `${JSON.stringify(line)}`,
            )
        }
        assert.ok(
            !hasLoneSurrogate(rendered),
            "no lone surrogate anywhere in the panel, for any reason",
        )
    })

    it("elides an emoji topic name and recommendation without splitting a pair", () => {
        const rendered = renderPanel(
            panelData({
                topics: [{ topic: "🔐".repeat(200), count: 1, tokens: 10 }],
                recommendations: ["✅".repeat(200)],
            }),
        )
        for (const line of rendered.split("\n")) {
            assert.ok(
                !hasLoneSurrogate(line),
                `lone surrogate in ${JSON.stringify(line)}`,
            );
            assert.ok(
                displayWidth(line) <= FRAME,
                `emoji values must not burst the frame: ${displayWidth(line)} columns: ` +
                    `${JSON.stringify(line)}`,
            )
        }
    })
})

// ─── 6. Per-line budget independence ───────────────────────────────────────
//
// The topic budget is not a constant: the `: N msgs (X)` suffix is measured
// per topic, so a topic with large figures gets a SMALLER name budget. That is
// the easiest thing in this file to regress and the quietest: a fixed 45 would
// leave every large-count topic one or two columns over the frame, which is
// invisible on a 63-column box in a terminal and completely over the top in a
// dialog. A fixed budget is also the WRONG budget for a topic with a huge
// suffix, where the name must shrink much further.

describe("per-line budget: the topic name budget moves with that topic's suffix", () => {
    it("shrinks the name budget when the count and token figures are large", () => {
        // `: 999999 msgs (9007.2T)` — count is emitted raw (16 columns at
        // MAX_SAFE_INTEGER, 6 here) and tokens through `formatTokens`, whose
        // worst case is the 7-character "9007.2T".
        const count = 999_999
        const tokens = Number.MAX_SAFE_INTEGER
        const suffix = `: ${count} msgs (9007.2T)`
        const bigBudget = 61 - 3 - [...suffix].length
        const topic = "t".repeat(200)

        assert.strictEqual(
            [...suffix].length,
            23,
            `precondition: the wide suffix must be 23 columns (got ${[...suffix].length})`,
        )
        assert.strictEqual(
            bigBudget,
            35,
            "precondition: the wide suffix must shrink the name budget from 45 to 35 — this is " +
                "the behaviour a fixed budget would lose",
        );
        assert.ok(
            bigBudget < SMALL_TOPIC_BUDGET,
            "precondition: the wide suffix must leave LESS room for the name than the narrow one",
        )

        const rendered = renderPanel(panelData({ topics: [{ topic, count, tokens }] }))
        const line = lineWith(rendered, "msgs")
        assert.ok(line, `the panel must render the topic line:\n${rendered}`)
        assert.ok(
            line.endsWith(suffix),
            `the count and token figures are numbers and must be emitted untouched: ` +
                `${JSON.stringify(line)}`,
        )
        assert.ok(
            displayWidth(line) <= CONTENT_LINE,
            `a long name and a wide suffix together must not overflow: ` +
                `${displayWidth(line)} columns: ${JSON.stringify(line)}`,
        )
        assert.strictEqual(
            markerCount(line),
            1,
            "the name must be elided, because 200 columns cannot fit a 35-column budget",
        );
        assert.strictEqual(
            line,
            `│   ${topic.slice(0, bigBudget - 1)}${ELISION_MARKER}${suffix}`,
            "the name must be cut at the budget this topic's OWN suffix leaves, and the marker " +
                "must be terminal",
        )
    })

    it("leaves a topic with a small suffix its full 45-column name budget", () => {
        // The other side of the same rule, and the reason a fixed budget cannot
        // be made to work: the budget must actually MOVE, not just shrink.
        const rendered = renderPanel(
            panelData({
                topics: [
                    { topic: "s".repeat(SMALL_TOPIC_BUDGET), count: 1, tokens: 10 },
                    { topic: "l".repeat(200), count: 1, tokens: 10 },
                ],
            }),
        )
        const lines = rendered.split("\n").filter((line) => line.includes("msgs (10)"))
        assert.strictEqual(lines.length, 2, "precondition: both topics must be rendered")
        assert.strictEqual(
            lines[0],
            `│   ${"s".repeat(SMALL_TOPIC_BUDGET)}${SMALL_TOPIC_SUFFIX}`,
            "a topic that exactly fills its own budget must be untouched, even though a LONGER " +
                "topic in the same panel is elided",
        )
        assert.strictEqual(
            lines[1],
            `│   ${"l".repeat(SMALL_TOPIC_BUDGET - 1)}${ELISION_MARKER}${SMALL_TOPIC_SUFFIX}`,
            "the long topic is cut at the same 45-column budget",
        )
    })

    it("spends the recommendation line's whole 56-column budget and no more", () => {
        // The recommendation prefix `│   • ` is fixed at 5 columns, so its budget
        // is a constant 56. This is the counterpart to the topic test: it
        // catches a change to the `• ` prefix arithmetic that would leave the
        // line either overflowing or wasting a column.
        const rec = "r".repeat(200)
        const rendered = renderPanel(panelData({ recommendations: [rec] }))
        const line = lineWith(rendered, "•")
        assert.ok(line, `the panel must render the recommendation line:\n${rendered}`)
        assert.strictEqual(
            line,
            `│   • ${rec.slice(0, REC_BUDGET - 1)}${ELISION_MARKER}`,
            "a 200-column recommendation must be cut at exactly 55 columns plus the marker",
        )
        assert.strictEqual(
            displayWidth(line),
            CONTENT_LINE,
            `the elided recommendation line must fill the inner frame exactly (${CONTENT_LINE} ` +
                `columns), which is what pins the 5-column prefix: one column more overflows, one ` +
                `column less wastes the budget`,
        )
    })
})

// ─── 7. Degenerate budgets ─────────────────────────────────────────────────
//
// `available` is derived arithmetic on strings the plugin does not control, and
// the count/token figures in a topic suffix are the widest thing in it. A
// budget of 0 or 1 is reachable by a future change to that arithmetic long
// before anyone has a reproducer, so the helper must be total: no throw, and
// never a result wider than the budget it was given.

describe("fitValue degenerate budgets: total, and never wider than the budget", () => {
    it("returns the empty string for a non-positive budget in both modes", () => {
        const value = "a".repeat(200)
        for (const available of [0, -1, -63, -1000]) {
            for (const mode of ["middle", "end"] as const) {
                const out = fitValue(value, available, mode)
                assert.strictEqual(
                    out,
                    "",
                    `budget ${available} in ${mode} mode must yield the empty string, not a ` +
                        `marker or a run of characters`,
                )
            }
        }
    })

    it("returns the first available code points when the budget is the marker's own width", () => {
        // A budget of 1 has no room for content AND a marker. The current rule
        // emits the single code point with NO marker, which means this one
        // character is NOT annotated as shortened. Pinned deliberately: it is
        // the honest reading (there is nothing else it could be — a reader
        // cannot act on a 1-column value) and the alternative, spending the
        // whole budget on the marker, would hide the value entirely.
        assert.strictEqual(fitValue("abcdef", 1, "middle"), "a")
        assert.strictEqual(fitValue("abcdef", 1, "end"), "a")
        assert.strictEqual(
            fitValue("😀bcdef", 1, "middle"),
            "😀",
            "even at a 1-column budget the code point is taken whole, never half a surrogate pair",
        )
        assert.strictEqual(fitValue("😀bcdef", 1, "end"), "😀")
    })

    it("collapses the tail to zero and keeps the marker inside the budget at 'middle' with a 3-column budget", () => {
        // 3 - 1 = 2 to split 2:1 → head 2, tail 0. There is no tail to keep, so
        // the marker is terminal rather than trailing an empty run.
        assert.strictEqual(
            fitValue("abcdef", 3, "middle"),
            "ab…",
            "with no room for a tail the marker must be terminal and the head must still fill the " +
                "budget; two empty runs around a marker would be a different value",
        )
        assert.strictEqual(fitValue("abcdef", 2, "middle"), "a…")
        assert.strictEqual(fitValue("abcdef", 2, "end"), "a…")
    })

    it("never exceeds its budget and never throws, across a wide sweep of budgets", () => {
        const values = [
            "",
            "x",
            "a".repeat(200),
            "😀".repeat(200),
            "mixed ascii and astral 日本語 text " + "z".repeat(100),
        ]
        for (const value of values) {
            for (let available = -3; available <= 80; available++) {
                for (const mode of ["middle", "end"] as const) {
                    const out = fitValue(value, available, mode)
                    assert.ok(
                        displayWidth(out) <= Math.max(available, 0),
                        `fitValue(${JSON.stringify(value.slice(0, 12))}…, ${available}, ` +
                            `${JSON.stringify(mode)}) returned ${displayWidth(out)} columns, ` +
                            `which is more than the budget allows`,
                    )
                    assert.ok(
                        !hasLoneSurrogate(out),
                        `fitValue(${JSON.stringify(value.slice(0, 12))}…, ${available}, ` +
                            `${JSON.stringify(mode)}) emitted a lone surrogate`,
                    )
                }
            }
        }
    })
})

// ─── 8. Both renderers ─────────────────────────────────────────────────────
//
// The `panel` TOOL (renderPanel, src/lib/tui.ts) and the TUI `/panel` dialog
// (renderPanelText, src/tui.tsx) both print an unbounded model id, and until
// this change nothing drove both. The TUI's budget is a LITERAL `61 - 8` rather
// than the shared `FRAME_INNER` constant, so it is exactly the kind of
// arithmetic that drifts: change `FRAME_WIDTH` and `renderPanel` follows while
// the TUI does not.
//
// The pin is the rendered line's EXACT width. A value long enough to be elided
// fills its budget completely, so `│` + budget = 62 on both surfaces, and both
// the top border and every elided line are asserted against the same 63. A
// frame constant that drifts from the border, or a literal that drifts from
// the constant, moves one of those numbers and fails here.

/** Drives the real TUI plugin against a fake host and returns the dialog text. */
async function renderTuiPanel(model: string): Promise<string> {
    const dialogs: { title: string; message: string }[] = []
    let renderSlot: (() => void) | undefined
    let commands: any[] = []
    const context: any = {
        data: { session: { list: () => [{ id: "ses_test" }] } },
        ui: {
            slot: (claim: any) => {
                renderSlot = claim.render
            },
            router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
            toast: { show: () => {} },
            dialog: { alert: async (dialog: any) => void dialogs.push(dialog) },
        },
        keymap: {
            layer: (input: () => any) => {
                commands = input().commands ?? []
            },
        },
        client: {
            session: {
                context: async () => [{ type: "user", text: "hello" }],
                get: async () => ({
                    tokens: { input: 100_000, output: 500, cache: { read: 0, write: 0 } },
                    cost: 1,
                    model: { id: model, providerID: "acme", limit: { context: 200_000 } },
                }),
                synthetic: async () => {},
            },
            model: { list: async () => ({ data: [] }) },
        },
    }

    await (tuiPlugin as any).setup(context)
    renderSlot?.()
    const panel = commands.find((cmd: any) => cmd.slash?.name === "panel")
    assert.ok(panel, "precondition: /panel must be registered, or the TUI surface is untested")
    await panel.run(undefined, undefined)
    assert.strictEqual(
        dialogs.length,
        1,
        "precondition: /panel must produce exactly one dialog",
    )
    return dialogs[0].message
}

describe("both renderers elide the same model id within the same frame", () => {
    it("elides a 200-column model id on BOTH surfaces, at the same frame width", async () => {
        const model = "m".repeat(200)
        assert.ok(
            displayWidth(model) > TUI_MODEL_BUDGET,
            "precondition: the fixture must exceed both renderers' budgets",
        )

        const tool = renderPanel(panelData({ model }))
        const tui = await renderTuiPanel(model)

        // The frame itself, as both surfaces draw it.
        for (const [name, rendered] of [
            ["panel tool", tool],
            ["/panel dialog", tui],
        ] as const) {
            const border = lineWith(rendered, "┌")
            assert.ok(border, `${name}: the frame must render a top border:\n${rendered}`)
            assert.strictEqual(
                displayWidth(border),
                FRAME,
                `${name}: the border must be ${FRAME} columns (got ${displayWidth(border)})`,
            )
        }

        const toolLine = lineWith(tool, "Model:")
        const tuiLine = lineWith(tui, "Model:")
        assert.ok(toolLine, `precondition: the panel tool must render a Model: line:\n${tool}`)
        assert.ok(tuiLine, `precondition: the /panel dialog must render a Model: line:\n${tui}`)

        for (const [name, line, prefix] of [
            ["panel tool", toolLine, "│   Model: "],
            ["/panel dialog", tuiLine, "│ Model: "],
        ] as const) {
            assert.strictEqual(
                markerCount(line),
                1,
                `${name}: the elided model id must carry exactly one marker, or a shortened id ` +
                    `is indistinguishable from a short one:\n${line}`,
            )
            assert.ok(
                displayWidth(line) <= CONTENT_LINE,
                `${name}: the model line must fit the inner frame: ${displayWidth(line)} columns: ` +
                    `${JSON.stringify(line)}`,
            )
            // The exact width, not just "fits". An elided value fills its
            // budget completely, so this is the assertion that pins the budget
            // literals: change FRAME_WIDTH, or the TUI's `61 - 8`, and this
            // number moves.
            assert.strictEqual(
                displayWidth(line),
                CONTENT_LINE,
                `${name}: the elided model line must fill the inner frame exactly ` +
                    `(${CONTENT_LINE} columns, prefix "${prefix}" plus its budget), got ` +
                    `${displayWidth(line)} — a budget that drifts from the frame shows up here`,
            )
        }

        // The two surfaces indent differently, so their budgets differ by
        // exactly the 2 columns between `   Model: ` and ` Model: `. Asserting
        // the DIFFERENCE rather than each literal separately is what ties the
        // TUI's hardcoded budget to the same 61-column frame the tool uses.
        assert.strictEqual(
            displayWidth(toolLine),
            displayWidth(tuiLine),
            "precondition/consistency: both elided model lines must be the same width, so the " +
                "2-column prefix difference is absorbed by each renderer's own budget",
        );
        assert.strictEqual(
            TUI_MODEL_BUDGET - MODEL_BUDGET,
            2,
            "precondition: the TUI budget is the tool budget plus the 2 columns its shorter " +
                "prefix gives back — if the two prefixes ever change together this must be updated",
        )
    })

    it("passes a 53-column model id through the TUI verbatim, so its literal budget is pinned", async () => {
        // The TUI budget is not observable from outside except by its boundary,
        // so the boundary is what is pinned: 53 columns through, 54 elided.
        const fits = "t".repeat(TUI_MODEL_BUDGET)
        const overflows = "t".repeat(TUI_MODEL_BUDGET + 1)

        const atBudget = await renderTuiPanel(fits)
        const overBudget = await renderTuiPanel(overflows)

        const atLine = lineWith(atBudget, "Model:")
        const overLine = lineWith(overBudget, "Model:");
        assert.ok(atLine, `precondition: a Model: line must render:\n${atBudget}`)
        assert.ok(overLine, `precondition: a Model: line must render:\n${overBudget}`)

        assert.strictEqual(
            atLine,
            `│ Model: ${fits}`,
            "a model id of exactly the TUI's budget must be emitted verbatim. The `61 - 8` " +
                "literal is the one number in this file nothing else observes, so its boundary is " +
                "the only place a drift in it can show.",
        );
        assert.strictEqual(markerCount(atLine), 0, "no marker at the budget")
        assert.ok(
            atLine.includes(ELISION_MARKER) === false,
            "precondition: the at-budget id must not be elided, or the next assertion is the " +
                "same case twice",
        )
        // 53 - 1 (marker) = 52 to split 2:1 with the remainder to the head is
        // ceil(104/3) = 35, leaving 17. Same rule, different budget.
        assert.strictEqual(
            overLine,
            `│ Model: ${"t".repeat(35)}${ELISION_MARKER}${"t".repeat(17)}`,
            "one column over the TUI budget the id is middle-elided at 35 head / 17 tail — the " +
                "same 2:1 rule as the tool's renderer, on a 53-column budget. Pinning the split " +
                "here too is what ties the TUI's literal budget to the same helper.",
        )
    })
})
