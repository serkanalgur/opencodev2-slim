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
