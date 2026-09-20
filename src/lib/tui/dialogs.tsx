/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, For, Show } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SlimConfig } from "../types"
import type { Message, Part, AssistantMessage } from "@opencode-ai/sdk/v2"

// ─── Types ──────────────────────────────────────────────────────────────────

interface PanelData {
    currentTokens: number
    maxTokens: number
    usagePercent: number
    status: "healthy" | "warning" | "critical"
    userMessages: number
    assistantMessages: number
    toolCalls: number
    toolResults: number
    compressionCount: number
    averageRatio: number
    totalTokensSaved: number
    estimatedCost: number
    costSaved: number
    model: string
    recommendations: string[]
}

// ─── UI Components ──────────────────────────────────────────────────────────

function SlimFrame(props: {
    api: TuiPluginApi
    title: string
    eyebrow: string
    children: any
    onBack?: () => void
}) {
    const theme = props.api.theme.current

    return (
        <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
                <box flexDirection="column">
                    <text fg={theme.primary}>
                        <b>{props.eyebrow}</b>
                    </text>
                    <text fg={theme.text}>
                        <b>{props.title}</b>
                    </text>
                </box>
                <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
                    esc
                </text>
            </box>
            <box height={1} border={["bottom"]} borderColor={theme.borderSubtle} />
            {props.children}
            <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
                <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={theme.primary}
                    onMouseUp={() => props.api.ui.dialog.clear()}
                >
                    <text fg={theme.selectedListItemText}>close</text>
                </box>
            </box>
        </box>
    )
}

function Card(props: { theme: any; title: string; children: any }) {
    const accent = props.theme.primary
    return (
        <box
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={props.theme.backgroundElement}
            border={["left"]}
            borderColor={accent}
            gap={1}
        >
            <text fg={accent}>
                <b>{props.title}</b>
            </text>
            {props.children}
        </box>
    )
}

function Metric(props: { theme: any; label: string; value: string; hint?: string }) {
    return (
        <box flexDirection="row" gap={2}>
            <box width={24}>
                <text fg={props.theme.textMuted}>{props.label}</text>
            </box>
            <box flexDirection="row" gap={1} flexGrow={1}>
                <text fg={props.theme.text}>
                    <b>{props.value}</b>
                </text>
                {props.hint ? <text fg={props.theme.textMuted}>{props.hint}</text> : null}
            </box>
        </box>
    )
}

function Progress(props: {
    theme: any
    label: string
    value: number
    total: number
    color: "primary" | "accent" | "success" | "warning" | "error"
    detail: string
}) {
    const width = 32
    const filled =
        props.total > 0 ? Math.max(0, Math.round((props.value / props.total) * width)) : 0
    const empty = Math.max(0, width - filled)
    return (
        <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={2}>
                <box width={20}>
                    <text fg={props.theme.text}>{props.label}</text>
                </box>
                <box flexDirection="row" gap={1} flexGrow={1}>
                    <text fg={props.theme.text}>
                        <b>{props.total > 0 ? `${Math.round((props.value / props.total) * 100)}%` : "0%"}</b>
                    </text>
                    <text fg={props.theme.textMuted}>{props.detail}</text>
                </box>
            </box>
            <box flexDirection="row">
                <text fg={props.theme[props.color]}>{"█".repeat(filled)}</text>
                <text fg={props.theme.borderSubtle}>{"░".repeat(empty)}</text>
            </box>
        </box>
    )
}

// ─── Panel Dialog ───────────────────────────────────────────────────────────

export function PanelDialog(props: { api: TuiPluginApi; config: SlimConfig }) {
    const theme = props.api.theme.current
    const [data, setData] = createSignal<PanelData | null>(null)
    const [loading, setLoading] = createSignal(true)
    const [activeTab, setActiveTab] = createSignal<"context" | "stats" | "help">("context")

    onMount(async () => {
        try {
            const panelData = await fetchPanelData(props.api, props.config)
            setData(panelData)
        } catch (error) {
            console.error("Failed to load panel data:", error)
        } finally {
            setLoading(false)
        }
    })

    const formatTokens = (tokens: number): string => {
        if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
        if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
        return String(tokens)
    }

    return (
        <SlimFrame api={props.api} title="Context Panel" eyebrow="SLIM">
            {/* Tab Navigation */}
            <box flexDirection="row" gap={1} marginBottom={1}>
                <TabButton
                    theme={theme}
                    label="Context"
                    active={activeTab() === "context"}
                    onClick={() => setActiveTab("context")}
                />
                <TabButton
                    theme={theme}
                    label="Stats"
                    active={activeTab() === "stats"}
                    onClick={() => setActiveTab("stats")}
                />
                <TabButton
                    theme={theme}
                    label="Help"
                    active={activeTab() === "help"}
                    onClick={() => setActiveTab("help")}
                />
            </box>

            {/* Content */}
            <Show
                when={!loading()}
                fallback={
                    <box padding={2}>
                        <text fg={theme.textMuted}>Loading...</text>
                    </box>
                }
            >
                <Show
                    when={data()}
                    fallback={
                        <box padding={2}>
                            <text fg={theme.error}>Failed to load panel data</text>
                        </box>
                    }
                >
                    {activeTab() === "context" && (
                        <ContextTab data={data()!} theme={theme} formatTokens={formatTokens} />
                    )}
                    {activeTab() === "stats" && (
                        <StatsTab data={data()!} theme={theme} formatTokens={formatTokens} />
                    )}
                    {activeTab() === "help" && <HelpTab theme={theme} />}
                </Show>
            </Show>
        </SlimFrame>
    )
}

// ─── Tab Button ─────────────────────────────────────────────────────────────

function TabButton(props: {
    theme: any
    label: string
    active: boolean
    onClick: () => void
}) {
    return (
        <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.active ? props.theme.primary : props.theme.backgroundElement}
            onMouseUp={props.onClick}
        >
            <text fg={props.active ? props.theme.background : props.theme.text}>
                {props.label}
            </text>
        </box>
    )
}

// ─── Context Tab ────────────────────────────────────────────────────────────

function ContextTab(props: { data: PanelData; theme: any; formatTokens: (n: number) => string }) {
    const statusIcon = () =>
        props.data.status === "healthy" ? "🟢" : props.data.status === "warning" ? "🟡" : "🔴"

    const statusColor = () =>
        props.data.status === "healthy"
            ? props.theme.success
            : props.data.status === "warning"
              ? props.theme.warning
              : props.theme.error

    return (
        <box flexDirection="column" gap={1}>
            <Card theme={props.theme} title="Status">
                <Metric
                    theme={props.theme}
                    label="Status"
                    value={`${statusIcon()} ${props.data.status.toUpperCase()}`}
                />
                <Progress
                    theme={props.theme}
                    label="Context"
                    value={props.data.currentTokens}
                    total={props.data.maxTokens}
                    color={props.data.status === "critical" ? "error" : props.data.status === "warning" ? "warning" : "primary"}
                    detail={`${props.formatTokens(props.data.currentTokens)} / ${props.formatTokens(props.data.maxTokens)} tokens`}
                />
            </Card>

            <Card theme={props.theme} title="Messages">
                <Metric theme={props.theme} label="User" value={`${props.data.userMessages}`} />
                <Metric theme={props.theme} label="Assistant" value={`${props.data.assistantMessages}`} />
                <Metric theme={props.theme} label="Tool calls" value={`${props.data.toolCalls}`} />
                <Metric theme={props.theme} label="Results" value={`${props.data.toolResults}`} />
            </Card>

            <Card theme={props.theme} title="Recommendations">
                <box flexDirection="column">
                    <For each={props.data.recommendations}>
                        {(rec) => <text>• {rec}</text>}
                    </For>
                </box>
            </Card>
        </box>
    )
}

// ─── Stats Tab ──────────────────────────────────────────────────────────────

function StatsTab(props: { data: PanelData; theme: any; formatTokens: (n: number) => string }) {
    return (
        <box flexDirection="column" gap={1}>
            <Card theme={props.theme} title="Compression">
                <Metric theme={props.theme} label="Count" value={`${props.data.compressionCount}`} />
                <Metric
                    theme={props.theme}
                    label="Avg ratio"
                    value={`${(props.data.averageRatio * 100).toFixed(1)}%`}
                />
                <Metric
                    theme={props.theme}
                    label="Tokens saved"
                    value={props.formatTokens(props.data.totalTokensSaved)}
                />
            </Card>

            <Card theme={props.theme} title="Cost">
                <Metric
                    theme={props.theme}
                    label="Current"
                    value={`$${props.data.estimatedCost.toFixed(4)}`}
                />
                <Metric
                    theme={props.theme}
                    label="Saved"
                    value={`$${props.data.costSaved.toFixed(4)}`}
                />
                <Metric theme={props.theme} label="Model" value={props.data.model} />
            </Card>
        </box>
    )
}

// ─── Help Tab ───────────────────────────────────────────────────────────────

function HelpTab(props: { theme: any }) {
    return (
        <box flexDirection="column" gap={1}>
            <Card theme={props.theme} title="Commands">
                <text>/panel - Open this panel</text>
                <text>/compress [focus] - Run compression</text>
            </Card>

            <Card theme={props.theme} title="Tool Usage">
                <text>compress({"{ focus: \"old exploration\" }"})</text>
                <text>compress({"{ focus: \"tasks\", mode: \"range\", start: 0, end: 50 }"})</text>
                <text>compress({"{ focus: \"database\", mode: \"topic\", topic: \"db\" }"})</text>
            </Card>

            <Card theme={props.theme} title="Configuration">
                <text>~/.config/opencode/slim.jsonc</text>
            </Card>
        </box>
    )
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchPanelData(
    api: TuiPluginApi,
    config: SlimConfig,
): Promise<PanelData> {
    const currentRoute = api.route.current

    let sessionId: string | undefined
    if (currentRoute.name === "session") {
        sessionId = currentRoute.params?.sessionID as string | undefined
    }

    if (!sessionId) {
        return {
            currentTokens: 0,
            maxTokens: resolveTokenLimit(config.compress.maxContextLimit, 200000),
            usagePercent: 0,
            status: "healthy",
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            compressionCount: 0,
            averageRatio: 0,
            totalTokensSaved: 0,
            estimatedCost: 0,
            costSaved: 0,
            model: "unknown",
            recommendations: ["No active session. Start a conversation to see context usage."],
        }
    }

    const messages = api.state.session.messages(sessionId)

    // Calculate token usage from messages
    let currentTokens = 0
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let toolResults = 0
    let model = "unknown"

    for (const msg of messages) {
        // Get role from message
        const role = msg.role
        if (role === "user") {
            userMessages++
        } else if (role === "assistant") {
            assistantMessages++
            // Get model from assistant message
            const assistantMsg = msg as AssistantMessage
            if (assistantMsg.providerID && assistantMsg.modelID) {
                model = `${assistantMsg.providerID}/${assistantMsg.modelID}`
            }
        }

        // Get parts for this message
        const parts = api.state.part(msg.id)

        for (const part of parts) {
            if (part.type === "text") {
                const textPart = part as any
                currentTokens += Math.ceil((textPart.text?.length || 0) / 4)
            } else if (part.type === "tool") {
                const toolPart = part as any
                const status = toolPart.state?.type
                if (status === "completed") {
                    toolResults++
                } else if (status === "pending" || status === "running") {
                    toolCalls++
                }
            }
        }
    }

    const maxTokens = resolveTokenLimit(config.compress.maxContextLimit, 200000)
    const usagePercent = (currentTokens / maxTokens) * 100

    let statusLevel: "healthy" | "warning" | "critical" = "healthy"
    if (usagePercent > 90) statusLevel = "critical"
    else if (usagePercent > 70) statusLevel = "warning"

    const recommendations: string[] = []
    if (usagePercent > 80) {
        recommendations.push("Context usage is high. Consider compressing older messages.")
    }
    if (usagePercent > 90) {
        recommendations.push("Context nearly full! Run compress immediately.")
    }
    if (recommendations.length === 0) {
        recommendations.push("Context is healthy. No action needed.")
    }

    return {
        currentTokens,
        maxTokens,
        usagePercent,
        status: statusLevel,
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        compressionCount: 0,
        averageRatio: 0,
        totalTokensSaved: 0,
        estimatedCost: (currentTokens / 1000) * 0.003,
        costSaved: 0,
        model,
        recommendations,
    }
}

function resolveTokenLimit(value: number | string, contextLimit: number): number {
    if (typeof value === "number") return value
    const percent = parseFloat(value.replace("%", "")) / 100
    return Math.floor(contextLimit * percent)
}
