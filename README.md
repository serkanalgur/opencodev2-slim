# OpenCode Slim

<div align="center">

<img src="./assets/banner.svg" alt="OpenCode Slim" width="100%" />

[![npm version](https://img.shields.io/npm/v/@serkanalgur/opencodev2-slim?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@serkanalgur/opencodev2-slim)
[![npm downloads](https://img.shields.io/npm/dw/@serkanalgur/opencodev2-slim?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@serkanalgur/opencodev2-slim)
[![stars](https://img.shields.io/github/stars/serkanalgur/opencodev2-slim?style=flat-square&color=f59e0b)](https://github.com/serkanalgur/opencodev2-slim/stargazers)
[![license](https://img.shields.io/npm/l/@serkanalgur/opencodev2-slim?style=flat-square&color=8b5cf6)](https://github.com/serkanalgur/opencodev2-slim/blob/main/LICENSE)
[![Socket Badge](https://badge.socket.dev/npm/package/@serkanalgur/opencodev2-slim/latest)](https://socket.dev/npm/package/@serkanalgur/opencodev2-slim/overview)
[![opencode](https://img.shields.io/badge/OpenCode-V2-6366f1?style=flat-square)](https://opencode.ai)
[![typescript](https://img.shields.io/badge/TypeScript-5.7%2B-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=github)](https://github.com/sponsors/serkanalgur)

**Smart context management plugin for OpenCode v2 — semantic compression, cost-aware pruning, adaptive thresholds**

[Installation](#installation) • [Usage](#usage) • [Features](#features) • [Configuration](#configuration) • [How It Works](#how-it-works) • [Commands](#commands) • [Changelog](#changelog)

</div>

---

## Features

- **TUI Panel** - Rich context usage visualization with status indicators
- **Enhanced Compress** - Auto/range/topic modes for flexible compression
- **Semantic Compression** - Groups related tool calls and compresses them intelligently
- **Cost-Aware Pruning** - Considers token pricing when deciding what to compress
- **Adaptive Thresholds** - Learns from compression history to optimize timing
- **Session Persistence** - Saves state across restarts
- **Deduplication** - Removes repeated tool calls automatically
- **Error Purging** - Cleans up failed tool call outputs after configurable turns
- **Tool-Output Pruning** - Replaces old, large tool-result payloads on the outgoing request (opt-in, off by default)
- **Measured vs Estimated Tokens** - Merges the server's real usage with a full-prompt estimate, and labels which one the panel is showing
- **Topic Extraction** - Identifies and tracks conversation topics
- **Smart Recommendations** - Provides actionable suggestions for context optimization

## Installation

```bash
opencode plugin @serkanalgur/opencodev2-slim@latest --global
```

This installs the plugin globally. The TUI features (panel, slash commands) are automatically loaded when OpenCode starts.

### Manual Installation

If the CLI command doesn't work, add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["@serkanalgur/opencodev2-slim"]
}
```

## Usage

### Slash Commands

After installation, these slash commands are available in the TUI:

- `/panel` — Context window panel in a dialog: message/token breakdown for the
  active context, the resolved compression trigger, and live measurements
- `/compress` — Sends the assistant a compression instruction (see below)
- `/status` — One-line context health report (tokens / limit / %, model, cost)
- `/slim-debug` — Toggles `debug` in `~/.config/opencode/slim.jsonc`

`/panel`, `/status` and `/slim-debug` are display-only: they render through
`context.ui.dialog.alert` and never append anything to the session transcript.
`/compress` is the exception — it is a deliberate instruction to the model.

### TUI Panel

`/panel` prints:

- Session id and the scope of the numbers — they come from
  `session.context`, i.e. **messages since the last compaction**, not session
  totals. The panel states this on a `Scope:` line.
- Message breakdown by role (user/assistant/system), tool calls, and
  compactions within that scope
- Estimated tokens per role plus a total estimate
- The resolved compression trigger as a token count and as a percentage of the
  context window (`Trigger: … tokens (…% of … window) · floor …`) — the same
  line the `panel` tool prints
- Live measurements: tokens, usage %, status, cost, model

### `panel` tool

The `panel` tool prints a richer, boxed report. Two lines make the numbers
self-explanatory:

- `Source: measured (server-reported)` / `Source: estimated (approximate)` —
  where the headline `Context` token figure came from (see
  [Measurement trust](#measurement-trust-usage)). An estimate is a magnitude,
  not an exact count.
- `Prune: N outputs · ~X chars (~Y tokens) saved on last request` — tool-output
  pruning activity from the most recent request. It is a *per-request* figure
  (the plan is re-applied every request), not a cumulative saving, and the line
  appears only when pruning is enabled or the last request actually pruned
  something.

### Compress Tool

The enhanced compress tool supports multiple modes:

```typescript
// Auto mode (default) - intelligently selects what to compress
compress({ focus: "old exploration" })

// Range mode - compress specific message range
compress({ focus: "completed tasks", mode: "range", start: 0, end: 50 })

// Topic mode - compress messages matching a topic
compress({ focus: "database work", mode: "topic", topic: "database" })
```

#### `/compress` delivery

`/compress` does not compress anything itself — it writes a short instruction
(the focus/mode/keep-recent you passed) into the transcript so the assistant
calls the `compress` tool. Because the point is to make the model act *now*,
the synthetic message is sent with an explicit `delivery: "steer"`:

- **`steer` (chosen)** — delivered immediately: it interrupts an in-flight turn,
  and `session.synthetic` wakes an idle session (`resume` stays at its default
  `true`). This matches both the server default (`delivery ?? "steer"`) and the
  TUI's own default prompt delivery, so `/compress` behaves like typing a
  message.
- **`queue` (rejected)** — a queued item is only taken when the runner is not
  already consuming a turn, so the instruction would wait for the next user
  turn instead of compressing now.

`/panel`, `/status` and `/slim-debug` write nothing to the session.

## Configuration

Create `~/.config/opencode/slim.jsonc`:

```jsonc
{
    "enabled": true,
    "compress": {
        "enabled": true,
        "permission": "allow",
        // Absolute token count (e.g. 200000) or percent of the model context
        // window ("80%"). Broken values fall back to the default, never 0.
        "maxContextLimit": "80%",
        "minContextLimit": "40%",
        "nudgeFrequency": 5,
        "protectUserMessages": false,
        "protectedTools": ["task", "skill", "todowrite", "todoread"]
    },
    "strategies": {
        "deduplication": {
            "enabled": true,
            "protectedTools": []
        },
        "purgeErrors": {
            "enabled": true,
            "turns": 4,
            "protectedTools": []
        },
        // OFF by default. When enabled, replaces the payload of old, large,
        // non-protected tool results on the outgoing request only.
        "pruneOutputs": {
            "enabled": false,
            "minChars": 2000,
            "maxPerRequest": 50,
            "protectedTools": []
        },
        // Never prune a tool result produced within the last `turns` turns.
        "turnProtection": {
            "enabled": true,
            "turns": 4
        }
    },
    // Measured-vs-estimated token accounting (see "Measurement trust" below).
    "usage": {
        "trustRatio": 0.5,
        "capRatio": 3
    },
    "adaptive": {
        "enabled": true,
        "learningRate": 0.1,
        "minCompressionRatio": 0.3
    },
    "costAware": {
        "enabled": true,
        "cacheBoostFactor": 0.5
    },
    "persistence": {
        "enabled": true,
        "directory": "~/.config/opencode/slim"
    }
}
```

### Context thresholds

`compress.maxContextLimit` and `compress.minContextLimit` (and their per-model
overrides `compress.modelMaxLimits` / `compress.modelMinLimits`, keyed
`"providerId/modelId"`) accept two forms:

| Form | Example | Meaning |
| --- | --- | --- |
| Number | `200000` | Absolute token count — triggers once the session reaches 200k tokens. |
| Percent string | `"80%"` | Percentage of the model's context window (80% of 200k = 160k tokens). |

Percent strings accept a decimal comma for locale-typed configs: if the plain
parse fails, every comma is retried as the decimal separator, so `"80,5%"`
means 80.5% of the window (write absolute counts as JSON numbers — thousands
separators are not supported). A value that still cannot be parsed falls back
to the built-in default with a console warning, deduplicated per
(config key, issue, offending value) — repairing a value and breaking the key
again with a *different* bad value warns again.

Values that cannot be used (unparsable, negative, or a percent while the model
window is unknown) fall back to the built-in default (`100000` / `50000`) with a
one-time console warning — never to `0`, which would disable triggering. An
absolute threshold above the context window is clamped to that window so it can
still fire. Both panel surfaces — the `panel` tool and the TUI `/panel` dialog —
show the resolved trigger as a token count and as its percentage of the window
(`Trigger: … tokens (…% of … window) · floor …`), with the percentage omitted
when the window is unknown.

**What the threshold is actually compared against.** `maxContextLimit` /
`minContextLimit` are compared against the size of the **outgoing prompt we are
about to send** — the real measured usage of the last completed request when the
provider reported one, otherwise a full-prompt estimate (system prompt, tool
schemas, message text, tool-call inputs and tool results). They are **never**
compared against the session's lifetime cumulative token counter, which grows
without bound because `cache.read` re-reads the whole context every turn. The
`panel` reflects this split explicitly:

- `Context: … tokens` (the bar) is the **current prompt size** — the figure the
  threshold applies to.
- `Lifetime: … tokens · cumulative spend, NOT context size` is the separate
  lifetime total (`Session.Info.tokens`), shown only when it differs from the
  prompt size. It is a cost statistic, not occupancy.

The `Context` figure also carries a `Source:` line naming where it came from —
see [Measurement trust](#measurement-trust-usage) below.

### Tool-output pruning and turn protection

`strategies.pruneOutputs` replaces the *payload* of old, large, non-protected
tool results (e.g. a huge `read`, `grep` or `bash` output) with a short
placeholder **on the outgoing request only** — session history is never touched.
It is **OFF by default** (`enabled: false`): pruning rewrites an earlier part of
the prompt and therefore invalidates the provider's prefix cache, so it costs a
one-time full-price request per newly pruned turn.

| Key | Default | Meaning |
| --- | --- | --- |
| `pruneOutputs.enabled` | `false` | Master switch. Opt-in; an absent block leaves the prompt untouched. |
| `pruneOutputs.minChars` | `2000` | Minimum serialized size (characters) for an output to be eligible. |
| `pruneOutputs.maxPerRequest` | `50` | At most this many outputs pruned per request. Never splits a turn. |
| `pruneOutputs.protectedTools` | `[]` | Extra tool names kept, on top of the always-protected set (`task`, `skill`, `todowrite`, `todoread`, `write`, `edit`, …). `purgeErrors.protectedTools` is honoured here too. |
| `turnProtection.enabled` | `true` | Keep the most recent turns intact. |
| `turnProtection.turns` | `4` | Number of recent turns never pruned — the working set the model is actively using. |

Because the prune plan is rebuilt and re-applied on **every** request, any
saving it produces is a *per-request* figure, not a cumulative or permanent one.
The `panel` tool states this on its `Prune:` line (`… saved on last request`) and
shows it only when pruning is enabled or the last request actually pruned
something; with the default (off) the line is absent.

### Measurement trust (`usage`)

The trigger merges two independent numbers:

- **measured** — what the provider actually reported for the last completed
  request (`session.step.ended`: `input + output + reasoning + cache.read +
  cache.write`). Exact for that request, but it describes the *previous* prompt,
  so it goes stale the moment pruning/compression shrinks the next one.
- **estimated** — a character-count approximation of everything on the wire for
  *this* request (system prompt, tool schemas, text, reasoning, tool-call inputs,
  tool results, compaction summaries), divided once by ~4 chars/token. No
  tokenizer is invoked, so it is a magnitude, not an exact count.

Neither is safe alone, so the two are clamped in both directions:

| Key | Default | Meaning |
| --- | --- | --- |
| `usage.trustRatio` | `0.5` | A measurement below this fraction of the estimate is treated as stale and the **estimate** wins. |
| `usage.capRatio` | `3` | A measurement above this multiple of the estimate is treated as a broken reading and **capped** at `capRatio × estimated`. |

Both fields are optional and fall back to the defaults, so an absent block is
safe. The `panel`'s `Source:` line reports where the panel's **own headline
figure** came from — `measured (server-reported)` when the server reported usage
for that request, otherwise `estimated (approximate)` — so an approximation is
never mistaken for an exact count. It does **not** replay the merge above: the
trigger applies its own `trustRatio`/`capRatio` rules to the measured *total*
(`input + output + reasoning + cache.read + cache.write`) against the
outgoing-prompt estimate, a different quantity from the panel's `Context` figure.
The panel's `Context:` line is the last request's prompt size
(`input + cache.read + cache.write`) and its `Lifetime:` line is the session's
cumulative spend; the two are never mixed, and `Source:` labels only the
`Context` figure.

Global limits are only resolved when they are actually needed: a model with a
valid `compress.modelMaxLimits` / `compress.modelMinLimits` override never
reads — and never warns about — the global `maxContextLimit` /
`minContextLimit`. The fallback chain itself is unchanged and covered by the
test suite: a broken per-model override degrades to the *configured* global
(not straight to the built-in default), a broken global degrades to the
built-in default, and warnings fire once per (key, issue, value) across
repeated calls.

## How It Works

### Semantic Compression

Unlike simple text truncation, slim analyzes the semantic content of messages and groups related tool calls together. This preserves context while removing redundancy.

### Cost-Aware Pruning

Slim considers the cost of tokens when deciding what to compress. It prioritizes compressing expensive operations (like large file reads) while preserving cheap but important context.

### Adaptive Thresholds

The plugin learns from your compression patterns and adjusts thresholds over time. If you tend to need more context, it will compress less aggressively. If you're efficient, it will compress more.

### Session Persistence

State is saved to disk, so compression history and learning persist across restarts.

## Commands

| Command | Description |
|---------|-------------|
| `/panel` | Open the Slim TUI panel in a dialog with context usage, stats, and trigger thresholds |
| `/compress` | Send the assistant a compression instruction (`delivery: "steer"`) |
| `/status` | Show a one-line context health report in a dialog (never written to the session) |
| `/slim-debug` | Toggle `debug` in `~/.config/opencode/slim.jsonc` and show the result in a dialog |

Note: Compression is performed by the AI assistant using the `compress` tool. The slash command provides guidance on usage; it is the only slash command that writes to the session, and it does so with an explicit `delivery: "steer"` (see [Compress Tool](#compress-tool)).

## Changelog

### 3.0.1

**FIXES**

- The context window is no longer resolved by borrowing an arbitrary model's
  limit. When the active model is not found in the model list, the resolver no
  longer falls back to "the first listed model with any limit"; it now uses the
  active model's `default()` limit and, failing that, the documented
  `DEFAULT_MODEL_LIMIT` with a warning. A usage percentage computed against
  another model's context window is meaningless. The TUI's resolver was
  tightened the same way, from a modelID-only match to an exact
  providerID+modelID match.
- The panel and TUI no longer fall back to the lifetime-cumulative token counter
  when showing how full the context window is. When the transcript carries no
  per-call prompt measurement, the displayed occupancy now falls back to our own
  per-message transcript estimate rather than the session's cumulative total —
  which grows every turn, because `cache.read` re-reads the whole context, and
  which therefore produced bogus "100% critical" readings. The cumulative figure
  is still reported where it is legitimate (as lifetime spend/cost) and is still
  explicitly labelled as not being a context size. The `status`/`CRITICAL`
  derivation is now clamped to 0..100.
- The welcome toast no longer reports a stale version. The `Slim Plugin vX.Y.Z`
  title was a hardcoded literal that had drifted to `v2.1.0`; it is now derived
  from a single `PLUGIN_VERSION` constant, guarded by a test that keeps it in
  sync with `package.json`.

**DOCS**

- Refreshed the README: banner, badge row, and a `## Credits` section.

### 3.0.0

**BREAKING CHANGES**

- The compression trigger threshold is now compared against the outgoing
  prompt's measurement/estimate. The old `Session.Info.tokens` lifetime
  cumulative cost counter is no longer used to decide the trigger, so existing
  config files with tuned `maxContextLimit`/`minContextLimit` can behave
  differently and may need re-tuning. In the panel, `Context:` is the last
  request's prompt size (`input + cache.read + cache.write`) and `Lifetime:` is
  the session's cumulative spend; the two are shown separately. When the
  transcript carries no per-turn usage the old figure is still shown, explicitly
  labelled as lifetime cumulative.
- `/panel`, `/status` and `/slim-debug` no longer write to the session (no
  transcript message); their output is shown in a modal dialog
  (`context.ui.dialog.alert`). Previous versions wrote the output into the
  message stream. Only `/compress` still writes (it is an instruction to the
  model) and now passes an explicit `delivery: "steer"` instead of relying on
  the server default.

**FIXES**

- Session corruption: removed v1 API remnants (`client.session.synthetic`,
  `data.session.message.*`) and migrated to the OpenCode v2 API.
- Compression blocks did not work in production: in the v2 context hook,
  messages have no `id` field, so the old code always found an empty id and
  deleted every block. Now uses deterministic content-based key generation plus
  an ambiguity lock.
- The token metric only counted text parts (tool input/output, system prompt,
  tool schemas and reasoning were not counted), so auto-compress effectively
  never triggered. Now uses the real API measurement (`session.step.ended`) plus
  a full-prompt-scoped estimate.
- In v2 a tool result is an array of content blocks, not a string; `String()`
  produced `[object Object]`.
- The panel threw `RangeError` when above 100% (negative repeat on a full bar).
- An invalid threshold value silently fell back to 0, so the trigger never
  fired. It now falls back to the default and emits a warning.
- Context-window resolution: the model list was called without `await`, so it
  always fell back to 200000.
- Decimal comma support (`80,5%`).

**NEW**

- `maxContextLimit`/`minContextLimit` accept absolute token counts (a bare
  number); percentage forms (`80%`, `80,5%`) keep working.
- `strategies.pruneOutputs` prunes tool output (default OFF, opt-in) with turn
  protection. Auto-compress keys are captured **before** pruning replaces pruned
  messages with clones, so pruning no longer desynchronises the persisted
  compression block's anchors from the messages it covered (which left the block
  inert and re-triggered every throttle window).
- `usage.trustRatio` / `usage.capRatio` measurement-trust settings.
- State reset after compaction (`compressionBlocks`, nudge anchors, token
  measurement).
- The panel shows a `Source: measured/estimated` line and prune statistics. The
  `Source:` line describes where the headline figure came from —
  `measured (server-reported)` when the server reported usage, otherwise
  `estimated (approximate)` — so an approximation is never read as an exact
  count. The `Prune:` line reports outputs pruned and characters/tokens saved on
  the last request (a per-request figure, since pruning is re-applied every
  request; the line is absent while the default-off feature has not pruned
  anything).
- `/panel` states its scope: the stats come from `session.context` ("all
  messages after the last compaction"), so `Messages:`/`Tokens (est)` are window
  counts, not session totals, and it now shows the resolved compression trigger
  (`Trigger: … tokens (…% of … window) · floor …`), matching the `panel` tool.
- `deriveStats` counts unknown message types (`agent-switched`, `model-switched`,
  `location-switched`, `idle`, …) as `system` instead of `assistant`, keeping
  `user + assistant + system === total messages`.
- Documented `strategies.pruneOutputs` (off by default) and
  `strategies.turnProtection` in the config reference, plus the `usage`
  measurement-trust ratios (`trustRatio` / `capRatio`), and clarified that
  `maxContextLimit` is compared against the outgoing prompt estimate/measurement
  — not the lifetime cumulative counter.

### 2.0.13

- Fix `/panel` in the TUI not reflecting real context usage:
  - The TUI command now reads live server measurements (`Session.Info.tokens` + `cost` + `model` + context window) via `context.client.session.get()` and prints them (measured tokens, %, cost, model) at the bottom of the panel, matching what the `panel` tool reports.
  - Resolve the active session from `context.ui.router.current()` instead of a non-existent `context.router`, so the panel targets the focused session rather than always the first one.
  - Call `context.data.session.message.sync()` before reading the transcript so stats aren't computed from an empty/stale cache.

### 2.0.12

- Bind panel/nudge to real OpenCode context measurements:
  - Resolve the active model's real context window from `ctx.model.default().data.limit.context` instead of the hard-coded 200k.
  - `/panel` now reads live server measurements (`Session.Info.tokens` + `cost`) via `ctx.session.get()` and feeds them to `buildPanelData`, so the headline tokens/percent/cost match what OpenCode's UI reports.
  - The nudge decision prefers the measured token count over the rough 4-char estimation.

### 2.0.11

- Fix CI publish: add `solid-js`, `@opentui/core`, `@opentui/solid` to `devDependencies`.
  The workflow runs `npm ci --legacy-peer-deps`, which skips peer deps, so loading
  `@opencode/plugin/tui` failed with `Cannot find package 'solid-js'`.

### 2.0.10

- Fix `/panel` output showing `User tokens: 0`: user/system messages carry their text
  on a top-level `text` field (not inside `content`), which `deriveStats` now captures.
- Add regression tests for CLI panel stats.

### 2.0.9

- `feat(panel-as-message)`: `/panel` and `slim-panel` now print the context stats as plain
  text into the message stream via `client.session.synthetic`, instead of taking over
  OpenCode's own panel UI (`session.panel` slot + `ui.panel.open` removed).
- The TUI panel now derives its own stats (token estimate, role breakdown, tool/compaction
  counts) directly from the session transcript rather than deferring to the server tool.

### 2.0.8

- Fix `keymap.provider is missing` in the CLI plugin: register the keymap layer inside
  an `app` slot render (where the keymap provider is available) instead of in `setup()`.

### 2.0.7

- Fix `Cannot find package 'react'` when the plugin is loaded from the global npm cache:
  add a per-file `/** @jsxImportSource @opentui/solid */` pragma to `src/tui.tsx` so JSX
  always compiles against `@opentui/solid/jsx-runtime`
- Ship `tsconfig.json` in the published package so loaders that read `jsxImportSource` from config pick it up

### 2.0.6

- Add real `compaction` hook so history actually shrinks (the `context` hook only affects the outgoing request)
- Resolve the active model's real context limit instead of hard-coding 200k
- Register `compress`/`panel` tools with `options.codemode` so they appear in agent/codemode environments
- Fix token-by-role panel bug where `tools` always equalled zero
- Replace toast-only CLI panel with a real `session.panel` slot (`slim-panel` / `/panel`)
- Add regression test for the tool-token bucket

### 2.0.3

- Fix v2 API compatibility issues
- Remove namespace from tool registration
- Handle both v1 and v2 message part types
- Make context hooks synchronous

### 2.0.2

- Update README documentation
- Add GitHub Actions workflow for automated npm publish

### 2.0.1

- Fix npm publish conflict

### 2.0.0

**Breaking Changes:** Migrated to OpenCode v2 plugin API.

- Migrate from `@opencode-ai/plugin` to `@opencode/plugin`
- Use `Plugin.define()` pattern instead of server function
- Register tools via `ctx.tool.transform()` with JSON Schema input
- Replace experimental hooks with `ctx.session.hook()`
- Replace event callback with `ctx.event.subscribe()`
- Update cleanup to use setup return function
- Minimum OpenCode version: 2.0.0

### 1.0.1

- Initial release

## Credits

- [PrakharSrivastav](https://github.com/PrakharSrivastav) — reported [issue #11](https://github.com/serkanalgur/opencodev2-slim/issues/11), suggesting that a context window should not be resolved by borrowing an arbitrary model's limit, and that current context usage should be measured per model call rather than read off session lifetime totals. Both suggestions shipped in 3.0.1.

## License

MIT
