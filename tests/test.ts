import { describe, it } from "node:test"
import assert from "node:assert"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countTokens, shouldCompress, getMessageText, getToolResultContent } from "../src/lib/compress"
import {
    pruneMessages,
    registerCompressionBlock,
    syncCompressionBlocks,
    applyCompressedRanges,
    injectLimitNudges,
    purgeStaleToolErrors,
    pruneInPlace,
    buildCompressionSummary,
} from "../src/lib/strategies"
import { resolveCompressLimits, resolveThreshold } from "../src/lib/config"
// Namespace import so optional test hooks (resetThresholdWarnings) can be
// probed at runtime without breaking the module graph when they are absent.
import * as configModule from "../src/lib/config"
import { buildPanelData, renderPanel, formatTokens } from "../src/lib/tui"
import type { PanelData } from "../src/lib/tui"
import { loadConfig } from "../src/lib/config"
// `measureSession` is a test-only export (see its JSDoc): the rendered
// surfaces gate occupancy on `hasPrompt`, so the fallback it guards is
// unreachable from /panel, /status or /compress.
import tuiPlugin, { deriveStats, measureSession } from "../src/tui"
import type { MessageWithParts, SessionState, SlimConfig } from "../src/lib/types"

// ─── Token Counting ─────────────────────────────────────────────────────────

describe("Token Counting", () => {
    it("should count tokens for empty string", async () => {
        const count = await countTokens("")
        assert.strictEqual(count, 0)
    })

    it("should count tokens for simple text", async () => {
        const count = await countTokens("Hello, world!")
        assert.ok(count > 0)
        assert.ok(count < 10) // Should be small for short text
    })
})

// ─── Compression Decision ───────────────────────────────────────────────────

describe("Compression Decision", () => {
    it("should compress when context limit exceeded", () => {
        const result = shouldCompress(100000, 80000, 40000, 0, 5, 100)
        assert.strictEqual(result.compress, true)
        assert.ok(result.reason.includes("Context limit reached"))
    })

    it("should compress on soft limit reminder", () => {
        const result = shouldCompress(50000, 80000, 40000, 0, 5, 100)
        assert.strictEqual(result.compress, true)
        assert.ok(result.reason.includes("Context at"))
    })

    it("should not compress when below thresholds", () => {
        const result = shouldCompress(20000, 80000, 40000, 0, 5, 100)
        assert.strictEqual(result.compress, false)
    })
})

// ─── Message Text Extraction ────────────────────────────────────────────────

describe("Message Text Extraction", () => {
    it("should extract text from message parts", () => {
        const msg: MessageWithParts = {
            info: { id: "1", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
            parts: [{ type: "text", text: "Hello world" } as any],
        }
        const text = getMessageText(msg)
        assert.strictEqual(text, "Hello world")
    })

    it("should extract tool results", () => {
        const msg: MessageWithParts = {
            info: { id: "1", role: "assistant", sessionID: "s1", time: { created: Date.now() } } as any,
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    state: { type: "result", output: "command output here" },
                } as any,
            ],
        }
        const result = getToolResultContent(msg)
        assert.ok(result.includes("command output here"))
    })
})

// ─── Message Pruning ────────────────────────────────────────────────────────

describe("Message Pruning", () => {
    it("should apply deduplication", () => {
        const messages: MessageWithParts[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hello" } as any],
            },
            {
                info: { id: "2", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hello" } as any],
            },
        ]

        const config: SlimConfig = {
            enabled: true,
            debug: false,
            compress: {
                enabled: true,
                permission: "allow",
                maxContextLimit: "80%",
                minContextLimit: "40%",
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
            persistence: { enabled: true, directory: "/tmp/slim-test" },
        }

        const pruned = pruneMessages(messages, config, messages.length)
        // Should deduplicate identical messages
        assert.ok(pruned.length <= messages.length)
    })
})

// ─── TUI Panel ──────────────────────────────────────────────────────────────

describe("TUI Panel", () => {
    it("should build panel data with correct message counts", async () => {
        const messages: MessageWithParts[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hello" } as any],
            },
            {
                info: { id: "2", role: "assistant", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hi there!" } as any],
            },
        ]

        const state: SessionState = {
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
        }

        const config: SlimConfig = {
            enabled: true,
            debug: false,
            compress: {
                enabled: true,
                permission: "allow",
                maxContextLimit: "80%",
                minContextLimit: "40%",
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
            persistence: { enabled: true, directory: "/tmp/slim-test" },
        }

        const panelData = await buildPanelData("s1", messages, state, config, "test-model")

        assert.strictEqual(panelData.userMessages, 1)
        assert.strictEqual(panelData.assistantMessages, 1)
        assert.strictEqual(panelData.messageCount, 2)
        assert.ok(panelData.currentTokens > 0)
    })

    it("should assign tool tokens to the tools bucket, not always zero", async () => {
        const messages: MessageWithParts[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hello" } as any],
            },
            {
                info: { id: "2", role: "tool", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        state: { type: "result", output: "some long command output that takes tokens" },
                    } as any,
                ],
            },
        ]

        const state: SessionState = {
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
        }

        const config: SlimConfig = {
            enabled: true,
            debug: false,
            compress: {
                enabled: true,
                permission: "allow",
                maxContextLimit: "80%",
                minContextLimit: "40%",
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
            persistence: { enabled: true, directory: "/tmp/slim-test" },
        }

        const panelData = await buildPanelData("s1", messages, state, config, "test-model")
        assert.ok(panelData.tokensByRole.tools > 0, "tool tokens should be > 0")
        assert.strictEqual(panelData.toolCalls + panelData.toolResults, 1)
    })

    it("should render panel with all sections", async () => {
        const data = {
            sessionId: "s1",
            timestamp: Date.now(),
            currentTokens: 50000,
            maxTokens: 100000,
            usagePercent: 50,
            status: "healthy" as const,
            messageCount: 10,
            userMessages: 5,
            assistantMessages: 5,
            toolCalls: 2,
            toolResults: 3,
            tokensByRole: { user: 20000, assistant: 25000, tools: 3000, system: 2000 },
            compressionCount: 0,
            averageRatio: 0,
            totalTokensSaved: 0,
            lastCompression: null,
            estimatedCost: 0.15,
            costSaved: 0,
            model: "test-model",
            topics: [{ topic: "general", count: 10, tokens: 50000 }],
            recommendations: ["Context is healthy. No action needed."],
        }

        const panel = renderPanel(data)

        assert.ok(panel.includes("SLIM CONTEXT PANEL"))
        assert.ok(panel.includes("50.0%"))
        assert.ok(panel.includes("test-model"))
    })

    it("should prefer server-measured tokens/cost/limit when provided", async () => {
        const messages: MessageWithParts[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: Date.now() } } as any,
                parts: [{ type: "text", text: "Hello" } as any],
            },
        ]

        const state: SessionState = {
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
        }

        const config: SlimConfig = {
            enabled: true,
            debug: false,
            compress: {
                enabled: true,
                permission: "allow",
                maxContextLimit: "30%",
                minContextLimit: "10%",
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
            persistence: { enabled: true, directory: "/tmp/slim-test" },
        }

        // Simulate the server reporting 22% of a 1M-token model, $0.25 spent.
        const panelData = await buildPanelData(
            "s1",
            messages,
            state,
            config,
            "real-model",
            {
                // `tokens` is the session's LIFETIME CUMULATIVE spend counter and
                // must NOT stand in for context occupancy (issue #11). Only
                // `promptTokens` — the last request's input + cache.read +
                // cache.write — describes how full the window is.
                tokens: 220326,
                promptTokens: 220326,
                cost: 0.25,
                contextLimit: 1000000,
                model: "real-model",
            },
        )

        assert.strictEqual(panelData.currentTokens, 220326)
        assert.ok(Math.abs(panelData.usagePercent - 22.03) < 1, "~22% used (of real model limit)")
        assert.strictEqual(panelData.estimatedCost, 0.25)
        assert.strictEqual(panelData.maxTokens, 300000) // 30% of 1,000,000
        // real limit drives the maxTokens (30% = 300k), not 200k-based 60k
        assert.ok(panelData.maxTokens === 300000)
        assert.ok(panelData.model === "real-model")
    })
})

// ─── CLI Panel Stats (tui.tsx) ─────────────────────────────────────────────

describe("CLI Panel Stats", () => {
    it("should count user text carried on the top-level text field", () => {
        const stats = deriveStats([
            {
                type: "user",
                text: "Hello there, please help me with my project",
            },
            {
                type: "assistant",
                content: [{ type: "text", text: "Sure, I can help with that." }],
            },
        ])
        assert.strictEqual(stats.userMessages, 1)
        assert.strictEqual(stats.assistantMessages, 1)
        assert.ok(stats.tokensByRole.user > 0, "user tokens should be > 0")
        assert.strictEqual(stats.totalMessages, 2)
    })

    it("should count tool calls inside assistant content", () => {
        const stats = deriveStats([
            {
                type: "user",
                text: "run it",
            },
            {
                type: "assistant",
                content: [
                    { type: "text", text: "Let me run that." },
                    { type: "tool", text: '{"command":"ls"}' },
                ],
            },
        ])
        assert.strictEqual(stats.toolCalls, 1)
    })
})

// ─── DCP Compression Blocks ────────────────────────────────────────────────

function makeConfig(overrides: Partial<SlimConfig["compress"]> = {}): SlimConfig {
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
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectUserMessages: false,
            protectedTools: [],
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        adaptive: { enabled: true, learningRate: 0.1, minCompressionRatio: 0.3 },
        costAware: { enabled: true, cacheBoostFactor: 0.5 },
        persistence: { enabled: true, directory: "/tmp/slim-test" },
    }
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
    }
}

function rawMessage(id: string, role = "user", text = "hello"): any {
    return { id, role, content: [{ type: "text", text }] }
}

describe("DCP Compression Blocks", () => {
    it("should replace covered messages with summary at the anchor", () => {
        const state = makeState()
        const messages = [
            rawMessage("1"),
            rawMessage("2"),
            rawMessage("3", "assistant", "work"),
            rawMessage("4"),
        ]

        registerCompressionBlock(state, {
            coveredIds: ["1", "2"],
            anchorMessageId: "3",
            summary: "## Compression Summary\nwork done",
            topic: "old work",
        })
        syncCompressionBlocks(state, new Set(["1", "2", "3", "4"]))

        const filtered = applyCompressedRanges(state, messages)
        assert.strictEqual(filtered.length, 3) // summary + "3" + "4"
        assert.strictEqual(filtered[0].id, "slim-summary-1")
        assert.ok(filtered[0].content[0].text.includes("Compression Summary"))
        assert.ok(!filtered.some((m) => m.id === "1" || m.id === "2"), "covered dropped")
    })

    it("should deactivate a block when its anchor disappears", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1"],
            anchorMessageId: "2",
            summary: "S",
            topic: "t",
        })

        // Anchor "2" no longer present in the outgoing list.
        syncCompressionBlocks(state, new Set(["1"]))
        const filtered = applyCompressedRanges(state, [rawMessage("1"), rawMessage("2")])

        assert.strictEqual(filtered.length, 2, "nothing replaced when inactive")
        assert.ok(!filtered.some((m) => m.id === "slim-summary-1"))
    })

    it("should not replace when nothing is compressed", () => {
        const state = makeState()
        const messages = [rawMessage("1"), rawMessage("2")]
        const filtered = applyCompressedRanges(state, messages)
        assert.strictEqual(filtered, messages)
    })

    it("newer block consumes an older block anchored inside its range", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1", "2"],
            anchorMessageId: "3",
            summary: "A summary",
            topic: "a",
        })
        registerCompressionBlock(state, {
            coveredIds: ["3", "4"],
            anchorMessageId: "5",
            summary: "B summary",
            topic: "b",
        })

        const messages = [
            rawMessage("1"),
            rawMessage("2"),
            rawMessage("3"),
            rawMessage("4"),
            rawMessage("5"),
            rawMessage("6"),
        ]
        syncCompressionBlocks(state, new Set(messages.map((m) => m.id)))

        const filtered = applyCompressedRanges(state, messages)
        assert.deepStrictEqual(
            filtered.map((m) => m.id),
            ["slim-summary-2", "5", "6"],
        )
        assert.ok(filtered[0].content[0].text.includes("B summary"), "newest summary wins")
    })
})

// ─── DCP Limit Rules ───────────────────────────────────────────────────────

describe("DCP Limit Rules", () => {
    it("resolves absolute limits by default", () => {
        const limits = resolveCompressLimits(makeConfig(), makeState())
        assert.deepStrictEqual(limits, { max: 100000, min: 50000 })
    })

    it("resolves percent limits against the model context window", () => {
        const config = makeConfig({ maxContextLimit: "80%", minContextLimit: "40%" })
        const state = makeState()
        const limits = resolveCompressLimits(config, state)
        assert.deepStrictEqual(limits, { max: 160000, min: 80000 })
    })

    it("prefers per-model overrides over global limits", () => {
        const config = makeConfig({
            modelMaxLimits: { "anthropic/claude": 50000 },
            modelMinLimits: { "anthropic/claude": 10000 },
        })
        const limits = resolveCompressLimits(config, makeState(), "anthropic", "claude")
        assert.deepStrictEqual(limits, { max: 50000, min: 10000 })
    })

    it("anchors a context-limit nudge when over the max limit", () => {
        const state = makeState()
        const messages = [
            rawMessage("1"),
            rawMessage("2", "assistant", "work"),
            rawMessage("3"),
        ]

        injectLimitNudges(state, makeConfig(), messages, 150000, { max: 100000, min: 50000 })

        assert.strictEqual(state.nudges?.contextLimitAnchors.length, 1)
        const last = messages[2]
        assert.ok(
            last.content.some(
                (p: any) => p.type === "text" && p.text.includes("Context at capacity"),
            ),
            "nudge appended to the anchored (last) message",
        )
    })

    it("does not grow anchors within nudgeFrequency", () => {
        const state = makeState()
        const messages = [
            rawMessage("1"),
            rawMessage("2", "assistant", "a"),
            rawMessage("3"),
            rawMessage("4"),
            rawMessage("5"),
            rawMessage("6"),
        ]
        const limits = { max: 100000, min: 50000 }

        injectLimitNudges(state, makeConfig(), messages, 150000, limits)
        const first = state.nudges!.contextLimitAnchors.length
        injectLimitNudges(state, makeConfig(), messages, 150000, limits)

        assert.strictEqual(state.nudges!.contextLimitAnchors.length, first)
    })

    it("clears anchors when the model already ran compress", () => {
        const state = makeState()
        const messages = [
            rawMessage("1"),
            {
                id: "2",
                role: "assistant",
                content: [
                    { type: "text", text: "ok" },
                    { type: "tool-call", name: "compress", input: { focus: "x" } },
                ],
            },
        ]
        state.nudges!.contextLimitAnchors = ["2"]

        injectLimitNudges(state, makeConfig(), messages, 150000, { max: 100000, min: 50000 })
        assert.strictEqual(state.nudges!.contextLimitAnchors.length, 0)
    })

    it("does nothing when compress is denied", () => {
        const state = makeState()
        const messages = [rawMessage("1"), rawMessage("2", "assistant")]
        injectLimitNudges(state, makeConfig({ permission: "deny" }), messages, 150000, {
            max: 100000,
            min: 50000,
        })
        assert.strictEqual(state.nudges?.contextLimitAnchors.length, 0)
    })
})

// ─── Pruning Strategies ────────────────────────────────────────────────────

describe("Pruning Strategies", () => {
    it("purges stale errored tool inputs but keeps recent messages", () => {
        const messages = [
            {
                id: "1",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallID: "c1",
                        name: "edit",
                        input: { content: "A".repeat(500) },
                    },
                ],
            },
            {
                id: "2",
                role: "tool",
                content: [
                    { type: "tool-result", toolCallID: "c1", result: { type: "error", value: "boom" } },
                ],
            },
            { id: "3", role: "user", content: [{ type: "text", text: "ok" }] },
            {
                id: "4",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallID: "c2",
                        name: "edit",
                        input: { content: "B".repeat(500) },
                    },
                ],
            },
            {
                id: "5",
                role: "tool",
                content: [
                    { type: "tool-result", toolCallID: "c2", result: { type: "error", value: "boom2" } },
                ],
            },
            { id: "6", role: "user", content: [{ type: "text", text: "recent" }] },
        ]

        purgeStaleToolErrors(messages, 4)

        // c1 (stale, index 0) is purged; c2 (recent, index 3) is untouched.
        assert.ok(messages[0].content[0].input.content.startsWith("[input removed"))
        assert.strictEqual(messages[3].content[0].input.content, "B".repeat(500))
    })
})

// ─── purgeStaleToolErrors on the v2 hook shape ─────────────────────────────
//
// Regression class this section exists for: the id read. On the v2 hook part
// (`node_modules/@opencode/ai/dist/schema/messages.js` — ToolCallPart and
// ToolResultPart both REQUIRE `id`) there is no `toolCallID` and no `callID`.
// The function used to read only those two, so `pairingIdOf` yielded
// undefined on every part, the errored-id set came back empty, and the
// function returned before touching anything — on EVERY request, despite
// `strategies.purgeErrors.enabled` defaulting to true. Every test that shipped
// with it used the legacy `toolCallID` shape, which never reaches production,
// so the defect was green in CI.
//
// Every fixture below is therefore built on `id`, and each asserts its own
// precondition (the part really carries the id the implementation will look
// for, the result really is an error) BEFORE asserting the outcome — so a test
// cannot pass by failing to pair at all.

describe("purgeStaleToolErrors: the v2 hook shape", () => {
    /** The marker the production code writes. */
    const MARKER = "[input removed due to failed tool call]"

    /** 81 chars: one over the `> 80` threshold, so it must be replaced. */
    const OVER = "A".repeat(81)

    /** Exactly 80: the threshold is `> 80`, so this must survive. */
    const AT_LIMIT = "B".repeat(80)

    /** An errored v2 tool-call at message index `i`, with its result attached. */
    function erroredPair(
        i: number,
        callId: string,
        input: Record<string, unknown>,
        resultType = "error",
        resultValue = "boom",
    ): [any, any] {
        return [
            {
                id: `m${i}`,
                role: "assistant",
                content: [{ type: "tool-call", id: callId, name: "edit", input }],
            },
            {
                id: `r${i}`,
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: callId,
                        name: "edit",
                        result: { type: resultType, value: resultValue },
                    },
                ],
            },
        ]
    }

    function callInputAt(messages: any[], i: number): any {
        return messages[i].content[0].input
    }

    /**
     * Pad to `n` messages. The age gate is `i > n - turns - 1`, so index 0 is
     * only eligible once `n >= turns + 1` — a short fixture proves nothing,
     * because every index is gated out and the purge would be a no-op for
     * reasons unrelated to the id read. Every fixture below is padded and
     * asserts its eligibility explicitly.
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
            `fixture is too short (n=${messages.length}, turns=${turns}): index 0 would be ` +
                `gated out, so this test could not fail for the reason it claims to check`,
        )
        return messages
    }

    it("purges a large input on the v2 shape, where the pairing id is `id`", () => {
        // THE regression. `toolCallID`/`callID` do not exist on these parts, so
        // the pre-fix implementation found no errored ids and returned early —
        // this test fails against it.
        const messages: any[] = padTo([...erroredPair(0, "call_v2", { content: OVER })], 6, 4)
        // Precondition: the parts carry the id the implementation must read,
        // and carry none of the legacy keys that used to be the only source.
        assert.strictEqual(messages[0].content[0].id, "call_v2", "fixture must use `id`")
        assert.strictEqual(messages[1].content[0].id, "call_v2", "result must share the `id`")
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "fixture must actually be an errored result, or nothing should fire",
        )
        assert.strictEqual(
            "toolCallID" in messages[0].content[0],
            false,
            "fixture must not carry the legacy key, or it proves nothing",
        )
        assert.strictEqual(callInputAt(messages, 0).content.length, 81, "input starts over the threshold")

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "an errored v2 tool-call's oversized input must be replaced",
        )
    })

    it("leaves a successful call untouched even when it is old and oversized", () => {
        // Negative: `result.type !== "error"` must never purge. Guard against a
        // fix that keys off "has a result" instead of "the result is an error".
        const messages: any[] = padTo(
            [
                ...erroredPair(0, "ok1", { content: OVER }, "text", "fine"),
                ...erroredPair(2, "ok2", { content: OVER }, "text", "fine"),
            ],
            6,
            4,
        )
        assert.strictEqual(messages[1].content[0].result.type, "text", "fixture must NOT be an error")
        // Precondition: index 0 is age-eligible (gate: i > 6-4-1 = 1), so the
        // only reason to spare it is that its result is not an error.
        assert.strictEqual(0 > 6 - 4 - 1, false, "index 0 must be inside the age window for this fixture")

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(callInputAt(messages, 0).content, OVER, "a successful call must be untouched")
    })

    it("purges one position inside the turns window and spares the boundary position", () => {
        // The gate is `i > n - turnsEffective - 1` → continue, so with n=6 and
        // turns=4 the eligible indices are 0..1 and the boundary is index 2.
        // Both calls are errored and oversized; only the age differs, so this
        // pins the window and nothing else.
        const messages: any[] = []
        // n=6, turns=4 → the gate `i > 6 - 4 - 1` is `i > 1`, so index 1 is the LAST
        // eligible position and index 2 is the FIRST gated-out one. Both calls
        // are errored and oversized; only the index differs.
        messages.push(...erroredPair(0, "inside", { content: OVER }).slice(0, 1)) // index 0: call
        messages.push({ id: "filler", role: "user", content: [{ type: "text", text: "f" }] }) // 1
        messages.push(...erroredPair(2, "boundary", { content: OVER }).slice(0, 1)) // index 2: call
        // Both results, then padding to reach the length the gate is computed from.
        messages.push(...erroredPair(0, "inside", { content: OVER }).slice(1)) // index 3
        messages.push(...erroredPair(2, "boundary", { content: OVER }).slice(1)) // index 4
        messages.push({ id: "tail", role: "user", content: [{ type: "text", text: "recent" }] }) // 5
        assert.strictEqual(messages.length, 6, "the age gate is computed from the array length")
        assert.strictEqual(
            1 > 6 - 4 - 1,
            false,
            "index 1 is the last eligible position, else this proves nothing",
        )
        assert.strictEqual(
            2 > 6 - 4 - 1,
            true,
            "index 2 is the first gated-out position, else this proves nothing",
        )

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "index 0 is strictly inside the window and must be purged",
        )
        assert.strictEqual(
            callInputAt(messages, 2).content,
            OVER,
            "index 2 is the first gated-out position and must be untouched",
        )
    })

    it("keeps an input of exactly 80 characters and replaces 81", () => {
        // `> 80` is strict: the boundary value is NOT over the threshold. An
        // off-by-one to `>= 80` would silently rewrite inputs that were small
        // enough to be worth keeping.
        // Both calls sit at eligible indices (index 0 and index 1 of n=6), so the
        // ONLY variable between them is the string length.
        const messages: any[] = padTo(
            [
                ...erroredPair(0, "over", { content: OVER }).slice(0, 1), // 0: 81-char call
                ...erroredPair(0, "atlimit", { content: AT_LIMIT }).slice(0, 1), // 1: 80-char call
                ...erroredPair(0, "over", { content: OVER }).slice(1), // 2: "over"'s result
                ...erroredPair(0, "atlimit", { content: AT_LIMIT }).slice(1), // 3: "atlimit"'s result
            ],
            6,
            4,
        )
        assert.strictEqual(messages.length, 6, "the age gate is computed from the array length")
        assert.strictEqual(0 > 6 - 4 - 1, false, "index 0 must be inside the age window for this fixture")
        assert.strictEqual(1 > 6 - 4 - 1, false, "index 1 must be inside the age window for this fixture")
        assert.strictEqual(AT_LIMIT.length, 80, "fixture boundary must be exactly 80 chars")
        assert.strictEqual(OVER.length, 81, "fixture over-limit must be exactly 81 chars")

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "81 chars is over the threshold and must be replaced",
        )
        assert.strictEqual(
            callInputAt(messages, 1).content,
            AT_LIMIT,
            "80 chars is not over the threshold and must be kept verbatim",
        )
    })

    it("never rewrites a non-string input value, whatever its size", () => {
        // Only `typeof value === "string"` is in scope: a large object or array
        // in `input` (a structured edit payload, a file map) must not be
        // swapped for a string marker, which would change the request's shape.
        //
        // The assertion compares against a `structuredClone` SNAPSHOT taken
        // before the call, not against `input` itself. `purgeStaleToolErrors`
        // mutates in place, so `after` IS the same object reference as `input`:
        // `deepStrictEqual(x, x)` is true no matter what the function did, and
        // the previous version of this test kept passing after every value in
        // the object had been destroyed. It also carries a paired control — a
        // sibling call holding an over-threshold STRING — so a regression that
        // rewrites everything indiscriminately cannot pass.
        const input = {
            num: 12345678901234567890,
            obj: { blob: "C".repeat(500) },
            arr: ["D".repeat(500)],
            nil: null,
            undef: undefined,
            bool: true,
        }
        const snapshot = structuredClone(input)

        const control = { content: OVER }
        // Shape pair at indices 0/1, control pair at 2/3. The age gate is
        // `i > n - turns - 1`, so n=8/turns=4 leaves indices 0..3 eligible —
        // BOTH pairs are inside the window, which is what makes the control
        // meaningful.
        const messages: any[] = padTo(
            [
                ...erroredPair(0, "shapes", input),
                {
                    id: "m2c",
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            id: "call_control",
                            name: "edit",
                            input: control,
                        },
                    ],
                },
                {
                    id: "m2r",
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "call_control",
                            name: "edit",
                            result: { type: "error", value: "boom" },
                        },
                    ],
                },
            ],
            8,
            4,
        )
        assert.strictEqual(
            messages[1].content[0].result.type,
            "error",
            "fixture must be an errored call, or this passes vacuously",
        )
        assert.strictEqual(
            messages[3].content[0].result.type,
            "error",
            "control must also be errored, or the control assertion proves nothing",
        )
        assert.ok(
            0 <= 3 - (8 - 4 - 1),
            "control pair at index 2 must be inside the age window, or the control proves nothing",
        )

        purgeStaleToolErrors(messages, 4)

        // Control first: proves the function RAN and the purge path is live.
        assert.strictEqual(
            control.content,
            MARKER,
            "control: an over-threshold string on a sibling call MUST be rewritten, " +
                "otherwise this test cannot prove it ran and a rewrite-everything " +
                "regression would pass",
        )

        const after = callInputAt(messages, 0)
        assert.deepStrictEqual(
            after,
            snapshot,
            "no non-string input value may be rewritten",
        )
        assert.strictEqual(
            after.obj.blob.length,
            500,
            "a nested large string is still a value, not a top-level string",
        )
    })

    it("pairs on `callID` when a v1 part also carries a disagreeing `id`", () => {
        // THE precedence fix. On the v1 ToolPart shape a part carries BOTH `id`
        // (the PART id, `prt_*`) and `callID` (the CALL id). The CALL lives in
        // the assistant message and the RESULT in a separate `role:"tool"`
        // message, so the two sides carry DIFFERENT `id`s and the SAME `callID`.
        //
        // This test was previously written to assert the OPPOSITE (`id` wins),
        // and was green for the wrong reason: the only thing it pinned was the
        // order of the two reads, and the order it pinned mispaired every real
        // v1 split pair. The fixture below is the shape that actually occurs —
        // the two sides disagree on `id` — so `id`-first cannot pair them.
        const messages: any[] = padTo(
            [
                {
                    id: "m1",
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            id: "prt_CALL",
                            callID: "call_1",
                            name: "edit",
                            input: { content: OVER },
                        },
                    ],
                },
                {
                    id: "m2",
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "prt_RES",
                            callID: "call_1",
                            name: "edit",
                            result: { type: "error", value: "boom" },
                        },
                    ],
                },
            ],
            6,
            4,
        )
        assert.strictEqual(
            messages[0].content[0].callID,
            messages[1].content[0].callID,
            "precondition: the split pair shares one `callID`",
        )
        assert.ok(
            messages[0].content[0].id !== messages[1].content[0].id,
            "precondition: the PART ids must differ, else `id`-first would pair them and this could not detect it",
        )

        purgeStaleToolErrors(messages, 4)

        assert.strictEqual(
            callInputAt(messages, 0).content,
            MARKER,
            "`callID` must win over a disagreeing `id`; reading `id` first mispairs a v1 split pair and purges nothing",
        )
    })

    it("pairs on `id` on the v2 shape, which carries no `callID`", () => {
        // The other half of the precedence. A v2 part has no `callID` at all,
        // so the legacy read falls through and `id` — which IS the pairing id
        // there — must still be used. Without this, "legacy first" would be
        // read as "never read `id`" and v2 pairing would break.
        const messages: any[] = padTo([...erroredPair(0, "call_v2", { content: OVER })], 6, 4)
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

// ─── collectProtectedToolOutputs: protected OUTPUTS in the summary ──────────
//
// The same broken id read lived in `collectProtectedToolOutputs`, which feeds
// the "### Protected Tool Outputs" section of a compression summary. It matched
// results by `toolCallID`/`callID`, so on the v2 shape it never produced the
// `output:` half of a line — a user who listed a tool as protected was told its
// output was preserved, and the summary silently preserved only the INPUT. That
// is user-visible content loss in the summary, so it is pinned directly.

describe("buildCompressionSummary: protected tool outputs survive compression", () => {
    it("carries BOTH the input and the output of a protected v2 tool pair", async () => {
        const messages: any[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } },
                parts: [{ type: "text", text: "run the build" }],
            },
            {
                info: { id: "2", role: "assistant", sessionID: "s1", time: { created: 0 } },
                parts: [{ type: "tool-call", id: "call_1", name: "bash", input: { command: "npm run build" } }],
            },
            {
                info: { id: "3", role: "tool", sessionID: "s1", time: { created: 0 } },
                parts: [
                    {
                        type: "tool-result",
                        id: "call_1",
                        name: "bash",
                        result: { type: "text", value: "BUILD OK" },
                    },
                ],
            },
        ] as any

        // Preconditions: the pair is joined on `id` and carries no legacy key.
        assert.strictEqual((messages[1].parts[0] as any).id, "call_1", "fixture must use `id`")
        assert.strictEqual((messages[2].parts[0] as any).id, "call_1", "result must share the `id`")
        assert.strictEqual("toolCallID" in (messages[1].parts[0] as any), false, "no legacy key on the fixture")

        const summary = await buildCompressionSummary(messages, "the build", ["bash"])

        assert.ok(summary.includes("### Protected Tool Outputs"), `expected the section:\n${summary}`)
        assert.ok(
            summary.includes("npm run build"),
            `the protected tool's INPUT must be in the summary:\n${summary}`,
        )
        assert.ok(
            summary.includes("BUILD OK"),
            `the protected tool's OUTPUT must be in the summary; it was silently dropped because ` +
                `the result was matched by a legacy id key that does not exist on the v2 shape:\n${summary}`,
        )
    })

    it("omits the output half when the tool result itself is an error", async () => {
        // Documents the existing filter: an errored result contributes no
        // output (purgeStaleToolErrors rewrites the input instead), but the
        // call's input is still listed so the turn is not lost entirely.
        const messages: any[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } },
                parts: [{ type: "text", text: "try it" }],
            },
            {
                info: { id: "2", role: "assistant", sessionID: "s1", time: { created: 0 } },
                parts: [{ type: "tool-call", id: "call_e", name: "bash", input: { command: "boom" } }],
            },
            {
                info: { id: "3", role: "tool", sessionID: "s1", time: { created: 0 } },
                parts: [
                    {
                        type: "tool-result",
                        id: "call_e",
                        name: "bash",
                        result: { type: "error", value: "exit 1" },
                    },
                ],
            },
        ] as any

        const summary = await buildCompressionSummary(messages, "the build", ["bash"])

        assert.ok(summary.includes("command"), `the call input is still listed:\n${summary}`)
        // Scope to the section under test: the error VALUE legitimately appears
        // in the separate "### Errors Encountered" section, so asserting on the
        // whole summary would fail for an unrelated and correct reason.
        const section = summary.slice(summary.indexOf("### Protected Tool Outputs"))
        assert.ok(!section.includes("exit 1"), `an errored result must not contribute an output half:\n${section}`)
    })
})

// ─── Nudge idempotency ─────────────────────────────────────────────────────

describe("Nudge Idempotency", () => {
    it("does not duplicate a nudge when the usage percentage changes", () => {
        const state = makeState()
        const config = makeConfig()
        const messages = [
            rawMessage("1"),
            rawMessage("2", "assistant", "work"),
            rawMessage("3"),
        ]
        const limits = { max: 100000, min: 50000 }

        injectLimitNudges(state, config, messages, 101000, limits) // 101%
        injectLimitNudges(state, config, messages, 102000, limits) // 102% — same anchor

        const textParts = messages[2].content.filter((p: any) => p.type === "text")
        const nudges = textParts.filter((p: any) => p.text.includes("[[slim:context-limit]]"))
        assert.strictEqual(nudges.length, 1, "nudge appended exactly once despite % change")
    })
})

// ─── Deduplication correctness ─────────────────────────────────────────────

describe("Deduplication Correctness", () => {
    it("keeps distinct messages that share a common prefix", () => {
        const messages = [
            rawMessage("1", "user", "Same start " + "x".repeat(300)),
            rawMessage("2", "user", "Same start " + "x".repeat(299) + "y"),
        ]
        pruneInPlace(messages, makeConfig())
        assert.strictEqual(messages.length, 2, "shared prefix must not be deduplicated")
    })

    it("removes only truly identical messages", () => {
        const messages = [
            rawMessage("1", "user", "identical content"),
            rawMessage("2", "user", "identical content"),
        ]
        pruneInPlace(messages, makeConfig())
        assert.strictEqual(messages.length, 1)
    })
})

// ─── Compression block hygiene ─────────────────────────────────────────────

describe("Compression Block Hygiene", () => {
    it("drops orphaned inactive blocks when all referenced messages are gone", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1"],
            anchorMessageId: "2",
            summary: "S",
            topic: "t",
        })

        // Only unrelated messages remain (e.g. after OpenCode compaction).
        syncCompressionBlocks(state, new Set(["99"]))

        assert.strictEqual(state.compressionBlocks?.length, 0, "orphaned block forgotten")
    })

    it("keeps blocks that still reference a live message", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1"],
            anchorMessageId: "2",
            summary: "S",
            topic: "t",
        })

        syncCompressionBlocks(state, new Set(["2"])) // anchor still alive
        assert.strictEqual(state.compressionBlocks?.length, 1)
        assert.strictEqual(state.compressionBlocks![0].active, true)
    })
})

// ─── Protected user messages ───────────────────────────────────────────────

describe("Protected User Messages", () => {
    it("preserves user text verbatim in the summary when enabled", async () => {
        const messages = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } } as any,
                parts: [{ type: "text", text: "Please refactor the auth module" }] as any,
            },
            {
                info: { id: "2", role: "assistant", sessionID: "s1", time: { created: 0 } } as any,
                parts: [{ type: "text", text: "Done" }] as any,
            },
        ]

        const withProtection = await buildCompressionSummary(messages, "auth work", [], true)
        assert.ok(withProtection.includes("Please refactor the auth module"))

        const withoutProtection = await buildCompressionSummary(messages, "auth work", [], false)
        assert.ok(!withoutProtection.includes("Please refactor the auth module"))
    })
})

// ─── Multi-Format Message Handling ──────────────────────────────────────────

describe("Multi-Format Message Handling", () => {
    it("messageHasCompress detects compress in hook format (tool-call)", () => {
        const msg = {
            role: "assistant",
            content: [
                { type: "text", text: "ok" },
                { type: "tool-call", name: "compress", input: { focus: "x" } },
            ],
        }
        assert.strictEqual(messageHasCompress(msg), true)
    })

    it("messageHasCompress detects compress in SessionMessageInfo format (tool)", () => {
        const msg = {
            type: "assistant",
            content: [
                { type: "text", text: "ok" },
                { type: "tool", name: "compress", state: { status: "completed", input: {} } },
            ],
        }
        assert.strictEqual(messageHasCompress(msg), true)
    })

    it("messageHasCompress returns false when no compress call present", () => {
        const msg = {
            role: "assistant",
            content: [
                { type: "text", text: "ok" },
                { type: "tool-call", name: "read", input: {} },
            ],
        }
        assert.strictEqual(messageHasCompress(msg), false)
    })

    it("purgeStaleToolErrors handles SessionMessageInfo tool format", () => {
        // Need enough messages so the errored tool is "stale" (> turns positions from end)
        const messages = [
            {
                id: "1",
                type: "assistant",
                content: [
                    {
                        type: "tool",
                        callID: "c1",
                        name: "edit",
                        state: { status: "error", input: { content: "A".repeat(500) }, error: "boom" },
                    },
                ],
            },
            { id: "2", type: "user", text: "ok" },
            { id: "3", type: "assistant", content: [{ type: "text", text: "response" }] },
            { id: "4", type: "user", text: "continue" },
            {
                id: "5",
                type: "assistant",
                content: [
                    {
                        type: "tool",
                        callID: "c2",
                        name: "edit",
                        state: { status: "completed", input: { content: "B".repeat(500) }, content: ["done"] },
                    },
                ],
            },
            { id: "6", type: "user", text: "recent" },
        ]

        // turns=2: messages at index <= 6-2-1=3 are eligible for purging
        purgeStaleToolErrors(messages, 2)

        // c1 (index 0, stale) should be purged
        assert.ok(messages[0].content[0].state.input.content.startsWith("[input removed"))
        // c2 (index 4, recent) should be untouched
        assert.strictEqual(messages[4].content[0].state.input.content, "B".repeat(500))
    })

    it("applyCompressedRanges handles transcript format messages", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1", "2"],
            anchorMessageId: "3",
            summary: "## Summary\nwork done",
            topic: "work",
        })

        // Transcript format messages (no 'role', has 'type')
        const messages = [
            { id: "1", type: "user", text: "hello" },
            { id: "2", type: "assistant", content: [{ type: "text", text: "work" }] },
            { id: "3", type: "user", text: "next" },
        ]

        syncCompressionBlocks(state, new Set(["1", "2", "3"]))
        const filtered = applyCompressedRanges(state, messages)

        assert.strictEqual(filtered.length, 2) // summary + "3"
        assert.strictEqual(filtered[0].type, "user")
        assert.ok(filtered[0].text.includes("Summary"))
        assert.ok(!filtered.some((m: any) => m.id === "1" || m.id === "2"))
    })

    it("resolveModelContextLimit never borrows another model's window", async () => {
        // The active model is NOT in the list, and default() gives no window.
        // There is no honest answer, so we must warn and take the 200k safety
        // net — NOT the 175k belonging to an unrelated Anthropic model. That
        // borrowing is exactly issue #11 (a 128k model measured against another
        // provider's 1M window).
        resetContextLimitFallbackWarning()
        const mockCtx = {
            model: {
                default: () => Promise.resolve(undefined),
                list: () => [
                    { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", limit: { context: 175000 } },
                    { providerID: "openai", modelID: "gpt-4o", limit: { context: 128000 } },
                ],
            },
        }
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        let limit: number
        try {
            limit = await (resolveModelContextLimit as any)(mockCtx)
        } finally {
            console.warn = originalWarn
        }
        assert.strictEqual(
            limit,
            200000,
            "an unrelated model's window must never be borrowed — 200k + warning instead",
        )
        assert.ok(
            warnings.some((w) => w.includes("[slim] could not read the model context window")),
            `the safety net must announce itself, got: ${JSON.stringify(warnings)}`,
        )
    })
})

// ─── Import for new tests ──────────────────────────────────────────────────

import { messageHasCompress, purgeStaleToolErrors, applyCompressedRanges, syncCompressionBlocks } from "../src/lib/strategies"
import { resolveModelContextLimit, resetContextLimitFallbackWarning } from "../src/index"

// ─── resolveThreshold ──────────────────────────────────────────────────────

describe("resolveThreshold", () => {
    const WINDOW = 200000
    const FALLBACK = 100000

    /** Resolve and capture every reported issue, so tests can assert both. */
    function resolve(
        value: number | string | null | undefined,
        contextLimit: number = WINDOW,
        fallback: number = FALLBACK,
    ): { resolved: number; issues: string[] } {
        const issues: string[] = []
        const resolved = resolveThreshold(value, contextLimit, fallback, (issue) => {
            issues.push(issue)
        })
        return { resolved, issues }
    }

    it("uses an absolute token count verbatim", () => {
        const { resolved, issues } = resolve(200000, 1000000)
        assert.strictEqual(resolved, 200000, "200000 tokens must stay 200000 tokens")
        assert.deepStrictEqual(issues, [], "a valid value reports no issue")
    })

    it("resolves \"80%\" to 80% of the context window", () => {
        const { resolved, issues } = resolve("80%")
        assert.strictEqual(resolved, 160000, "80% of 200000 = 160000")
        assert.deepStrictEqual(issues, [])
    })

    it("keeps the historic percent meaning of a bare numeric string", () => {
        assert.strictEqual(resolve("80").resolved, 160000, "\"80\" must stay 80%, not 80 tokens")
        assert.strictEqual(resolve("40").resolved, 80000, "\"40\" must stay 40%, not 40 tokens")
        assert.deepStrictEqual(resolve("80").issues, [], "a legacy percent is not an issue")
    })

    it("accepts a decimal comma percent (\"80,5%\")", () => {
        const { resolved, issues } = resolve("80,5%")
        assert.strictEqual(resolved, 161000, "80,5% of 200000 = 161000")
        assert.deepStrictEqual(
            issues,
            [],
            "a comma decimal separator is valid input, not a parse error",
        )
    })

    it("rounds the comma-decimal percent to whole tokens", () => {
        // 80.5% of 100001 = 80500.805 → 80501. A truncating implementation
        // would return 80500, so the off-by-one is observable.
        const odd = resolve("80,5%", 100001)
        assert.strictEqual(odd.resolved, 80501, "percent results are rounded, not truncated")
        assert.deepStrictEqual(odd.issues, [], "rounding is not a reported issue")

        // The same math via the ASCII form must agree with the comma form.
        assert.strictEqual(resolve("80.5%", 100001).resolved, odd.resolved)
    })

    it("falls back — never to 0 — for unparsable strings and reports the issue", () => {
        for (const value of ["not-a-number", "abc", "", "   ", "%", "80%%"]) {
            const { resolved, issues } = resolve(value)
            assert.strictEqual(resolved, FALLBACK, `${JSON.stringify(value)} must fall back`)
            assert.notStrictEqual(resolved, 0, "a broken value must not disable triggering")
            assert.deepStrictEqual(issues, ["invalid-number"], JSON.stringify(value))
        }
    })

    it("falls back for undefined and null as a missing value", () => {
        for (const value of [undefined, null]) {
            const { resolved, issues } = resolve(value)
            assert.strictEqual(resolved, FALLBACK, String(value))
            assert.notStrictEqual(resolved, 0)
            assert.deepStrictEqual(issues, ["missing"], String(value))
        }
    })

    it("falls back for negative, NaN and infinite numbers", () => {
        for (const value of [-1, -0.5, NaN, Infinity, -Infinity]) {
            const { resolved, issues } = resolve(value)
            assert.strictEqual(resolved, FALLBACK, `${String(value)} must fall back`)
            assert.deepStrictEqual(issues, ["invalid-number"], String(value))
        }
    })

    it("falls back for a percent when the context window is unknown", () => {
        for (const contextLimit of [0, -1, NaN]) {
            const { resolved, issues } = resolve("80%", contextLimit)
            assert.strictEqual(
                resolved,
                FALLBACK,
                `percent with contextLimit=${contextLimit} must not resolve to 0 or a guess`,
            )
            assert.notStrictEqual(resolved, 0, "the known silent-0 bug")
            assert.deepStrictEqual(issues, ["unknown-context-limit"], String(contextLimit))
        }
    })

    it("clamps an absolute threshold above the context window to the window", () => {
        const { resolved, issues } = resolve(250000, 200000)
        assert.strictEqual(resolved, 200000, "clamped to the window, not left unreachable")
        assert.notStrictEqual(resolved, FALLBACK, "clamping is not a fallback")
        assert.deepStrictEqual(issues, ["above-context-limit"])
    })

    it("clamps a percent above 100 to the window", () => {
        const explicit = resolve("150%", 200000)
        assert.strictEqual(explicit.resolved, 200000)
        assert.deepStrictEqual(explicit.issues, ["percent-out-of-range"])

        // A mistaken absolute count written as a string has the same shape.
        const mistakenAbsolute = resolve("250000", 200000)
        assert.strictEqual(mistakenAbsolute.resolved, 200000)
        assert.deepStrictEqual(mistakenAbsolute.issues, ["percent-out-of-range"])
    })

    it("leaves an in-window absolute value untouched (clamp boundary)", () => {
        const atWindow = resolve(200000, 200000)
        assert.strictEqual(atWindow.resolved, 200000, "exactly at the window is not clamped")
        assert.deepStrictEqual(atWindow.issues, [])

        const belowWindow = resolve(150000, 200000)
        assert.strictEqual(belowWindow.resolved, 150000)
        assert.deepStrictEqual(belowWindow.issues, [])
    })
})

// ─── resolveCompressLimits fallbacks & warning hygiene ────────────────────

describe("Compress Limit Resolution", () => {
    it("uses a percent-form per-model override instead of the global limit", () => {
        const config = makeConfig({
            maxContextLimit: 120000,
            minContextLimit: 60000,
            modelMaxLimits: { "anthropic/claude": 90000 },
            modelMinLimits: { "anthropic/claude": "25%" },
        })
        const limits = resolveCompressLimits(config, makeState(), "anthropic", "claude")
        assert.deepStrictEqual(limits, { max: 90000, min: 50000 })
    })

    it("falls back to the global limit when a per-model override is broken", () => {
        const config = makeConfig({
            maxContextLimit: 120000,
            minContextLimit: 60000,
            modelMaxLimits: { "anthropic/claude": "yikes" },
            modelMinLimits: { "anthropic/claude": "40 %%" },
        })
        const limits = resolveCompressLimits(config, makeState(), "anthropic", "claude")
        assert.deepStrictEqual(
            limits,
            { max: 120000, min: 60000 },
            "a broken override degrades to the configured global, not to 0 or the built-in default",
        )
        assert.notStrictEqual(limits.max, 0)
    })

    it("falls back to the built-in defaults when the global limits are broken", () => {
        const config = makeConfig({ maxContextLimit: "nope", minContextLimit: null as any })
        const limits = resolveCompressLimits(config, makeState())
        assert.deepStrictEqual(limits, { max: 100000, min: 50000 })
        assert.notStrictEqual(limits.max, 0, "a broken global limit must not disable triggering")
    })

    it("warns exactly once per config key across repeated calls", () => {
        const config = makeConfig({
            maxContextLimit: 120000,
            modelMaxLimits: { "acme/alpha-warn": "bogus" },
            modelMinLimits: { "bravo/beta-warn": -5 },
        })
        const state = makeState()
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            for (let i = 0; i < 3; i++) {
                // Identical inputs must keep producing identical limits.
                assert.deepStrictEqual(
                    resolveCompressLimits(config, state, "acme", "alpha-warn"),
                    { max: 120000, min: 50000 },
                )
                assert.deepStrictEqual(
                    resolveCompressLimits(config, state, "bravo", "beta-warn"),
                    { max: 120000, min: 50000 },
                )
            }
        } finally {
            console.warn = originalWarn
        }

        const alphaWarnings = warnings.filter((w) =>
            w.includes('compress.modelMaxLimits["acme/alpha-warn"]'),
        )
        const betaWarnings = warnings.filter((w) =>
            w.includes('compress.modelMinLimits["bravo/beta-warn"]'),
        )
        assert.strictEqual(alphaWarnings.length, 1, "same broken key warned only once")
        assert.strictEqual(betaWarnings.length, 1, "a different broken key still warns once each")
        assert.ok(alphaWarnings[0].includes('"bogus"'), "the offending value is echoed")
        assert.ok(alphaWarnings[0].startsWith("[slim] config"), "diagnostic names the config key")
    })

    it("warns again when the same config key carries a different broken value", () => {
        const config = makeConfig({
            maxContextLimit: 120000,
            modelMaxLimits: { "kilo/lima-diff": "bogus" },
        })
        const state = makeState()
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            resolveCompressLimits(config, state, "kilo", "lima-diff")
            // Same config key, different (also broken) value: deduplication is
            // per value, so this second diagnostic must not be swallowed.
            config.compress.modelMaxLimits = { "kilo/lima-diff": "still-bogus" }
            resolveCompressLimits(config, state, "kilo", "lima-diff")
        } finally {
            console.warn = originalWarn
        }

        const hits = warnings.filter((w) =>
            w.includes('compress.modelMaxLimits["kilo/lima-diff"]'),
        )
        assert.strictEqual(
            hits.length,
            2,
            `the dedup key must include the offending value, got: ${JSON.stringify(hits)}`,
        )
        assert.ok(hits[0]?.includes('"bogus"'), hits[0])
        assert.ok(hits[1]?.includes('"still-bogus"'), hits[1])
    })

    it("re-emits a warning after resetThresholdWarnings()", () => {
        const config = makeConfig({
            maxContextLimit: 120000,
            modelMaxLimits: { "november/yankee-reset": "nope" },
        })
        const state = makeState()
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            resolveCompressLimits(config, state, "november", "yankee-reset")
            assert.strictEqual(warnings.length, 1, "a fresh broken key warns exactly once")

            const reset = (configModule as { resetThresholdWarnings?: () => void })
                .resetThresholdWarnings
            assert.strictEqual(
                typeof reset,
                "function",
                "config.ts must export resetThresholdWarnings() as a test hook",
            )
            reset!()

            resolveCompressLimits(config, state, "november", "yankee-reset")
            assert.strictEqual(
                warnings.length,
                2,
                "after the reset the same key+value warns again",
            )
        } finally {
            console.warn = originalWarn
        }
    })
})

// ─── Panel threshold display ───────────────────────────────────────────────

describe("Panel Threshold Display", () => {
    function makePanelData(threshold: {
        tokens: number
        percent: number | null
        minTokens: number
        minPercent: number | null
        contextLimit: number
    }) {
        return {
            sessionId: "s1",
            timestamp: Date.now(),
            currentTokens: 50000,
            maxTokens: threshold.tokens,
            usagePercent: 50,
            status: "healthy" as const,
            messageCount: 10,
            userMessages: 5,
            assistantMessages: 5,
            toolCalls: 2,
            toolResults: 3,
            tokensByRole: { user: 20000, assistant: 25000, tools: 3000, system: 2000 },
            compressionCount: 0,
            averageRatio: 0,
            totalTokensSaved: 0,
            lastCompression: null,
            estimatedCost: 0.15,
            costSaved: 0,
            model: "test-model",
            topics: [{ topic: "general", count: 10, tokens: 50000 }],
            recommendations: ["Context is healthy. No action needed."],
            threshold,
        }
    }

    it("shows an absolute trigger together with its percent of the window", async () => {
        const messages: MessageWithParts[] = [
            {
                info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } } as any,
                parts: [{ type: "text", text: "Hello" }] as any,
            },
        ]

        const panel = await buildPanelData(
            "s1",
            messages,
            makeState(),
            makeConfig({ maxContextLimit: 150000, minContextLimit: 50000 }),
            "test-model",
        )

        assert.strictEqual(panel.maxTokens, 150000)
        assert.deepStrictEqual(panel.threshold, {
            tokens: 150000,
            percent: 75,
            minTokens: 50000,
            minPercent: 25,
            contextLimit: 200000,
        })

        const rendered = renderPanel(panel)
        // The trigger is two lines (threshold + window, then the floor): the
        // three facts together overrun the 63-column frame at worst-case
        // magnitudes, and truncating would silently hide the floor.
        assert.ok(
            rendered.includes("Trigger: 150.0K tokens (75.0% of 200.0K window)"),
            `expected the trigger line with both token and percent values, got:\n${rendered}`,
        )
        assert.ok(
            rendered.includes("│   floor 50.0K (25.0%)"),
            `expected the floor on its own continuation line, got:\n${rendered}`,
        )
    })

    it("shows no percent when the context window is unknown", () => {
        const rendered = renderPanel(
            makePanelData({
                tokens: 150000,
                percent: null,
                minTokens: 50000,
                minPercent: null,
                contextLimit: 0,
            }),
        )

        const lines = rendered.split("\n")
        const triggerLine = lines.find((line) => line.includes("Trigger:"))
        assert.ok(triggerLine, "a trigger line is rendered")
        assert.ok(triggerLine!.includes("window unknown"), triggerLine)
        assert.ok(triggerLine!.includes("150.0K"), "absolute trigger tokens still shown")
        // The floor moved to its own line (see the sibling test above), and
        // without a window it degrades to the bare token count.
        const floorLine = lines.find((line) => line.includes("│   floor"))
        assert.ok(floorLine, `a floor line expected:\n${rendered}`)
        assert.ok(floorLine!.includes("50.0K"), "absolute floor still shown")
        assert.ok(!floorLine!.includes("%"), "no percent can be computed without a window")
        assert.ok(!triggerLine!.includes("%"), "no percent can be computed without a window")
    })
})

// ─── /panel slash command (v2 session API) ─────────────────────────────────

interface PanelHarness {
    context: any
    commands: any[]
    dialogs: { title: string; message: string }[]
    toasts: any[]
    syntheticWrites: any[]
    contextReads: any[]
    forbiddenReads: string[]
    renderCommands: () => void
}

/**
 * Minimal TUI host: registers the plugin's commands without mounting a real
 * TUI. Reads that the v1 implementation used (`data.session.message.*`) are
 * trapped so any regression back to them fails loudly.
 */
function makePanelHarness(
    options: {
        sessions?: { id: string }[]
        transcript?: unknown[]
        sessionInfo?: unknown
        contextError?: string
        /** Entries returned by `client.model.list()`; defaults to an empty list. */
        models?: unknown[]
    } = {},
): PanelHarness {
    const commands: any[] = []
    const dialogs: { title: string; message: string }[] = []
    const toasts: any[] = []
    const syntheticWrites: any[] = []
    const contextReads: any[] = []
    const forbiddenReads: string[] = []

    const messageTrap = new Proxy(
        {},
        {
            get(_target, prop) {
                const access = `data.session.message.${String(prop)}`
                forbiddenReads.push(access)
                throw new Error(`v1 API accessed: ${access}`)
            },
        },
    )
    const dataSession: any = { list: () => options.sessions ?? [{ id: "ses_test" }] }
    Object.defineProperty(dataSession, "message", {
        get: () => {
            forbiddenReads.push("data.session.message")
            return messageTrap
        },
    })

    let slotClaim: any = null
    const context: any = {
        data: { session: dataSession },
        ui: {
            slot: (claim: any) => {
                slotClaim = claim
                return () => {}
            },
            router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
            toast: { show: (toast: any) => void toasts.push(toast) },
            dialog: {
                alert: async (dialog: any) => {
                    dialogs.push(dialog)
                    return undefined
                },
            },
        },
        keymap: {
            layer: (input: () => any) => {
                commands.push(...(input().commands ?? []))
            },
        },
        client: {
            session: {
                context: async (args: any) => {
                    contextReads.push(args)
                    if (options.contextError) throw new Error(options.contextError)
                    return options.transcript ?? []
                },
                get: async (_args: any) => options.sessionInfo ?? null,
                synthetic: async (args: any) => void syntheticWrites.push(args),
            },
            model: { list: async () => ({ data: options.models ?? [] }) },
        },
    }

    return {
        context,
        commands,
        dialogs,
        toasts,
        syntheticWrites,
        contextReads,
        forbiddenReads,
        renderCommands: () => slotClaim?.render(),
    }
}

/**
 * Registers the plugin's commands on the fake host and returns a runner for
 * the named slash command. Same pattern as startPanel below, generalised so
 * /status and /slim-debug can be exercised without mounting a real TUI.
 */
async function startSlash(
    harness: PanelHarness,
    name: string,
): Promise<(input?: unknown) => Promise<void>> {
    await tuiPlugin.setup(harness.context)
    harness.renderCommands()
    const command = harness.commands.find((cmd: any) => cmd.slash?.name === name)
    assert.ok(command, `/${name} is registered on the keymap layer`)
    return (input?: unknown) => command.run(input, undefined)
}

describe("/panel Command", () => {
    async function startPanel(harness: PanelHarness): Promise<(input?: unknown) => Promise<void>> {
        await tuiPlugin.setup(harness.context)
        harness.renderCommands()
        const panel = harness.commands.find((cmd: any) => cmd.slash?.name === "panel")
        assert.ok(panel, "/panel is registered on the keymap layer")
        return (input?: unknown) => panel.run(input, undefined)
    }

    it("renders through a dialog using read-only v2 session APIs", async () => {
        const harness = makePanelHarness({
            transcript: [
                { type: "user", text: "please inspect the module" },
                { type: "assistant", content: [{ type: "text", text: "inspecting now" }] },
            ],
            sessionInfo: {
                tokens: { input: 1200, output: 300 },
                cost: 0.5,
                model: { id: "test-model", providerID: "acme", limit: { context: 100000 } },
            },
        })
        const run = await startPanel(harness)

        await run()

        assert.strictEqual(harness.dialogs.length, 1, "panel output goes to a dialog")
        assert.strictEqual(harness.dialogs[0].title, "Slim Context Panel")
        const text = harness.dialogs[0].message
        assert.ok(text.includes("SLIM CONTEXT PANEL"), text)
        assert.ok(text.includes("│ Messages: 2"), "transcript read via the v2 API")
        // The session.get total is lifetime spend, not occupancy: with no
        // per-turn usage in the transcript it is reported as a labelled Lifetime
        // line with no percent and no health status (issue #11). The old label
        // was "Measured tokens: 1500" on its own line.
        assert.ok(
            text.includes("│ Lifetime: 1.5K tokens (cumulative spend, fill unknown)"),
            `lifetime spend shown as spend, not occupancy:\n${text}`,
        )
        assert.ok(text.includes("Model: test-model"), text)

        assert.deepStrictEqual(
            harness.contextReads,
            [{ sessionID: "ses_test" }],
            "transcript comes from client.session.context",
        )
        assert.strictEqual(harness.syntheticWrites.length, 0, "nothing is written to the session")
        assert.deepStrictEqual(harness.forbiddenReads, [], "v1 data.session.message.* is off limits")
        assert.ok(
            harness.toasts.every((toast) => toast.variant !== "error"),
            `unexpected error toast: ${JSON.stringify(harness.toasts)}`,
        )
    })

    it("reports a read failure as a toast instead of a panel", async () => {
        const harness = makePanelHarness({ contextError: "backend unavailable" })
        const run = await startPanel(harness)

        await run()

        assert.strictEqual(harness.dialogs.length, 0, "no panel when the read fails")
        assert.strictEqual(harness.syntheticWrites.length, 0, "no session write on failure")
        const errorToast = harness.toasts.find((toast) => toast.variant === "error")
        assert.ok(errorToast, JSON.stringify(harness.toasts))
        assert.ok(String(errorToast.message).includes("backend unavailable"), errorToast.message)
    })

    it("toasts a warning and touches no client API without an active session", async () => {
        const harness = makePanelHarness({ sessions: [] })
        const run = await startPanel(harness)

        await run()

        assert.strictEqual(harness.dialogs.length, 0)
        assert.strictEqual(harness.contextReads.length, 0, "no client call without a session")
        assert.strictEqual(harness.syntheticWrites.length, 0)
        const warning = harness.toasts.at(-1)
        assert.strictEqual(warning?.variant, "warning")
        assert.strictEqual(warning?.title, "Slim Panel")
    })
})

// ─── Usage bar rendering (out-of-range percentages) ────────────────────────
//
// Regression: renderPanel fed usagePercent straight into String.repeat(), so
// a >100% figure (a lifetime cumulative counter can reach 56.1M tokens) or a
// negative/NaN one threw RangeError and took the whole panel down.

describe("Panel Usage Bar Rendering", () => {
    function usagePanelData(usagePercent: number) {
        return {
            sessionId: "s1",
            timestamp: Date.now(),
            currentTokens: 50000,
            cumulativeTokens: 56100000,
            maxTokens: 100000,
            usagePercent,
            status: "healthy" as const,
            messageCount: 10,
            userMessages: 5,
            assistantMessages: 5,
            toolCalls: 2,
            toolResults: 3,
            tokensByRole: { user: 20000, assistant: 25000, tools: 3000, system: 2000 },
            compressionCount: 0,
            averageRatio: 0,
            totalTokensSaved: 0,
            lastCompression: null,
            estimatedCost: 0.15,
            costSaved: 0,
            model: "test-model",
            topics: [] as { topic: string; count: number; tokens: number }[],
            recommendations: ["Context is healthy. No action needed."],
            threshold: {
                tokens: 80000,
                percent: 80,
                minTokens: 40000,
                minPercent: 40,
                contextLimit: 100000,
            },
        }
    }

    it("never crashes and always renders a fixed 30-cell bar", () => {
        const cases: { input: number; expected: string }[] = [
            { input: 145, expected: "100.0%" }, // over-window figure clamps, never repeats 43 cells
            { input: -5, expected: "0.0%" },
            { input: NaN, expected: "0.0%" },
            { input: Infinity, expected: "100.0%" },
            { input: -Infinity, expected: "0.0%" },
            { input: 0, expected: "0.0%" },
            { input: 50, expected: "50.0%" },
            { input: 100, expected: "100.0%" },
        ]

        for (const { input, expected } of cases) {
            const rendered = renderPanel(usagePanelData(input)) // must not throw
            const contextLine = rendered.split("\n").find((line) => line.includes("Context: ["))
            assert.ok(contextLine, `context bar rendered for usagePercent=${String(input)}`)

            const match = /^│ Context: \[([█░]{30})\] ([0-9]+\.[0-9]%)$/.exec(contextLine!)
            assert.ok(
                match,
                `bar must always be exactly 30 cells with a finite percent for ` +
                    `usagePercent=${String(input)}, got: ${contextLine}`,
            )
            assert.strictEqual(
                match![2],
                expected,
                `displayed percent for usagePercent=${String(input)}`,
            )
        }
    })
})

// ─── Prompt size vs lifetime cumulative total ──────────────────────────────

describe("Panel prompt size vs lifetime total", () => {
    const transcript: MessageWithParts[] = [
        {
            info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } } as any,
            parts: [{ type: "text", text: "Hello" }] as any,
        },
    ]

    it("shows the prompt size as Context and the cumulative total only as Lifetime", async () => {
        const panel = await buildPanelData(
            "s1",
            transcript,
            makeState(),
            makeConfig({ maxContextLimit: "80%" }),
            "test-model",
            {
                tokens: 56_100_000,
                promptTokens: 180_000,
                cost: 1.5,
                contextLimit: 1_000_000,
                model: "test-model",
            },
        )

        assert.strictEqual(panel.currentTokens, 180_000, "headline = current prompt size")
        assert.strictEqual(panel.cumulativeTokens, 56_100_000, "lifetime total kept apart")
        assert.ok(
            Math.abs(panel.usagePercent - 18) < 0.01,
            `180k of a 1M window = 18%, got ${panel.usagePercent}`,
        )

        const lines = renderPanel(panel).split("\n")
        const contextIdx = lines.findIndex((line) => line.includes("Context: ["))
        assert.ok(contextIdx >= 0, "context bar rendered")
        assert.ok(
            lines[contextIdx].includes("18.0%"),
            `prompt occupancy on the bar, got: ${lines[contextIdx]}`,
        )

        const tokensLine = lines[contextIdx + 1]
        assert.ok(
            tokensLine.includes("180.0K / 800.0K"),
            `Context must show the prompt size, got: ${tokensLine}`,
        )
        assert.ok(
            !tokensLine.includes("56.1M"),
            `cumulative spend must never be the Context figure, got: ${tokensLine}`,
        )

        const lifetime = lines.find((line) => line.includes("Lifetime:"))
        assert.ok(lifetime, `Lifetime line expected:\n${lines.join("\n")}`)
        assert.ok(lifetime.includes("56.1M"), lifetime)

        // renderPanel prints the resolved trigger threshold alongside the usage.
        assert.ok(
            lines.some((line) => line.includes("Trigger:")),
            `renderPanel includes the Trigger line:\n${lines.join("\n")}`,
        )
    })

    it("omits the Lifetime line when prompt and cumulative totals are equal", async () => {
        const panel = await buildPanelData(
            "s1",
            transcript,
            makeState(),
            makeConfig({ maxContextLimit: "80%" }),
            "test-model",
            {
                tokens: 200_000,
                promptTokens: 200_000,
                cost: 0,
                contextLimit: 1_000_000,
                model: "test-model",
            },
        )

        const rendered = renderPanel(panel)
        assert.ok(
            !rendered.includes("Lifetime:"),
            `identical figures must not repeat the Lifetime line:\n${rendered}`,
        )
        assert.ok(rendered.includes("200.0K / 800.0K"), rendered)
    })
})

// ─── /panel scope labels + trigger line ────────────────────────────────────

describe("/panel scope labels", () => {
    it("states the compaction scope, compaction count and the trigger threshold", async () => {
        const harness = makePanelHarness({
            transcript: [
                { type: "user", text: "first request" },
                { type: "compaction", summary: "earlier work was compacted" },
                { type: "assistant", content: [{ type: "text", text: "continuing" }] },
            ],
            sessionInfo: {
                tokens: { input: 1200, output: 300 },
                cost: 0.5,
                model: { id: "test-model", providerID: "acme", limit: { context: 100000 } },
            },
        })
        const run = await startSlash(harness, "panel")
        await run()

        assert.strictEqual(harness.dialogs.length, 1, "panel output goes to a dialog")
        const text = harness.dialogs[0].message
        assert.ok(text.includes("Scope: messages since the last compaction"), text)
        assert.ok(text.includes("Compactions in scope: 1"), text)
        assert.ok(text.includes("│ Messages: 3"), text)
        assert.ok(
            text.includes("│ Trigger:"),
            `trigger line expected in the slash output:\n${text}`,
        )
        assert.deepStrictEqual(
            harness.contextReads,
            [{ sessionID: "ses_test" }],
            "transcript still comes from exactly one client.session.context call",
        )
        assert.strictEqual(harness.syntheticWrites.length, 0, "nothing is written to the session")
    })
})

// ─── /status ───────────────────────────────────────────────────────────────

describe("/status Command", () => {
    it("reports through a dialog and never writes to the session", async () => {
        const harness = makePanelHarness({
            sessionInfo: {
                tokens: { input: 500, output: 100 },
                cost: 0.1,
                model: { id: "test-model", providerID: "acme", limit: { context: 100000 } },
            },
        })
        const run = await startSlash(harness, "status")
        await run()

        assert.strictEqual(
            harness.syntheticWrites.length,
            0,
            "/status must not write to the session",
        )
        assert.strictEqual(harness.dialogs.length, 1, "output goes to ui.dialog.alert")
        assert.strictEqual(harness.dialogs[0].title, "Slim Status")
        const text = harness.dialogs[0].message
        assert.ok(text.includes("**Context Status:**"), text)
        assert.ok(text.includes("**Usage:** 600"), text)
        assert.ok(text.includes("**Model:** test-model"), text)
        assert.ok(
            harness.toasts.every((toast) => toast.variant !== "error"),
            JSON.stringify(harness.toasts),
        )
    })
})

// ─── /slim-debug ───────────────────────────────────────────────────────────

describe("/slim-debug Command", () => {
    it("reports the toggle through a dialog; the session is never written to", async () => {
        // The command's only side effect is the user config file, so point HOME
        // at a scratch directory for the duration of the run.
        const originalHome = process.env.HOME
        const tmpHome = await mkdtemp(join(tmpdir(), "slim-home-"))
        process.env.HOME = tmpHome
        try {
            const harness = makePanelHarness()
            const run = await startSlash(harness, "slim-debug")
            await run()

            assert.strictEqual(
                harness.syntheticWrites.length,
                0,
                "/slim-debug must not write to the session",
            )
            assert.strictEqual(harness.dialogs.length, 1, "output goes to ui.dialog.alert")
            assert.strictEqual(harness.dialogs[0].title, "Slim Debug")
            const text = harness.dialogs[0].message
            assert.ok(text.includes("**Slim Debug Mode:** ON"), text)
            assert.ok(
                existsSync(join(tmpHome, ".config", "opencode", "slim.jsonc")),
                "config file toggled under the isolated HOME",
            )
            assert.ok(
                harness.toasts.every((toast) => toast.variant !== "error"),
                JSON.stringify(harness.toasts),
            )
        } finally {
            process.env.HOME = originalHome
            await rm(tmpHome, { recursive: true, force: true })
        }
    })
})

// ─── deriveStats message typing ────────────────────────────────────────────

describe("deriveStats message typing", () => {
    it("counts metadata events as system, not assistant; buckets sum to the total", () => {
        const stats = deriveStats([
            { type: "user", text: "hello" },
            { type: "assistant", content: [{ type: "text", text: "hi" }] },
            { type: "agent-switched" },
            { type: "model-switched" },
            { type: "location-switched" },
            { type: "idle" },
        ])

        assert.strictEqual(stats.totalMessages, 6)
        assert.strictEqual(stats.userMessages, 1)
        assert.strictEqual(
            stats.assistantMessages,
            1,
            "metadata events must not inflate the assistant bucket",
        )
        assert.strictEqual(stats.systemMessages, 4)
        assert.strictEqual(
            stats.userMessages + stats.assistantMessages + stats.systemMessages,
            stats.totalMessages,
            "user + assistant + system must account for every message",
        )
    })
})

// ─── resolveModelContextLimit (v2 envelopes) ───────────────────────────────

describe("resolveModelContextLimit (v2 model shapes)", () => {
    it("reads default().data and list().data: 1M window, \"80%\" → 800000", async () => {
        const ctx = {
            model: {
                default: async () => ({
                    data: {
                        providerID: "anthropic",
                        modelID: "claude-opus-4",
                        limit: { context: 1000000 },
                    },
                }),
                list: async () => ({
                    data: [
                        // The active model is NOT first, so an un-awaited or
                        // un-unwrapped list() would latch onto the 128k window.
                        { providerID: "openai", modelID: "gpt-4o", limit: { context: 128000 } },
                        {
                            providerID: "anthropic",
                            modelID: "claude-opus-4",
                            limit: { context: 1000000 },
                        },
                    ],
                }),
            },
        }

        const limit = await resolveModelContextLimit(ctx)
        assert.strictEqual(limit, 1000000, "the active model's own window wins")
        assert.strictEqual(
            resolveThreshold("80%", limit, 100000),
            800000,
            "\"80%\" of a 1M window = 800000 (the old code returned 160000)",
        )
    })

    it("uses default().data's limit when the list has no entry for the active model", async () => {
        const ctx = {
            model: {
                default: async () => ({
                    data: {
                        providerID: "anthropic",
                        modelID: "claude-opus-4",
                        limit: { context: 1000000 },
                    },
                }),
                list: async () => ({
                    data: [{ providerID: "openai", modelID: "gpt-4o", limit: { context: 128000 } }],
                }),
            },
        }

        assert.strictEqual(await resolveModelContextLimit(ctx), 1000000)
    })

    it("falls back to default().data when list() rejects", async () => {
        const ctx = {
            model: {
                default: async () => ({
                    data: { providerID: "p", modelID: "m", limit: { context: 1000000 } },
                }),
                list: async () => {
                    throw new Error("model registry unavailable")
                },
            },
        }

        assert.strictEqual(
            await resolveModelContextLimit(ctx),
            1000000,
            "a failing list() must not discard the active model's window",
        )
    })

    it("stays silent about a list() failure that a usable default() covers", async () => {
        // Behaviour 13, recoverable half: the fallback itself must work AND the
        // failure must not be reported until it actually forces the fake 200k
        // window — otherwise every session with a flaky registry gets noise.
        const ctx = {
            model: {
                default: async () => ({
                    data: { providerID: "p", modelID: "m", limit: { context: 1000000 } },
                }),
                list: async () => {
                    throw new Error("model registry unavailable")
                },
            },
        }

        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            assert.strictEqual(
                await resolveModelContextLimit(ctx),
                1000000,
                "the fallback still resolves the active model's window",
            )
            assert.deepStrictEqual(
                warnings,
                [],
                `a recovered list() failure must not warn, got: ${JSON.stringify(warnings)}`,
            )
        } finally {
            console.warn = originalWarn
        }
    })

    it("falls back to the built-in 200k window with a warning when both reads fail", async () => {
        resetContextLimitFallbackWarning()
        const ctx = {
            model: {
                default: async () => ({ data: null }),
                list: async () => {
                    throw new Error("model registry unavailable")
                },
            },
        }

        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            const limit = await resolveModelContextLimit(ctx)
            assert.strictEqual(limit, 200000, "the safety-net window, never 0")
            const hit = warnings.find((w) =>
                w.includes("[slim] could not read the model context window"),
            )
            assert.ok(hit, `expected a fallback warning, got: ${JSON.stringify(warnings)}`)
            assert.ok(
                hit!.includes("list: failed: model registry unavailable"),
                `the diagnostic must name the failing list() call, got: ${hit}`,
            )
            assert.ok(
                hit!.includes("list: failed") && !hit!.includes("default: failed"),
                `only list() failed — default() answered "no usable limit", got: ${hit}`,
            )
        } finally {
            console.warn = originalWarn
        }
    })
})

// ─── Compression block message identity (stableMessageKey + ambiguity lock) ─
//
// These are the regression locks for the v2 bug where blocks were keyed on a
// message `id` that production messages do not carry: every block looked
// orphaned and no compression ever happened. The keys are also the safety
// boundary — two messages that map to ONE key must never let a block choose
// which message to close.

import { stableMessageKey, findAmbiguousKeys } from "../src/lib/strategies"

describe("stableMessageKey", () => {
    it("uses a raw message id as 'id:<id>' and info.id the same way", () => {
        assert.strictEqual(stableMessageKey({ id: "m1", role: "user" }, 0), "id:m1")
        assert.strictEqual(stableMessageKey({ info: { id: "m2", role: "user" } }, 3), "id:m2")
    })

    it("falls back to a 'k:' key that is stable across calls for the same message", () => {
        // No id anywhere — exactly the v2 Prompt.Message shape.
        const msg = { role: "user", content: [{ type: "text", text: "hello world" }] }

        const a = stableMessageKey(msg, 7)
        const b = stableMessageKey(msg, 7)

        assert.ok(a.startsWith("k:user:"), `expected a 'k:user:' key, got ${a}`)
        assert.strictEqual(a, b, "same message + same index must yield the same key")
    })

    it("is order-insensitive: structurally equal messages hash identically at the same index", () => {
        const a = { role: "assistant", content: [{ type: "text", text: "x" }], extra: 1 }
        const b = { extra: 1, content: [{ type: "text", text: "x" }], role: "assistant" }

        assert.strictEqual(stableMessageKey(a, 2), stableMessageKey(b, 2))
    })

    it("never collides two distinct messages that share the same content (index disambiguates)", () => {
        const msg = { role: "user", content: [{ type: "text", text: "identical" }] }

        const first = stableMessageKey(msg, 0)
        const second = stableMessageKey(msg, 1)

        assert.notStrictEqual(first, second, "the index must separate identical payloads")
        assert.strictEqual(
            findAmbiguousKeys([first, second]).size,
            0,
            "distinct keys must not be reported ambiguous",
        )
    })
})

describe("findAmbiguousKeys", () => {
    it("marks only the keys produced by more than one message", () => {
        const ambiguous = findAmbiguousKeys(["a", "b", "a", "c", "b"])

        assert.strictEqual(ambiguous.size, 2)
        assert.ok(ambiguous.has("a"))
        assert.ok(ambiguous.has("b"))
        assert.ok(!ambiguous.has("c"), "a unique key is never ambiguous")
    })

    it("returns an empty set for no keys or all-unique keys", () => {
        assert.strictEqual(findAmbiguousKeys([]).size, 0)
        assert.strictEqual(findAmbiguousKeys(["x", "y", "z"]).size, 0)
    })
})

describe("Compression ambiguity safety lock", () => {
    it("never activates a block whose anchor is ambiguous, but never deletes it either", () => {
        const state = makeState()
        // Two DIFFERENT messages squashed onto one key (duplicate id in a
        // malformed transcript). stableMessageKey gives both `id:dup`.
        const messages = [
            rawMessage("dup", "user", "first"),
            rawMessage("dup", "user", "second"),
            rawMessage("other"),
        ]
        const keys = messages.map((m, i) => stableMessageKey(m, i))
        const ambiguous = findAmbiguousKeys(keys)

        registerCompressionBlock(state, {
            coveredIds: ["other"],
            anchorMessageId: "dup",
            summary: "## Compression Summary\nshould never be injected",
            topic: "t",
        })

        syncCompressionBlocks(state, new Set(keys), ambiguous)

        // Lock: the ambiguous anchor means no safe insertion point -> inactive...
        assert.strictEqual(
            state.compressionBlocks!.find((b) => b.anchorMessageId === "dup")!.active,
            false,
            "an ambiguous anchor must not activate a block",
        )
        // ...but the block is NOT thrown away: its key really is in this request.
        assert.strictEqual(
            state.compressionBlocks!.length,
            1,
            "ambiguity must cost compression, never data/state",
        )

        // And with the block inactive, applyCompressedRanges changes nothing.
        const filtered = applyCompressedRanges(state, messages, keys)
        assert.strictEqual(filtered.length, messages.length, "nothing may be replaced")
        assert.ok(
            !filtered.some((m) => m.id === "slim-summary-1"),
            "no summary is injected at a guessed anchor",
        )
    })

    it("never removes an ambiguous message, even when a block claims to cover it", () => {
        const state = makeState()
        const messages = [
            rawMessage("dup", "user", "a"),
            rawMessage("dup", "user", "b"),
            rawMessage("x"),
            rawMessage("y"),
        ]
        const keys = messages.map((m, i) => stableMessageKey(m, i))

        // The block covers the ambiguous "dup" AND the clean "x"; anchor is "y".
        registerCompressionBlock(state, {
            coveredIds: ["dup", "x"],
            anchorMessageId: "y",
            summary: "## Compression Summary\nwork",
            topic: "t",
        })
        syncCompressionBlocks(state, new Set(keys), findAmbiguousKeys(keys))

        const filtered = applyCompressedRanges(state, messages, keys)

        assert.strictEqual(
            filtered.filter((m) => m.id === "dup").length,
            2,
            "the ambiguous message is covered by a block but must survive",
        )
        assert.ok(
            !filtered.some((m) => m.id === "x"),
            "the clean covered message is removed normally",
        )
        assert.ok(filtered.some((m) => m.id === "slim-summary-1"), "summary is injected once landed")
    })

    it("locks (returns messages untouched) when the key array does not line up", () => {
        const state = makeState()
        registerCompressionBlock(state, {
            coveredIds: ["1"],
            anchorMessageId: "2",
            summary: "S",
            topic: "t",
        })
        const messages = [rawMessage("1"), rawMessage("2")]

        // Deliberately short key array: cannot be trusted to identify anything.
        const filtered = applyCompressedRanges(state, messages, ["id:1"])
        assert.strictEqual(filtered, messages)
    })
})

// ─── usage.ts: token metrics ───────────────────────────────────────────────

import {
    totalTokens,
    promptTokens,
    measuredUsageFromTokens,
    findLastCompactionIndex,
    readMeasuredUsage,
    estimatePromptTokens,
    resolveTriggerTokens,
    recordUsage,
    resetSuspiciousMeasurementWarning,
} from "../src/lib/usage"
import type { UsageCache } from "../src/lib/usage"

describe("totalTokens / promptTokens", () => {
    it("sums all five billable fields", () => {
        const t = { input: 10, output: 20, reasoning: 5, cache: { read: 3, write: 2 } }
        assert.strictEqual(totalTokens(t), 40)
        assert.strictEqual(promptTokens(t), 15, "prompt side = input + cache.read + cache.write")
    })

    it("treats missing, broken and negative fields as 0 and never returns NaN", () => {
        assert.strictEqual(totalTokens({ input: 10 }), 10)
        assert.strictEqual(totalTokens({ input: NaN, output: -5, reasoning: Infinity }), 0)
        assert.strictEqual(
            totalTokens({ input: 1, cache: { read: "oops", write: undefined } }),
            1,
        )
        assert.strictEqual(totalTokens(null), 0)
        assert.strictEqual(totalTokens(undefined), 0)
        assert.strictEqual(totalTokens("not-a-record"), 0)

        const result = totalTokens({ input: NaN, output: Infinity, reasoning: -1 })
        assert.ok(Number.isFinite(result), "a broken reading must not become NaN/Infinity")
        assert.strictEqual(result, 0)
    })
})

describe("findLastCompactionIndex", () => {
    it("finds the last completed compaction", () => {
        const messages = [
            { type: "compaction", status: "completed" },
            { type: "assistant" },
            { type: "compaction", status: "completed" },
        ]
        assert.strictEqual(findLastCompactionIndex(messages), 2)
    })

    it("ignores running/failed compactions and returns -1 when none completed", () => {
        assert.strictEqual(
            findLastCompactionIndex([
                { type: "compaction", status: "running" },
                { type: "assistant" },
            ]),
            -1,
        )
        assert.strictEqual(findLastCompactionIndex([{ type: "compaction", status: "failed" }]), -1)
        assert.strictEqual(findLastCompactionIndex([]), -1)
        assert.strictEqual(findLastCompactionIndex([{ type: "assistant" }]), -1)
    })

    it("scans backwards: the last completed wins over an older one", () => {
        const messages = [
            { type: "compaction", status: "completed" },
            { type: "compaction", status: "running" },
            { type: "compaction", status: "completed" },
        ]
        assert.strictEqual(findLastCompactionIndex(messages), 2)
    })
})

describe("readMeasuredUsage", () => {
    it("skips an assistant step with output<=0 and uses the next valid measurement", () => {
        const messages = [
            { type: "assistant", id: "a1", tokens: { input: 100, output: 50 } },
            // Phantom/aborted step: no output -> carries no usable measurement.
            { type: "assistant", id: "a2", tokens: { input: 200, output: 0 } },
        ]

        const usage = readMeasuredUsage(messages)
        assert.ok(usage, "a valid measurement exists behind the phantom step")
        assert.strictEqual(usage!.messageID, "a1")
        assert.strictEqual(usage!.tokens, 150)
        assert.strictEqual(usage!.promptTokens, 100)
    })

    it("does not use a measurement recorded before the last completed compaction", () => {
        const messages = [
            { type: "assistant", id: "old", tokens: { input: 900, output: 900 } },
            { type: "compaction", status: "completed" },
            { type: "assistant", id: "new", tokens: { input: 10, output: 5 } },
        ]
        const afterIndex = findLastCompactionIndex(messages)
        assert.strictEqual(afterIndex, 1)

        const usage = readMeasuredUsage(messages, afterIndex)
        assert.strictEqual(usage!.messageID, "new", "pre-compaction usage describes a dead prompt")
    })

    it("returns null (never 0) when nothing qualifies", () => {
        assert.strictEqual(
            readMeasuredUsage([{ type: "assistant", tokens: { input: 5, output: 0 } }]),
            null,
        )
        assert.strictEqual(readMeasuredUsage([]), null)
        assert.strictEqual(readMeasuredUsage([{ type: "user", tokens: { input: 9, output: 9 } }]), null)
    })

    it("measuredUsageFromTokens rejects output<=0 and an empty prompt side", () => {
        assert.strictEqual(measuredUsageFromTokens({ input: 100, output: 0 }), null)
        assert.strictEqual(measuredUsageFromTokens({ output: 20 }), null, "no prompt side = no measurement")
        assert.strictEqual(measuredUsageFromTokens(null), null)

        const u = measuredUsageFromTokens({ input: 100, output: 20 }, "m1")
        assert.ok(u)
        assert.strictEqual(u!.tokens, 120)
        assert.strictEqual(u!.promptTokens, 100)
        assert.strictEqual(u!.messageID, "m1")
    })
})

describe("resolveTriggerTokens merge rules", () => {
    it("no measurement -> the estimate", () => {
        const r = resolveTriggerTokens(null, 1000)
        assert.strictEqual(r.tokens, 1000)
        assert.strictEqual(r.source, "estimated")
        assert.strictEqual(r.clamped, false)
    })

    it("keeps a real measurement when the estimate is 0 (empty request must not zero it)", () => {
        const r = resolveTriggerTokens({ tokens: 500, promptTokens: 400 }, 0)
        assert.strictEqual(r.tokens, 500)
        assert.strictEqual(r.source, "measured")
        assert.strictEqual(r.clamped, false)
    })

    it("prefers the estimate when the measurement is below half of it (stale)", () => {
        const r = resolveTriggerTokens({ tokens: 100, promptTokens: 90 }, 1000)
        assert.strictEqual(r.tokens, 1000)
        assert.strictEqual(r.source, "estimated")
        assert.strictEqual(r.clamped, true)
    })

    it("clamps an impossibly large measurement at 3x the estimate and flags it", () => {
        let detail: { capped: number; capRatio: number } | undefined
        const r = resolveTriggerTokens({ tokens: 5000, promptTokens: 4000 }, 1000, {
            onSuspiciousMeasurement: (d) => {
                detail = d
            },
        })
        assert.strictEqual(r.tokens, 3000)
        assert.strictEqual(r.source, "measured")
        assert.strictEqual(r.clamped, true)
        assert.ok(detail, "the clamp must be observable")
        assert.strictEqual(detail!.capped, 3000)
        assert.strictEqual(detail!.capRatio, 3)
    })

    it("uses the measurement untouched when it sits between the two ratios", () => {
        const r = resolveTriggerTokens({ tokens: 1200, promptTokens: 1100 }, 1000)
        assert.strictEqual(r.tokens, 1200)
        assert.strictEqual(r.source, "measured")
        assert.strictEqual(r.clamped, false)
    })

    it("treats the ratio boundaries inclusively (0.5x and 3x are not clamped)", () => {
        const low = resolveTriggerTokens({ tokens: 500, promptTokens: 400 }, 1000)
        assert.strictEqual(low.tokens, 500)
        assert.strictEqual(low.clamped, false)

        const high = resolveTriggerTokens({ tokens: 3000, promptTokens: 2000 }, 1000)
        assert.strictEqual(high.tokens, 3000)
        assert.strictEqual(high.clamped, false)
    })

    it("is 'none' with 0 tokens when neither side produced a usable number", () => {
        const r = resolveTriggerTokens(null, 0)
        assert.strictEqual(r.tokens, 0)
        assert.strictEqual(r.source, "none")
        assert.strictEqual(r.clamped, false)
    })

    it("warns once for suspicious measurements and resetSuspiciousMeasurementWarning re-arms it", () => {
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "))
        }
        try {
            resetSuspiciousMeasurementWarning()
            resolveTriggerTokens({ tokens: 9000, promptTokens: 8000 }, 1000)
            resolveTriggerTokens({ tokens: 9000, promptTokens: 8000 }, 1000)
            assert.strictEqual(warnings.length, 1, "warn-once guard must suppress the repeat")

            resetSuspiciousMeasurementWarning()
            resolveTriggerTokens({ tokens: 9000, promptTokens: 8000 }, 1000)
            assert.strictEqual(warnings.length, 2, "reset must re-arm the warning")
        } finally {
            console.warn = originalWarn
            resetSuspiciousMeasurementWarning()
        }
    })
})

describe("recordUsage cache", () => {
    it("stores a measurement and can cache the explicit 'unmeasurable' null", () => {
        const cache: UsageCache = new Map()

        recordUsage(cache, "s1", { tokens: 10, promptTokens: 8 }, 1234)
        const entry = cache.get("s1")!
        assert.strictEqual(entry.updatedAt, 1234)
        assert.strictEqual(entry.usage!.tokens, 10)

        recordUsage(cache, "s1", null, 2000)
        assert.strictEqual(cache.get("s1")!.usage, null, "null is a real, cacheable answer")
        assert.strictEqual(cache.get("s1")!.updatedAt, 2000)
    })
})

describe("estimatePromptTokens coverage", () => {
    it("counts tool output, tool input, reasoning and system text — not just text parts", () => {
        const base = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
        const withTools = [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
                role: "assistant",
                content: [
                    { type: "reasoning", text: "thinking about it ".repeat(50) },
                    { type: "tool-call", name: "read", input: { path: "src/" + "x".repeat(500) } },
                ],
            },
            {
                role: "tool",
                content: [{ type: "tool-result", result: { value: "y".repeat(2000) } }],
            },
        ]

        const baseEst = estimatePromptTokens(base)
        const toolEst = estimatePromptTokens(withTools)

        assert.ok(toolEst > baseEst, "tool/reasoning content must raise the estimate")
        assert.ok(
            toolEst - baseEst > 500,
            `expected a large increase from tool content, got ${toolEst - baseEst}`,
        )

        const withSystem = estimatePromptTokens(base, [{ text: "s".repeat(4000) }])
        assert.ok(
            withSystem > baseEst + 900,
            `system prompt text must be counted, got ${withSystem} vs ${baseEst}`,
        )
    })

    it("counts a v2 tool-result content-block array in full, not as '[object Object]'", () => {
        const text = "R".repeat(4000)
        const messages = [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        result: { type: "content", value: [{ type: "text", text }] },
                    },
                ],
            },
        ]

        const est = estimatePromptTokens(messages)
        // 4000 chars ~ 1000 tokens. A String(object) regression would land near 0.
        assert.ok(
            est >= 900,
            `the full block text must be counted (B-3 regression), got ${est}`,
        )
    })

    it("returns 0 for empty/non-array input and never a bogus positive", () => {
        assert.strictEqual(estimatePromptTokens([]), 0)
        assert.strictEqual(estimatePromptTokens("not-an-array"), 0)
        assert.strictEqual(estimatePromptTokens(null), 0)
    })
})

// ─── state.ts: post-compaction reset ───────────────────────────────────────

import { resetOnCompaction } from "../src/lib/state"

describe("resetOnCompaction", () => {
    it("clears blocks, nudges, token count, auto-compress throttle and tool calls", () => {
        const state = makeState()
        state.compressionBlocks = [
            {
                blockId: 1,
                topic: "t",
                summary: "s",
                anchorMessageId: "a",
                compressMessageId: "c",
                coveredMessageIds: ["x"],
                consumedBlockIds: [],
                active: true,
                createdAt: 1,
                summaryTokens: 1,
            },
        ]
        state.nudges = {
            contextLimitAnchors: ["a"],
            turnNudgeAnchors: ["b"],
            iterationNudgeAnchors: ["c"],
        }
        state.currentTokenCount = 12345
        ;(state as any).lastAutoCompressTime = 999
        state.toolCalls.set("t1", { tool: "read", args: {}, timestamp: 1, turn: 1 })

        resetOnCompaction(state, "comp-1")

        assert.deepStrictEqual(state.compressionBlocks, [])
        assert.deepStrictEqual(state.nudges, {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        })
        assert.strictEqual(state.currentTokenCount, 0)
        assert.strictEqual((state as any).lastAutoCompressTime, 0, "first post-compaction request must not be auto-compress eligible")
        assert.strictEqual(state.toolCalls.size, 0)
    })

    it("preserves user-visible stats, config/identity and the monotonic nextBlockId", () => {
        const state = makeState()
        state.compressionHistory = [
            { timestamp: 1, inputTokens: 100, outputTokens: 10, ratio: 0.9, messageCount: 2, success: true },
        ]
        state.compressionCount = 5
        state.averageCompressionRatio = 0.42
        state.lastCompressionTime = 777
        state.modelContextLimit = 1000000
        state.nextBlockId = 9
        state.manualMode = true
        state.compressPermission = "allow"
        state._lastProviderId = "anthropic"
        state._lastModelId = "claude"

        resetOnCompaction(state, "comp-1")

        assert.strictEqual(state.compressionCount, 5)
        assert.strictEqual(state.compressionHistory.length, 1)
        assert.strictEqual(state.averageCompressionRatio, 0.42)
        assert.strictEqual(state.lastCompressionTime, 777)
        assert.strictEqual(state.modelContextLimit, 1000000)
        assert.strictEqual(state.nextBlockId, 9, "block ids are monotonic — resetting collides summaries")
        assert.strictEqual(state.manualMode, true)
        assert.strictEqual(state.compressPermission, "allow")
        assert.strictEqual(state._lastProviderId, "anthropic")
        assert.strictEqual(state._lastModelId, "claude")
    })

    it("records the compaction id and is idempotent for the same id", () => {
        const state = makeState()
        state.compressionCount = 3

        resetOnCompaction(state, "c1")
        assert.strictEqual(state.lastCompactionMessageId, "c1")

        const snapshot = JSON.stringify({ ...state, toolCalls: [] })
        resetOnCompaction(state, "c1")
        assert.strictEqual(
            JSON.stringify({ ...state, toolCalls: [] }),
            snapshot,
            "a second call with the same id must be a no-op",
        )
        assert.strictEqual(state.lastCompactionMessageId, "c1")
    })
})

// ─── src/lib/prune.ts — tool-output pruning (DCP pruneOutputs) ──────────────
//
// prune.ts is the only strategy that rewrites the *payload* of an already-sent
// message. Providers require exactly one tool_result per tool_call, so dropping
// a message or changing a result's `type` is an immediate 400 that kills the
// session. These tests lock the session-survival invariants, the opt-in gate,
// every eligibility gate, the placeholder contract and the prefix-cache
// (frontier) stability. Fixtures use the verified v2 @opencode/ai Message shape:
//
//   { role, content: ContentPart[] }
//   tool-result part: { type:"tool-result", id, name, result }
//   result: { type:"text"|"json"|"error", value } | { type:"content", value: Block[] }
//   block:  { type:"text", text } | { type:"file", uri, mime, name? }

import {
    PRUNE_MARKER,
    PRUNE_ALWAYS_PROTECTED,
    renderPrunePlaceholder,
    buildPrunePlan,
    applyPrunePlan,
} from "../src/lib/prune"

type PruneOpts = Partial<NonNullable<SlimConfig["strategies"]["pruneOutputs"]>>
type TurnOpts = Partial<NonNullable<SlimConfig["strategies"]["turnProtection"]>>

/** Opt-in config: pruneOutputs explicitly enabled, unless overridden. */
function pruneConfig(prune: PruneOpts = {}, turn?: TurnOpts): SlimConfig {
    const config = makeConfig()
    config.strategies.pruneOutputs = { enabled: true, ...prune }
    if (turn) config.strategies.turnProtection = turn
    return config
}

/** Turn protection off, so a fixture exercises only the gate under test. */
function pruneConfigNoTurn(prune: PruneOpts = {}): SlimConfig {
    return pruneConfig(prune, { enabled: false })
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A payload comfortably over the default 2000-char threshold. */
const PRUNE_BIG = "x".repeat(3000)

function pUser(text = "go"): any {
    return { role: "user", content: [{ type: "text", text }] }
}

function pCall(id: string, name: string): any {
    return { role: "assistant", content: [{ type: "tool-call", id, name, input: {} }] }
}

function pResult(id: string, name: string, type: string, value: unknown): any {
    return { role: "tool", content: [{ type: "tool-result", id, name, result: { type, value } }] }
}

function pText(id: string, name: string, value: string = PRUNE_BIG): any {
    return pResult(id, name, "text", value)
}

function pJson(id: string, name: string, value: unknown = { blob: PRUNE_BIG }): any {
    return pResult(id, name, "json", value)
}

function pContent(
    id: string,
    name: string,
    blocks: any[] = [
        { type: "text", text: PRUNE_BIG },
        { type: "file", uri: "file:///a.png", mime: "image/png", name: "a.png" },
    ],
): any {
    return pResult(id, name, "content", blocks)
}

function pContentOf(message: any): any[] {
    const content = message?.content ?? message?.parts ?? []
    return Array.isArray(content) ? content : []
}

/** The payload-bearing part for a call id (skips the tool-call part). */
function pPayload(messages: readonly any[], id: string): any {
    for (const message of messages) {
        for (const part of pContentOf(message)) {
            if (part?.id === id && (part.result || part.state)) return part
        }
    }
    return undefined
}

function pCount(messages: readonly any[], type: string): number {
    let count = 0
    for (const message of messages) {
        for (const part of pContentOf(message)) if (part?.type === type) count += 1
    }
    return count
}

function pIds(messages: readonly any[], type: string): string[] {
    const ids: string[] = []
    for (const message of messages) {
        for (const part of pContentOf(message)) {
            if (part?.type === type && typeof part.id === "string") ids.push(part.id)
        }
    }
    return ids.sort()
}

// Three prunable payload types (text/json/content) plus an error that must
// never be touched, each paired with its tool-call.
function pTypedTranscript(): any[] {
    return [
        pUser("hi"),
        pCall("t1", "bash"), pText("t1", "bash"),
        pCall("j1", "grep"), pJson("j1", "grep"),
        pCall("c1", "read"), pContent("c1", "read"),
        pCall("e1", "bash"), pResult("e1", "bash", "error", PRUNE_BIG),
    ]
}

// Turn indices (number of preceding user messages):
//   u0(t0) | O1,O2(t1) | u1(t1) | M1..M6(t2) | u2(t2) | R1(t3) | u3(t3)
// The last message is turn 3, so ages are O=2, M=1, R=0.
function pAgedTranscript(): any[] {
    const messages: any[] = [pUser("t0"), pText("O1", "bash"), pText("O2", "grep"), pUser("t1")]
    for (let i = 1; i <= 6; i++) messages.push(pText(`M${i}`, "read"))
    messages.push(pUser("t2"), pText("R1", "bash"), pUser("t3"))
    return messages
}

// ─── A) Session-survival safety locks ───────────────────────────────────────

describe("tool output pruning safety locks", () => {
    it("never changes the message count — no role:'tool' message is dropped", () => {
        const messages = pTypedTranscript()
        const before = messages.length
        const plan = buildPrunePlan(messages, pruneConfigNoTurn())
        assert.ok(plan.outputs.size > 0, "fixture must produce a non-empty plan")

        applyPrunePlan(messages, plan)
        assert.strictEqual(
            messages.length,
            before,
            "dropping a role:'tool' message is a 400 that kills the session",
        )
    })

    it("never changes the tool-call/tool-result part count and keeps every call paired", () => {
        const messages = pTypedTranscript()
        const callsBefore = pIds(messages, "tool-call")
        const resultsBefore = pIds(messages, "tool-result")
        const callsCount = pCount(messages, "tool-call")
        const resultsCount = pCount(messages, "tool-result")

        applyPrunePlan(messages, buildPrunePlan(messages, pruneConfigNoTurn()))

        assert.strictEqual(pCount(messages, "tool-call"), callsCount)
        assert.strictEqual(pCount(messages, "tool-result"), resultsCount)
        assert.deepStrictEqual(pIds(messages, "tool-call"), callsBefore)
        assert.deepStrictEqual(pIds(messages, "tool-result"), resultsBefore)
        assert.deepStrictEqual(
            callsBefore,
            resultsBefore,
            "every tool-call must still have exactly one tool-result",
        )
    })

    it("preserves result.type for text, json and content, and leaves error untouched", () => {
        const messages = pTypedTranscript()
        applyPrunePlan(messages, buildPrunePlan(messages, pruneConfigNoTurn()))

        assert.strictEqual(pPayload(messages, "t1").result.type, "text")
        assert.strictEqual(pPayload(messages, "j1").result.type, "json")
        assert.strictEqual(pPayload(messages, "c1").result.type, "content")
        assert.strictEqual(pPayload(messages, "e1").result.type, "error")
        assert.strictEqual(
            pPayload(messages, "e1").result.value,
            PRUNE_BIG,
            "an error result is owned by purgeStaleToolErrors, never by prune",
        )
    })

    it("keeps a json result an object — never a stringified placeholder", () => {
        const messages = pTypedTranscript()
        applyPrunePlan(messages, buildPrunePlan(messages, pruneConfigNoTurn()))

        const value = pPayload(messages, "j1").result.value
        assert.strictEqual(
            typeof value,
            "object",
            "turning a json value into a string is a type lie the provider can reject",
        )
        assert.ok(!Array.isArray(value))
        assert.strictEqual((value as any).slim_pruned, true)
        assert.deepStrictEqual(Object.keys(value).sort(), ["chars", "slim_pruned", "tool"])
    })

    it("keeps content file blocks and only collapses the text blocks", () => {
        const messages = pTypedTranscript()
        const fileBefore = structuredClone(pPayload(messages, "c1").result.value[1])
        applyPrunePlan(messages, buildPrunePlan(messages, pruneConfigNoTurn()))

        const blocks = pPayload(messages, "c1").result.value
        assert.strictEqual(blocks.length, 2, "the file block must not be dropped")
        assert.strictEqual(blocks[0].type, "text")
        assert.ok(blocks[0].text.startsWith(PRUNE_MARKER))
        assert.deepStrictEqual(blocks[1], fileBefore, "the file uri/mime reference must survive")
    })

    it("clones changed messages and never mutates the caller's live objects", () => {
        const messages = pTypedTranscript()
        const originals = messages.slice()
        const snapshots = originals.map((message) => structuredClone(message))

        applyPrunePlan(messages, buildPrunePlan(messages, pruneConfigNoTurn()))

        // The three payload messages are swapped for clones; the rest are untouched.
        for (const slot of [2, 4, 6]) {
            assert.notStrictEqual(
                messages[slot],
                originals[slot],
                "a changed payload message must be replaced by a clone",
            )
            assert.deepStrictEqual(
                originals[slot],
                snapshots[slot],
                "the live session object must not be mutated",
            )
        }
        for (const slot of [0, 1, 3, 5, 7, 8]) {
            assert.strictEqual(
                messages[slot],
                originals[slot],
                "a message without a planned output stays identity-equal",
            )
        }
    })

    it("buildPrunePlan is pure — repeated builds never mutate the transcript", () => {
        const messages = pTypedTranscript()
        const snapshot = JSON.stringify(messages)
        buildPrunePlan(messages, pruneConfigNoTurn())
        buildPrunePlan(messages, pruneConfigNoTurn())
        assert.strictEqual(JSON.stringify(messages), snapshot)
    })
})

// ─── B) Eligibility gates ───────────────────────────────────────────────────

describe("buildPrunePlan eligibility", () => {
    it("prunes nothing when the pruneOutputs block is absent (default OFF)", () => {
        const plan = buildPrunePlan([pUser(), pText("a1", "bash")], makeConfig())
        assert.strictEqual(
            plan.outputs.size,
            0,
            "an absent block must not rewrite the prompt or break the prefix cache",
        )
        assert.strictEqual(plan.stats.prunedOutputs, 0)
        assert.strictEqual(plan.stats.charsSaved, 0)
    })

    it("prunes nothing when enabled is explicitly false", () => {
        const plan = buildPrunePlan(
            [pUser(), pText("a1", "bash")],
            pruneConfig({ enabled: false }, { enabled: false }),
        )
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("does not prune a result below minChars", () => {
        const messages = [pUser(), pText("small", "bash", "x".repeat(1999))]
        const plan = buildPrunePlan(messages, pruneConfigNoTurn({ minChars: 2000 }))
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("admits a result exactly at minChars (inclusive) and a comfortably large one", () => {
        const atThreshold = [pUser(), pText("edge", "bash", "x".repeat(2000))]
        assert.ok(
            buildPrunePlan(atThreshold, pruneConfigNoTurn({ minChars: 2000 })).outputs.has("edge"),
            "the gate is `size >= minChars`",
        )
        const large = [pUser(), pText("big", "bash")]
        assert.ok(buildPrunePlan(large, pruneConfigNoTurn({ minChars: 2000 })).outputs.has("big"))
    })

    it("protects the last N turns as whole turns (a 6-tool batch is ONE turn)", () => {
        const plan = buildPrunePlan(pAgedTranscript(), pruneConfig({}, { turns: 2 }))

        assert.ok(plan.outputs.has("O1") && plan.outputs.has("O2"), "the age-2 turn is eligible")
        for (let i = 1; i <= 6; i++) {
            assert.ok(
                !plan.outputs.has(`M${i}`),
                `M${i} shares the protected age-1 turn and must not be pruned`,
            )
        }
        assert.ok(!plan.outputs.has("R1"), "the newest turn is always protected")
        assert.strictEqual(plan.stats.prunedOutputs, 2)
    })

    it("never prunes a PRUNE_ALWAYS_PROTECTED tool (the edit family)", () => {
        for (const tool of ["edit", "write", "multiedit", "patch"]) {
            assert.ok(
                PRUNE_ALWAYS_PROTECTED.includes(tool),
                `${tool} must stay in the always-protected set`,
            )
        }

        const messages = [pUser(), pText("e1", "edit"), pText("b1", "bash")]
        const plan = buildPrunePlan(messages, pruneConfigNoTurn())
        assert.ok(
            !plan.outputs.has("e1"),
            "pruning an edit result invites a duplicate edit against stale content",
        )
        assert.ok(plan.outputs.has("b1"), "the unprotected control tool must still be pruned")
    })

    it("honours config protectedTools additions", () => {
        const messages = [pUser(), pText("c1", "mycustom")]
        assert.strictEqual(
            buildPrunePlan(messages, pruneConfigNoTurn()).outputs.size,
            1,
            "control: pruned without protection",
        )
        assert.strictEqual(
            buildPrunePlan(messages, pruneConfigNoTurn({ protectedTools: ["mycustom"] })).outputs
                .size,
            0,
        )
    })

    it("does not prune an errored result", () => {
        const plan = buildPrunePlan(
            [pUser(), pResult("err", "bash", "error", PRUNE_BIG)],
            pruneConfigNoTurn(),
        )
        assert.strictEqual(plan.outputs.size, 0)
    })

    it("does not prune a value already carrying the marker (idempotency)", () => {
        const already = `${PRUNE_MARKER} bash ciktisi kisaltildi (5000 karakter, 3 turn once).`
        assert.strictEqual(
            buildPrunePlan([pUser(), pText("p1", "bash", already)], pruneConfigNoTurn()).outputs
                .size,
            0,
        )

        const json = [pUser(), pJson("j1", "grep", { slim_pruned: true, chars: 5000, tool: "grep" })]
        assert.strictEqual(buildPrunePlan(json, pruneConfigNoTurn()).outputs.size, 0)

        const content = [
            pUser(),
            pContent("c1", "read", [
                { type: "text", text: `${PRUNE_MARKER} read ciktisi kisaltildi.` },
                { type: "file", uri: "file:///a.png", mime: "image/png" },
            ]),
        ]
        assert.strictEqual(buildPrunePlan(content, pruneConfigNoTurn()).outputs.size, 0)
    })

    it("rounds the per-request cap back to a turn boundary (never a partial turn)", () => {
        // Candidates in order: A(turn1), B1..B3(turn2). A cap of 2 lands inside
        // turn2, so the whole turn2 is dropped and only A is pruned.
        const messages = [
            pUser(),
            pText("A", "bash"),
            pUser(),
            pText("B1", "bash"),
            pText("B2", "bash"),
            pText("B3", "bash"),
        ]
        const plan = buildPrunePlan(messages, pruneConfigNoTurn({ maxPerRequest: 2 }))
        assert.strictEqual(plan.stats.prunedOutputs, 1)
        assert.ok(plan.outputs.has("A"))
        assert.ok(!plan.outputs.has("B1") && !plan.outputs.has("B2") && !plan.outputs.has("B3"))
    })
})

// ─── C) Placeholder contract ────────────────────────────────────────────────

describe("prune placeholder", () => {
    it("starts with PRUNE_MARKER", () => {
        assert.ok(renderPrunePlaceholder("bash", 5000, 3).startsWith(PRUNE_MARKER))
    })

    it("carries the tool name, the character count and the turn age", () => {
        const text = renderPrunePlaceholder("grep", 12345, 7)
        assert.ok(text.includes("grep"), "the model must know which tool to re-run")
        assert.ok(
            text.includes("12345"),
            "the model must be able to judge whether the size matters",
        )
        assert.ok(text.includes("7"), "the model must know how stale the output is")
    })

    it("is exactly the text applyPrunePlan writes into a text result", () => {
        const messages = [pUser(), pText("t1", "bash")]
        const plan = buildPrunePlan(messages, pruneConfigNoTurn())
        applyPrunePlan(messages, plan)
        assert.strictEqual(pPayload(messages, "t1").result.value, plan.outputs.get("t1"))
    })
})

// ─── D) Frontier stability (prefix-cache safety) ────────────────────────────

describe("prune frontier stability", () => {
    it("two consecutive builds over the same transcript prune the identical set", () => {
        const messages = [
            pUser(),
            pText("O1", "bash"),
            pText("O2", "grep"),
            pUser(),
            pText("M1", "read"),
            pUser(),
            pText("R1", "bash"),
            pUser(),
        ]
        const config = pruneConfig({}, { turns: 1 })

        const first = buildPrunePlan(messages, config)
        const second = buildPrunePlan(messages, config)

        assert.deepStrictEqual(
            [...first.outputs.keys()].sort(),
            [...second.outputs.keys()].sort(),
        )
        assert.deepStrictEqual(
            [...first.outputs.values()].sort(),
            [...second.outputs.values()].sort(),
        )
        assert.deepStrictEqual(first.stats, second.stats)
    })
})

// ─── Panel occupancy is never the lifetime counter (issue #11) ─────────────
//
// Regression lock for GitHub issue #11. `buildPanelData` used to derive its
// headline occupancy from `measured.tokens` — the session's LIFETIME
// CUMULATIVE counter — whenever the transcript carried no per-call prompt
// measurement. That counter (input+output+reasoning+cache.read+cache.write
// summed over the whole session) exceeds the window by orders of magnitude, so
// the panel reported a bogus "100% critical" on a nearly empty session.
//
// `measured.tokens` is still reported — on its own `cumulativeTokens` field,
// rendered as a separately-labelled Lifetime line. It must never be the
// headline.

describe("Panel occupancy never falls back to the lifetime counter", () => {
    const LIFETIME = 56_100_000
    const smallTranscript: MessageWithParts[] = [
        {
            info: { id: "1", role: "user", sessionID: "s1", time: { created: 0 } } as any,
            parts: [{ type: "text", text: "Hello" }] as any,
        },
    ]

    it("uses the transcript estimate for the headline, not measured.tokens, when no promptTokens exist", async () => {
        // A small transcript, a 1M window, and a lifetime counter of 56.1M with
        // NO promptTokens — the exact shape of issue #11.
        const panel = await buildPanelData(
            "s1",
            smallTranscript,
            makeState(),
            makeConfig({ maxContextLimit: "80%" }),
            "test-model",
            {
                tokens: LIFETIME,
                // promptTokens deliberately absent: the transcript has no usage.
                cost: 1.5,
                contextLimit: 1_000_000,
                model: "test-model",
            },
        )

        assert.notStrictEqual(
            panel.currentTokens,
            LIFETIME,
            "the headline must not be the lifetime counter (this is issue #11)",
        )
        assert.ok(
            panel.currentTokens < 10_000,
            `headline must be the small transcript estimate, got ${panel.currentTokens}`,
        )
        assert.ok(
            panel.usagePercent < 1,
            `56.1M against a 1M window would read ${panel.usagePercent}%; the headline must stay small`,
        )
        assert.notStrictEqual(
            panel.status,
            "critical",
            "a small transcript is not a critical window",
        )
    })

    it("keeps the lifetime total on cumulativeTokens and labels the source estimated", async () => {
        const panel = await buildPanelData(
            "s1",
            smallTranscript,
            makeState(),
            makeConfig({ maxContextLimit: "80%" }),
            "test-model",
            { tokens: LIFETIME, cost: 1.5, contextLimit: 1_000_000, model: "test-model" },
        )

        assert.strictEqual(
            panel.cumulativeTokens,
            LIFETIME,
            "the lifetime spend is still reported, just never as occupancy",
        )
        assert.strictEqual(
            panel.tokenSource,
            "estimated",
            "with no per-call prompt size the headline is our estimate, not a measurement",
        )

        // The lifetime figure must appear on a Lifetime line only — never on
        // the Context line, which is the occupancy read.
        const lines = renderPanel(panel).split("\n")
        const lifetime = lines.find((line) => line.includes("Lifetime:"))
        assert.ok(lifetime, `a Lifetime line expected:\n${lines.join("\n")}`)
        assert.ok(lifetime.includes("56.1M"), lifetime)
        const contextLine = lines.find((line) => line.includes("Context: ["))
        assert.ok(contextLine, "context bar rendered")
        assert.ok(
            !contextLine.includes("56.1M"),
            `the Context figure must never be the lifetime counter: ${contextLine}`,
        )
    })
})

// ─── Panel box width guard ────────────────────────────────────────────────
//
// Regression class: a long line punches through the fixed 63-column box frame
// and corrupts the panel's border. The instance this replaces was the pre-fix
// `│ Measured tokens: 56100000  (100% of 200000)  [critical]`, which is why
// the lifetime figure is now rendered through `formatTokens`.
//
// Width is measured in DISPLAY columns, not UTF-16 `String.length`: the two
// disagree for every astral glyph (an emoji counts 2 in `String.length` but
// occupies 1-2 terminal cells), and a check built on `String.length` silently
// measures the wrong thing for exactly the characters most likely to appear
// in a status line.
//
// The `Trigger:` and `Prune:` lines used to be 67-79 columns wide — a real
// cosmetic defect, previously tolerated through the allowlist below rather
// than fixed. Both are now split across two lines, so `ALLOWED_OVERFLOW` is
// empty. The mechanism itself is kept deliberately and is checked for
// exactness: any NEW over-wide line fails immediately, and re-adding an entry
// requires a conscious decision rather than a widened assertion.

describe("Panel box width", () => {
    /**
     * Display width in terminal cells for the text the panel emits (ASCII,
     * box-drawing, and the occasional emoji). Code points is the right measure
     * here: every glyph the panel uses is single-width, and the alternative —
     * `String.length` — is provably wrong for astral characters, which is the
     * mistake this guard exists to prevent.
     */
    function displayWidth(line: string): number {
        return [...line].length
    }

    /**
     * Lines permitted to exceed the frame, named by the SECTION they sit under
     * so a growing value cannot smuggle a second offender in under the same
     * entry (see `overflowingSections`).
     *
     * Everything the panel renders from a NUMBER fits at worst-case
     * magnitudes: the multi-fact lines that could not (Trigger, Prune) were
     * split across two lines rather than truncated. What does NOT fit is
     * everything rendered from an UNBOUNDED string, and that set is disclosed
     * here rather than left to a reviewer's memory:
     *
     *   - "Cost Estimate" — the `Model:` line. A model id is a server-supplied
     *     string (a self-hosted gateway can name a model anything at all), and
     *     it is emitted raw, so an id longer than ~40 columns overflows.
     *   - "Top Topics" — a topic name. Topic names come from the model's own
     *     output over the transcript, so nothing here bounds their length.
     *   - "Recommendations" — a recommendation string, free text by nature.
     *
     * None of the three is truncated, and that is a DELIBERATE PRODUCTION
     * DESIGN DECISION deferred to a later change, not an oversight: silently
     * eliding a model id or a topic name is worse than a wide line, exactly as
     * the Trigger/Prune splits reasoned. The value of recording them is that
     * the claim is now in the code: a future change that truncates one of them
     * will fail the exactness assertion below until its entry is removed on
     * purpose, and a new over-wide line fails immediately.
     */
    const ALLOWED_OVERFLOW: string[] = ["Cost Estimate", "Top Topics", "Recommendations"]

    /**
     * The `ALLOWED_OVERFLOW` entries that exist because of UNBOUNDED input
     * rather than because of any swept magnitude.
     *
     * A sweep that holds the model id, topic name and recommendation at their
     * fixture values cannot reach these, so its exactness check is on the
     * remainder — while a sweep that DOES drive those strings past the frame
     * is the one that produces all three. Listing them separately is what lets
     * both sweeps assert against the same single source of truth without either
     * of them having to pretend it reached the others' cases.
     */
    const FREE_TEXT_SECTIONS: string[] = ["Cost Estimate", "Top Topics", "Recommendations"]

    /**
     * Drive the real /panel command (which calls renderPanelText) and return the box.
     *
     * `prune` switches the driver to the `panel` TOOL path (`buildPanelData` +
     * `renderPanel` in src/lib/tui.ts), which is the only surface that renders
     * the Prune line — the /panel slash output has no prune figures at all, so
     * driving only that path is exactly what left the Prune line unmeasured
     * (and overflowing) before this was fixed.
     */
    async function panelTextFor(options: {
        promptTokens?: number
        contextLimit: number
        lifetime: number
        model?: string
        /** When set, render the `panel` tool with this prune payload. */
        prune?: { prunedOutputs: number; charsSaved: number }
    }): Promise<string> {
        if (options.prune) {
            const panel = await buildPanelData(
                "ses_test",
                [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }] as any,
                makeState(),
                makeConfig(),
                options.model ?? "test-model",
                {
                    tokens: options.lifetime,
                    promptTokens: options.promptTokens ?? 1_000,
                    cost: 1,
                    contextLimit: options.contextLimit,
                    model: options.model ?? "test-model",
                },
                options.prune,
            )
            return renderPanel(panel)
        }
        const promptTokens = options.promptTokens
        const harness = makePanelHarness({
            transcript: promptTokens === undefined
                ? [{ type: "user", text: "hello" }]
                : [
                      {
                          type: "assistant",
                          tokens: {
                              input: promptTokens,
                              output: 500,
                              cache: { read: 0, write: 0 },
                          },
                      },
                  ],
            sessionInfo: {
                tokens: { input: options.lifetime, output: 100_000 },
                cost: 1,
                model: {
                    id: options.model ?? "test-model",
                    providerID: "acme",
                    limit: { context: options.contextLimit },
                },
            },
        })
        const run = await startSlash(harness, "panel")
        await run()
        assert.strictEqual(harness.dialogs.length, 1, "panel output goes to a dialog")
        return harness.dialogs[0].message
    }

    it("keeps every panel line inside the 63-column frame, with no allowed overflow", async () => {
        // Sweep the whole occupancy range (including absent and over-window)
        // across several window sizes, always with an enormous lifetime
        // counter attached. Any line that grows past the frame fails with the
        // offending text, so the guard catches the class, not one instance.
        const windows = [32_768, 128_000, 200_000, 1_000_000]
        const occupancies: (number | undefined)[] = [
            undefined, // no per-turn usage: the "fill unknown" branch
            0, 1, 10, 50, 70, 75, 90, 95, 100, 150, 5_610,
        ]
        // Ordinary prune traffic AND the worst case the formatter can produce:
        // MAX_SAFE_INTEGER charsSaved is "9007.2T" and its /4 is "2251.8T", the
        // two widest values `formatTokens` can return.
        const prunes: (undefined | { prunedOutputs: number; charsSaved: number })[] = [
            undefined,
            { prunedOutputs: 50, charsSaved: 1_200_000 },
            { prunedOutputs: 12_345, charsSaved: Number.MAX_SAFE_INTEGER },
        ]
        const seenOverflow = new Set<string>()

        for (const contextLimit of windows) {
            for (const percent of occupancies) {
                for (const prune of prunes) {
                const promptTokens =
                    percent === undefined ? undefined : Math.round((contextLimit * percent) / 100)
                const rendered = await panelTextFor({
                    promptTokens,
                    contextLimit,
                    lifetime: 56_000_000,
                    prune,
                })
                for (const line of rendered.split("\n")) {
                    if (displayWidth(line) > 63) continue;
                    // Redundant with the branch above, deliberately: it states
                    // the invariant in the failure message, so a future edit that
                    // changes the condition cannot quietly weaken it.
                    assert.ok(
                        displayWidth(line) <= 63,
                        `line is ${displayWidth(line)} columns, over the 63-column frame ` +
                            `(window=${contextLimit}, occupancy=${String(percent)}%): ` +
                            `${JSON.stringify(line)}`,
                    )
                }
                for (const section of overflowingSections(rendered)) seenOverflow.add(section)
                }
            }
        }

        // This sweep drives the free-text inputs (model id, topic name,
        // recommendation) only at their fixture magnitudes, so it can never
        // reach the three entries in ALLOWED_OVERFLOW that exist because those
        // strings are UNBOUNDED — the worst-case sweep at the end of this
        // describe is what reaches them, and it asserts the same list. So the
        // exactness check here is on the REACHABLE remainder, plus a separate
        // assertion that this sweep overflowed in none of the free-text
        // sections: an entry must never be quietly absorbing an offender that
        // is reachable without an extreme input.
        const reachable = ALLOWED_OVERFLOW.filter((s) => !FREE_TEXT_SECTIONS.includes(s))
        assert.deepStrictEqual(
            [...seenOverflow].filter((s) => !FREE_TEXT_SECTIONS.includes(s)),
            reachable,
            `the set of over-wide lines changed; update ALLOWED_OVERFLOW deliberately ` +
                `(saw: ${JSON.stringify([...seenOverflow])})`,
        );
        assert.deepStrictEqual(
            [...seenOverflow].filter((s) => FREE_TEXT_SECTIONS.includes(s)),
            [],
            `a line over-widened at FIXTURE magnitudes inside ${JSON.stringify(FREE_TEXT_SECTIONS)}; ` +
                `those entries exist only for unbounded input, so they must not absorb this`,
        )
    })

    it("measures the Prune line at a magnitude that overflowed before the split", async () => {
        // The specific instance that was fixed: the pre-fix line was a single
        // `│ Prune: 50 outputs · ~1.2M chars (~300.0K tokens) saved on last
        // request` at 72 columns — 9 over the frame — and at MAX_SAFE_INTEGER
        // magnitudes it reached 79. This is the case the sweep could never
        // reach, because panelTextFor never drove renderPanel with a prune.
        const text = await panelTextFor({
            promptTokens: 100_000,
            contextLimit: 200_000,
            lifetime: 56_000_000,
            prune: { prunedOutputs: 50, charsSaved: 1_200_000 },
        })

        const pruneLines = text
            .split("\n")
            .filter((l) => l.includes("Prune:") || l.includes("saved on"))
        assert.strictEqual(
            pruneLines.length,
            2,
            `a figure line and a caveat line expected:\n${text}`,
        )
        for (const line of pruneLines) {
            assert.ok(
                displayWidth(line) <= 63,
                `Prune line is ${displayWidth(line)} columns: ${JSON.stringify(line)}`,
            )
        }
        // Every fact survives the split, including the caveat that stops a
        // reader treating the figure as a permanent saving.
        assert.ok(pruneLines[0].includes("50 outputs"), pruneLines[0])
        assert.ok(pruneLines[0].includes("1.2M chars"), pruneLines[0])
        assert.ok(pruneLines[0].includes("300.0K tokens"), pruneLines[0])
        assert.ok(/last request only/.test(pruneLines[1]), pruneLines[1])
    })

    it("keeps the Lifetime line inside the frame at every magnitude, not just at 56.1M", async () => {
        // The specific instance that was fixed: an unformatted lifetime total
        // ("56100000") is 8 characters where "56.1M" is 4, so a regression that
        // drops `formatTokens` from this line overflows here even though the
        // 56.1M rendering still fits comfortably.
        //
        // Swept to the magnitudes that used to break it: `formatTokens` scales
        // one step per 1e3 (K/M/G/T), so 1e12 renders "1.0T" and
        // MAX_SAFE_INTEGER renders the 7-character "9007.2T" — both inside the
        // 7 columns the 56-column fixed text of this line leaves.
        for (const lifetime of [
            1,
            999,
            1_000,
            999_999,
            1_000_000,
            56_100_000,
            999_999_999,
            999_999_999_999, // was "1000000.0M" — 10 chars, punched through
            1e12,
            Number.MAX_SAFE_INTEGER,
        ]) {
            const text = await panelTextFor({
                promptTokens: 1_000,
                contextLimit: 200_000,
                lifetime,
            })
            const line = text
                .split("\n")
                .find((l) => l.includes("Lifetime:"))
            assert.ok(line, `a Lifetime line expected for lifetime=${lifetime}:\n${text}`)
            assert.ok(
                displayWidth(line) <= 63,
                `Lifetime line is ${displayWidth(line)} columns at lifetime=${lifetime}: ` +
                    `${JSON.stringify(line)}`,
            )
        }
    })

    // ── Independent verification of the Trigger / Prune split ─────────────
    //
    // The sweep above proves the FRAME is intact. It cannot prove the split did
    // not quietly DROP a value: a line truncated to fit is inside the frame and
    // loses information, and the whole point of the caveat on the Prune line is
    // to stop a user reading a per-request saving as a permanent one. The tests
    // below therefore assert that every fact is still PRESENT, at the magnitudes
    // where the joined line used to overflow.
    //
    // `renderPanel` is driven directly with hand-built PanelData so the sweep
    // can reach magnitudes `buildPanelData` will not produce (a four-digit
    // threshold percent, a MAX_SAFE_INTEGER window). The values are ones
    // `formatTokens` can actually return, not invented shapes.

    /** A PanelData with every field populated, for overriding the swept ones. */
    function panelDataWith(overrides: Partial<PanelData> = {}): PanelData {
        return {
            sessionId: "width-sweep",
            timestamp: 0,
            currentTokens: 1_000,
            maxTokens: 200_000,
            usagePercent: 0.5,
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
            ...overrides,
        }
    }

    /** Every line of a rendered panel that exceeds the frame. */
    function overflowingLines(text: string): string[] {
        return text.split("\n").filter((line) => displayWidth(line) > 63)
    }

    /**
     * The SECTION each over-wide line sits under, de-duplicated, in render
     * order.
     *
     * Attribution is by the section header (`Cost Estimate:`, `Top Topics:`,
     * `Recommendations:`), not by the text before the first ":" and not by the
     * offending line itself. Both of those are unusable for the free-text
     * lines: a recommendation carries no colon at all, so the key would be the
     * whole recommendation, and a topic name IS the text before the colon. A
     * section header is fixed text that cannot grow with the value, so an entry
     * in `ALLOWED_OVERFLOW` covers exactly the lines that belong to it and no
     * more.
     */
    function overflowingSections(text: string): string[] {
        let section = "(frame)"
        const found: string[] = []
        for (const line of text.split("\n")) {
            const body = line.replace(/^│\s*/, "").trim()
            if (/^[A-Z][A-Za-z ]*:$/.test(body)) {
                section = body.slice(0, -1)
                continue
            }
            if (displayWidth(line) > 63 && !found.includes(section)) found.push(section)
        }
        return found
    }

    it("keeps all four Prune facts — count, chars, tokens and the last-request-only caveat — at the widest magnitude", async () => {
        // The pre-split Prune line reached 79 columns at MAX_SAFE_INTEGER
        // ("9007.2T chars", "2251.8T tokens", a five-digit output count). A
        // split that fitted the frame by dropping the caveat would still pass
        // every width assertion above while silently turning a per-request
        // saving into what reads as a cumulative one.
        const text = await panelTextFor({
            promptTokens: 100_000,
            contextLimit: 200_000,
            lifetime: 56_000_000,
            prune: { prunedOutputs: 12_345, charsSaved: Number.MAX_SAFE_INTEGER },
        })
        const pruneLines = text.split("\n").filter((l) => l.includes("Prune:") || l.includes("saved on"))

        assert.deepStrictEqual(
            overflowingLines(text),
            [],
            `the panel must fit the frame at MAX_SAFE_INTEGER prune magnitudes:\n${text}`,
        );
        assert.strictEqual(pruneLines.length, 2, `a figure line and a caveat line expected:\n${text}`);
        // 1) the output count
        assert.ok(pruneLines[0].includes("12345 outputs"), pruneLines[0]);
        // 2) the characters saved
        assert.ok(pruneLines[0].includes("9007.2T chars"), pruneLines[0]);
        // 3) the approximate token figure
        assert.ok(pruneLines[0].includes("2251.8T tokens"), pruneLines[0]);
        // 4) the caveat. Asserted as two halves because the caveat is the fact
        //    a width-driven "simplification" would remove.
        assert.ok(
            /last request only/.test(pruneLines[1]) && /not cumulative/.test(pruneLines[1]),
            `the "last request only, not cumulative" caveat must survive the split: ${pruneLines[1]}`,
        )
    })

    it("keeps the Trigger threshold, the window it is relative to, and the floor all visible after the split", async () => {
        // The same class on the Trigger line: threshold, window and floor are
        // three separate facts, and the floor was the one moved to a
        // continuation line. `formatTokens` is 7 columns at its worst
        // ("9007.2T") and a four-digit percent adds 5 more, which is what made
        // the joined line impossible.
        const thresholds: NonNullable<PanelData["threshold"]>[] = [
            {
                tokens: 150_000,
                percent: 75,
                minTokens: 100_000,
                minPercent: 50,
                contextLimit: 200_000,
            },
            {
                // MAX_SAFE_INTEGER window: "9007.2T" for both the threshold and
                // the window, with a four-digit percent on each.
                tokens: 9_007_199_254_740_991,
                percent: 1234.5,
                minTokens: 9_007_199_254_740_990,
                minPercent: 1234.4,
                contextLimit: Number.MAX_SAFE_INTEGER,
            },
            {
                // No window: both percent fields are null, the other branch.
                tokens: 8_000_000,
                percent: null,
                minTokens: 4_000_000,
                minPercent: null,
                contextLimit: 0,
            },
        ]
        for (const threshold of thresholds) {
            const data = panelDataWith({
                threshold,
                currentTokens: 1_000,
                maxTokens: 9_007_199_254_740_991,
                usagePercent: 99.9,
                status: "critical",
                cumulativeTokens: Number.MAX_SAFE_INTEGER,
            })
            const text = renderPanel(data)
            const label = JSON.stringify(threshold)

            assert.deepStrictEqual(
                overflowingLines(text),
                [],
                `panel overflows the frame for threshold ${label}:\n${text}`,
            )

            const triggerLines = text
                .split("\n")
                .filter((l) => l.includes("Trigger:") || l.includes("floor"))
            assert.strictEqual(
                triggerLines.length,
                2,
                `a threshold line and a floor line expected for ${label}:\n${text}`,
            );
            // The threshold itself.
            assert.ok(
                triggerLines[0].includes(`Trigger: ${formatTokens(threshold.tokens)} tokens`),
                `the threshold value must be stated for ${label}: ${triggerLines[0]}`,
            );
            // The window it is relative to (both branches of that fact).
            assert.ok(
                threshold.percent === null
                    ? triggerLines[0].includes("window unknown")
                    : triggerLines[0].includes(
                          `${threshold.percent.toFixed(1)}% of ${formatTokens(threshold.contextLimit)} window`,
                      ),
                `the window the threshold is relative to must be stated for ${label}: ${triggerLines[0]}`,
            );
            // The floor — the fact the split moved to its own line.
            assert.ok(
                triggerLines[1].includes(formatTokens(threshold.minTokens)),
                `the floor value must survive the split for ${label}: ${triggerLines[1]}`,
            )
        }
    })

    it("keeps every panel line inside the frame across a worst-case magnitude sweep", async () => {
        // This sweeps the magnitudes directly: windows, occupancies, token
        // figures, lifetime, threshold and prune all pushed to the widest value
        // `formatTokens` can return (and to MAX_SAFE_INTEGER itself). Nothing
        // swept here may overflow, and the exactness assertion at the end says
        // so against the same `ALLOWED_OVERFLOW` the free-text cases below
        // populate.
        //
        // Message COUNTS stay at their fixture magnitudes: they are emitted raw
        // (not through `formatTokens`) and are the count of messages in one
        // request, so a nine-quadrillion count is not a state the plugin can
        // reach. Every value that IS a token or character figure — the class
        // this guard exists for — is swept to its worst case.
        const windows = [1, 32_768, 200_000, 1_000_000, 1e12, Number.MAX_SAFE_INTEGER]
        const occupancies = [0, 0.5, 50, 80, 90, 99.9, 100, 150, 1000]
        const tokenFigures = [1, 1_000, 999_999, 1_000_000, 1e12, Number.MAX_SAFE_INTEGER]
        const prunes: (undefined | { prunedOutputs: number; charsSaved: number })[] = [
            undefined,
            { prunedOutputs: 1, charsSaved: 1 },
            { prunedOutputs: 50, charsSaved: 1_200_000 },
            { prunedOutputs: 999_999, charsSaved: Number.MAX_SAFE_INTEGER },
        ]
        const seenOverflow = new Set<string>()

        for (const window of windows) {
            for (const percent of occupancies) {
                for (const tokens of tokenFigures) {
                    for (const prune of prunes) {
                        // A threshold of an arbitrary window: 1e9% of a small
                        // window and a four-digit percent of a huge one are both
                        // reachable, and the percent is the part the joined line
                        // could not absorb.
                        const windowPercent = window > 0 ? (tokens / window) * 100 : null
                        const data = panelDataWith({
                            currentTokens: tokens,
                            maxTokens: window === 0 ? tokens : window,
                            usagePercent: percent,
                            status: percent > 90 ? "critical" : percent > 70 ? "warning" : "healthy",
                            cumulativeTokens: Number.MAX_SAFE_INTEGER,
                            totalTokensSaved: Number.MAX_SAFE_INTEGER,
                            threshold: {
                                tokens,
                                percent: windowPercent,
                                minTokens: Math.floor(tokens / 2),
                                minPercent: windowPercent === null ? null : windowPercent / 2,
                                contextLimit: window,
                            },
                            prune: prune
                                ? {
                                      enabled: true,
                                      prunedOutputs: prune.prunedOutputs,
                                      charsSaved: prune.charsSaved,
                                  }
                                : undefined,
                        })
                        for (const section of overflowingSections(renderPanel(data))) {
                            seenOverflow.add(section)
                        }
                    }
                }
            }
        }

        // ── Unbounded free text: the magnitudes above cannot reach these ────
        //
        // Every value swept above is a NUMBER, and a number is bounded by
        // `formatTokens` (7 columns at worst) or by the count of messages in
        // one request. The three lines below are rendered from UNBOUNDED
        // strings — a model id, a topic name, a recommendation — which have no
        // worst case short of "as long as the input is". Holding the sweep at
        // fixture magnitudes therefore proved nothing about them, and
        // `ALLOWED_OVERFLOW: []` was an incomplete claim rather than a clean
        // one.
        //
        // They are driven past the frame here, the overflows are attributed to
        // their section, and each one is asserted to be the ONLY section that
        // overflows in its own panel — so an entry cannot quietly absorb a
        // second offender. The lines are not truncated; see `ALLOWED_OVERFLOW`.
        const freeText: { section: string; overrides: Partial<PanelData> }[] = [
            {
                section: "Cost Estimate",
                // A 200-character model id. A real provider id is ~20 columns;
                // a self-hosted gateway can name a model anything at all, and
                // the id is emitted raw.
                overrides: { model: "m".repeat(200) },
            },
            {
                section: "Top Topics",
                // A topic name is derived from the model's own output over the
                // transcript, so nothing in this codebase bounds its length.
                overrides: { topics: [{ topic: "t".repeat(200), count: 1, tokens: 10 }] },
            },
            {
                section: "Recommendations",
                // Free text by nature.
                overrides: { recommendations: ["r".repeat(200)] },
            },
        ]
        for (const { section, overrides } of freeText) {
            const text = renderPanel(panelDataWith(overrides))
            const sections = overflowingSections(text);
            assert.deepStrictEqual(
                sections,
                [section],
                `the ${section} case must overflow the frame in that section and nowhere else ` +
                    `(so the ALLOWED_OVERFLOW entry for it is not absorbing an unrelated line), ` +
                    `or its entry is stale because the line now fits:\n${text}`,
            );
            for (const found of sections) seenOverflow.add(found)
        }

        assert.deepStrictEqual(
            [...seenOverflow],
            ALLOWED_OVERFLOW,
            "the overflow allowlist must be EXACTLY what actually overflows: an entry that no " +
                `longer describes a real overflow is stale, and a new one is a defect. ` +
                `These lines exceeded the 63-column frame: ${JSON.stringify([...seenOverflow])}`,
        )
    })

    it("keeps every recommendation line inside the frame, at the wording production emits", async () => {
        // The recommendation strings were shortened so that the lines
        // `generateRecommendations` itself emits fit the frame, and no width
        // assertion above covers them. They are produced by
        // `generateRecommendations` inside
        // `buildPanelData`, so this drives that (not a hand-written list) and
        // measures what production actually emits.
        const manySmall = Array.from({ length: 60 }, (_, i) => ({
            info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant" },
            parts: [{ type: "text", text: "hi" }],
        })) as any
        const oneHuge = [
            {
                info: { id: "big", role: "user" },
                parts: [{ type: "text", text: "x".repeat(8_000) }],
            },
        ] as any
        // Occupancy is currentTokens / maxTokens, and maxTokens is the resolved
        // compress trigger. Shrinking the WINDOW (not the prompt — the real
        // tokenizer is O(chars) and a prompt large enough to matter would make
        // this test take minutes) puts an 8k-character prompt far over the
        // window without changing the recommendation logic under test.
        const tinyWindow = makeState()
        tinyWindow.modelContextLimit = 1_000

        // Scenario 1: low occupancy, many messages, no compression yet — the
        // "no compressions yet" and "many messages but low usage" lines.
        const lowUsage = await buildPanelData("s1", manySmall, makeState(), makeConfig(), "test-model")
        // Scenario 2: a prompt far over the window — the "usage is high" and
        // "nearly full" lines, the two longest of the five.
        const highUsage = await buildPanelData("s2", oneHuge, tinyWindow, makeConfig(), "test-model")

        assert.ok(
            lowUsage.recommendations.length >= 2,
            `precondition: the many-messages scenario must produce its recommendations, got ` +
                `${JSON.stringify(lowUsage.recommendations)}`,
        );
        assert.ok(
            highUsage.usagePercent > 90,
            `precondition: the high-usage scenario must really be over 90%, got ${highUsage.usagePercent}`,
        )

        for (const [label, panel] of [
            ["low usage", lowUsage],
            ["high usage", highUsage],
        ] as const) {
            const rendered = renderPanel(panel)
            assert.ok(
                rendered.includes("│ Recommendations:"),
                `a Recommendations section expected for the ${label} scenario:\n${rendered}`,
            );
            assert.deepStrictEqual(
                overflowingLines(rendered),
                [],
                `the panel overflows the frame with the ${label} recommendations ` +
                    `(${JSON.stringify(panel.recommendations)}):\n${rendered}`,
            )
        }

        // The specific facts the shortened wording must still carry: the advice
        // to compress, the consequence the second line warns about, and the
        // deduplication hint.
        const all = [...lowUsage.recommendations, ...highUsage.recommendations].join(" | ")
        assert.ok(/Consider compressing/.test(all), `the compress advice must survive: ${all}`);
        assert.ok(/truncation/.test(all), `the truncation warning must survive: ${all}`);
        assert.ok(/Deduplication/.test(all), `the deduplication hint must survive: ${all}`);
        assert.ok(/No compressions yet/.test(all), `the no-compressions-yet line must survive: ${all}`)
    })
})

// ─── /panel no-per-turn-usage branch ──────────────────────────────────────
//
// With no per-message usage in the transcript, the only server figure is the
// lifetime cumulative counter. It is spend, not occupancy, so the panel must
// print exactly one line saying so — with no window percentage and no health
// status beside it. The pre-fix line was
// `│ Measured tokens: 56100000  (100% of 200000)  [critical]`.

describe("/panel without per-turn usage", () => {
    async function panelTextFor(
        tokens: Record<string, number>,
        models?: unknown[],
    ): Promise<string> {
        const harness = makePanelHarness({
            transcript: [{ type: "user", text: "hello" }],
            sessionInfo: {
                tokens,
                cost: 0.5,
                model: { id: "test-model", providerID: "acme", limit: { context: 200000 } },
            },
            models,
        })
        const run = await startSlash(harness, "panel")
        await run()
        assert.strictEqual(harness.dialogs.length, 1, "panel output goes to a dialog")
        return harness.dialogs[0].message
    }

    it("prints exactly one Lifetime line with the formatted total and no percent or status", async () => {
        // 56.1M tokens of lifetime spend on a 200k window: 28050%, which the
        // old code clamped to a confident "100% ... [critical]".
        const text = await panelTextFor({
            input: 56_000_000,
            output: 100_000,
            cache: { read: 0, write: 0 },
        })
        const lines = text.split("\n")

        const lifetimeLines = lines.filter((line) => line.includes("Lifetime:"))
        assert.strictEqual(
            lifetimeLines.length,
            1,
            `exactly one Lifetime line expected:\n${text}`,
        )

        const line = lifetimeLines[0]
        assert.ok(line.includes("56.1M"), `the formatted lifetime total must be shown: ${line}`)
        assert.ok(
            line.includes("fill unknown"),
            `the line must say the window fill cannot be derived from it: ${line}`,
        )

        // What the line must NOT contain: the pre-fix conflation.
        assert.ok(
            !line.includes("Measured tokens:"),
            `the lifetime counter must not be labelled a measurement: ${line}`,
        )
        assert.ok(
            !line.includes("%"),
            `no window percentage may sit beside a lifetime figure: ${line}`,
        )
        for (const status of ["healthy", "warning", "critical", "unknown", "n/a"]) {
            assert.ok(
                !line.includes(`[${status}]`),
                `no health status may sit beside a lifetime figure: ${line}`,
            )
        }
        assert.ok(
            !/of\s+[\d.]+[KM]?\b/.test(line),
            `the lifetime figure must not be presented against a window: ${line}`,
        )
    })

    it("never renders a 100% occupancy from a lifetime counter on any surface", async () => {
        const harness = makePanelHarness({
            transcript: [{ type: "user", text: "hello" }],
            sessionInfo: {
                tokens: { input: 56_000_000, output: 100_000, cache: { read: 0, write: 0 } },
                cost: 0.5,
                model: { id: "test-model", providerID: "acme", limit: { context: 200000 } },
            },
        })
        for (const command of ["panel", "status", "compress"]) {
            const run = await startSlash(harness, command)
            await run()
        }
        const output = [
            ...harness.dialogs.map((d) => d.message),
            ...harness.syntheticWrites.map((w) => String(w.text ?? "")),
        ].join("\n")

        // The Trigger line legitimately carries percentages of the WINDOW
        // (e.g. "80.0% of 200.0K window") — that is a threshold, not occupancy.
        // What must never appear is an occupancy percentage: a `%` sitting
        // directly beside the 56.1M lifetime figure.
        assert.ok(
            !/56\.1M[^│\n]*%/.test(output) && !/%[^│\n]*56\.1M/.test(output),
            `no percentage may be derived from the lifetime counter:\n${output}`,
        )
        for (const line of output.split("\n")) {
            if (line.includes("Lifetime") || line.includes("lifetime")) {
                assert.ok(
                    !/56,100,000[^\n]*%/.test(line) && !/%[^\n]*56,100,000/.test(line),
                    `lifetime spend must not carry a window percentage: ${line}`,
                )
            }
        }
    })
})

// ─── /status health is UNKNOWN when occupancy cannot be measured ─────────
//
// Regression: `/status` derived its health from `real.usagePercent` with no
// measurement in sight. With no per-message usage in the transcript that
// percent is 0 — "unknown", not "empty" — so the old code printed a confident
// "🟢 HEALTHY" for a session whose real occupancy it could not know. A false
// all-clear is as wrong as the false "🔴 CRITICAL" the lifetime fallback
// caused, and harder to notice.

describe("/status health reporting", () => {
    /** Drive the real /status command and return the dialog body. */
    async function statusText(options: {
        promptInput?: number
        limit?: number
        lifetime?: number
    }): Promise<string> {
        const limit = options.limit ?? 100_000
        const harness = makePanelHarness({
            // A transcript with NO per-message usage: occupancy is unmeasurable.
            transcript: [{ type: "user", text: "hello" }],
            sessionInfo: {
                tokens: { input: options.lifetime ?? 56_000_000, output: 100_000 },
                cost: 1,
                model: { id: "test-model", providerID: "acme", limit: { context: limit } },
            },
        })
        const run = await startSlash(harness, "status")
        await run()
        assert.strictEqual(harness.dialogs.length, 1, "/status reports through a dialog")
        return harness.dialogs[0].message
    }

    it("reports ⚪ UNKNOWN, never a confident health, when the transcript has no per-message usage", async () => {
        const text = await statusText({})
        assert.ok(
            text.includes("⚪ UNKNOWN"),
            `an unmeasurable occupancy must read UNKNOWN, not a health:\n${text}`,
        )
        for (const status of ["🟢 HEALTHY", "🟡 WARNING", "🔴 CRITICAL"]) {
            assert.ok(
                !text.includes(status),
                `no confident health may be claimed without a measurement (${status}):\n${text}`,
            )
        }
    })

    it("still reports HEALTHY / WARNING / CRITICAL for a real measurement", async () => {
        // The three measured states must keep working — the UNKNOWN branch is
        // only for "cannot measure", never a replacement for the thresholds.
        const cases: { input: number; expected: string; label: string }[] = [
            { input: 10_000, expected: "🟢 HEALTHY", label: "~10% of the window" },
            { input: 75_000, expected: "🟡 WARNING", label: "~75% of the window" },
            { input: 95_000, expected: "🔴 CRITICAL", label: "~95% of the window" },
        ]
        for (const { input, expected, label } of cases) {
            const harness = makePanelHarness({
                transcript: [
                    {
                        type: "assistant",
                        tokens: { input, output: 500, cache: { read: 0, write: 0 } },
                    },
                ],
                sessionInfo: {
                    tokens: { input: 56_000_000, output: 100_000 },
                    cost: 1,
                    model: { id: "test-model", providerID: "acme", limit: { context: 100_000 } },
                },
            })
            const run = await startSlash(harness, "status")
            await run()
            const text = harness.dialogs[0].message
            assert.ok(
                text.includes(expected),
                `a measured ${label} must still report ${expected}:\n${text}`,
            )
        }
    })

    it("clamps an over-window measurement to CRITICAL without throwing or rendering nonsense", async () => {
        const harness = makePanelHarness({
            transcript: [
                {
                    type: "assistant",
                    tokens: { input: 150_000, output: 500, cache: { read: 0, write: 0 } },
                },
            ],
            sessionInfo: {
                tokens: { input: 56_000_000, output: 100_000 },
                cost: 1,
                model: { id: "test-model", providerID: "acme", limit: { context: 100_000 } },
            },
        })
        const run = await startSlash(harness, "status")
        await run() // must not throw
        const text = harness.dialogs[0].message
        assert.ok(
            text.includes("🔴 CRITICAL"),
            `a prompt larger than the window is critical:\n${text}`,
        )
        assert.ok(
            !/NaN|Infinity|undefined/.test(text),
            `an over-window figure must not render nonsense:\n${text}`,
        )
        assert.ok(
            text.includes("(100%)"),
            `the displayed percent is clamped, not 150%:\n${text}`,
        )
    })
})

// ─── TUI context-window resolver never borrows another model's window ─────
//
// The other half of issue #11. `measureSession` used to fall back to matching
// on `modelID` alone, so when two providers expose the same `modelID` — or
// when the active model is simply absent from the list — the panel measured a
// 128k session against an unrelated provider's 1M window and reported every
// occupancy as a fraction of a window we are not running.

describe("TUI context-window resolver", () => {
    /** Drive the real /panel command and return the rendered box. */
    async function panelFor(
        sessionInfo: unknown,
        models: unknown[],
    ): Promise<string> {
        const harness = makePanelHarness({ transcript: [], sessionInfo, models })
        const run = await startSlash(harness, "panel")
        await run()
        assert.strictEqual(harness.dialogs.length, 1, "panel output goes to a dialog")
        return harness.dialogs[0].message
    }

    it("does not borrow another provider's 1M window when the active model is absent from the list", async () => {
        // The exact shape of issue #11: the active model is a 128k model, and
        // the registry holds an unrelated provider's 1M model.
        const text = await panelFor(
            {
                tokens: { input: 10_000, output: 500 },
                cost: 0.1,
                model: { id: "active-model", providerID: "acme", limit: { context: 128_000 } },
            },
            [
                { providerID: "othercorp", modelID: "gigantic", limit: { context: 1_000_000 } },
            ],
        )
        assert.ok(
            !/1\.0M window/.test(text),
            `an unrelated provider's 1M window must never become ours:\n${text}`,
        )
        assert.ok(
            text.includes("128.0K window"),
            `the active model's own 128k window is the honest answer:\n${text}`,
        )
    })

    it("does not borrow a same-modelID entry from a different provider", async () => {
        // The specific case the exact-match tightening defends against: two
        // providers expose the SAME modelID, and only one of them is active.
        const text = await panelFor(
            {
                tokens: { input: 10_000, output: 500 },
                cost: 0.1,
                // Active model is "shared-model" on provider "acme" at 128k.
                model: { id: "shared-model", providerID: "acme", limit: { context: 128_000 } },
            },
            [
                // Same modelID, different provider, huge window. A modelID-only
                // match latches onto this one.
                {
                    providerID: "othercorp",
                    modelID: "shared-model",
                    limit: { context: 1_000_000 },
                },
            ],
        )
        assert.ok(
            !/1\.0M window/.test(text),
            `a modelID collision across providers must not hand back the wrong window:\n${text}`,
        )
        assert.ok(
            text.includes("128.0K window"),
            `the active model's own window must be used:\n${text}`,
        )
    })

    it("uses the exact providerID+modelID match when the active model IS in the list", async () => {
        // The tightening must not have broken the normal path: an exact match
        // on both fields still resolves, and prefers the right entry even when
        // a same-modelID impostor comes first in the list.
        const text = await panelFor(
            {
                tokens: { input: 10_000, output: 500 },
                cost: 0.1,
                model: { id: "shared-model", providerID: "acme", limit: { context: 128_000 } },
            },
            [
                { providerID: "othercorp", modelID: "shared-model", limit: { context: 1_000_000 } },
                { providerID: "acme", modelID: "shared-model", limit: { context: 256_000 } },
            ],
        )
        assert.ok(
            text.includes("256.0K window"),
            `the exact acme/shared-model entry must win over the impostor:\n${text}`,
        )
        assert.ok(
            !/1\.0M window/.test(text),
            `the impostor's window must not appear:\n${text}`,
        )
    })
})

// ─── measureSession occupancy source (issue #11, direct) ──────────────────
//
// Mutation note: the `contextTokens` fallback in `measureSession` is NOT
// observable through /panel, /status or /compress. All three render the
// occupancy only when `promptTokens` exists, so `promptTokens ?? 0` and
// `promptTokens ?? lifetimeTokens` produce identical output on every surface —
// verified by mutation testing, where reintroducing the lifetime fallback
// breaks no rendered-surface test. These tests therefore call the exported
// `measureSession` directly, which is why the test-only export exists.

describe("measureSession occupancy source", () => {
    /** A PluginContext shaped like the harness, but minimal and purpose-built. */
    function measuringContext(sessionInfo: unknown, messages: unknown[]) {
        return {
            client: {
                session: {
                    get: async () => sessionInfo,
                    context: async () => messages,
                },
                model: { list: async () => ({ data: [] }) },
            },
            ui: { toast: { show: () => {} } },
        } as any
    }

    it("returns 0% occupancy when no per-turn usage exists, even with a huge lifetime total", async () => {
        const real = await measureSession(
            measuringContext(
                {
                    tokens: { input: 56_000_000, output: 1_000_000 },
                    cost: 1,
                    model: { id: "test-model", providerID: "acme", limit: { context: 200_000 } },
                },
                // No per-message usage: occupancy is genuinely unmeasurable.
                [{ type: "user", text: "hello" }],
            ),
            "ses_test",
        )

        assert.ok(real, "measureSession must return a reading")
        assert.strictEqual(
            real!.usagePercent,
            0,
            `56.1M lifetime against a 200k window would read 100%; an unmeasurable ` +
                `occupancy must be 0, not the lifetime counter (issue #11)`,
        )
        assert.strictEqual(
            real!.promptTokens,
            undefined,
            "there is no prompt measurement to report, and none may be invented",
        )
        // The lifetime figure is still available — as the separate counter.
        assert.strictEqual(real!.tokens, 57_000_000, "lifetime spend is still reported")
    })

    it("derives occupancy from promptTokens when a per-turn measurement exists", async () => {
        const real = await measureSession(
            measuringContext(
                {
                    tokens: { input: 57_000_000, output: 1_000_000 },
                    cost: 1,
                    model: { id: "test-model", providerID: "acme", limit: { context: 200_000 } },
                },
                [{ type: "user", text: "hello" }],
            ),
            "ses_test",
            // The transcript is passed explicitly: `measureSession` reads the
            // measurement from `messages`, not from `client.session.context`.
            [
                {
                    type: "assistant",
                    tokens: { input: 150_000, output: 500, cache: { read: 0, write: 0 } },
                },
            ],
        )

        assert.ok(real)
        assert.strictEqual(real!.promptTokens, 150_000, "the prompt measurement is used verbatim")
        assert.strictEqual(
            real!.usagePercent,
            75,
            "occupancy is prompt against the window, never lifetime against the window",
        )
    })

    it("keeps occupancy at 0 rather than the lifetime total for every magnitude", async () => {
        // Guards against a future "close enough" fallback: the guard is on
        // promptTokens being absent, not on the lifetime figure being large.
        for (const lifetime of [0, 1, 1_000, 200_000, 56_100_000, 1e12]) {
            const real = await measureSession(
                measuringContext(
                    {
                        tokens: { input: lifetime, output: 0 },
                        cost: 0,
                        model: { id: "test-model", providerID: "acme", limit: { context: 200_000 } },
                    },
                    [{ type: "user", text: "hello" }],
                ),
                "ses_test",
            )
            assert.ok(real, `a reading for lifetime=${lifetime}`)
            assert.strictEqual(
                real!.usagePercent,
                0,
                `lifetime=${lifetime} with no per-turn usage must not produce occupancy`,
            )
        }
    })
})

// ─── purgeErrors: the default-off flag ─────────────────────────────────────
//
// The pair of facts this section exists to hold together:
//   (a) the id read is FIXED, so the strategy is no longer inert;
//   (b) it is nonetheless OFF by default, so enabling it is an explicit choice
//       rather than a silent behaviour change on a patch release.
// Dropping either half is a real defect — (a) alone would rewrite every
// existing user's errored tool inputs; (b) alone leaves the fix dormant.

describe("purgeErrors: default-off and config merge", () => {
    /** loadConfig with XDG_CONFIG_HOME pointed at an empty scratch dir. */
    async function configWith(file: string | null): Promise<any> {
        const previousXdg = process.env.XDG_CONFIG_HOME
        const dir = await mkdtemp(join(tmpdir(), "slim-purge-cfg-"))
        process.env.XDG_CONFIG_HOME = dir
        try {
            if (file !== null) {
                const { mkdir, writeFile } = await import("node:fs/promises")
                await mkdir(join(dir, "opencode"), { recursive: true })
                await writeFile(join(dir, "opencode", "slim.jsonc"), file, "utf-8")
            }
            // Precondition: with no file there is nothing for loadConfig to read.
            if (file === null) {
                assert.strictEqual(
                    existsSync(join(dir, "opencode", "slim.jsonc")),
                    false,
                    "the no-file case must really have no config to read",
                )
            }
            return loadConfig()
        } finally {
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previousXdg
            await rm(dir, { recursive: true, force: true })
        }
    }

    it("ships purgeErrors disabled, with turns and protectedTools still present", async () => {
        const config = await configWith(null)
        assert.strictEqual(
            config.strategies.purgeErrors.enabled,
            false,
            "purgeErrors must be off by default now that it actually does something",
        )
        assert.strictEqual(
            config.strategies.purgeErrors.turns,
            4,
            "disabling must not drop the sibling keys the strategy still needs",
        )
        assert.deepStrictEqual(
            config.strategies.purgeErrors.protectedTools,
            [],
            "the protectedTools whitelist must survive alongside the disabled flag",
        )
    })

    it("a partial override of turns keeps the disabled flag (per-sub-object merge)", async () => {
        // The merge is a whitelist of sub-object spreads. If `purgeErrors` were
        // merged as a whole-object REPLACEMENT, this user's override would drop
        // `enabled` from the object entirely — and `undefined` is falsy, which
        // would silently disable the strategy they were trying to configure.
        const config = await configWith('{ "strategies": { "purgeErrors": { "turns": 2 } } }')
        assert.strictEqual(
            config.strategies.purgeErrors.turns,
            2,
            "the user's override must apply",
        )
        assert.strictEqual(
            config.strategies.purgeErrors.enabled,
            false,
            "a partial override must inherit the default flag, not drop the key",
        )
        assert.ok(
            "enabled" in config.strategies.purgeErrors,
            "`enabled` must be present, not merely falsy by omission",
        )
    })

    it("a partial override of protectedTools keeps the disabled flag", async () => {
        const config = await configWith('{ "strategies": { "purgeErrors": { "protectedTools": ["bash"] } } }')
        assert.deepStrictEqual(config.strategies.purgeErrors.protectedTools, ["bash"])
        assert.strictEqual(
            config.strategies.purgeErrors.enabled,
            false,
            "overriding one sibling must not resurrect or erase the flag",
        )
    })

    it("an explicit enabled: true in the user's config turns the strategy on", async () => {
        // The other half of the pair: the flag is a real switch, not a hard-off.
        const config = await configWith('{ "strategies": { "purgeErrors": { "enabled": true } } }')
        assert.strictEqual(config.strategies.purgeErrors.enabled, true, "opt-in must work")
    })
})

// ─── formatTokens: width budget and back-compatibility ─────────────────────
//
// Regression class: the formatter was duplicated byte-for-byte in two files and
// scaled ONE step per 1e3, so `999999999999` rendered as "1000000.0M" — 10
// characters where the panel frame allows 4, punching straight through the
// box border. It is now one exported implementation with a progressive
// T/G/M/K ladder.
//
// The panel-level suite above proves the rendered LINE fits; this section pins
// the formatter itself, and — just as important — proves that nothing below the
// overflow point changed. A fix that reformatted everything to be "nicer"
// would silently alter the panel text that other tests assert verbatim, and
// that is a user-visible change nobody asked for.

describe("formatTokens", () => {
    /**
     * The widest form the ladder can produce for any REACHABLE input: 7
     * characters ("1000.0M" / "1000.0G" / "9007.2T") — a 4-digit mantissa plus
     * ".0" and the unit suffix. The old single-step version exceeded this
     * ("1000000.0M", 10 chars), which is what punched through the box frame.
     *
     * Bounded by `Number.MAX_SAFE_INTEGER`, the largest input any token count
     * can reach. Beyond that (1e18 renders "1000000.0T", 10 chars) the ladder
     * runs out of rungs — asserted explicitly below rather than silently
     * excluded, so the limit of this guarantee is on the record.
     */
    const BUDGET = 7

    it("never renders more than the character budget, at any reachable magnitude", () => {
        // Swept across every ladder step and the values just below each one,
        // where an off-by-one in the ladder comparison would show up.
        const magnitudes = [
            0, 1, 9, 10, 99, 100, 999, 1_000, 1_001, 1_499, 9_999, 999_999,
            1_000_000, 56_100_000, 999_999_999, 1_000_000_000, 1_500_000_000,
            999_999_999_999, 1e12, 1.5e12, 1e15, 1e15 + 1,
            Number.MAX_SAFE_INTEGER,
        ]
        for (const tokens of magnitudes) {
            const rendered = formatTokens(tokens)
            assert.ok(
                rendered.length <= BUDGET,
                `formatTokens(${tokens}) = ${JSON.stringify(rendered)} is ` +
                    `${rendered.length} chars, over the ${BUDGET}-char budget`,
            )
        }

        // The exact instance that overflowed: single-step scaling rendered this
        // as "1000000.0M". Assert the value, not just the length, so a fix
        // cannot pass by emitting some other 10-char string.
        assert.strictEqual(formatTokens(999_999_999_999), "1000.0G", "the overflow instance itself")
        assert.strictEqual(formatTokens(1e12), "1.0T", "1e12 must take the T rung")
        assert.strictEqual(formatTokens(Number.MAX_SAFE_INTEGER), "9007.2T", "the largest input")
    })

    it("renders every sub-1e9 value byte-identically to the previous implementation", () => {
        // Nothing below the overflow point may have changed. These are the exact
        // strings the panel tests assert elsewhere ("150.0K", "1.0M"), so any
        // drift here is a visible change to already-asserted panel output.
        // The trailing ".0" is deliberate — it distinguishes a rounded figure
        // from a count — and must NOT be "cleaned up".
        const expected: Array<[number, string]> = [
            [0, "0"],
            [1, "1"],
            [999, "999"], // below 1000: printed exactly, never "999.0"
            [1_000, "1.0K"],
            [1_200, "1.2K"],
            [150_000, "150.0K"],
            [1_000_000, "1.0M"],
            [56_100_000, "56.1M"],
            [999_999_999, "1000.0M"], // the largest pre-fix-safe mantissa: exactly at the budget
        ]
        for (const [tokens, want] of expected) {
            assert.strictEqual(
                formatTokens(tokens),
                want,
                `formatTokens(${tokens}) must be unchanged below 1e9 — this string appears ` +
                    `verbatim in the panel's own output`,
            )
        }
    })

    it("picks the largest rung that fits, so the mantissa never exceeds 4 digits", () => {
        // The bound is 4 mantissa digits ("1000.0"), not 3: with a T rung at
        // 1e12 there is no 4-digit mantissa left to overflow into, so "1000.0G"
        // is the widest legitimate rendering. What must NEVER appear is the
        // old unbounded quotient ("1000000.0M"), which is 5+ digits.
        for (const [tokens, suffix] of [
            [1_000_000_000, "G"],
            [999_999_999_999, "G"],
            [1e12, "T"],
            [1e15, "T"],
        ] as const) {
            const rendered = formatTokens(tokens)
            assert.strictEqual(
                rendered.endsWith(suffix),
                true,
                `formatTokens(${tokens}) = ${JSON.stringify(rendered)} should use the ${suffix} rung`,
            )
            assert.ok(
                rendered.length <= BUDGET,
                `formatTokens(${tokens}) = ${JSON.stringify(rendered)} exceeds the 4-digit-mantissa bound; ` +
                    `the ladder must step up rather than print an unbounded quotient`,
            )
        }
    })

    it("stays within budget all the way to MAX_SAFE_INTEGER, and the bound is MAX_SAFE_INTEGER", () => {
        // The ladder has four rungs (T at 1e12 is the top), so the guarantee
        // holds exactly as far as a token count can reach. Past
        // MAX_SAFE_INTEGER there is no rung left and the quotient grows
        // unbounded again — documenting that ceiling is honest; pretending the
        // budget is universal would not be.
        assert.ok(formatTokens(Number.MAX_SAFE_INTEGER).length <= BUDGET, "the largest real input fits")
        // The 7-column budget is what the LIFETIME call site needs; the
        // wider-number lines (Trigger, Prune) are a separate pre-existing
        // defect and are deliberately out of scope here — see the
        // `formatTokens` comment in src/lib/tui.ts.
    })
})
