import { describe, it } from "node:test"
import assert from "node:assert"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_VERSION } from "../src/lib/version"
import tuiPlugin from "../src/tui"

// ─── Released version (src/lib/version.ts) ──────────────────────────────────
//
// The welcome toast used to hardcode a hand-maintained literal ("Slim Plugin
// v2.1.0" while the package was at 3.0.0). The failure mode these tests
// prevent is drift: a release bump touches package.json, the literal in
// src/tui.tsx is left behind, and every user is told they are running a version
// that does not exist. `PLUGIN_VERSION` is now the single place the version is
// written down, and the test below is what makes forgetting to update it a test
// failure rather than a shipped bug.

// Resolved from this file's own URL, not process.cwd(): the suite is runnable
// from the repo root, from tests/, or from anywhere else.
const PACKAGE_JSON = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string }

describe("plugin version", () => {
    it("should match the version in package.json", () => {
        assert.strictEqual(
            PLUGIN_VERSION,
            PACKAGE_JSON.version,
            "PLUGIN_VERSION is the single source of truth and must track package.json; a release bump that forgets it ships a stale version to users",
        )
    })

    it("should be a non-empty semver string", () => {
        assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
    })
})

// ─── Welcome toast title (src/tui.tsx) ───────────────────────────────────────

describe("welcome toast", () => {
    it("should title the toast from PLUGIN_VERSION, not a hardcoded literal", async () => {
        const toasts: { title: string }[] = []
        const context: any = {
            ui: {
                slot: () => () => {},
                toast: { show: (toast: any) => void toasts.push(toast) },
                dialog: { alert: async () => undefined },
            },
            keymap: { layer: () => {} },
        }

        await tuiPlugin.setup(context)

        const welcome = toasts.find((toast) => toast.title.startsWith("Slim Plugin"))
        assert.ok(welcome, "the plugin shows a welcome toast on setup")
        assert.strictEqual(
            welcome.title,
            `Slim Plugin v${PLUGIN_VERSION}`,
            "the welcome toast must interpolate PLUGIN_VERSION, never a literal",
        )
    })
})
