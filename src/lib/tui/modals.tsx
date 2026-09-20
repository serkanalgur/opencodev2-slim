/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SlimConfig } from "../types"
import { PanelDialog } from "./dialogs"

export function openPanelModal(api: TuiPluginApi, config: SlimConfig): void {
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(() => (
        <PanelDialog api={api} config={config} />
    ))
}
