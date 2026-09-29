import { describe, it } from "node:test"
import assert from "node:assert"
import { purgeStaleToolErrors, pairingIdOf } from "../src/lib/strategies"
import {
    buildPrunePlan,
    applyPrunePlan,
    PRUNE_ALWAYS_PROTECTED,
} from "../src/lib/prune"
import type { SlimConfig } from "../src/lib/types"
import { loadConfig } from "../src/lib/config"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── purgeStaleToolErrors: the protected-tool list, called directly ──────────
//
// The protected-tool work is covered end to end in tests/purge-e2e.test.ts,
// but every test there reaches it through the hook, so the three-argument
// signature itself is never the thing under test. That hides a whole class:
// anything gated on `protectedTools.length > 0` (the name-map build) only runs
// when the third argument is actually passed, and a caller that stopped passing
// it would leave every e2e test green while the list silently stopped working
// for anyone calling the function directly.
//
// The other gaps closed here are the ones a single-transcript e2e fixture
// cannot show: the list interacting with the `turns` age window, a message
// carrying SEVERAL tool parts (which is the entire reason the name is read per
// part rather than per message), and what the list does and does not suppress
// on a call that never errored.
//
// Every fixture asserts its own precondition — the parts really carry the id
// the implementation pairs on, the results really are errors, the indices
// really are inside the age window — BEFORE the outcome, so nothing can pass by
// failing to pair or by being gated out.

/** The exact marker production writes over a purged input string. */
const MARKER = "[input removed due to failed tool call]"

/** 81 chars: one over the strict `> 80` threshold in the purge. */
const OVER = "A".repeat(81)

/**
 * Pad to `n` messages and assert that index 0 is age-eligible. The gate is
 * `i > n - turns - 1` → skip, so a fixture shorter than `turns + 1` has every
 * index gated out and the purge is a no-op for reasons that have nothing to do
 * with protection — the vacuous-test failure mode.
 */
function padTo(messages: any[], n: number, turns: number): any[] {
    while (messages.length < n) {
        messages.push({
            id: `pad${messages.length}`,
            role: "user",
            content: [{ type: "text", text: `pad ${messages.length}` }],
        })
    }
    const lastEligible = messages.length - turns - 1
    assert.ok(
        lastEligible >= 0,
        `fixture is too short (n=${messages.length}, turns=${turns}): index 0 would be gated out, ` +
            `so this test could not fail for the reason it claims to check`,
    )
    return messages
}

/**
 * A v2 `tool-call` / `tool-result` pair sharing one `id`. `resultType` is
 * settable so a fixture can answer with a SUCCESS, which is the case the
 * protected list must have no effect on.
 */
function pair(
    callId: string,
    input: Record<string, unknown>,
    name: string | null = "bash",
    resultType = "error",
): [any, any] {
    const call: any = { type: "tool-call", id: callId, input }
    const result: any = {
        type: "tool-result",
        id: callId,
        result: { type: resultType, value: "boom" },
    }
    // `null` is the explicit "this part carries no name" sentinel; omitting the
    // argument would fall through to the default and silently name the tool.
    if (name !== null) {
        call.name = name
        result.name = name
    }
    return [
        { id: `msg-call-${callId}`, role: "assistant", content: [call] },
        { id: `msg-res-${callId}`, role: "tool", content: [result] },
    ]
}

/** The `input` object of the tool-call in message `i`, post-call. */
function callInputAt(messages: any[], i: number): any {
    return messages[i].content[0].input
}

/** A plain user message — filler with no tool parts. */
function filler(id: string, text: string): any {
    return { id, role: "user", content: [{ type: "text", text }] }
}

describe("purgeStaleToolErrors: the protectedTools argument, called directly", () => {
    it("purges a protected tool's errored input when the list is omitted, and spares it when passed", () => {
        // The two halves of the third argument's whole purpose, on ONE fixture.
        // The first call is the control: it proves this transcript is one the
        // purge provably rewrites, so the second call's "untouched" is a
        // protection verdict and not a purge that never ran.
        const build = () => padTo([...pair("call_a", { content: OVER })], 6, 4);

        const withoutList = build()
        assert.strictEqual(
            withoutList[1].content[0].result.type,
            "error",
            "precondition: the result must actually be an error, or nothing should fire",
        )
        assert.strictEqual(
            pairingIdOf(withoutList[0].content[0]),
            "call_a",
            "precondition: both sides must resolve to the same pairing id",
        )
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(withoutList, 4)

        assert.strictEqual(
            callInputAt(withoutList, 0).content,
            MARKER,
            "control: with the list omitted the purge must rewrite the input, otherwise the " +
                "protected case below proves nothing",
        )

        const withList = build()
        assert.strictEqual(
            withList[0].content[0].name,
            "bash",
            "precondition: the fixture really is on the protected list",
        )

        purgeStaleToolErrors(withList, 4, ["bash"])

        assert.strictEqual(
            callInputAt(withList, 0).content,
            OVER,
            "the third argument is the only thing standing between this input and the marker: " +
                "omitting it purges, passing it spares",
        )
    })

    it("protects nothing from an empty list, and spares a nameless call on the strength of its result's own name", () => {
        // A pair whose CALL side carries no name and whose RESULT side does.
        // The collection pass reads the RESULT part, finds a protected name and
        // declines to register the call id, so the pair is never purged — no
        // cross-side lookup exists or is consulted.
        //
        // The list-empty half is the one that pins the `protectedSet.size > 0`
        // gate: an empty list must protect nothing, or the default `[]` would
        // silently start protecting tools.
        //
        // HONEST SCOPE — this pins the OUTCOME, not a mechanism that reads the
        // other side of the pair. There is no such mechanism: a cross-side
        // name map in `purgeStaleToolErrors` was dead code, because the
        // collection pass is the reader of the result and a result it spares
        // never reaches the rewrite pass. It has been REMOVED, so the path this
        // fixture used to be credited with covering no longer exists. The
        // disagreeing-side fixtures further down still separate the two passes
        // from each other.
        const build = () => {
            const [call, result] = pair("call_nameless_call", { content: OVER }, null)
            result.content[0].name = "bash"
            return padTo([call, result], 6, 4)
        }

        const noList = build()
        assert.strictEqual(
            noList[0].content[0].name,
            undefined,
            "precondition: the CALL side carries no name, so the call cannot identify itself",
        )
        assert.strictEqual(
            noList[1].content[0].name,
            "bash",
            "precondition: the RESULT side carries the name, and the collection pass reads THIS part",
        )

        purgeStaleToolErrors(noList, 4, [])

        assert.strictEqual(
            callInputAt(noList, 0).content,
            MARKER,
            "an empty protected list protects nothing, including a pair whose result is named: " +
                "the default must stay the default",
        )

        const withList = build()
        purgeStaleToolErrors(withList, 4, ["bash"])

        assert.strictEqual(
            callInputAt(withList, 0).content,
            OVER,
            "a protected result is never registered as errored, so its call is never rewritten — " +
                "that is the protection, and it needs no name from the call side",
        )
    })

    it("reads the name per part, so a protected tool cannot suppress an unprotected sibling in the same message", () => {
        // The reason the name is read from the PART and not the message: a real
        // assistant turn carries several tool parts of DIFFERENT tools. A
        // message-level filter would either spare the whole message (the
        // unprotected tool's failed input survives) or purge the whole message
        // (the protected tool loses its input). Both are wrong, and neither is
        // visible in a fixture with one tool part per message.
        const messages = padTo(
            [
                {
                    id: "msg-multi",
                    role: "assistant",
                    content: [
                        // Protected tool FIRST, so a filter that stops at the
                        // first match would pass, and a filter that reads the
                        // message rather than the part would spare the second.
                        { type: "tool-call", id: "call_prot", name: "bash", input: { command: OVER } },
                        { type: "tool-call", id: "call_unprot", name: "grep", input: { pattern: OVER } },
                    ],
                },
                {
                    id: "msg-multi-res",
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "call_prot",
                            name: "bash",
                            result: { type: "error", value: "boom" },
                        },
                        {
                            type: "tool-result",
                            id: "call_unprot",
                            name: "grep",
                            result: { type: "error", value: "boom" },
                        },
                    ],
                },
            ],
            6,
            4,
        )
        assert.strictEqual(
            messages[0].content.length,
            2,
            "precondition: the message must carry TWO tool parts, or the per-part read is untested",
        );
        assert.notStrictEqual(
            messages[0].content[0].name,
            messages[0].content[1].name,
            "precondition: the two parts must be DIFFERENT tools, or a message-level filter would " +
                "give the same answer as a per-part one",
        )
        for (const i of [0, 1]) {
            assert.strictEqual(
                messages[1].content[i].result.type,
                "error",
                `precondition: result ${i} must be an error, or nothing should fire`,
            )
            assert.strictEqual(
                pairingIdOf(messages[0].content[i]),
                messages[1].content[i].id,
                `precondition: part ${i} must pair with its result`,
            )
        }
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            messages[0].content[0].input.command,
            OVER,
            "the protected tool's input must survive even though it shares a message with a " +
                "purged call",
        )
        assert.strictEqual(
            messages[0].content[1].input.pattern,
            MARKER,
            "the UNPROTECTED tool in the same message must still be purged: a protected sibling " +
                "must not suppress the whole message",
        )
    })

    it("protects a tool named only on its `tool` field, never on `name`", () => {
        // The v1 `ToolPart` shape names the tool in the SDK's `tool` field.
        // A reader that only looked at `name` would miss it — silently, because
        // the user spelled the name exactly as the SDK documents it.
        const messages = padTo(
            [
                filler("pad-a", "earlier work"),
                {
                    id: "msg-v1",
                    role: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "prt_V1",
                            callID: "call_v1",
                            tool: "bash",
                            state: { status: "error", input: { command: OVER }, error: "exit 1" },
                        },
                    ],
                },
            ],
            6,
            4,
        )
        assert.strictEqual(
            messages[1].content[0].tool,
            "bash",
            "precondition: the v1 tool name lives in `tool`",
        )
        assert.strictEqual(
            messages[1].content[0].name,
            undefined,
            "precondition: this shape must NOT carry `name`, or the `tool` read is untested",
        )
        assert.strictEqual(
            pairingIdOf(messages[1].content[0]),
            "call_v1",
            "precondition: the part must resolve to its callID, not its part id",
        )
        assert.ok(!(1 > 6 - 4 - 1), "precondition: index 1 must be inside the age window")

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            messages[1].content[0].state.input.command,
            OVER,
            "the `tool` field must be honoured by the filter, or a protected v1 tool is still purged",
        )
    })

    it("purges a nameless pair rather than treating an undeterminable name as a match", () => {
        // Failing open. The list is a whitelist; a name that cannot be read is
        // not in it. Failing closed would make the purge silently inert for
        // any transcript the host delivers without names, which is the far more
        // damaging direction — the user opts into a purge that does nothing.
        const messages = padTo([...pair("call_nameless", { content: OVER }, null)], 6, 4)
        assert.strictEqual(
            messages[0].content[0].name,
            undefined,
            "precondition: the call side carries no name",
        )
        assert.strictEqual(
            messages[1].content[0].name,
            undefined,
            "precondition: the result side carries no name either",
        )
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "an undeterminable name must not count as a match: the purge is the default behaviour",
        )
    })

    it("treats a protected tool the same at both ends of the transcript, under two age windows", () => {
        // The list and the `turns` window are two independent gates and must not
        // interfere. Nothing in the e2e fixtures pins this: each uses one
        // protected call at one index with one `turns` value. Here the SAME
        // protected tool appears early in the transcript and again late in it,
        // an unprotected control sits beside each, and the identical array is
        // run at two `turns` values so the window is shown to be live.
        //
        // n=12. turns=4 → indices 0..7 eligible, so all four calls fire;
        // turns=6 → indices 0..5 eligible, so the two late calls (6 and 7) are
        // gated out. The protected verdict must be the SAME at every index
        // under turns=4, and under turns=6 every call must be spared BY THE
        // WINDOW — including the unprotected controls, which proves the list
        // did not disable the gate.
        const [epCall, epRes] = pair("early_prot", { content: OVER }, "bash");
        const [ecCall, ecRes] = pair("early_ctrl", { content: OVER }, "grep");
        const [lpCall, lpRes] = pair("late_prot", { content: OVER }, "bash");
        const [lcCall, lcRes] = pair("late_ctrl", { content: OVER }, "grep");
        /**
         * A FRESH array each call. The purge mutates in place, so reusing one
         * array across the two runs would make the second run's expectations
         * vacuous — the fixture would already carry the first run's verdicts.
         */
        const build = (): any[] =>
            padTo(
                [
                    epCall,
                    ecCall,
                    filler("f2", "filler"),
                    filler("f3", "filler"),
                    filler("f4", "filler"),
                    filler("f5", "filler"),
                    lpCall,
                    lcCall,
                    epRes,
                    lpRes,
                    ecRes,
                    lcRes,
                ].map((m) => structuredClone(m)),
                12,
                4,
            )

        const assertFixture = (messages: any[]): void => {
            assert.strictEqual(messages.length, 12, "precondition: the array length is what the age gate reads");
            assert.strictEqual(messages[0].content[0].name, "bash", "precondition: index 0 is the protected tool");
            assert.strictEqual(messages[1].content[0].name, "grep", "precondition: index 1 is its unprotected control");
            assert.strictEqual(messages[6].content[0].name, "bash", "precondition: index 6 is the SAME protected tool, late");
            assert.strictEqual(messages[7].content[0].name, "grep", "precondition: index 7 is its unprotected control");
            for (const i of [0, 1, 6, 7]) {
                assert.ok(
                    !(i > 12 - 4 - 1),
                    `precondition: index ${i} must be eligible at turns=4, or this fixture is not the ` +
                        `shape it claims to be`,
                )
            }
            for (const i of [6, 7]) {
                assert.ok(
                    i > 12 - 6 - 1,
                    `precondition: index ${i} must be gated out at turns=6, or the second run proves ` +
                        `nothing the first did not`,
                )
            }
            for (const [label, res] of [
                ["early protected", epRes],
                ["early control", ecRes],
                ["late protected", lpRes],
                ["late control", lcRes],
            ] as const) {
                assert.strictEqual(
                    res.content[0].result.type,
                    "error",
                    `precondition: the ${label} pair's result must be an error, or nothing should fire`,
                )
            }
        }

        const wide = build();
        assertFixture(wide);
        purgeStaleToolErrors(wide, 4, ["bash"]);

        assert.strictEqual(
            wide[0].content[0].input.content,
            OVER,
            "a protected tool early in the transcript must be spared",
        );
        assert.strictEqual(
            wide[6].content[0].input.content,
            OVER,
            "the SAME tool late in the transcript must be spared identically: protection is a " +
                "property of the name, not of where in the transcript the call sits",
        );
        assert.strictEqual(
            wide[1].content[0].input.content,
            MARKER,
            "the unprotected control beside the early protected call must still be purged: the " +
                "protected list must not have widened the window",
        );
        assert.strictEqual(
            wide[7].content[0].input.content,
            MARKER,
            "the unprotected control beside the LATE protected call must be purged too, or a " +
                "protected sibling somewhere earlier in the array leaked into it",
        )

        const narrow = build();
        assertFixture(narrow);
        purgeStaleToolErrors(narrow, 6, ["bash"]);

        assert.strictEqual(
            narrow[7].content[0].input.content,
            OVER,
            "at turns=6 the late UNPROTECTED control is outside the window and must be spared: the " +
                "list must not have disabled the age gate",
        );
        assert.strictEqual(
            narrow[6].content[0].input.content,
            OVER,
            "and the late protected call is spared under this window for the same reason",
        )
    })

    it("skips a protected RESULT whose CALL side names a different, unprotected tool", () => {
        // This fixture exists to isolate the COLLECTION pass, and it is the only
        // shape that does. The two passes are deliberately redundant — the
        // implementation checks the name on both sides of a pair — so almost
        // every protected fixture is spared by whichever pass happens to be
        // intact, and removing either check alone changes nothing observable.
        //
        // Here the sides DISAGREE, and only the collection pass sees the
        // protected one: the errored RESULT names `bash` (protected) while the
        // CALL it would exempt names `grep` (not protected). The collection
        // pass reads the result and must decline to register the id; if it
        // registered, the rewrite pass would read the call, see `grep`, and
        // purge. Every other fixture has the two sides agreeing, which is
        // exactly why none of them can catch a check removed from one pass.
        const [call, result] = pair("c1", { content: OVER }, "bash");
        call.content[0].name = "grep";
        const messages = padTo([call, result], 6, 4)
        assert.strictEqual(
            messages[1].content[0].name,
            "bash",
            "precondition: the RESULT side names the protected tool",
        )
        assert.strictEqual(
            messages[0].content[0].name,
            "grep",
            "precondition: the CALL side names an UNPROTECTED tool, which is the whole point",
        )
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "precondition: the result must be an error, or nothing should fire",
        )
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            callInputAt(messages, 0).content,
            OVER,
            "the collection pass must decline to register a call whose errored RESULT names a " +
                "protected tool, even though the call itself names one that is not protected",
        )
    })

    it("re-checks the name on the CALL side, so a protected call behind an unprotected result is spared", () => {
        // The mirror of the previous fixture, isolating the REWRITE pass. Here
        // the sides disagree the other way: the errored RESULT names `grep`
        // (not protected), so the collection pass correctly registers the id,
        // and only the rewrite pass — reading the CALL, which names the
        // protected `bash` — can still spare the input.
        //
        // Without the rewrite-pass re-check the call is purged here, so this is
        // the fixture that catches a re-check removed from that pass alone.
        const [call, result] = pair("c1", { content: OVER }, "bash");
        result.content[0].name = "grep";
        const messages = padTo([call, result], 6, 4)
        assert.strictEqual(
            messages[0].content[0].name,
            "bash",
            "precondition: the CALL side names the protected tool",
        )
        assert.strictEqual(
            messages[1].content[0].name,
            "grep",
            "precondition: the RESULT side names an UNPROTECTED tool, so the id IS registered and " +
                "the rewrite pass is the only thing that can spare this input",
        )
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            callInputAt(messages, 0).content,
            OVER,
            "the rewrite pass must re-check the name on the side it is about to modify: the " +
                "collection pass saw only the unprotected result and registered the call",
        )
    })

    it("purges an unprotected errored call even when a protected call in the same transcript SUCCEEDED", () => {
        // What the list does NOT do. A successful call is never a purge
        // candidate, so a protected list has nothing to suppress there — but
        // the risk is a filter consulted in a way that leaks: an empty or
        // short-circuited `erroredCallIds` would silently spare the whole
        // transcript. The unprotected errored call is the control that catches
        // exactly that.
        const protOk = pair("call_prot_ok", { command: "ls" }, "bash", "success");
        const ctrlErr = pair("call_ctrl_err", { content: OVER }, "grep");
        const messages = padTo([protOk[0], ctrlErr[0], protOk[1], ctrlErr[1]], 6, 4);
        assert.strictEqual(
            messages[2].content[0].result.type,
            "success",
            "precondition: the protected call's result must be a SUCCESS, or this is the errored case",
        )
        assert.ok(
            (messages[0].content[0].input.command as string).length <= 80,
            "precondition: the successful call's input is under the purge threshold, so nothing " +
                "about it could be mistaken for a purge",
        )
        assert.strictEqual(
            messages[3].content[0].result.type,
            "error",
            "precondition: the control must be an error, or the control is not a control",
        )
        assert.ok(
            !(0 > 6 - 4 - 1) && !(1 > 6 - 4 - 1),
            "precondition: both calls must be inside the age window",
        )

        purgeStaleToolErrors(messages, 4, ["bash"])

        assert.strictEqual(
            messages[1].content[0].input.content,
            MARKER,
            "a protected SUCCESSFUL call in the transcript must not stop an unprotected errored one " +
                "from being purged",
        )
        assert.strictEqual(
            messages[0].content[0].input.command,
            "ls",
            "the successful call's input is not a purge candidate and must be untouched",
        )
    })
})

// ─── resolvePruneConfig's fold, from a user's point of view ─────────────────

/** pruneOutputs on, turn protection off, so only the gate under test applies. */
function pruneConfig(purgeErrorsProtected: string[] = []): SlimConfig {
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
            protectedTools: [],
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: purgeErrorsProtected },
            pruneOutputs: { enabled: true, minChars: 2000, maxPerRequest: 50, protectedTools: [] },
            turnProtection: { enabled: false, turns: 4 },
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: true, directory: "/tmp/slim-purge-protected-test" },
    }
}

/** A 3000-char successful text result — comfortably over `minChars: 2000`. */
function bigResult(id: string, name: string): any {
    return {
        role: "tool",
        content: [
            { type: "tool-result", id, name, result: { type: "text", value: "x".repeat(3000) } },
        ],
    }
}

describe("purgeErrors.protectedTools: the output side, as a user sees it", () => {
    it("keeps a protected tool's large SUCCESSFUL output out of the prune plan, and prunes an unprotected one", () => {
        // The user-visible consequence of the fold in `resolvePruneConfig`. The
        // pre-existing "honours the legacy purgeErrors.protectedTools list"
        // test in tests/prune.test.ts asserts the plan is empty; it does not
        // say WHICH tool was spared, so it would still pass if the fold stopped
        // working and the messages simply became unprunable for some other
        // reason. Here the same plan carries both tools and only the named one
        // survives — the control is what makes it a protection verdict.
        const messages = [
            { role: "user", content: [{ type: "text", text: "go" }] },
            bigResult("prot", "mytool"),
            bigResult("ctrl", "othertool"),
        ]
        assert.ok(
            !PRUNE_ALWAYS_PROTECTED.includes("mytool") && !PRUNE_ALWAYS_PROTECTED.includes("othertool"),
            "precondition: neither fixture tool may be in the always-protected set, or the fold is " +
                "not what is under test",
        )
        assert.strictEqual(
            bigResult("x", "mytool").content[0].result.value.length,
            3000,
            "precondition: the payload must be over minChars: 2000, or nothing is eligible",
        )

        const plan = buildPrunePlan(messages, pruneConfig(["mytool"]))

        assert.ok(
            !plan.outputs.has("prot"),
            "a tool named in `purgeErrors.protectedTools` must keep its large successful output: " +
                "that is the fold's whole purpose",
        )
        assert.ok(
            plan.outputs.has("ctrl"),
            "the unprotected tool beside it must still be pruned, or this test cannot tell a " +
                "protection from a prune that stopped working",
        )
    })

    it("still prunes a protected tool's large successful output once the name leaves the list", () => {
        // The other direction, on the same fixture: the ONLY difference is
        // whether the name is in `purgeErrors.protectedTools`. Without this,
        // "not pruned" could be a property of the fixture (a small payload, an
        // already-marked value, a turn-protection gate) rather than of the fold.
        const messages = [
            { role: "user", content: [{ type: "text", text: "go" }] },
            bigResult("prot", "mytool"),
        ]
        const plan = buildPrunePlan(messages, pruneConfig([]))

        assert.ok(
            plan.outputs.has("prot"),
            "with the name off the list the identical output must be pruned, so the previous " +
                "test's 'not pruned' is attributable to the list and nothing else",
        )
    })

    it("does not protect an errored result's output, whatever the list says", () => {
        // The one thing the list does NOT buy, stated as a test because it is
        // the asymmetry a user is most likely to assume away: an errored
        // result is excluded from output pruning unconditionally, so naming a
        // tool in `purgeErrors.protectedTools` changes nothing there. The test
        // pins the behaviour so a future "let the list unblock errored outputs"
        // change is a deliberate one.
        const messages = [
            { role: "user", content: [{ type: "text", text: "go" }] },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "err",
                        name: "mytool",
                        result: { type: "error", value: "x".repeat(3000) },
                    },
                ],
            },
        ]
        const plan = buildPrunePlan(messages, pruneConfig(["mytool"]))

        assert.ok(
            !plan.outputs.has("err"),
            "an errored result's output is never pruned — the error message is the only record of " +
                "what went wrong, and the list does not unlock it",
        )
    })
})

// ─── The config-merge path ──────────────────────────────────────────────────
//
// Every other test supplies the list by calling the function or by writing a
// whole config file. The gap is the merge itself: `deepMerge` in src/lib/config.ts
// is a WHITELIST of per-sub-object spreads, so a key it forgets is dropped
// silently and the purge goes back to protecting nothing with no error anywhere.

describe("purgeErrors.protectedTools: surviving the config merge", () => {
    /** loadConfig with XDG_CONFIG_HOME pointed at a scratch dir holding `file`. */
    async function configWith(file: string): Promise<SlimConfig> {
        const previousXdg = process.env.XDG_CONFIG_HOME
        const dir = await mkdtemp(join(tmpdir(), "slim-merge-"))
        process.env.XDG_CONFIG_HOME = dir
        try {
            await mkdir(join(dir, "opencode"), { recursive: true })
            await writeFile(join(dir, "opencode", "slim.jsonc"), file, "utf-8")
            return loadConfig()
        } finally {
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previousXdg
            await rm(dir, { recursive: true, force: true })
        }
    }

    it("delivers a protectedTools list written in a config file to the purge that consumes it", async () => {
        const config = await configWith(
            JSON.stringify({
                strategies: { purgeErrors: { enabled: true, protectedTools: ["bash"] } },
            }),
        )

        assert.deepStrictEqual(
            config.strategies.purgeErrors.protectedTools,
            ["bash"],
            "the user's list must survive the merge: `deepMerge` is a whitelist of sub-object " +
                "spreads, and a key it omits is dropped with no error",
        )
        assert.strictEqual(
            config.strategies.purgeErrors.turns,
            4,
            "a partial override must inherit the default age window, not drop the key",
        )
        assert.strictEqual(
            config.strategies.purgeErrors.enabled,
            true,
            "the opt-in flag must survive the merge too",
        )

        // The merged list must actually reach the purge. The merge test alone
        // would pass even if `src/index.ts` stopped forwarding the list, so the
        // merged value is fed to the real strategy and must spare the tool.
        const messages = padTo([...pair("call_merged", { content: OVER }, "bash")], 6, 4);
        assert.strictEqual(
            messages[0].content[0].name,
            "bash",
            "precondition: the fixture's tool is the one the merged config protects",
        )
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "precondition: the result must be an error, or nothing should fire",
        )
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        purgeStaleToolErrors(messages, 4, config.strategies.purgeErrors.protectedTools)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            OVER,
            "the list as merged out of a user's config file must spare the tool it names",
        )
    })

    it("applies a merged protectedTools list to the prune plan as well as the purge", async () => {
        // The fold reads the SAME config value, so a merge that dropped the key
        // would also silently unprotect outputs. Asserting it here pins the
        // merge as the single source both consumers read.
        const config = await configWith(
            JSON.stringify({
                strategies: { purgeErrors: { protectedTools: ["mergedtool"] } },
            }),
        )
        assert.deepStrictEqual(
            config.strategies.purgeErrors.protectedTools,
            ["mergedtool"],
            "precondition on the merge itself",
        )
        config.strategies.pruneOutputs = { enabled: true, minChars: 2000, maxPerRequest: 50 }

        const messages = [
            { role: "user", content: [{ type: "text", text: "go" }] },
            bigResult("m", "mergedtool"),
        ]
        const plan = buildPrunePlan(messages, config)

        assert.ok(
            !plan.outputs.has("m"),
            "the merged list must reach the output-side fold too, or a merged config protects only " +
                "one of the two things the key is documented to protect",
        )
    })

    it("leaves the default list empty, so nothing is protected unless a user asks", async () => {
        // The other end: with no config file at all, the list must be `[]` and
        // the purge must run. A default that shipped non-empty would silently
        // protect tools for every user who never configured anything.
        const previousXdg = process.env.XDG_CONFIG_HOME
        const dir = await mkdtemp(join(tmpdir(), "slim-merge-empty-"))
        process.env.XDG_CONFIG_HOME = dir
        let config: SlimConfig
        try {
            config = loadConfig()
        } finally {
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previousXdg
            await rm(dir, { recursive: true, force: true })
        }

        assert.deepStrictEqual(
            config.strategies.purgeErrors.protectedTools,
            [],
            "the default list must be empty",
        )

        const messages = padTo([...pair("call_default", { content: OVER }, "bash")], 6, 4)
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "precondition: the result must be an error",
        )

        purgeStaleToolErrors(messages, 4, config.strategies.purgeErrors.protectedTools)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "with the default list the purge must run, including on a tool a user might have " +
                "protected in some other config",
        )
    })
})

// ─── applyPrunePlan reachability ────────────────────────────────────────────
//
// `applyPrunePlan` is imported so the fold test's consequence is checked on the
// value a user actually sees in the request, not only on the plan. A test that
// asserted a plan entry without applying it would pass even if `applyPrunePlan`
// wrote a different tool's placeholder.

describe("purgeErrors.protectedTools: the protected output reaches the request intact", () => {
    it("leaves a protected tool's output verbatim on the outgoing request while pruning its neighbour", () => {
        const messages = [
            { role: "user", content: [{ type: "text", text: "go" }] },
            bigResult("prot", "mytool"),
            bigResult("ctrl", "othertool"),
        ]
        const original = "x".repeat(3000);

        const plan = buildPrunePlan(messages, pruneConfig(["mytool"]))
        applyPrunePlan(messages, plan)

        const valueOf = (id: string) =>
            messages
                .flatMap((m: any) => m.content ?? [])
                .find((p: any) => p?.id === id).result.value;

        assert.strictEqual(
            valueOf("prot"),
            original,
            "the protected tool's output must reach the request byte-for-byte",
        )
        assert.notStrictEqual(
            valueOf("ctrl"),
            original,
            "the unprotected neighbour must be replaced on the request, or this test would pass " +
                "on a prune that never applied",
        )
        assert.ok(
            String(valueOf("ctrl")).length < original.length,
            "the pruned neighbour's payload must actually shrink",
        )
    })
})
