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
function renderPanelText(sessionID: string, stats: PanelStats): string {
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
    lines.push("└─────────────────────────────────────────────────────────────┘")
    return lines.join("\n")
}

// Resolves the "current" session: the focused session if any, else the most recent.
function resolveCurrentSession(context: any): string | null {
    const sessions = context.data.session.list() || []
    if (sessions.length === 0) return null
    // Prefer the focused session if exposed; otherwise fall back to the first.
    const focused = context.router?.current?.()
    if (focused && typeof focused === "object" && "sessionID" in focused) {
        return focused.sessionID as string
    }
    return sessions[0].id
}

export default Plugin.define({
    id: "opencodev2-slim.cli",
    setup(context) {
        // Register the command inside the "app" slot render, where the keymap
        // provider is available (consistent with OpenCode V2 CLI plugins).
        context.ui.slot({
            append: "app",
            render: () => {
                context.keymap.layer(() => ({
                    mode: "global",
                    priority: 10,
                    commands: [
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
                                    const messages =
                                        context.data.session.message.list(sessionID) || []
                                    const stats = deriveStats(messages)
                                    const text = renderPanelText(sessionID, stats)
                                    // Inject the panel as plain text into the session stream,
                                    // so it doesn't take over OpenCode's own panel UI.
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
                    ],
                }))
                return null
            },
        })

        context.ui.toast.show({
            title: "Slim Plugin",
            message: "Use /panel to print the context panel as a message.",
            variant: "success",
            duration: 3000,
        })

        return () => {}
    },
})