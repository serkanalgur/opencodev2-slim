/**
 * Single source of truth for the plugin's released version.
 *
 * Lives in its own module rather than in config.ts / types.ts / usage.ts so
 * that both `src/tui.tsx` (which renders the welcome toast) and the test suite
 * can import it without dragging in config's filesystem side effects or types'
 * SDK type import — and without an import cycle.
 *
 * The value is duplicated from package.json on purpose: the plugin ships as raw
 * TypeScript (`"exports": "./src/index.ts"`), so there is no build step that
 * could inline it. `tests/version.test.ts` asserts the two stay equal, so a
 * release bump that forgets this constant fails the suite instead of shipping a
 * stale version string to users.
 */
export const PLUGIN_VERSION = "3.1.0"
