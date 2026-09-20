import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SlimConfig } from "../types"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"

const DEFAULT_CONFIG: SlimConfig = {
    enabled: true,
    debug: false,
    compress: {
        enabled: true,
        permission: "allow",
        maxContextLimit: "80%",
        minContextLimit: "40%",
        nudgeFrequency: 5,
        protectUserMessages: false,
        protectedTools: ["task", "skill", "todowrite", "todoread"],
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
    adaptive: {
        enabled: true,
        learningRate: 0.1,
        minCompressionRatio: 0.3,
    },
    costAware: {
        enabled: true,
        cacheBoostFactor: 0.5,
    },
    persistence: {
        enabled: true,
        directory: join(homedir(), ".config", "opencode", "slim"),
    },
}

function deepMerge(base: SlimConfig, override: Partial<SlimConfig>): SlimConfig {
    return {
        ...base,
        ...override,
        compress: { ...base.compress, ...override.compress },
        strategies: {
            deduplication: { ...base.strategies.deduplication, ...override.strategies?.deduplication },
            purgeErrors: { ...base.strategies.purgeErrors, ...override.strategies?.purgeErrors },
        },
        adaptive: { ...base.adaptive, ...override.adaptive },
        costAware: { ...base.costAware, ...override.costAware },
        persistence: { ...base.persistence, ...override.persistence },
    }
}

export function loadConfig(_api: TuiPluginApi): SlimConfig {
    let config = { ...DEFAULT_CONFIG }

    const globalDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")

    const globalPath = join(globalDir, "slim.jsonc")
    const globalPathJson = join(globalDir, "slim.json")

    const configPath = existsSync(globalPath)
        ? globalPath
        : existsSync(globalPathJson)
          ? globalPathJson
          : null

    if (configPath) {
        try {
            const content = readFileSync(configPath, "utf-8")
            const parsed = parse(content)
            if (parsed) {
                config = deepMerge(config, parsed)
            }
        } catch {
            // Use defaults
        }
    }

    return config
}
