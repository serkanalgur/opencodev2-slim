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
import { buildPanelData, renderPanel } from "../src/lib/tui"
import tuiPlugin, { deriveStats } from "../src/tui"
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
                    // Deliberately NOT 200000: that is DEFAULT_MODEL_LIMIT, so a
                    // 200000 result would also be produced by the safety net and
                    // the assertion could not tell a real list() fallback apart.
                    { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", limit: { context: 175000 } },
                    { providerID: "openai", modelID: "gpt-4o", limit: { context: 128000 } },
                ],
            },
        }
        // Since no default is set, it should try list() and find the first model with a limit
        const limit = await (resolveModelContextLimit as any)(mockCtx)
        assert.strictEqual(
            limit,
            175000,
            "the first listed model's window wins — not the 200k safety net",
        )
        assert.ok(limit > 0)
    })
})

// ─── Import for new tests ──────────────────────────────────────────────────

import { messageHasCompress, purgeStaleToolErrors, applyCompressedRanges, syncCompressionBlocks } from "../src/lib/strategies"
import { resolveModelContextLimit } from "../src/index"

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
        assert.ok(
            rendered.includes(
                "Trigger: 150.0K tokens (75.0% of 200.0K window) · floor 50.0K (25.0%)",
            ),
            `expected the trigger line with both token and percent values, got:\n${rendered}`,
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

        const triggerLine = rendered.split("\n").find((line) => line.includes("Trigger:"))
        assert.ok(triggerLine, "a trigger line is rendered")
        assert.ok(triggerLine!.includes("window unknown"), triggerLine)
        assert.ok(triggerLine!.includes("150.0K"), "absolute trigger tokens still shown")
        assert.ok(triggerLine!.includes("floor 50.0K"), "absolute floor still shown")
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
            model: { list: async () => ({ data: [] }) },
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
        assert.ok(text.includes("Measured tokens: 1500"), "session.get usage shown")
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
