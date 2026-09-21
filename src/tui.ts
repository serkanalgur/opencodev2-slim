import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
    id: "opencodev2-slim.cli",
    setup(context) {
        // Register /panel slash command
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
                        try {
                            // Get active sessions
                            const sessions = context.data.session.list()
                            
                            if (!sessions || sessions.length === 0) {
                                context.ui.toast.show({
                                    title: "Slim Panel",
                                    message: "No active session found",
                                    variant: "warning",
                                })
                                return
                            }

                            // Use the first session
                            const session = sessions[0]
                            
                            // Show basic session info
                            context.ui.toast.show({
                                title: "Slim Context Panel",
                                message: `Session: ${session.title || session.id}`,
                                variant: "info",
                                duration: 3000,
                            })

                            // TODO: Fetch detailed panel data from server
                            // This would require server-side API to get token usage, compression stats, etc.
                            
                        } catch (error) {
                            context.ui.toast.show({
                                title: "Slim Panel",
                                message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                                variant: "error",
                            })
                        }
                    },
                },
            ],
        }))

        context.ui.toast.show({
            title: "Slim Plugin",
            message: "CLI loaded. Use /panel to show context panel.",
            variant: "success",
            duration: 3000,
        })

        return () => {
            // Cleanup
        }
    },
})
