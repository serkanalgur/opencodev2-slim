import { describe, it } from "node:test"
import assert from "node:assert"
import {
    applyCompressedRanges,
    registerCompressionBlock,
    syncCompressionBlocks,
    stableMessageKey,
    findAmbiguousKeys,
} from "../src/lib/strategies"
import type { SessionState } from "../src/lib/types"

// A summary is injected at its anchor, which can sit after the removed head of
// the history. Anthropic rejects a request whose first message is not a user
// turn (reported as a tool_use without a tool_result), so the injected summary
// must lead the history whenever the original one started with a user turn.

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
    }
}

const text = (id: string, role: string): any => ({ id, role, content: [{ type: "text", text: "hello" }] })
const call = (id: string, callId: string): any => ({
    id,
    role: "assistant",
    content: [{ type: "tool-call", id: callId, name: "read", input: {} }],
})
const result = (id: string, callId: string): any => ({
    id,
    role: "tool",
    content: [{ type: "tool-result", id: callId, result: { type: "text", value: "ok" } }],
})

function run(messages: any[], coveredIds: string[], anchorMessageId: string) {
    const state = makeState()
    registerCompressionBlock(state, { coveredIds, anchorMessageId, summary: "## Compression Summary\nx", topic: "t" })
    const keys = messages.map((m, i) => stableMessageKey(m, i))
    syncCompressionBlocks(state, new Set(keys), findAmbiguousKeys(keys))
    return applyCompressedRanges(state, messages, keys)
}

describe("compression block: history keeps a leading user turn", () => {
    it("hoists the summary when the removed head was the only user turn before a tool loop", () => {
        const messages = [
            text("m1", "user"),
            call("m2", "call_1"),
            result("m3", "call_1"),
            text("m4", "assistant"),
        ]
        const out = run(messages, ["m1"], "m4")

        assert.ok(!out.some((m) => m.id === "m1"), "the covered prompt is removed")
        assert.strictEqual(out[0].role, "user", "the history must start with a user turn")
        assert.ok(String(out[0].id).startsWith("slim-summary-"), "and that turn is the summary")
        assert.deepStrictEqual(out.slice(1).map((m) => m.id), ["m2", "m3", "m4"])
    })

    it("leaves the order alone when the summary already leads", () => {
        const messages = [text("m1", "user"), text("m2", "assistant"), text("m3", "user")]
        const out = run(messages, ["m1", "m2"], "m3")

        assert.strictEqual(out[0].role, "user")
        assert.ok(String(out[0].id).startsWith("slim-summary-"))
        assert.strictEqual(out[1].id, "m3")
    })
})
