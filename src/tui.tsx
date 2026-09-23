/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

// Rough token estimate: ~4 chars per token.
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
}

interface PanelStats {
    totalMessages: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    systemMessages: number
    compactionCount: number
    totalTokens: number
    tokensByRole: { user: number; assistant: number; system: number }
}

function emptyStats(): PanelStats {
    return {
        totalMessages: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        systemMessages: 0,
        compactionCount: 0,
        totalTokens: 0,
        tokensByRole: { user: 0, assistant: 0, system: 0 },
    }
}

// Derives context-usage stats from the session transcript.
export function deriveStats(messages: readonly unknown[]): PanelStats {
    const stats = emptyStats()
    for (const raw of messages) {
        const m = raw as {
            type?: string
            content?: Array<{ type?: string; text?: string }>
            summary?: string
        }
        let text = ""
        let role: "user" | "assistant" | "system" = "assistant"

        const t = m?.type
        if (t === "user" || t === "synthetic" || t === "shell") {
            role = "user"
        } else if (t === "assistant") {
            role = "assistant"
        } else if (t === "system" || t === "skill") {
            role = "system"
        } else if (t === "compaction") {
            role = "system"
            stats.compactionCount++
            text = m.summary || ""
        }

        // User/system messages carry their text on a top-level `text` field
        // (not inside a `content` array). Capture it too so their tokens count.
        if (role !== "assistant" && typeof (m as any).text === "string") {
            text += (m as any).text
        }

        if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part?.type === "text" && typeof part.text === "string") {
                    text += part.text
                } else if (part?.type === "tool") {
                    stats.toolCalls++
                    if (typeof part.text === "string") text += part.text
                }
            }
        }

        const tokens = estimateTokens(text)
        switch (role) {
            case "user":
                stats.userMessages++
                stats.tokensByRole.user += tokens
                break
            case "assistant":
                stats.assistantMessages++
                stats.tokensByRole.assistant += tokens
                break
            case "system":
                stats.systemMessages++
                stats.tokensByRole.system += tokens
                break
        }
        stats.totalTokens += tokens
    }
    stats.totalMessages = messages.length
    return stats
}

// Builds a human-readable panel as plain text (injected into the message stream).
function renderPanelText(
    sessionID: string,
    stats: PanelStats,
    real?: MeasuredReal | null,
): string {
    const limit = real?.contextLimit ?? 0
    const pct = real?.usagePercent ?? 0
    const status = real ? (pct >= 90 ? "critical" : pct >= 70 ? "warning" : "healthy") : "n/a"
    const lines: string[] = []
    lines.push("┌─────────────────────────────────────────────────────────────┐")
    lines.push("│                    SLIM CONTEXT PANEL                       │")
    lines.push("├─────────────────────────────────────────────────────────────┤")
    lines.push(`│ Session: ${sessionID.slice(0, 40)}`)
    lines.push(`│ Messages: ${stats.totalMessages}`)
    lines.push(
        `│   User: ${stats.userMessages}  Assistant: ${stats.assistantMessages}  System: ${stats.systemMessages}`,
    )
    lines.push(`│   Tool calls: ${stats.toolCalls}  Compactions: ${stats.compactionCount}`)
    lines.push(`│ Tokens (est): User ${stats.tokensByRole.user} | Assistant ${stats.tokensByRole.assistant} | System ${stats.tokensByRole.system}`)
    lines.push(`│ Total token estimate: ${stats.totalTokens}`)
    if (real) {
        lines.push("├─────────────────────────────────────────────────────────────┤")
        lines.push(`│ Measured tokens: ${real.tokens}  (${pct}% of ${limit})  [${status}]`)
        if (real.cost > 0) lines.push(`│ Cost: $${real.cost.toFixed(6)}`)
        lines.push(`│ Model: ${real.model}`)
    }
    lines.push("└─────────────────────────────────────────────────────────────┘")
    return lines.join("\n")
}

// Resolves the "current" session: the router-focused session if any, else the most recent.
function resolveCurrentSession(context: any): string | null {
    const sessions = context.data.session.list() || []
    if (sessions.length === 0) return null
    // The TUI host exposes the active route via context.ui.router (not context.router).
    const route = context.ui?.router?.current?.()
    if (route && typeof route === "object" && "sessionID" in route) {
        return route.sessionID as string
    }
    return sessions[0].id
}

// Server-measured context numbers for a session (Session.Info.tokens + cost + model),
// mirroring what the `panel` tool in index.ts reads via ctx.session.get().
interface MeasuredReal {
    tokens: number
    cost: number
    contextLimit: number
    model: string
    usagePercent: number
}

async function measureSession(context: any, sessionID: string): Promise<MeasuredReal | null> {
    try {
        const info: any = await context.client.session.get({ sessionID })
        if (!info) return null
        const tokens: any = info.tokens ?? {}
        const tokenCount =
            (typeof tokens.input === "number" ? tokens.input : 0) +
            (typeof tokens.output === "number" ? tokens.output : 0) +
            (typeof tokens.reasoning === "number" ? tokens.reasoning : 0) +
            (typeof tokens.cache?.read === "number" ? tokens.cache.read : 0) +
            (typeof tokens.cache?.write === "number" ? tokens.cache.write : 0)

        // Resolve context limit: try model.list() first, then session info, then default.
        let contextLimit = 200000
        const modelID: string = info.model?.id || ""
        const providerID: string = info.model?.providerID || ""

        try {
            const modelList: any = await context.client.model.list()
            const models: any[] = modelList?.data ?? modelList ?? []
            // Find by exact match (providerID/modelID), then by modelID alone
            const found = models.find(
                (m: any) => m.providerID === providerID && m.modelID === modelID,
            ) || models.find((m: any) => m.modelID === modelID)
            if (found?.limit?.context && found.limit.context > 0) {
                contextLimit = found.limit.context
            }
        } catch {
            // Fall through to session info or default
        }

        // Fallback: session info might have model.limit.context
        if (contextLimit === 200000 && info.model?.limit?.context && info.model.limit.context > 0) {
            contextLimit = info.model.limit.context
        }

        const usagePercent =
            contextLimit > 0 ? Math.min(100, Math.round((tokenCount / contextLimit) * 100)) : 0
        return {
            tokens: tokenCount,
            cost: typeof info.cost === "number" ? info.cost : 0,
            contextLimit,
            model: modelID || "unknown",
            usagePercent,
        }
    } catch {
        return null
    }
}

export default Plugin.define({
    id: "opencodev2-slim.cli",
    setup(context) {
        // Register commands inside the "app" slot render, where the keymap
        // provider is available (consistent with OpenCode V2 CLI plugins).
        context.ui.slot({
            append: "app",
            render: () => {
                context.keymap.layer(() => ({
                    mode: "global",
                    priority: 10,
                    commands: [
                        // ─── /panel ────────────────────────────────────
                        {
                            id: "opencodev2-slim.panel",
                            title: "Show Slim Context Panel",
                            group: "Slim",
                            palette: true,
                            slash: { name: "panel", aliases: ["slim-panel"] },
                            enabled: true,
                            suggested: true,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Panel",
                                        message: "No active session found. Open a session first.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    await context.data.session.message.sync(sessionID)
                                    const messages =
                                        context.data.session.message.list(sessionID) || []
                                    const real = await measureSession(context, sessionID)
                                    const stats = deriveStats(messages)
                                    const text = renderPanelText(sessionID, stats, real)
                                    await context.client.session.synthetic({
                                        sessionID,
                                        text,
                                        description: "slim-panel",
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Panel",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /compress ─────────────────────────────────
                        {
                            id: "opencodev2-slim.compress",
                            title: "Compress Context",
                            group: "Slim",
                            palette: true,
                            slash: {
                                name: "compress",
                                aliases: ["slim-compress"],
                                args: [
                                    {
                                        name: "focus",
                                        description: "What to compress (e.g., 'old exploration')",
                                        required: false,
                                    },
                                    {
                                        name: "mode",
                                        description: "Compression mode: auto, range, or topic",
                                        required: false,
                                    },
                                    {
                                        name: "keepRecent",
                                        description: "Number of recent messages to keep (default: 5)",
                                        required: false,
                                    },
                                ],
                            },
                            enabled: true,
                            suggested: true,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    const args = (input as any) || {}
                                    const focus = args.focus || "user-requested compression"
                                    const mode = args.mode || "auto"
                                    const keepRecent = args.keepRecent ?? 5

                                    // Measure current state first
                                    const real = await measureSession(context, sessionID)

                                    const statusLine = real
                                        ? `${real.tokens.toLocaleString()} tokens (${real.usagePercent}% of ${real.contextLimit.toLocaleString()})`
                                        : "unknown"

                                    const text = [
                                        `**Slim Compress**`,
                                        ``,
                                        `**Current state:** ${statusLine}`,
                                        ``,
                                        `Ready to compress with:`,
                                        `- **Focus:** ${focus}`,
                                        `- **Mode:** ${mode}`,
                                        `- **Keep recent:** ${keepRecent} messages`,
                                        ``,
                                        `> The assistant will now call the compress tool.`,
                                        `> Or type: \`compress({ focus: "${focus}", mode: "${mode}", keepRecent: ${keepRecent} })\``,
                                    ].join("\n")

                                    await context.client.session.synthetic({
                                        sessionID,
                                        text,
                                        description: "slim-compress",
                                    })

                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: `Compression ready: "${focus}". Assistant will process it.`,
                                        variant: "success",
                                        duration: 3000,
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Compress",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /status ──────────────────────────────────
                        {
                            id: "opencodev2-slim.status",
                            title: "Show Compact Status",
                            group: "Slim",
                            palette: true,
                            slash: { name: "status", aliases: ["slim-status"] },
                            enabled: true,
                            suggested: false,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Status",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    const real = await measureSession(context, sessionID)
                                    if (!real) {
                                        context.ui.toast.show({
                                            title: "Slim Status",
                                            message: "Could not measure session.",
                                            variant: "warning",
                                        })
                                        return
                                    }

                                    const status =
                                        real.usagePercent >= 90
                                            ? "🔴 CRITICAL"
                                            : real.usagePercent >= 70
                                              ? "🟡 WARNING"
                                              : "🟢 HEALTHY"

                                    const text = [
                                        `**Context Status:** ${status}`,
                                        `**Usage:** ${real.tokens.toLocaleString()} / ${real.contextLimit.toLocaleString()} tokens (${real.usagePercent}%)`,
                                        `**Model:** ${real.model}`,
                                        real.cost > 0 ? `**Cost:** $${real.cost.toFixed(4)}` : "",
                                    ]
                                        .filter(Boolean)
                                        .join("\n")

                                    await context.client.session.synthetic({
                                        sessionID,
                                        text,
                                        description: "slim-status",
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Status",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },

                        // ─── /slim-debug ──────────────────────────────
                        {
                            id: "opencodev2-slim.debug",
                            title: "Toggle Slim Debug Mode",
                            group: "Slim",
                            palette: true,
                            slash: { name: "slim-debug", aliases: ["debug-slim"] },
                            enabled: true,
                            suggested: false,
                            run: async (input: unknown, event: unknown) => {
                                const sessionID =
                                    resolveCurrentSession(context) ||
                                    (event && typeof event === "object" && "sessionID" in event
                                        ? (event as any).sessionID
                                        : null)

                                if (!sessionID) {
                                    context.ui.toast.show({
                                        title: "Slim Debug",
                                        message: "No active session found.",
                                        variant: "warning",
                                    })
                                    return
                                }

                                try {
                                    // Read current config
                                    const configPath = `${process.env.HOME || "~"}/.config/opencode/slim.jsonc`
                                    const fs = await import("fs")
                                    let debug = false
                                    if (fs.existsSync(configPath)) {
                                        const content = fs.readFileSync(configPath, "utf-8")
                                        const match = content.match(/"debug"\s*:\s*(true|false)/)
                                        if (match) debug = match[1] === "true"
                                    }

                                    // Toggle
                                    debug = !debug

                                    // Write back
                                    const { parse } = await import("jsonc-parser")
                                    let config: any = {}
                                    if (fs.existsSync(configPath)) {
                                        config = parse(fs.readFileSync(configPath, "utf-8")) || {}
                                    }
                                    config.debug = debug

                                    const dir = `${process.env.HOME || "~"}/.config/opencode`
                                    if (!fs.existsSync(dir)) {
                                        fs.mkdirSync(dir, { recursive: true })
                                    }
                                    fs.writeFileSync(
                                        configPath,
                                        JSON.stringify(config, null, 2),
                                        "utf-8",
                                    )

                                    const text = `**Slim Debug Mode:** ${debug ? "ON 🔴" : "OFF ⚪"}\n\nDebug logs will ${debug ? "now" : "no longer"} appear in the console.`

                                    await context.client.session.synthetic({
                                        sessionID,
                                        text,
                                        description: "slim-debug",
                                    })
                                } catch (e) {
                                    context.ui.toast.show({
                                        title: "Slim Debug",
                                        message: `Error: ${e instanceof Error ? e.message : e}`,
                                        variant: "error",
                                    })
                                }
                            },
                        },
                    ],
                }))
                return null
            },
        })

        context.ui.toast.show({
            title: "Slim Plugin v2.1.0",
            message: "Commands: /panel, /compress, /status, /slim-debug",
            variant: "success",
            duration: 4000,
        })

        return () => {}
    },
})