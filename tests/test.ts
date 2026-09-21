import { describe, it } from "node:test"
import assert from "node:assert"
import { countTokens, shouldCompress, getMessageText, getToolResultContent } from "../src/lib/compress"
import { pruneMessages } from "../src/lib/strategies"
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
