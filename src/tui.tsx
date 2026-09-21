/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"

const PANEL_NAME = "opencodev2-slim.panel"

function SlimPanel(props: { panel: PanelInput }) {
    return (
        <box
            width="100%"
            height="100%"
            paddingX={1}
            paddingY={1}
            flexDirection="column"
        >
            <text>SLIM CONTEXT PANEL</text>
            <text>Session: {props.panel.sessionID}</text>
            <text>Compression and context stats live on the server.</text>
            <text>Run the server `panel` tool for a full live breakdown.</text>
        </box>
    )
}

export default Plugin.define({
    id: "opencodev2-slim.cli",
    setup(context) {
        context.ui.slot({
            append: "session.panel",
            render: (panel) => (
                <Show when={panel.name === PANEL_NAME}>
                    <SlimPanel panel={panel} />
                </Show>
            ),
        })

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
                    run: async () => {
                        const opened = context.ui.panel.open(PANEL_NAME, {
                            presentation: "panel",
                        })
                        if (!opened) {
                            context.ui.toast.show({
                                title: "Slim Panel",
                                message: "No active session found. Open a session first.",
                                variant: "warning",
                            })
                        }
                    },
                },
            ],
        }))

        context.ui.toast.show({
            title: "Slim Plugin",
            message: "CLI loaded. Use /panel to show the context panel.",
            variant: "success",
            duration: 3000,
        })

        return () => {
            // Cleanup
        }
    },
})