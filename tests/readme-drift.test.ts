import { describe, it } from "node:test"
import assert from "node:assert"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderPanel } from "../src/lib/tui"
import type { PanelData } from "../src/lib/tui"
import tuiPlugin from "../src/tui"

// ─── README ↔ panel: the documented strings must be the rendered strings ────
//
// The `Trigger:` and `Prune:` lines were split across two lines each this
// session, and the README was updated BY HAND to match. That is exactly how
// the drift happened in the first place: the convention "update the README when
// you change a panel line" is a convention, so it holds only as long as somebody
// remembers. Nothing rendered the panel and diffed it against the docs, so a
// split could have shipped with the README describing a line that no longer
// exists and every test would still be green — the width tests assert the
// panel is 63 columns wide, which is a DIFFERENT property from "the panel says
// what the README says it says".
//
// So this test reads the README, extracts the spans it presents as literal
// panel output, and asserts each one actually appears in a rendered panel.
//
// ── Scope: which spans count as "literal panel output" ──────────────────────
//
// Not every backticked span in the README is output. A generic
// "every backticked span must appear in the panel" rule fails immediately on
// `purgeOutputs.minChars`, `enabled: true`, `/panel` and `Session.Info.tokens`
// — those are config keys, command names and API paths, and asserting they
// appear in a rendered panel is asserting a falsehood.
//
// The two rules below admit a span only when it is presented AS OUTPUT:
//
//   1. LINE FORM — it begins with a capitalised label, a colon, a space and a
//      value: `Prune: N outputs · ~X chars (~Y tokens)`. This is the shape of a
//      panel line. A config key (`purgeOutputs.minChars`) has no such label
//      and a command name has no colon.
//
//   2. CONTINUATION FORM — it sits in a paragraph that says the fact is on a
//      "continuation" line or is a "caveat", and it is not a bare identifier.
//      These are the split-off second halves (`floor …`,
//      `saved on the last request only, not cumulative`), which have no label
//      of their own and would otherwise be invisible to rule 1 — and they are
//      precisely the strings the split created, so they are the ones most
//      worth pinning.
//
// What this deliberately does NOT extract, and why:
//
//   - Bare labels with no value (`Prune:`, `Scope:`, `Context:`) — these are
//     prose mentions of a line's NAME. The rendered line carries the name plus
//     more, and a substring match on the name alone is satisfied by any panel
//     whatsoever, so it constrains nothing.
//
// Two spans that once sat in KNOWN_DISAGREEMENTS for exactly this reason —
// `Context: … tokens` and `Source: measured/estimated` — are no longer quoted in
// the README in that form, so the extraction question does not arise for them.
//
// ── Placeholders: matched LOOSELY, and why ─────────────────────────────────
//
// The README's placeholders are `…` and the bare letters N / X / Y. Each is
// substituted with `\S+` (one or more non-space characters) rather than
// `[0-9.]+`:
//
//   - The values are FORMATTED MAGNITUDES, not the raw numbers: `N` is really
//     `50`, `X` is `1.2M`, `Y` is `300.0K`. A digit-only pattern would fail on
//     every one of them, so the test would be asserting a falsehood about the
//     formatter rather than about the doc.
//   - `\S+` still requires a NON-EMPTY value. That is the property that makes
//     the test non-vacuous: a placeholder cannot match nothing, so a renderer
//     that dropped the figure entirely fails instead of passing.
//   - Matching only ONE character or a fixed shape would pin magnitudes the
//     README never claimed, and the width tests already cover magnitudes.
//
// The literal (non-placeholder) text around each placeholder is matched
// VERBATIM, including the `·` separators and the `%`/`tokens` units. That is
// the part that drifts when a line is reworded or restructured, which is the
// whole point.
//
// A leading or trailing `…` is an ELISION of the box-drawing prefix or a
// trailing clause rather than a value, so it is normalised away before
// matching; only interior placeholders become `\S+`. `… saved on the last
// request only, not cumulative` and `saved on the last request only, not
// cumulative` are therefore the same claim and are deduplicated.

const README = readFileSync(join(process.cwd(), "README.md"), "utf-8")

/** `Label: value` — the shape of a rendered panel line. */
const LINE_FORM = /^(?:…\s*)?[A-Z][A-Za-z]*: \S/
/** A bare identifier / path / number: not output, whatever paragraph it is in. */
const BARE_TOKEN = /^[\w./:%-]+$/

/**
 * Every span the README presents as literal panel output, in document order.
 *
 * Returned as the raw spans so a failing assertion can quote both sides.
 */
function documentedOutputSpans(): string[] {
    const spans: string[] = []
    for (const paragraph of README.split(/\n\s*\n/)) {
        const introducesContinuation = /continuation|caveat/i.test(paragraph)
        for (const match of paragraph.matchAll(/`([^`\n]+)`/g)) {
            const span = match[1]
            const isLine = LINE_FORM.test(span)
            const isContinuation = introducesContinuation && !BARE_TOKEN.test(span)
            if (isLine || isContinuation) spans.push(span)
        }
    }
    return spans
}

/** Strip elision markers so the same claim quoted twice is compared once. */
function normalise(span: string): string {
    return span.replace(/^…\s*/, "").replace(/\s*…$/, "").trim()
}

/**
 * Turn a documented span into a matcher for a rendered line.
 *
 * Interior placeholders (`…`, and N / X / Y standing alone as a value) become
 * `\S+`; everything else is matched verbatim. `.` is escaped, so the `·`
 * separators and `~` sigils are compared exactly.
 */
function matcherFor(span: string): RegExp {
    // A sentinel, not the empty string: placeholders must be marked BEFORE the
    // literal text is escaped, or the replacement `\S+` would itself be escaped
    // into `\\S+` and end up matching a literal backslash.
    const SENTINEL = "\u0001";
    const body = normalise(span)
        // A single capital standing alone as a value is a placeholder. Word
        // boundaries keep ordinary words containing those letters intact.
        .replace(/\b[NXY]\b/g, SENTINEL)
        .replace(/\u2026/g, SENTINEL)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .split(SENTINEL)
        .join("\\S+")
    return new RegExp(body)
}

/**
 * Every line of a panel with the box-drawing gutter AND the continuation indent
 * removed.
 *
 * The indent matters: continuation lines are emitted two columns in (the
 * `Context` / `tokens` pair, and both split blocks), so a lookup for a line
 * starting with `floor` would miss `  floor 100.0K (50.0%)`. Trimming both ends
 * makes a line's CONTENT comparable against a README claim without pinning the
 * panel's indentation, which the width tests own.
 */
function contentLines(rendered: string): string[] {
    return rendered.split("\n").map((line) => line.replace(/^\u2502 ?/, "").trim())
}

// ─── Known README ↔ renderer disagreements ─────────────────────────────────
//
// Currently EMPTY, and asserted for EXACTNESS in both directions: a NEW
// disagreement fails the test, and so would the reintroduction of an entry
// whose disagreement has been fixed. Neither can happen silently, which is what
// keeps this file from rotting into a list of excuses.
//
// Two entries used to live here, and both were README errors rather than
// renderer errors, so both were fixed in the docs and their entries deleted:
//
//   1. `Context: … tokens` (was README:246) — no line reads
//      `Context: <value> tokens`; the panel renders the bar and the percentage
//      on the `Context:` line and the magnitudes on an unlabelled continuation
//      line. The README now quotes `Context: …%` and `… / … tokens`, both of
//      which are rendered verbatim.
//   2. `Source: measured/estimated` (was README:594) — a slash-joined
//      abbreviation of two MUTUALLY EXCLUSIVE renderings, matching neither. The
//      README now quotes `Source: measured (server-reported)` and
//      `Source: estimated (approximate)`, which is what `renderPanel` emits.
//
// The set is kept, empty, because the exactness assertion is the mechanism: it
// is what turns a fixed entry into a failure the author has to notice, and what
// makes the next drift impossible to absorb.
const KNOWN_DISAGREEMENTS: Record<string, { readme: string; renderer: string }> = {}

// ─── The rendered surfaces ─────────────────────────────────────────────────

/** A PanelData with every field populated, so every line is exercised. */
function panelData(overrides: Partial<PanelData> = {}): PanelData {
    return {
        sessionId: "readme-drift",
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
        threshold: {
            tokens: 150_000,
            percent: 75,
            minTokens: 100_000,
            minPercent: 50,
            contextLimit: 200_000,
        },
        cumulativeTokens: 56_100_000,
        prune: { enabled: true, prunedOutputs: 50, charsSaved: 1_200_000 },
        ...overrides,
    }
}

/**
 * Both panel surfaces, rendered for real.
 *
 * `renderPanel` is the `panel` TOOL. The TUI `/panel` dialog renders through
 * `renderPanelText` in src/tui.tsx, which is NOT exported, so it is driven
 * through the real plugin against a fake host — the same path production takes.
 * Both are needed: the README documents `Trigger:` and `floor …` for BOTH
 * surfaces, and a test that only rendered one would pass even if the other had
 * drifted, which is the exact failure this test exists to prevent.
 */
async function renderBothSurfaces(): Promise<Record<string, string[]>> {
    const measured = renderPanel(panelData({ tokenSource: "measured" }))
    const estimated = renderPanel(panelData({ tokenSource: "estimated" }))

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
                    model: { id: "test-model", providerID: "acme", limit: { context: 200_000 } },
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
        "precondition: /panel must produce exactly one dialog, or the TUI surface is untested",
    )

    return {
        "panel tool (Source: measured)": contentLines(measured),
        "panel tool (Source: estimated)": contentLines(estimated),
        "/panel dialog": contentLines(dialogs[0].message),
    }
}

describe("README ↔ panel: every documented output string is really rendered", () => {
    it("renders every literal panel-output span the README quotes, in at least one surface", async () => {
        const surfaces = await renderBothSurfaces();
        const spans = documentedOutputSpans();

        // Non-vacuity. A test that extracted nothing would loop zero times and
        // pass, which is the failure mode this whole file exists to rule out.
        assert.ok(
            spans.length >= 8,
            `the extractor found only ${spans.length} spans (${JSON.stringify(spans)}); it must ` +
                `find the README's panel-output quotes or this test asserts nothing`,
        )

        const distinct = new Map<string, string>()
        for (const span of spans) {
            const key = normalise(span)
            if (!distinct.has(key)) distinct.set(key, span)
        }

        const unmatched: string[] = []
        for (const [claim, span] of distinct) {
            const matcher = matcherFor(span)
            const hit = Object.entries(surfaces).find(([, lines]) =>
                lines.some((line) => matcher.test(line)),
            )
            if (!hit) unmatched.push(span);
            else {
                // The match must be a WHOLE line's content, not a fragment that
                // happens to contain the label. Anchoring both ends is what
                // stops `Prune:` from being "found" inside a line that dropped
                // every figure the README documents.
                assert.ok(
                    hit[1].some((line) => matcher.test(line)),
                    `${JSON.stringify(span)} must appear verbatim (placeholders aside) in ${hit[0]}`,
                )
            }
        }

        // A NEW disagreement is a failure: the docs would describe output the
        // plugin does not produce.
        assert.deepStrictEqual(
            unmatched.filter((span) => !(span in KNOWN_DISAGREEMENTS)),
            [],
            `these README quotes are not present in any rendered panel, so the docs describe ` +
                `output the plugin does not produce (and they are not in KNOWN_DISAGREEMENTS, ` +
                `which must stay exhaustive):\n${unmatched
                    .map((s) => `  ${s}`)
                    .join("\n")}\nrendered lines available:\n${JSON.stringify(surfaces, null, 2)}`,
        )

        // And the recorded set must be EXACT: no more, no fewer. An entry that
        // stopped disagreeing is stale and must be removed, or the record
        // becomes a place where real drift goes to hide.
        assert.deepStrictEqual(
            unmatched.slice().sort(),
            Object.keys(KNOWN_DISAGREEMENTS).sort(),
            `the set of README-vs-renderer disagreements changed. If one was FIXED, remove it ` +
                `from KNOWN_DISAGREEMENTS; if a new one appeared, investigate it rather than ` +
                `adding it here.\nunmatched: ${JSON.stringify(unmatched)}`,
        )

        // Each recorded disagreement must still be a real disagreement, and the
        // renderer side recorded in KNOWN_DISAGREEMENTS must still be what the
        // panel prints. Without this the table could rot into a list of claims
        // that no longer describe anything.
        const everyLine = Object.values(surfaces).flat()
        for (const [span, sides] of Object.entries(KNOWN_DISAGREEMENTS)) {
            assert.ok(
                !everyLine.some((line) => matcherFor(span).test(line)),
                `${JSON.stringify(span)} is recorded as a disagreement but now MATCHES a rendered ` +
                    `line — the disagreement was fixed, so this entry is stale`,
            )
            // The README side is pinned verbatim so a reword of the doc cannot
            // silently change what this file claims the disagreement is.
            assert.ok(
                README.includes(sides.readme),
                `the README no longer contains the recorded text ${JSON.stringify(sides.readme)}; ` +
                    `re-check the ${JSON.stringify(span)} disagreement against the new wording`,
            )
            assert.ok(
                everyLine.some((line) => line.includes(sides.renderer)),
                `the renderer side of the ${JSON.stringify(span)} disagreement changed: expected a ` +
                    `line containing ${JSON.stringify(sides.renderer)}`,
            )
        }
    })

    it("finds at least one distinct documented span per panel surface, so neither can drift unnoticed", async () => {
        // A panel that is never matched by ANY README quote would let that
        // surface drift wholesale. Each surface must be the one that satisfies
        // at least one documented claim — the /panel dialog in particular is
        // documented for `Scope:`, `Messages:` and `Tokens (est)`, none of which
        // the `panel` tool renders at all.
        const surfaces = await renderBothSurfaces()
        const distinct = new Set(documentedOutputSpans().map(normalise))

        for (const [name, lines] of Object.entries(surfaces)) {
            const satisfied = [...distinct].filter((claim) => {
                const matcher = matcherFor(claim)
                return lines.some((line) => matcher.test(line))
            });
            assert.ok(
                satisfied.length > 0,
                `no documented README output string appears in ${name}; that surface is ` +
                    `undocumented, so nothing pins it`,
            )
        }
    })

    it("matches a placeholder against a NON-EMPTY value, so a dropped figure cannot pass", async () => {
        // Proves the loose matching is not vacuous. The README's `…` stands for
        // a value; the rendered line must actually carry one. Two sub-cases:
        //
        //   - the real line, which carries a value, matches;
        //   - the SAME line with its value deleted does NOT match, even though
        //     every literal character of the README's claim is still present.
        //
        // The second case is the assertion that matters. Without it, `\S+`
        // could be matching nothing and the drift test would be decoration.
        const surfaces = await renderBothSurfaces()
        const pruneClaim = "Prune: N outputs · ~X chars (~Y tokens)"
        const matcher = matcherFor(pruneClaim);
        assert.ok(
            documentedOutputSpans().some((s) => normalise(s) === normalise(pruneClaim)),
            "precondition: the README must still quote the Prune line, or this proves nothing",
        )

        const toolLines = surfaces["panel tool (Source: measured)"]
        const realLine = toolLines.find((line) => line.startsWith("Prune:"))
        assert.ok(realLine, `precondition: the panel must render a Prune line:\n${JSON.stringify(toolLines)}`)
        assert.ok(
            matcher.test(realLine),
            `precondition: the real rendered line must match its own README quote: ${realLine}`,
        )

        // Same literal text, every value removed.
        const stripped = realLine
            .replace(/\d[\d.,]*[KMGT]?/g, "")
            .replace(/\s+/g, " ")
            .trim();
        assert.notStrictEqual(
            stripped,
            realLine,
            "precondition: stripping the figures must actually change the line, or the next " +
                "assertion is comparing a line to itself",
        );
        assert.ok(
            !matcher.test(stripped),
            `a Prune line with its figures removed must NOT satisfy the README's claim, or the ` +
                `placeholders are matching nothing: ${JSON.stringify(stripped)}`,
        )
    })

    it("anchors the Trigger claim to the line that states the threshold, not to any line containing 'Trigger:'", async () => {
        // The split moved the floor to its own line. A matcher loose enough to
        // match `Trigger: … tokens (…% of … window)` against a line that had
        // lost the window — or that had swallowed the floor back onto one line —
        // would let the split silently reverse. Anchoring the claim to a whole
        // rendered line, and requiring the floor to be a SEPARATE line, is what
        // pins the two-line shape the README documents.
        const surfaces = await renderBothSurfaces()
        const claim = "Trigger: … tokens (…% of … window)"
        const matcher = matcherFor(claim)
        assert.ok(
            documentedOutputSpans().some((s) => normalise(s) === claim),
            "precondition: the README must still quote the Trigger line, or this proves nothing",
        )

        for (const [name, lines] of Object.entries(surfaces)) {
            const triggerLine = lines.find((line) => line.startsWith("Trigger:"))
            assert.ok(
                triggerLine,
                `precondition: ${name} must render a Trigger line:\n${JSON.stringify(lines)}`,
            )
            assert.ok(
                matcher.test(triggerLine),
                `${name} must render the trigger as the README documents it: ${triggerLine}`,
            );
            assert.ok(
                !/floor/.test(triggerLine),
                `${name}: the floor must be on its OWN continuation line, as the README states — ` +
                    `the threshold line still carries it: ${triggerLine}`,
            )
            const floorLine = lines.find((line) => line.startsWith("floor"))
            assert.ok(
                floorLine,
                `${name}: the floor must be rendered on a continuation line of its own`,
            )
            assert.ok(
                matcherFor("floor …").test(floorLine),
                `${name}: the floor continuation must read as the README documents it: ${floorLine}`,
            )
        }
    })

    it("anchors the Prune claim to the line that states the figures, with the caveat on its own line", async () => {
        // The same shape on the other block. The caveat is the fact a width
        // fix would drop first — a per-request saving that reads as cumulative
        // is worse than a long line — so it is pinned as a line of its own.
        const surfaces = await renderBothSurfaces()
        const figures = "Prune: N outputs · ~X chars (~Y tokens)"
        const caveat = "saved on the last request only, not cumulative"
        for (const claim of [figures, caveat]) {
            assert.ok(
                documentedOutputSpans().some((s) => normalise(s) === normalise(claim)),
                `precondition: the README must still quote ${JSON.stringify(claim)}`,
            )
        }

        const toolLines = surfaces["panel tool (Source: measured)"]
        const pruneLine = toolLines.find((line) => line.startsWith("Prune:"))
        assert.ok(pruneLine, `precondition: a Prune line expected:\n${JSON.stringify(toolLines)}`)
        assert.ok(
            matcherFor(figures).test(pruneLine),
            `the figures line must read as documented: ${pruneLine}`,
        );
        assert.ok(
            !/last request/.test(pruneLine),
            `the caveat must be on its OWN line, not appended to the figures line: ${pruneLine}`,
        )
        const caveatLine = toolLines.find((line) => /last request/.test(line))
        assert.ok(caveatLine, "the caveat continuation line must be rendered")
        assert.ok(
            matcherFor(caveat).test(caveatLine),
            `the caveat must read verbatim as documented: ${caveatLine}`,
        )
    })
})
