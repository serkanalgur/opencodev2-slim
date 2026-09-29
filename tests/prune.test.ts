import { describe, it } from "node:test"
import assert from "node:assert"
import {
    PRUNE_MARKER,
    PRUNE_ALWAYS_PROTECTED,
    serializedToolResultSize,
    renderPrunePlaceholder,
    buildPrunePlan,
    applyPrunePlan,
} from "../src/lib/prune"
import type { SlimConfig } from "../src/lib/types"

// ─── Tool-output pruning (src/lib/prune.ts) ─────────────────────────────────
//
// These tests lock the *session-survival* invariants of pruneOutputs. The
// failure mode they guard against is not a wrong placeholder — it is a 400 that
// kills the session:
//
//   1. a message or tool-call/tool-result pairing is removed;
//   2. a `result.type` is changed (turning a `json` value into a string);
//   3. the caller's live message objects are mutated in place;
//   4. turn protection / size / protected-tool / idempotency gates leak;
//   5. the prune frontier jitters between two consecutive requests.

// A payload comfortably over the default 2000-char threshold.
const BIG = "x".repeat(3000)

// ─── Fixtures ───────────────────────────────────────────────────────────────

function slimConfig(): SlimConfig {
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
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: true, directory: "/tmp/slim-prune-test" },
    }
}

type PruneOverrides = Partial<NonNullable<SlimConfig["strategies"]["pruneOutputs"]>>
type TurnOverrides = Partial<NonNullable<SlimConfig["strategies"]["turnProtection"]>>

/** Opt-in config: pruneOutputs explicitly enabled, unless overridden. */
function withPrune(prune: PruneOverrides = {}, turn?: TurnOverrides): SlimConfig {
    const config = slimConfig()
    config.strategies.pruneOutputs = { enabled: true, ...prune }
    if (turn) config.strategies.turnProtection = turn
    return config
}

/** Turn protection off, so fixtures stay focused on the gate under test. */
function pruneNoTurnProtection(prune: PruneOverrides = {}): SlimConfig {
    return withPrune(prune, { enabled: false })
}

function user(text = "go"): any {
    return { role: "user", content: [{ type: "text", text }] }
}

function toolCall(id: string, name: string): any {
    return { role: "assistant", content: [{ type: "tool-call", id, name, input: {} }] }
}

function resultOf(id: string, name: string, type: string, value: unknown): any {
    return { role: "tool", content: [{ type: "tool-result", id, name, result: { type, value } }] }
}

function textResult(id: string, name: string, value: string = BIG): any {
    return resultOf(id, name, "text", value)
}

function jsonResult(id: string, name: string, value: unknown = { blob: BIG }): any {
    return resultOf(id, name, "json", value)
}

function contentResult(
    id: string,
    name: string,
    blocks: any[] = [
        { type: "text", text: BIG },
        { type: "file", uri: "file:///a.png", mime: "image/png", name: "a.png" },
    ],
): any {
    return resultOf(id, name, "content", blocks)
}

function contentOf(message: any): any[] {
    const content = message?.content ?? message?.parts ?? []
    return Array.isArray(content) ? content : []
}

function countParts(messages: readonly any[], type: string): number {
    let count = 0
    for (const message of messages) {
        for (const part of contentOf(message)) if (part?.type === type) count += 1
    }
    return count
}

function idsOfType(messages: readonly any[], type: string): string[] {
    const ids: string[] = []
    for (const message of messages) {
        for (const part of contentOf(message)) {
            if (part?.type === type && typeof part.id === "string") ids.push(part.id)
        }
    }
    return ids.sort()
}

function findPart(messages: readonly any[], id: string): any {
    for (const message of messages) {
        for (const part of contentOf(message)) {
            // A tool-call shares the call id with its tool-result; only the part
            // that carries a payload (result or legacy state) is interesting.
            if (part?.id === id && (part.result || part.state)) return part
        }
    }
    return undefined
}

function sortedIds(value: unknown): string[] {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("expected a plain json marker object")
    }
    return Object.keys(value as Record<string, unknown>).sort()
}

// A transcript with three payload types plus an error, each properly paired
// with a tool-call. Turn protection is disabled in the tests that use it.
function typedTranscript(): any[] {
    return [
        user("hi"),
        toolCall("t1", "bash"),
        textResult("t1", "bash"),
        toolCall("j1", "grep"),
        jsonResult("j1", "grep"),
        toolCall("c1", "read"),
        contentResult("c1", "read"),
        toolCall("e1", "bash"),
        resultOf("e1", "bash", "error", BIG),
    ]
}

// ─── Opt-in: pruning is OFF unless explicitly enabled ───────────────────────

describe("prune: opt-in gate", () => {
    it("does nothing when the pruneOutputs block is absent (default off)", () => {
        const messages = [user(), textResult("a1", "bash")]
        const plan = buildPrunePlan(messages, slimConfig())
        assert.strictEqual(plan.outputs.size, 0, "default must be off — no prompt rewrite, no cache break")
        assert.strictEqual(plan.stats.prunedOutputs, 0)
        assert.strictEqual(plan.stats.charsSaved, 0)
    })

    it("does nothing when pruneOutputs.enabled is explicitly false", () => {
        const messages = [user(), textResult("a1", "bash")]
        const plan = buildPrunePlan(messages, withPrune({ enabled: false }, { enabled: false }))
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("prunes a large, old, unprotected output when enabled", () => {
        const messages = [user(), textResult("a1", "bash")]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.ok(plan.outputs.has("a1"), "control case: an eligible output must be planned")
        assert.strictEqual(plan.stats.prunedOutputs, 1)
        assert.ok(plan.stats.charsSaved > 0)
    })
})

// ─── Size gate ──────────────────────────────────────────────────────────────

describe("prune: minChars size gate", () => {
    it("skips an output one character below the threshold", () => {
        const messages = [user(), textResult("small", "bash", "x".repeat(1999))]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ minChars: 2000 }))
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("admits an output exactly at the threshold (inclusive)", () => {
        const messages = [user(), textResult("edge", "bash", "x".repeat(2000))]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ minChars: 2000 }))
        assert.ok(plan.outputs.has("edge"), "size gate is `size >= minChars`")
    })

    it("respects a custom minChars", () => {
        const messages = [user(), textResult("tiny", "bash", "x".repeat(50))]
        assert.strictEqual(
            buildPrunePlan(messages, pruneNoTurnProtection({ minChars: 100 })).outputs.size,
            0,
        )
        assert.ok(
            buildPrunePlan(messages, pruneNoTurnProtection({ minChars: 10 })).outputs.has("tiny"),
        )
    })
})

// ─── Turn protection: counted in TURNS, not messages/tools ──────────────────

describe("prune: turn protection", () => {
    // Turn indices (number of preceding user messages):
    //   u0 turn0 | O1,O2 turn1 | u1 turn1 | M1..M6 turn2 | u2 turn2 | R1 turn3 | u3 turn3
    // last message turn = 3, so ages are O=2, M=1, R=0.
    function agedTranscript(): any[] {
        const messages: any[] = [user("t0"), textResult("O1", "bash"), textResult("O2", "grep"), user("t1")]
        for (let i = 1; i <= 6; i++) messages.push(textResult(`M${i}`, "read"))
        messages.push(user("t2"), textResult("R1", "bash"), user("t3"))
        return messages
    }

    it("protects the last N turns as whole turns, not the last N tools", () => {
        const plan = buildPrunePlan(agedTranscript(), withPrune({}, { turns: 2 }))

        // Age 2 (turn1) is eligible.
        assert.ok(plan.outputs.has("O1"))
        assert.ok(plan.outputs.has("O2"))
        // The 6-tool turn is age 1: protected in full. A per-message cap would
        // leak M1..M4 here.
        for (let i = 1; i <= 6; i++) {
            assert.ok(!plan.outputs.has(`M${i}`), `M${i} is in a protected turn and must not be pruned`)
        }
        assert.ok(!plan.outputs.has("R1"), "the newest turn is always protected")
        assert.strictEqual(plan.stats.prunedOutputs, 2)
    })

    it("moves the frontier one whole turn at a time when turns changes", () => {
        // turns=1 protects only age 0 -> O and all 6 M become eligible together.
        const wider = buildPrunePlan(agedTranscript(), withPrune({}, { turns: 1 }))
        assert.strictEqual(wider.stats.prunedOutputs, 8, "turn2's six tools must go as one unit")
        assert.ok(!wider.outputs.has("R1"))
    })

    it("protects everything when turns exceeds the transcript depth", () => {
        const plan = buildPrunePlan(agedTranscript(), withPrune({}, { turns: 10 }))
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("turnProtection.enabled=false disables the gate", () => {
        const plan = buildPrunePlan(agedTranscript(), pruneNoTurnProtection())
        assert.strictEqual(plan.stats.prunedOutputs, 9, "every completed output is eligible once the gate is off")
    })
})

// ─── Protected tools ────────────────────────────────────────────────────────

describe("prune: protected tools", () => {
    it("never prunes a tool in PRUNE_ALWAYS_PROTECTED (edit family)", () => {
        for (const tool of ["edit", "write", "multiedit", "patch"]) {
            assert.ok(PRUNE_ALWAYS_PROTECTED.includes(tool), `${tool} must be in the always-protected set`)
        }

        const messages = [user(), textResult("e1", "edit"), textResult("b1", "bash")]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.ok(!plan.outputs.has("e1"), "an edit result must survive — pruning it invites a duplicate edit")
        assert.ok(plan.outputs.has("b1"), "the unprotected control tool must still be pruned")
    })

    it("honours config.strategies.pruneOutputs.protectedTools", () => {
        const messages = [user(), textResult("c1", "mycustom")]
        assert.strictEqual(
            buildPrunePlan(messages, pruneNoTurnProtection()).outputs.size,
            1,
            "control: pruned without protection",
        )
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ protectedTools: ["mycustom"] }))
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("honours the legacy purgeErrors.protectedTools list", () => {
        const config = pruneNoTurnProtection()
        config.strategies.purgeErrors.protectedTools = ["legacytool"]
        const plan = buildPrunePlan([user(), textResult("l1", "legacytool")], config)
        assert.strictEqual(plan.outputs.size, 0, "a tool protected from error-purge must not be pruned")
    })
})

// ─── Error / unknown result types lock ──────────────────────────────────────

describe("prune: result-type locks", () => {
    it("does not prune an errored result (purgeStaleToolErrors owns errors)", () => {
        const messages = [user(), resultOf("err", "bash", "error", BIG)]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("does not prune an unknown result type (lock, never guess)", () => {
        const messages = [user(), resultOf("weird", "bash", "binary", BIG)]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(plan.outputs.size, 0)
    })
})

// ─── Idempotency via the marker ─────────────────────────────────────────────

describe("prune: idempotency", () => {
    it("skips a text value that already starts with the marker", () => {
        const already = `${PRUNE_MARKER} bash ciktisi kisaltildi (5000 karakter, 3 turn once).`
        const messages = [user(), textResult("p1", "bash", already)]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("a second build over an applied transcript prunes nothing and does not grow the placeholder", () => {
        const messages = [user(), textResult("t1", "bash")]
        const config = pruneNoTurnProtection()

        const first = buildPrunePlan(messages, config)
        assert.strictEqual(first.outputs.size, 1)
        applyPrunePlan(messages, first)

        const placeholderBefore = findPart(messages, "t1").result.value
        assert.ok(placeholderBefore.startsWith(PRUNE_MARKER))

        const second = buildPrunePlan(messages, config)
        assert.strictEqual(second.outputs.size, 0, "marker must make pruning idempotent")
        assert.strictEqual(findPart(messages, "t1").result.value, placeholderBefore)
    })

    it("skips a json value already carrying the slim_pruned marker object", () => {
        const messages = [user(), jsonResult("j1", "grep", { slim_pruned: true, chars: 5000, tool: "grep" })]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("skips a content payload whose text block already carries the marker", () => {
        const blocks = [
            { type: "text", text: `${PRUNE_MARKER} read ciktisi kisaltildi (10 karakter, 1 turn once).` },
            { type: "file", uri: "file:///a.png", mime: "image/png", name: "a.png" },
        ]
        const messages = [user(), contentResult("c1", "read", blocks)]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(plan.outputs.size, 0)
    })
})

// ─── Per-request cap rounds to a turn boundary ──────────────────────────────

describe("prune: maxPerRequest cap", () => {
    it("rolls back to the turn start instead of pruning a partial turn", () => {
        // Candidates in order: A(turn1), B1..B3(turn2). Cap 2 would land inside
        // turn2, so the whole turn2 is dropped and only A is pruned.
        const messages = [
            user(),
            textResult("A", "bash"),
            user(),
            textResult("B1", "bash"),
            textResult("B2", "bash"),
            textResult("B3", "bash"),
        ]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ maxPerRequest: 2 }))
        assert.strictEqual(plan.stats.prunedOutputs, 1)
        assert.ok(plan.outputs.has("A"))
        assert.ok(!plan.outputs.has("B1") && !plan.outputs.has("B2") && !plan.outputs.has("B3"))
    })

    it("lets the cap win when it lands inside the very first turn", () => {
        // All three candidates share turn1; there is no earlier turn to fall
        // back to, so pruning maxPerRequest is better than pruning none.
        const messages = [user(), textResult("A", "bash"), textResult("B1", "bash"), textResult("B2", "bash")]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ maxPerRequest: 2 }))
        assert.strictEqual(plan.stats.prunedOutputs, 2)
    })

    it("prunes everything when the cap exceeds the candidate count", () => {
        const messages = [user(), textResult("A", "bash"), textResult("B1", "bash")]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection({ maxPerRequest: 50 }))
        assert.strictEqual(plan.stats.prunedOutputs, 2)
    })
})

// ─── Placeholder content ────────────────────────────────────────────────────

describe("prune: placeholder", () => {
    it("starts with the marker", () => {
        assert.ok(renderPrunePlaceholder("bash", 5000, 3).startsWith(PRUNE_MARKER))
    })

    it("carries the tool name, the character count and the turn age", () => {
        const text = renderPrunePlaceholder("grep", 12345, 7)
        assert.ok(text.includes("grep"), "the model must know which tool to re-run")
        assert.ok(text.includes("12345"), "the model must be able to judge whether the size matters")
        assert.ok(text.includes("7"), "the model must know how stale the output is")
    })

    it("is the exact text written into a text result by applyPrunePlan", () => {
        const messages = [user(), textResult("t1", "bash")]
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        applyPrunePlan(messages, plan)
        assert.strictEqual(findPart(messages, "t1").result.value, plan.outputs.get("t1"))
    })
})

// ─── serializedToolResultSize ───────────────────────────────────────────────

describe("prune: serializedToolResultSize", () => {
    it("measures strings by length and other values by their JSON form", () => {
        assert.strictEqual(serializedToolResultSize("abcd"), 4)
        assert.strictEqual(serializedToolResultSize({ a: 1 }), JSON.stringify({ a: 1 }).length)
        assert.strictEqual(serializedToolResultSize(""), 0)
    })

    it("treats null/undefined as zero so they are never selected", () => {
        assert.strictEqual(serializedToolResultSize(null), 0)
        assert.strictEqual(serializedToolResultSize(undefined), 0)
    })

    it("treats a cyclic payload as zero (lock, never guess)", () => {
        const cyclic: any = {}
        cyclic.self = cyclic
        assert.strictEqual(serializedToolResultSize(cyclic), 0)
    })
})

// ─── applyPrunePlan: the session-survival invariants ────────────────────────

describe("prune: applyPrunePlan safety", () => {
    it("never removes a message — the message count is unchanged", () => {
        const messages = typedTranscript()
        const before = messages.length
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        assert.ok(plan.outputs.size > 0, "fixture must produce a non-empty plan")

        applyPrunePlan(messages, plan)
        assert.strictEqual(messages.length, before, "dropping a role:'tool' message is a 400 that kills the session")
    })

    it("never removes a tool-call or tool-result part and keeps every call/result paired", () => {
        const messages = typedTranscript()
        const callsBefore = idsOfType(messages, "tool-call")
        const resultsBefore = idsOfType(messages, "tool-result")
        const callsCountBefore = countParts(messages, "tool-call")
        const resultsCountBefore = countParts(messages, "tool-result")

        applyPrunePlan(messages, buildPrunePlan(messages, pruneNoTurnProtection()))

        assert.strictEqual(countParts(messages, "tool-call"), callsCountBefore)
        assert.strictEqual(countParts(messages, "tool-result"), resultsCountBefore)
        assert.deepStrictEqual(idsOfType(messages, "tool-call"), callsBefore)
        assert.deepStrictEqual(idsOfType(messages, "tool-result"), resultsBefore)
        assert.deepStrictEqual(callsBefore, resultsBefore, "every tool-call must still have exactly one tool-result")
    })

    it("preserves result.type for text, json, content and error", () => {
        const messages = typedTranscript()
        applyPrunePlan(messages, buildPrunePlan(messages, pruneNoTurnProtection()))

        assert.strictEqual(findPart(messages, "t1").result.type, "text")
        assert.strictEqual(findPart(messages, "j1").result.type, "json")
        assert.strictEqual(findPart(messages, "c1").result.type, "content")
        assert.strictEqual(findPart(messages, "e1").result.type, "error", "errors are never touched")
        assert.strictEqual(findPart(messages, "e1").result.value, BIG)
    })

    it("keeps a json payload an object — never a stringified placeholder (no type lie)", () => {
        const messages = typedTranscript()
        applyPrunePlan(messages, buildPrunePlan(messages, pruneNoTurnProtection()))

        const value = findPart(messages, "j1").result.value
        assert.strictEqual(typeof value, "object")
        assert.ok(!Array.isArray(value))
        assert.notStrictEqual(typeof value, "string")
        assert.strictEqual((value as any).slim_pruned, true)
        assert.deepStrictEqual(sortedIds(value), ["chars", "slim_pruned", "tool"])
    })

    it("keeps content file blocks and only collapses the text blocks", () => {
        const messages = typedTranscript()
        const fileBlockBefore = structuredClone(contentOf(messages[6])[0].result.value[1])
        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        applyPrunePlan(messages, plan)

        const blocks = findPart(messages, "c1").result.value
        assert.strictEqual(blocks.length, 2, "the file block must not be dropped")
        assert.strictEqual(blocks[0].type, "text")
        assert.ok(blocks[0].text.startsWith(PRUNE_MARKER))
        assert.deepStrictEqual(blocks[1], fileBlockBefore, "the file uri/mime reference must survive")
    })

    it("clones changed messages and never mutates the caller's original objects", () => {
        const messages = typedTranscript()
        const originals = messages.slice()
        const originalSnapshots = originals.map((message) => structuredClone(message))

        const plan = buildPrunePlan(messages, pruneNoTurnProtection())
        applyPrunePlan(messages, plan)

        // The three payload messages are swapped for clones; the others are untouched.
        const changedSlots = [2, 4, 6]
        for (const slot of changedSlots) {
            assert.notStrictEqual(messages[slot], originals[slot], "the payload message must be replaced by a clone")
            assert.deepStrictEqual(originals[slot], originalSnapshots[slot], "the live session object must not be mutated")
        }
        for (const slot of [0, 1, 3, 5, 7, 8]) {
            assert.strictEqual(messages[slot], originals[slot], "messages without a planned output stay identity-equal")
        }
    })

    it("buildPrunePlan is pure — it does not mutate the transcript it reads", () => {
        const messages = typedTranscript()
        const snapshot = JSON.stringify(messages)
        buildPrunePlan(messages, pruneNoTurnProtection())
        buildPrunePlan(messages, pruneNoTurnProtection())
        assert.strictEqual(JSON.stringify(messages), snapshot)
    })

    it("is a no-op for an empty plan", () => {
        const messages = typedTranscript()
        const originals = messages.slice()
        applyPrunePlan(messages, { outputs: new Map(), stats: { prunedOutputs: 0, charsSaved: 0 } })
        messages.forEach((message, i) => assert.strictEqual(message, originals[i]))
    })

    it("handles the legacy SessionMessageInfo tool-state shape", () => {
        const messages: any[] = [
            { type: "user", content: [{ type: "text", text: "hi" }] },
            {
                type: "tool",
                content: [
                    { type: "tool", id: "L1", name: "bash", state: { status: "completed", output: BIG } },
                ],
            },
        ]
        const config = pruneNoTurnProtection()
        const plan = buildPrunePlan(messages, config)
        assert.ok(plan.outputs.has("L1"), "a completed tool state must be eligible")

        applyPrunePlan(messages, plan)
        const part = findPart(messages, "L1")
        assert.strictEqual(part.type, "tool", "the part type is never changed")
        assert.strictEqual(part.state.status, "completed", "completion state is preserved")
        assert.ok(part.state.output.startsWith(PRUNE_MARKER))
    })
})

// ─── Frontier stability (prefix-cache safety) ───────────────────────────────

describe("prune: frontier stability", () => {
    it("two consecutive builds prune exactly the same message set", () => {
        const messages = [
            user(),
            textResult("O1", "bash"),
            textResult("O2", "grep"),
            user(),
            textResult("M1", "read"),
            user(),
            textResult("R1", "bash"),
            user(),
        ]
        const config = withPrune({}, { turns: 1 })

        const first = buildPrunePlan(messages, config)
        const second = buildPrunePlan(messages, config)

        assert.deepStrictEqual([...first.outputs.keys()].sort(), [...second.outputs.keys()].sort())
        assert.deepStrictEqual([...first.outputs.values()].sort(), [...second.outputs.values()].sort())
        assert.deepStrictEqual(first.stats, second.stats)
    })
})
