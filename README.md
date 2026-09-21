# opencodev2-slim

[![npm version](https://img.shields.io/npm/v/@serkanalgur/opencodev2-slim.svg)](https://www.npmjs.com/package/@serkanalgur/opencodev2-slim)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Smart context management plugin for OpenCode v2. Optimizes token usage through semantic compression, cost-aware pruning, and adaptive thresholds.

## Features

- **TUI Panel** - Rich context usage visualization with status indicators
- **Enhanced Compress** - Auto/range/topic modes for flexible compression
- **Semantic Compression** - Groups related tool calls and compresses them intelligently
- **Cost-Aware Pruning** - Considers token pricing when deciding what to compress
- **Adaptive Thresholds** - Learns from compression history to optimize timing
- **Session Persistence** - Saves state across restarts
- **Deduplication** - Removes repeated tool calls automatically
- **Error Purging** - Cleans up failed tool call outputs after configurable turns
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

- `/panel` — Opens the rich TUI panel with context usage, stats, and help
- `/compress` — Shows instructions for using the compress tool

### TUI Panel

The panel provides a real-time overview of your context usage, including:
- Token usage vs model limit with visual progress bar
- Message breakdown by role (user/assistant/tools)
- Compression history and savings
- Cost estimation based on your model
- Smart recommendations for optimization

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

## Configuration

Create `~/.config/opencode/slim.jsonc`:

```jsonc
{
    "enabled": true,
    "compress": {
        "enabled": true,
        "permission": "allow",
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
        }
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
| `/panel` | Open the Slim TUI panel with context usage, stats, and help |
| `/compress` | Show instructions for using the compress tool |

Note: Compression is performed by the AI assistant using the `compress` tool. The slash command provides guidance on usage.

## Changelog

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

## License

MIT
