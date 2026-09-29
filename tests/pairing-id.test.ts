import { describe, it } from "node:test"
import assert from "node:assert"
import { pairingIdOf, purgeStaleToolErrors } from "../src/lib/strategies"
import { buildPrunePlan, applyPrunePlan, PRUNE_MARKER } from "../src/lib/prune"
import type { SlimConfig } from "../src/lib/types"

// ─── pairingIdOf: which key identifies a tool pair ──────────────────────────
//
// Regression class this section exists for: the WRONG PRECEDENCE, and — more
// importantly — a fixture that could not detect the wrong precedence.
//
// `pairingIdOf` is asked "what is the in-hook identity of this tool part?"
// There are two live shapes and the right answer differs:
//
//   - v1 (`ToolPart`): a part carries BOTH `id` (the PART id, `prt_*`) and
//     `callID` (the CALL id). The CALL lives in the assistant message and the
//     RESULT in a SEPARATE `role:"tool"` message, so the two sides carry
//     DIFFERENT `id`s and the SAME `callID`. The pairing key is `callID`.
//
//   - v2 (the hook shape production actually delivers, per
//     `node_modules/@opencode/ai/dist/schema/messages.js` — ToolCallPart and
//     ToolResultPart both REQUIRE `id`): there is no `callID` at all, and the
//     two sides share one `id`. The pairing key is `id`.
//
// So the legacy key must be read FIRST, falling back to `id`. A prior test
// pinned the opposite order and was green for the wrong reason: its two sides
// AGREED on `id`, so an `id`-first implementation passed it while mispairing
// every real v1 split pair. Every fixture below therefore asserts that the two
// `id`s genuinely DISAGREE before asserting the outcome — otherwise the test
// proves nothing about precedence.

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The marker `purgeStaleToolErrors` writes over a purged input. */
const MARKER = "[input removed due to failed tool call]"

/** 81 chars: one over the `> 80` threshold, so it must be replaced. */
const OVER = "A".repeat(81)

/**
 * Pad to `n` messages. The age gate is `i > n - turns - 1`, so index 0 is only
 * eligible once `n >= turns + 1` — a short fixture proves nothing, because
 * every index is gated out and the purge would be a no-op for reasons
 * unrelated to the id read. This is the existing helper, repeated here so this
 * file is self-contained.
 */
function padTo(messages: any[], n: number, turns: number): any[] {
    while (messages.length < n) {
        messages.push({
            id: `pad${messages.length}`,
            role: "user",
            content: [{ type: "text", text: `pad ${messages.length}` }],
        })
    }
    assert.ok(
        0 <= messages.length - turns - 1,
        `fixture is too short (n=${messages.length}, turns=${turns}): index 0 would be gated out, ` +
            `so this test could not fail for the reason it claims to check`,
    )
    return messages
}

/**
 * A v1 SPLIT pair: the call part in a `role:"assistant"` message and the result
 * part in a SEPARATE `role:"tool"` message, sharing `callID` and carrying
 * distinct part ids. This is the shape that makes precedence observable.
 *
 * `idFirst` builds the agreeing variant, which must pair under EITHER
 * precedence — a control, not a discriminator.
 */
function splitPair(opts: { agree?: boolean; name?: string } = {}): [any, any] {
    const callId = opts.agree ? "prt_SHARED" : "prt_CALL"
    const resultId = opts.agree ? "prt_SHARED" : "prt_RES"
    const name = opts.name ?? "edit"
    return [
        {
            id: "m1",
            role: "assistant",
            content: [
                { type: "tool-call", id: callId, callID: "call_1", name, input: { content: OVER } },
            ],
        },
        {
            id: "m2",
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: resultId,
                    callID: "call_1",
                    name,
                    result: { type: "error", value: "boom" },
                },
            ],
        },
    ]
}

/** A v2 pair: one shared `id`, no legacy key anywhere. */
function v2Pair(callId = "call_v2", name = "edit"): [any, any] {
    return [
        {
            id: "m1",
            role: "assistant",
            content: [{ type: "tool-call", id: callId, name, input: { content: OVER } }],
        },
        {
            id: "m2",
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: callId,
                    name,
                    result: { type: "error", value: "boom" },
                },
            ],
        },
    ]
}

function callInputAt(messages: any[], i: number): any {
    return messages[i].content[0].input
}

// ─── The key, read directly ─────────────────────────────────────────────────

describe("pairingIdOf: the key is the legacy call id, falling back to id", () => {
    it("returns `callID` for a v1 part whose `id` is a different part id", () => {
        const part = { type: "tool-call", id: "prt_CALL", callID: "call_1", name: "edit" }

        assert.strictEqual(
            pairingIdOf(part),
            "call_1",
            "on the v1 shape the pairing key is the CALL id; `id` is only the PART id",
        )
    })

    it("prefers `toolCallID` over `id` as well", () => {
        // Both legacy spellings are in use: `toolCallID` on the pre-v2 hook
        // shape, `callID` on the v1 SDK shape. Whichever is present must win.
        const part = { type: "tool-call", id: "prt_CALL", toolCallID: "call_tc", callID: "call_c", name: "edit" }
        assert.strictEqual(
            pairingIdOf(part),
            "call_tc",
            "`toolCallID` is read before `callID`, and both beat `id`",
        )
    })

    it("falls back to `id` for a v2 part, which carries no legacy key", () => {
        const part = { type: "tool-call", id: "call_v2", name: "edit" }
        assert.strictEqual(
            pairingIdOf(part),
            "call_v2",
            "a v2 part has no `callID`, so `id` — which IS the pairing key there — must be used",
        )
    })

    it("ignores an empty legacy key and falls through to `id`", () => {
        // A present-but-empty `callID` must not shadow a usable `id`; an empty
        // key is not an identity, and returning it would collide every such
        // part under one bucket.
        const part = { type: "tool-call", id: "call_v2", callID: "", name: "edit" }
        assert.strictEqual(
            pairingIdOf(part),
            "call_v2",
            "an empty `callID` is not an identity, so `id` must be used instead",
        )
    })

    it("returns undefined for a part carrying neither key", () => {
        assert.strictEqual(
            pairingIdOf({ type: "text", text: "hi" }),
            undefined,
            "a part with no id at all has no pairing key, and the caller must be able to tell",
        )
    })
})

// ─── The key, through the v1 SPLIT shape (purge) ───────────────────────────

describe("purgeStaleToolErrors: a v1 split pair pairs on the call id", () => {
    it("purges a split pair whose two part ids DISAGREE", () => {
        // THE regression. The call and the result live in different messages
        // and carry different part ids, so they match only on `callID`. An
        // `id`-first read returns `prt_CALL` for one side and `prt_RES` for
        // the other, the errored-id set comes back empty, and nothing is purged
        // — silently, since `purgeErrors` is meant to be doing work.
        const messages: any[] = padTo([...splitPair()], 6, 4)

        // Preconditions: the two sides are in DIFFERENT messages (a same-part
        // fixture cannot detect this at all), and their `id`s really differ.
        assert.strictEqual(
            messages[0].role,
            "assistant",
            "precondition: the call must be in an assistant message",
        )
        assert.strictEqual(messages[1].role, "tool", "precondition: the result must be in a separate tool message")
        assert.strictEqual(
            messages[0].content[0].callID,
            messages[1].content[0].callID,
            "precondition: the split pair shares one `callID`",
        )
        assert.ok(
            messages[0].content[0].id !== messages[1].content[0].id,
            "precondition: the PART ids must differ, else `id`-first would pair them and this " +
                "could not detect the wrong precedence",
        )
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "precondition: the result must be an error or nothing should fire",
        )
        assert.strictEqual(callInputAt(messages, 0).content.length, 81, "precondition: the input starts over the threshold")

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "`callID` must win over a disagreeing `id`; reading `id` first mispairs a v1 split pair and purges nothing",
        )
    })

    it("purges a split pair whose `id` and `callID` AGREE (either precedence pairs it)", () => {
        // The control for the test above: when the two keys agree, the fixture
        // cannot discriminate, and pairing must happen regardless. It passes
        // today and must keep passing — it is what makes the disagreement test
        // above meaningful rather than accidentally correct.
        const messages: any[] = padTo([...splitPair({ agree: true })], 6, 4)

        assert.strictEqual(
            messages[0].content[0].id,
            messages[1].content[0].id,
            "precondition: this variant is the AGREEING one, so it cannot detect precedence",
        )

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "agreeing keys must pair under either precedence",
        )
    })

    it("purges a v2 pair, which has no legacy key and shares one `id`", () => {
        // The other half: "legacy first" must not be read as "never read `id`".
        const messages: any[] = padTo([...v2Pair()], 6, 4)

        assert.strictEqual(
            messages[0].content[0].callID,
            undefined,
            "precondition: a v2 part carries no `callID`, so the fallback must be `id`",
        )
        assert.strictEqual(
            messages[0].content[0].id,
            messages[1].content[0].id,
            "precondition: the v2 pair shares one `id`",
        )

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(callInputAt(messages, 0).content, MARKER)
    })
})

// ─── The same rule, reached through collectProtectedToolOutputs ─────────────
//
// `collectProtectedToolOutputs` builds the protected section of a compression
// summary by matching a result to its call. It reads the key through
// `pairingIdOf`, so a mispaired v1 split pair loses the `output:` half of its
// entry — user-visible content loss in the summary, on a section whose whole
// purpose is to preserve exactly that.

describe("buildCompressionSummary: a v1 split pair keeps its protected output", () => {
    it("emits the output half for a split pair whose part ids disagree", async () => {
        const { buildCompressionSummary } = await import("../src/lib/strategies")
        const messages: any[] = [
            { info: { id: "u", role: "user", sessionID: "s1", time: { created: 0 } }, parts: [{ type: "text", text: "go" }] },
            {
                info: { id: "c", role: "assistant", sessionID: "s1", time: { created: 0 } },
                parts: [{ type: "tool-call", id: "prt_CALL", callID: "call_1", name: "bash", input: { command: "ls" } }],
            },
            {
                info: { id: "r", role: "tool", sessionID: "s1", time: { created: 0 } },
                parts: [
                    {
                        type: "tool-result",
                        id: "prt_RES",
                        callID: "call_1",
                        name: "bash",
                        result: { type: "text", value: "SECRETOUTPUT" },
                    },
                ],
            },
        ]

        // Precondition: the two sides disagree on `id`, so only `callID` can join them.
        assert.ok(
            (messages[1].parts[0] as any).id !== (messages[2].parts[0] as any).id,
            "precondition: the PART ids must differ or this proves nothing about precedence",
        )

        const summary = await buildCompressionSummary(messages as any, "the build", ["bash"])

        assert.ok(summary.includes("### Protected Tool Outputs"), `expected the section:\n${summary}`)
        assert.ok(
            summary.includes("SECRETOUTPUT"),
            `a protected call's output must survive compression; it was dropped because the ` +
                `result was matched by a key the split pair does not share:\n${summary}`,
        )
    })
})

// ─── prune.ts must use the SAME rule ────────────────────────────────────────
//
// `prune.ts` had its own `part?.id ?? part?.toolCallID ?? part?.callID`
// re-derivation, which carried the SAME wrong precedence as the original
// `pairingIdOf`. It now delegates to `pairingIdOf`, so the two can never drift
// apart again. The observable effect is on `pruneOutputs`: on a v1 split pair
// the result was never matched to its call, so its output was NEVER replaced by
// the placeholder — the strategy silently did nothing on exactly the shape it
// was meant to shrink.

/** A payload comfortably over the default 2000-char prune threshold. */
const BIG = "x".repeat(3000)

function pruneConfig(): SlimConfig {
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
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
            pruneOutputs: { enabled: true },
            turnProtection: { enabled: false },
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: true, directory: "/tmp/slim-pairing-prune" },
    } as SlimConfig
}

describe("pruneOutputs: a v1 split pair is keyed on the call id", () => {
    it("plans the split pair's output under the shared `callID`", () => {
        // `bash`, not the `edit` the purge fixtures use: `edit` is in
        // PRUNE_ALWAYS_PROTECTED, so it is never a prune candidate at all and
        // would make these tests pass for the wrong reason.
        const [call, result] = splitPair({ agree: false, name: "bash" })
        // A large, successful payload: the prune path replaces COMPLETED
        // outputs, and an errored one is owned by purgeStaleToolErrors.
        result.content[0].result = { type: "text", value: BIG }
        const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, call, result]

        assert.ok(
            call.content[0].id !== result.content[0].id,
            "precondition: the PART ids must differ, else `id`-first would key them identically " +
                "and this could not detect the wrong precedence",
        )

        const plan = buildPrunePlan(messages, pruneConfig())

        assert.ok(
            plan.outputs.has("call_1"),
            `the plan must key the output on the shared \`callID\`; a plan keyed on the part ids ` +
                `(${JSON.stringify([...plan.outputs.keys()])}) can never match the result part`,
        )
    })

    it("replaces the split pair's output payload with the placeholder", () => {
        // The BEHAVIOUR change: before the delegation fix, `pruneOutputs` on a
        // v1 split pair planned nothing and replaced nothing.
        const [call, result] = splitPair({ agree: false, name: "bash" })
        result.content[0].result = { type: "text", value: BIG }
        const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, call, result]

        assert.strictEqual(
            result.content[0].result.value,
            BIG,
            "precondition: the payload starts as the real output",
        )

        const plan = buildPrunePlan(messages, pruneConfig())
        assert.strictEqual(plan.stats.prunedOutputs, 1, "precondition: exactly one output is planned")

        applyPrunePlan(messages, plan)

        // Read back through the ARRAY, not through the `result` local: a
        // changed message is swapped for a clone, so the local still points at
        // the untouched original. Asserting on it would pass no matter what
        // `applyPrunePlan` did — the very defect class this audit is about.
        const applied = messages[2].content[0].result
        assert.notStrictEqual(
            messages[2],
            result,
            "precondition: a changed message must be replaced by a clone, so the local is stale",
        )
        assert.strictEqual(
            applied.type,
            "text",
            "the result type must survive — changing it is a 400 that kills the session",
        )
        assert.ok(
            String(applied.value).startsWith(PRUNE_MARKER),
            `the split pair's output must actually be replaced; the delegation to ` +
                `\`pairingIdOf\` is what makes this work, and before it this payload survived untouched`,
        )
    })

    it("prunes a split pair whose result part carries no name of its own", () => {
        // The case that actually discriminates the delegation. A tool-result
        // part often does NOT repeat the tool's name — the name is resolved
        // from the CALL part via the shared key. With a local `id`-first
        // re-derivation the call is registered under `prt_CALL` while the
        // result is keyed `prt_RES`, the lookup misses, the name stays
        // unresolved, and the unresolved name means the protected list cannot
        // be checked → lock. The result is then never pruned at all, silently.
        //
        // This is why the two tests above are not redundant: with a `name` on
        // the result part, an `id`-first re-derivation happens to agree with
        // the delegation and both prune. Only the unnamed-result shape
        // separates them.
        const [call] = splitPair({ agree: false, name: "bash" })
        const result: any = {
            id: "m2",
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "prt_RES",
                    callID: "call_1",
                    // deliberately NO `name` — resolved from the call instead
                    result: { type: "text", value: BIG },
                },
            ],
        }
        const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, call, result]

        assert.strictEqual(
            "name" in result.content[0],
            false,
            "precondition: the result part must not carry a name, else the lookup cannot be exercised",
        )
        assert.strictEqual(
            call.content[0].name,
            "bash",
            "precondition: the CALL must carry the name that has to be resolved",
        )

        const plan = buildPrunePlan(messages, pruneConfig())

        assert.strictEqual(
            plan.stats.prunedOutputs,
            1,
            `the unnamed result must still be pruned: its tool name is resolvable through the ` +
                `shared \`callID\`, and a plan keyed on the part ids resolves nothing and locks the part`,
        )

        applyPrunePlan(messages, plan)
        assert.ok(
            String(messages[2].content[0].result.value).startsWith(PRUNE_MARKER),
            "the unnamed split pair's output must be replaced with the placeholder",
        )
    })

    it("still prunes a v2 pair, keyed on the shared `id`", () => {
        // The control: the delegation must not have broken the shape that
        // always worked.
        const [call, result] = v2Pair("call_v2", "bash")
        result.content[0].result = { type: "text", value: BIG }
        const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, call, result]

        const plan = buildPrunePlan(messages, pruneConfig())
        assert.ok(plan.outputs.has("call_v2"), "a v2 pair must be keyed on its shared `id`")

        applyPrunePlan(messages, plan)
        assert.ok(
            String(messages[2].content[0].result.value).startsWith(PRUNE_MARKER),
            "a v2 pair's output must still be replaced",
        )
    })
})
