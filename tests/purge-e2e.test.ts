import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import slimPlugin from "../src/index"
import { pairingIdOf } from "../src/lib/strategies"

// ─── purgeStaleToolErrors END TO END, through the real context hook ────────
//
// The whole strategy was shipped with unit tests that call
// `purgeStaleToolErrors` directly, and one end-to-end test on the v2 shape
// (tests/tool-pair-guard.test.ts). What no test covers is the thing that
// actually broke it: the id the HOST delivers. `pairingIdOf` reads the legacy
// key (`toolCallID` ?? `callID`) FIRST and only then falls back to `id`,
// because on the v1 `ToolPart` shape a part carries BOTH `id` (the PART id,
// `prt_*`) and `callID` (the CALL id) and the two DIFFER between the two
// sides of a split pair.
//
// If the host ever changes the shape it delivers, or the flag is flipped, or
// the id precedence is reordered, only an end-to-end test notices. Everything
// below therefore drives the real `session.hook("context")` callback with a
// message array, never an inner function, and every fixture asserts its own
// precondition BEFORE asserting the outcome — so a test cannot pass by
// failing to pair at all.

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The exact marker the production code writes over a purged input string. */
const MARKER = "[input removed due to failed tool call]"

/** 81 chars: one over the `> 80` threshold in `purgeStaleToolErrors`. */
const OVER = "A".repeat(81)
/** Exactly 80: the threshold is `> 80`, so this must survive verbatim. */
const AT_LIMIT = "B".repeat(80)

/**
 * Pad to `n` messages. The age gate is `i > n - turns - 1` (skip), so index 0
 * is only eligible once `n >= turns + 1`: a short fixture would have every
 * index gated out and the purge would be a no-op for reasons unrelated to
 * pairing — the vacuous-test failure mode. `padTo` asserts that eligibility
 * itself, so a fixture can never be built in a shape where nothing can fire.
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
        `fixture is too short (n=${messages.length}, turns=${turns}): index 0 would be gated ` +
            `out, so this test could not fail for the reason it claims to check`,
    )
    return messages
}

/** An ordinary user message — filler with no tool parts. */
function filler(id: string, text: string): any {
    return { id, role: "user", content: [{ type: "text", text }] }
}

/**
 * The v1 (legacy transcript) split pair, in the shape that actually occurs:
 * the CALL part lives in an assistant message and the RESULT in a separate
 * `role:"tool"` message, both carrying the SAME `callID` and DIFFERENT `id`s
 * (the PART ids). Reading `id` first returns `prt_CALL` for one side and
 * `prt_RES` for the other, so the pair never matches and nothing is purged.
 */
function v1SplitPair(
    callId: string,
    input: Record<string, unknown>,
    resultType = "error",
): [any, any] {
    return [
        {
            id: `msg-call-${callId}`,
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    id: `prt_CALL_${callId}`,
                    callID: callId,
                    name: "edit",
                    input,
                },
            ],
        },
        {
            id: `msg-res-${callId}`,
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: `prt_RES_${callId}`,
                    callID: callId,
                    name: "edit",
                    result: { type: resultType, value: "boom" },
                },
            ],
        },
    ]
}

/** The v2 hook shape: a `tool-call` and its `tool-result`, sharing one `id`. */
function v2SplitPair(
    callId: string,
    input: Record<string, unknown>,
    resultType = "error",
): [any, any] {
    return [
        {
            id: `msg-call-${callId}`,
            role: "assistant",
            content: [{ type: "tool-call", id: callId, name: "edit", input }],
        },
        {
            id: `msg-res-${callId}`,
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: callId,
                    name: "edit",
                    result: { type: resultType, value: "boom" },
                },
            ],
        },
    ]
}

/** The `input` object of the tool-call at message index `i`, post-hook. */
function callInputAt(messages: any[], i: number): any {
    return messages[i].content[0].input
}

/** The `state.input` object of the v1 `type:"tool"` part at index `i`. */
function v1StateInputAt(messages: any[], i: number): any {
    return messages[i].content[0].state.input
}

// ─── The hook harness ──────────────────────────────────────────────────────
//
// Drives the real plugin: `setup()` registers the context hook against a fake
// host, and `runContext` pushes a message array through the registered
// callback, exactly as the host would.

interface PluginHarness {
    runContext: (messages: any[], sessionID: string) => Promise<any>
}

function makePluginHarness(transcript: any[] = []): PluginHarness {
    const contextHooks: ((event: any) => any)[] = []

    const ctx: any = {
        model: {
            default: async () => ({
                data: {
                    providerID: "test",
                    modelID: "model",
                    limit: { context: 1_000_000 },
                },
            }),
            list: async () => ({ data: [] }),
        },
        tool: {
            transform: async (register: any) => register({ add: () => {} }),
        },
        session: {
            hook: async (name: string, cb: any) => {
                if (name === "context") contextHooks.push(cb)
            },
            context: async () => transcript,
            get: async () => null,
        },
        event: {
            subscribe: async function* () {
                // no host events: the pipeline must work on a cold session
            },
        },
    }

    return {
        runContext: async (messages: any[], sessionID: string) => {
            await (slimPlugin as any).setup(ctx)
            const event: any = { sessionID, messages, system: [], tools: [] }
            for (const hook of contextHooks) await hook(event)
            return event
        },
    }
}

describe("purgeStaleToolErrors end to end: the v1 tool shape, through the real hook", () => {
    let dir: string
    let previousXdg: string | undefined

    /**
     * Run one request through the real context hook under the given config.
     * Every fixture here starts from a COLD session (fresh state directory), so
     * nothing is removed by a compression block carried over from a previous
     * request — a removal would be a second reason for a message to be gone.
     */
    async function runHook(
        messages: any[],
        purgeErrors: Record<string, unknown> | undefined,
        sessionID = "purge-e2e",
    ): Promise<any[]> {
        const body: Record<string, unknown> = {
            enabled: true,
            compress: {
                enabled: true,
                // Absolute token counts (resolveThreshold reads a bare number
                // as tokens, not a percent), set far above these short
                // fixtures: the limit-nudge and auto-compress steps would
                // otherwise rewrite the array, and a second mutation
                // competing with the one under test is how a test ends up
                // passing for the wrong reason.
                maxContextLimit: 900_000,
                minContextLimit: 500_000,
            },
        }
        if (purgeErrors) body.strategies = { purgeErrors }
        await mkdir(join(dir, "opencode"), { recursive: true })
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({ ...body, persistence: { enabled: true, directory: join(dir, "state") } }),
            "utf-8",
        )
        const harness = makePluginHarness([])
        const event = await harness.runContext(messages, sessionID)
        return event.messages
    }

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-purge-e2e-"))
        process.env.XDG_CONFIG_HOME = dir
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
    })

    it("purges the oversized input of a v1 split pair whose two ids DIFFER, when purgeErrors is on", async () => {
        const messages = padTo([...v1SplitPair("call_v1", { content: OVER })], 6, 4)

        // Preconditions. Without these the test could pass because nothing
        // paired, not because the v1 shape is handled.
        assert.strictEqual(
            messages[0].content[0].callID,
            messages[1].content[0].callID,
            "precondition: a v1 split pair shares ONE callID",
        );
        assert.ok(
            messages[0].content[0].id !== messages[1].content[0].id,
            "precondition: the PART ids must DIFFER, or an `id`-first pairingIdOf would also " +
                "pair this fixture and the test would prove nothing",
        );
        assert.strictEqual(
            pairingIdOf(messages[0].content[0]),
            "call_v1",
            "precondition: both sides must resolve to the same pairing id",
        );
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "precondition: the result must actually be an error, or nothing should fire",
        );
        assert.ok(
            !(0 > 6 - 4 - 1),
            "precondition: index 0 must be inside the age window for this fixture",
        )
        assert.strictEqual(callInputAt(messages, 0).content.length, 81, "precondition: over the threshold")

        const after = await runHook(messages, { enabled: true, turns: 4 })

        assert.strictEqual(
            after.length,
            messages.length,
            "precondition after the hook: the purge must not have removed any message, or the " +
                "marker assertion below would be measuring a drop",
        );
        assert.strictEqual(
            callInputAt(after, 0).content,
            MARKER,
            "the v1 split pair must be purged through the real hook: an `id`-first read returns " +
                "two different ids, the errored set never matches, and the strategy does nothing " +
                "while the flag says it is on",
        )
    })

    it("leaves a v1 split pair byte-for-byte untouched when purgeErrors is off (the default)", async () => {
        // The end-to-end proof that the FLAG is the only thing between inert and
        // active: the identical array, with no `strategies` block at all, must
        // come out of the same hook unchanged. If this failed, either the flag
        // is ignored or the default is not actually off.
        const messages = padTo([...v1SplitPair("call_v1", { content: OVER })], 6, 4);
        assert.strictEqual(
            pairingIdOf(messages[0].content[0]),
            "call_v1",
            "precondition: this fixture is one the enabled path provably rewrites",
        )
        // Compared against a SNAPSHOT, never against `messages` itself: the
        // enabled path mutates in place, so a live-reference comparison would
        // be vacuous.
        const snapshot = structuredClone(messages)

        const after = await runHook(messages, undefined)

        assert.strictEqual(after.length, messages.length, "no message may be added or dropped");
        for (let i = 0; i < after.length; i++) {
            assert.deepStrictEqual(
                after[i],
                snapshot[i],
                `message ${i} must be byte-for-byte unchanged with purgeErrors off by default`,
            )
        }
        assert.strictEqual(
            callInputAt(after, 0).content,
            OVER,
            "the oversized errored input must survive verbatim while the flag is off",
        )
    })

    it("purges the v2 shape through the same hook, as the control for the v1 case", async () => {
        // Both shapes must work. A "fix" that only handled one — e.g. dropping
        // the `id` fallback after adding the legacy read — would be green on
        // the v1 fixture above and broken on every real v2 request.
        const messages = padTo([...v2SplitPair("call_v2", { content: OVER })], 6, 4);
        assert.strictEqual(
            messages[0].content[0].callID,
            undefined,
            "precondition: a v2 part carries no `callID`, so the legacy read must fall through",
        );
        assert.strictEqual(
            pairingIdOf(messages[0].content[0]),
            "call_v2",
            "precondition: the v2 pair resolves to its shared `id`",
        );
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        const after = await runHook(messages, { enabled: true, turns: 4 })

        assert.strictEqual(
            callInputAt(after, 0).content,
            MARKER,
            "the v2 shape must still purge: the legacy key is absent, so pairing depends " +
                "entirely on the `id` fallback",
        )
    })

    it("purges the v1 single-part `type:\"tool\"` transcript shape through the hook", async () => {
        // The other legacy shape the strategy reads (Format 2): ONE part
        // carries the call, its `callID` and its `state`, and an errored one is
        // both the registration of the error and the thing whose `state.input`
        // is rewritten. It carries a PART `id` distinct from the `callID`, so
        // it is the same precedence question seen from the other branch.
        const messages = padTo(
            [
                filler("pad-a", "earlier work"),
                {
                    id: "msg-v1-tool",
                    role: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "prt_ONLY",
                            callID: "call_tool",
                            tool: "bash",
                            state: {
                                status: "error",
                                input: { command: OVER },
                                error: "exit 1",
                            },
                        },
                    ],
                },
            ],
            6,
            4,
        );
        assert.strictEqual(
            messages[1].content[0].state.status,
            "error",
            "precondition: the part must be an errored v1 tool part",
        );
        assert.ok(
            messages[1].content[0].id !== messages[1].content[0].callID,
            "precondition: the PART id and the CALL id must differ on this shape",
        );
        assert.ok(!(1 > 6 - 4 - 1), "precondition: index 1 must be inside the age window")

        const after = await runHook(messages, { enabled: true, turns: 4 });

        assert.strictEqual(
            v1StateInputAt(after, 1).command,
            MARKER,
            "an errored v1 `type:\"tool\"` part's oversized state.input must be purged through " +
                "the real hook",
        );
        assert.strictEqual(
            after[1].content[0].state.status,
            "error",
            "only the input is rewritten: the error status that triggered the purge stays",
        )
    })
})

// ─── purgeStaleToolErrors on its first real run: what the flag actually does ─
//
// `strategies.purgeErrors.enabled` now defaults to `false` because the code
// path had never executed in production. A user who opts in is therefore the
// first real user of a code path, which is exactly the case that needs
// end-to-end pinning rather than a direct call into the function.

describe("purgeErrors enabled: the opted-in behaviour, through the real hook", () => {
    let dir: string
    let previousXdg: string | undefined

    async function runHook(
        messages: any[],
        purgeErrors: Record<string, unknown>,
        sessionID = "purge-on",
    ): Promise<any[]> {
        await mkdir(join(dir, "opencode"), { recursive: true })
        await writeFile(
            join(dir, "opencode", "slim.jsonc"),
            JSON.stringify({
                enabled: true,
                compress: {
                    enabled: true,
                    maxContextLimit: 900_000,
                    minContextLimit: 500_000,
                },
                strategies: { purgeErrors },
                persistence: { enabled: true, directory: join(dir, "state") },
            }),
            "utf-8",
        )
        const harness = makePluginHarness([])
        const event = await harness.runContext(messages, sessionID)
        return event.messages
    }

    beforeEach(async () => {
        previousXdg = process.env.XDG_CONFIG_HOME
        dir = await mkdtemp(join(tmpdir(), "slim-purge-on-"))
        process.env.XDG_CONFIG_HOME = dir
    })

    afterEach(async () => {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        await rm(dir, { recursive: true, force: true })
    })

    it("keeps an input of exactly 80 characters and replaces one of 81", async () => {
        // The threshold is a strict `> 80`, read from the source rather than
        // assumed. Both calls sit at age-eligible indices and both results are
        // errors, so the ONLY variable between them is the string length: an
        // off-by-one to `>= 80` would rewrite inputs that were small enough to
        // be worth keeping.
        const at = v2SplitPair("call_at", { content: AT_LIMIT });
        const over = v2SplitPair("call_over", { content: OVER })
        const messages = padTo([at[0], over[0], at[1], over[1]], 6, 4);
        assert.strictEqual(AT_LIMIT.length, 80, "precondition: the at-limit fixture is 80 chars");
        assert.strictEqual(OVER.length, 81, "precondition: the over fixture is 81 chars");
        assert.strictEqual(messages[2].content[0].result.type, "error", "precondition: at-limit is errored");
        assert.strictEqual(messages[3].content[0].result.type, "error", "precondition: over is errored");
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window");
        assert.ok(!(1 > 6 - 4 - 1), "precondition: index 1 must be inside the age window");

        const after = await runHook(messages, { enabled: true, turns: 4 });

        assert.strictEqual(
            callInputAt(after, 0).content,
            AT_LIMIT,
            "80 characters is not over the threshold and must be kept verbatim",
        );
        assert.strictEqual(
            callInputAt(after, 1).content,
            MARKER,
            "81 characters is over the threshold and must be replaced by the exact marker",
        )
    })

    it("never rewrites a non-string input value, against a snapshot taken before the call", async () => {
        // Only `typeof value === "string"` is in scope: a structured payload in
        // `input` (a file map, a patch object) must not be swapped for a string
        // marker, which would change the request's shape.
        //
        // The expectation is a `structuredClone` SNAPSHOT taken before the hook
        // ran. The purge mutates in place, so the live object IS the mutated
        // object: comparing it to itself is vacuous and passes even after every
        // value in it has been destroyed. A sibling over-threshold string on
        // another errored call in the SAME window is the control that proves
        // the purge path actually ran.
        const payload = {
            num: 12345678901234567890,
            obj: { blob: "C".repeat(500) },
            arr: ["D".repeat(500)],
            nil: null,
            undef: undefined,
            bool: true,
        }
        const control = { content: OVER }
        const shapes = v2SplitPair("call_shapes", payload)
        const ctrl = v2SplitPair("call_control", control)
        const messages = padTo(
            [shapes[0], ctrl[0], shapes[1], ctrl[1]],
            8,
            4,
        );
        assert.strictEqual(
            messages[2].content[0].result.type,
            "error",
            "precondition: the shape pair must be errored, or this passes vacuously",
        );
        assert.strictEqual(
            messages[3].content[0].result.type,
            "error",
            "precondition: the control pair must be errored too, or the control proves nothing",
        );
        assert.ok(
            !(0 > 8 - 4 - 1) && !(1 > 8 - 4 - 1),
            "precondition: BOTH pairs must be inside the age window, or the control is not a control",
        )
        const snapshot = structuredClone(payload)

        const after = await runHook(messages, { enabled: true, turns: 4 });

        // Control first: if the purge never ran, everything after it is noise.
        assert.strictEqual(
            callInputAt(after, 1).content,
            MARKER,
            "control: the over-threshold string on the sibling call MUST be rewritten, otherwise " +
                "this test cannot prove the purge path ran",
        );

        const live = callInputAt(after, 0);
        assert.strictEqual(
            live,
            payload,
            "precondition on the assertion itself: the purge mutates the caller's object in " +
                "place, so `live` and `payload` are the same reference and comparing them would " +
                "be vacuous — which is why the expectation is the pre-hook snapshot",
        );
        assert.deepStrictEqual(
            live,
            snapshot,
            "no non-string input value may be rewritten: numbers, objects, arrays, null and " +
                "undefined must come through the enabled purge untouched",
        );
        assert.strictEqual(
            live.obj.blob.length,
            500,
            "a nested 500-char string is a value, not a top-level string, so it must survive",
        )
    })

    it("purges the last index inside the turns window and spares the first one outside it", async () => {
        // The gate is `i > n - turnsEffective - 1` → skip. With n=6 and turns=4
        // the eligible indices are 0..1 and index 2 is the FIRST gated-out
        // position. Eligibility is derived from the formula, not guessed, and
        // asserted before the outcome so the fixture cannot be a shape in which
        // nothing can fire.
        const a = v2SplitPair("call_a", { content: OVER });
        const b = v2SplitPair("call_b", { content: OVER });
        const c = v2SplitPair("call_c", { content: OVER })
        const messages = padTo([a[0], b[0], c[0], a[1], b[1], c[1]], 6, 4);
        assert.strictEqual(messages.length, 6, "precondition: the age gate reads the array length");
        assert.ok(!(1 > 6 - 4 - 1), "precondition: index 1 is the last eligible position");
        assert.ok(2 > 6 - 4 - 1, "precondition: index 2 is the first gated-out position");
        for (const i of [3, 4, 5]) {
            assert.strictEqual(
                messages[i].content[0].result.type,
                "error",
                `precondition: the result backing index ${i - 3} is an error`,
            )
        }

        const after = await runHook(messages, { enabled: true, turns: 4 });

        assert.strictEqual(
            callInputAt(after, 1).content,
            MARKER,
            "index 1 is the last index inside the window and must be purged",
        );
        assert.strictEqual(
            callInputAt(after, 2).content,
            OVER,
            "index 2 is the first index outside the window and must be untouched: the `turns` " +
                "value is what makes a call recent, and a too-recent call must keep its input",
        )
    })

    it("purges a call that `turns: 1` treats as stale and spares the same call under `turns: 2`", async () => {
        // The window is read from config, so the SAME array must get opposite
        // verdicts under two values of `turns` — the strongest available proof
        // that the age gate is live and that "too recent" is a real, reachable
        // state rather than an assertion about a constant. With n=6: turns=1
        // leaves indices 0..4 eligible, turns=2 leaves 0..3, so a call at
        // index 4 flips from purged to spared and nothing else changes.
        const pair = v2SplitPair("call_recent", { content: OVER });
        const messages = padTo(
            [filler("f0", "a"), filler("f1", "b"), filler("f2", "c"), filler("f3", "d"), pair[0], pair[1]],
            6,
            1,
        );
        assert.ok(4 <= 6 - 1 - 1, "precondition: index 4 is eligible at turns=1");
        assert.ok(4 > 6 - 2 - 1, "precondition: index 4 is gated out at turns=2");
        assert.strictEqual(
            messages[5].content[0].result.type,
            "error",
            "precondition: the call at index 4 is answered by an error",
        )
        assert.strictEqual(callInputAt(messages, 4).content.length, 81, "precondition: over the threshold")

        const staleEnough = await runHook(
            structuredClone(messages),
            { enabled: true, turns: 1 },
            "purge-turns-1",
        );
        const tooRecent = await runHook(
            structuredClone(messages),
            { enabled: true, turns: 2 },
            "purge-turns-2",
        );

        assert.strictEqual(
            callInputAt(staleEnough, 4).content,
            MARKER,
            "at turns=1 index 4 is still inside the window and must be purged",
        );
        assert.strictEqual(
            callInputAt(tooRecent, 4).content,
            OVER,
            "at turns=2 the identical call is too recent to be stale and must keep its input: a " +
                "call the user can still act on must not be stripped",
        )
    })

    it("protects a tool input by name: purgeErrors.protectedTools exempts the tool from the purge", async () => {
        // This test previously PINNED THE DEFECT: it asserted that a tool named
        // in `purgeErrors.protectedTools` still had its errored input rewritten,
        // because the list was read in exactly one place — `resolvePruneConfig`
        // in src/lib/prune.ts, which gates the tool-OUTPUT prune — and
        // `purgeStaleToolErrors(messages, turns)` took no tool list at all. An
        // errored result is excluded from output pruning precisely so the purge
        // owns it, so the list protected nothing on either path.
        //
        // The list is now passed into the purge, which skips a protected tool on
        // BOTH sides: the errored result does not register its call id, and the
        // call-rewrite pass re-checks. The unprotected sibling pair is the
        // control that proves the purge still ran, without it a no-op would
        // pass for the same reason as a skip.
        const protectedPair = v2SplitPair("call_protected", { content: OVER });
        protectedPair[0].content[0].name = "bash";
        protectedPair[1].content[0].name = "bash"
        const controlPair = v2SplitPair("call_control2", { content: OVER });
        const messages = padTo(
            [protectedPair[0], controlPair[0], protectedPair[1], controlPair[1]],
            6,
            4,
        );
        assert.strictEqual(
            messages[0].content[0].name,
            "bash",
            "precondition: the fixture really is on the protected list",
        );
        assert.strictEqual(
            messages[2].content[0].result.type,
            "error",
            "precondition: the protected pair's result must be an error, or nothing should fire",
        );
        assert.strictEqual(
            messages[3].content[0].result.type,
            "error",
            "precondition: the control pair's result must be an error too, or the control is not a control",
        );
        assert.ok(!(0 > 6 - 4 - 1) && !(1 > 6 - 4 - 1), "precondition: both pairs are age-eligible")

        const after = await runHook(messages, { enabled: true, turns: 4, protectedTools: ["bash"] });

        assert.strictEqual(
            callInputAt(after, 1).content,
            MARKER,
            "control: an UNPROTECTED tool's errored input must still be rewritten, otherwise this " +
                "test cannot tell a skip from a purge that never ran",
        );
        assert.strictEqual(
            callInputAt(after, 0).content,
            OVER,
            "a tool named in `purgeErrors.protectedTools` must keep its errored input verbatim. " +
                "If this fails, the list is being read again without reaching the purge",
        )
    })

    it("skips a protected v1 `type:\"tool\"` part, whose name lives in `tool`, not `name`", async () => {
        // The v1 shape names the tool in the SDK's `tool` field. A filter that
        // only read `name` would miss it entirely and purge a protected tool —
        // silently, because the user spelled the name exactly as the SDK does.
        const messages = padTo(
            [
                filler("pad-b", "earlier work"),
                {
                    id: "msg-v1-protected",
                    role: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "prt_PROT",
                            callID: "call_protected_tool",
                            tool: "bash",
                            state: { status: "error", input: { command: OVER }, error: "exit 1" },
                        },
                    ],
                },
            ],
            6,
            4,
        );
        assert.strictEqual(
            messages[1].content[0].tool,
            "bash",
            "precondition: the v1 tool name is in `tool`, and the part carries no `name`",
        );
        assert.strictEqual(
            messages[1].content[0].name,
            undefined,
            "precondition: this shape must NOT carry `name`, or the `tool` read is untested",
        );
        assert.ok(!(1 > 6 - 4 - 1), "precondition: index 1 must be inside the age window")

        const after = await runHook(messages, { enabled: true, turns: 4, protectedTools: ["bash"] });

        assert.strictEqual(
            v1StateInputAt(after, 1).command,
            OVER,
            "the v1 `tool` field must be honoured by the protected-tool filter, or a protected " +
                "tool's errored state.input is still rewritten",
        )
    })

    it("still purges when a pair's name cannot be determined, rather than protecting everything", async () => {
        // The conservative direction. The name is read per part and is never
        // borrowed from the other side of the pair; when the part carries none,
        // the filter cannot match and must NOT skip. Failing closed would make
        // the purge silently inert for any transcript the host delivers without
        // names, which is a far worse failure than over-purging a tool the user
        // cannot name anyway.
        const pair = v2SplitPair("call_nameless", { content: OVER });
        delete pair[0].content[0].name;
        delete pair[1].content[0].name
        const messages = padTo([pair[0], pair[1]], 6, 4);
        assert.strictEqual(
            messages[0].content[0].name,
            undefined,
            "precondition: the fixture really has no name on either side",
        );
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        const after = await runHook(messages, { enabled: true, turns: 4, protectedTools: ["bash"] });

        assert.strictEqual(
            callInputAt(after, 0).content,
            MARKER,
            "an undeterminable name must NOT count as a match: the protected list is a whitelist, " +
                "and an unknown name is not in it",
        )
    })

    it("spares a nameless call when its result's OWN name is protected, without borrowing across the pair", async () => {
        // The result side carries the name, so the COLLECTION pass — which reads
        // the result part — declines to register the call id and the pair is
        // never purged. That is the whole mechanism.
        //
        // This test used to be named "protects a nameless call whose result
        // side carries the name" and claimed the name was read off the OTHER
        // side of the pair. It was not, and it never could be: the collection
        // pass is the one that sees the result, and a result it spares is never
        // registered, so the rewrite pass — the only reader that would have
        // needed a cross-side lookup — is never reached for this pair. The
        // outcome was right and the reason was fiction; the name and this
        // comment now say what actually happens.
        const call = v2SplitPair("call_nameonresult", { content: OVER });
        delete call[0].content[0].name;
        call[1].content[0].name = "bash"
        const messages = padTo([call[0], call[1]], 6, 4);
        assert.strictEqual(
            messages[0].content[0].name,
            undefined,
            "precondition: the CALL side carries no name, so the only name available is on the result",
        );
        assert.strictEqual(
            messages[1].content[0].name,
            "bash",
            "precondition: the result side carries the name, and the collection pass reads THIS part",
        );
        assert.ok(!(0 > 6 - 4 - 1), "precondition: index 0 must be inside the age window")

        const after = await runHook(messages, { enabled: true, turns: 4, protectedTools: ["bash"] });

        assert.strictEqual(
            callInputAt(after, 0).content,
            OVER,
            "the errored result's own name is protected, so its call id is never registered and " +
                "the call is never rewritten — no cross-side lookup is involved or needed",
        )
    })

    it("pairs a call to its errored result on `callID` when the two sides disagree on `id`", async () => {
        // The precedence question, end to end. Both fixtures go through the
        // same hook with the same flag; only the id shape differs, so this
        // pins BOTH halves of the rule in the place that decides it.
        const v1 = padTo([...v1SplitPair("call_precedence", { content: OVER })], 6, 4);
        const v2 = padTo([...v2SplitPair("call_precedence", { content: OVER })], 6, 4);
        assert.ok(
            v1[0].content[0].id !== v1[1].content[0].id,
            "precondition: the v1 sides disagree on `id`, so only `callID` can pair them",
        );
        assert.strictEqual(
            v2[0].content[0].callID,
            undefined,
            "precondition: the v2 sides carry no `callID`, so only `id` can pair them",
        )

        const v1After = await runHook(v1, { enabled: true, turns: 4 }, "precedence-v1");
        const v2After = await runHook(v2, { enabled: true, turns: 4 }, "precedence-v2");

        assert.strictEqual(
            callInputAt(v1After, 0).content,
            MARKER,
            "the legacy key must win: the call and its errored result share `callID` but not `id`",
        );
        assert.strictEqual(
            callInputAt(v2After, 0).content,
            MARKER,
            "and with no legacy key present the `id` fallback must still pair, or the v2 shape " +
                "stops being purged entirely",
        )
    })
})
