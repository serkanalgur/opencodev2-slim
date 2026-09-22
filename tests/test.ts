import { describe, it } from "node:test"
import assert from "node:assert"
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
import { resolveCompressLimits } from "../src/lib/config"
import { buildPanelData, renderPanel } from "../src/lib/tui"
import { deriveStats } from "../src/tui"
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
                tokens: 220326,
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

    it("resolveModelContextLimit falls back to model.list()", async () => {
        const mockCtx = {
            model: {
                default: () => Promise.resolve(undefined),
                list: () => [
                    { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", limit: { context: 200000 } },
                    { providerID: "openai", modelID: "gpt-4o", limit: { context: 128000 } },
                ],
            },
        }
        // Since no default is set, it should try list() and find the first model with a limit
        const limit = await (resolveModelContextLimit as any)(mockCtx)
        assert.ok(limit > 0)
    })
})

// ─── Import for new tests ──────────────────────────────────────────────────

import { messageHasCompress, purgeStaleToolErrors, applyCompressedRanges, syncCompressionBlocks } from "../src/lib/strategies"
import { resolveModelContextLimit } from "../src/index"
