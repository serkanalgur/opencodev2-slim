/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { SlimConfig } from "./lib/types"
import { loadConfig } from "./lib/tui/data"
import { openPanelModal } from "./lib/tui/modals"

/**
 * Register slash commands using the v2 keymap API.
 * This plugin is v2-only.
 */
function registerSlashCommands(api: any, config: SlimConfig): void {
    // v2 way: keymap.registerLayer
    if (api.keymap && typeof api.keymap.registerLayer === "function") {
        api.keymap.registerLayer({
            mode: "global",
            priority: 10,
            commands: [
                {
                    name: "slim.panel",
                    title: "Open Slim Panel",
                    group: "Slim",
                    slash: { name: "panel" },
                    enabled: () => true,
                    suggested: true,
                    run: () => {
                        openPanelModal(api, config)
                    },
                },
                {
                    name: "slim.compress",
                    title: "Compress Context",
                    group: "Slim",
                    slash: { name: "compress" },
                    enabled: () => true,
                    suggested: true,
                    run: () => {
                        api.ui.toast({
                            title: "Slim",
                            message:
                                "Use the compress tool: compress({ focus: 'your focus' })",
                            variant: "info",
                        })
                    },
                },
            ],
        })
    }
}

const tui: TuiPluginModule["tui"] = async (api) => {
    const config = loadConfig(api as any)
    if (!config.enabled) return

    registerSlashCommands(api, config)
}

export default {
    id: "opencodev2-slim",
    tui,
} satisfies TuiPluginModule
