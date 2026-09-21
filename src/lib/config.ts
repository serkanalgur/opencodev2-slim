import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { SlimConfig, SessionState } from "./types"

const DEFAULT_CONFIG: SlimConfig = {
    enabled: true,
    debug: false,
    compress: {
        enabled: true,
        mode: "range",
        permission: "allow",
        // DCP defaults: absolute token counts (not percentages).
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
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
        compress: {
            ...base.compress,
            ...override.compress,
            modelMaxLimits: override.compress?.modelMaxLimits ?? base.compress.modelMaxLimits,
            modelMinLimits: override.compress?.modelMinLimits ?? base.compress.modelMinLimits,
        },
        strategies: {
            deduplication: { ...base.strategies.deduplication, ...override.strategies?.deduplication },
            purgeErrors: { ...base.strategies.purgeErrors, ...override.strategies?.purgeErrors },
        },
        adaptive: { ...base.adaptive, ...override.adaptive },
        costAware: { ...base.costAware, ...override.costAware },
        persistence: { ...base.persistence, ...override.persistence },
    }
}

export function loadConfig(): SlimConfig {
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

export function createDefaultConfig(): void {
    const globalDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")

    const configPath = join(globalDir, "slim.jsonc")

    if (!existsSync(configPath)) {
        try {
            mkdirSync(globalDir, { recursive: true })
            writeFileSync(
                configPath,
                `{
    // Slim Configuration (DCP-compatible limit rules)
    "enabled": true,
    "compress": {
        "enabled": true,
        "mode": "range",
        "permission": "allow",
        "maxContextLimit": 100000,
        "minContextLimit": 50000,
        "nudgeFrequency": 5,
        "iterationNudgeThreshold": 15,
        "nudgeForce": "soft"
    }
}`,
                "utf-8",
            )
        } catch {
            // Ignore errors
        }
    }
}

export function resolveTokenLimit(value: number | string, contextLimit: number): number {
    if (typeof value === "number") return value
    const percent = parseFloat(value.replace("%", "")) / 100
    return Math.floor(contextLimit * percent)
}

/**
 * DCP limit resolution. Prefers per-model overrides (compress.modelMinLimits /
 * compress.modelMaxLimits keyed by "providerId/modelId"), then falls back to the
 * global max/min limit. Percent strings resolve against the model's context window.
 */
export function resolveCompressLimits(
    config: SlimConfig,
    state: SessionState,
    providerId?: string,
    modelId?: string,
): { max: number; min: number } {
    const parseLimit = (value: number | string | undefined): number => {
        if (value === undefined) {
            return 0
        }
        if (typeof value === "number") {
            return value
        }
        const pct = parseFloat(value.replace("%", ""))
        if (Number.isNaN(pct)) {
            return 0
        }
        return Math.round((Math.max(0, Math.min(100, pct)) / 100) * state.modelContextLimit)
    }

    const providerModel = providerId && modelId ? `${providerId}/${modelId}` : undefined

    const modelMin = providerModel ? config.compress.modelMinLimits?.[providerModel] : undefined
    const modelMax = providerModel ? config.compress.modelMaxLimits?.[providerModel] : undefined

    return {
        max: parseLimit(modelMax ?? config.compress.maxContextLimit),
        min: parseLimit(modelMin ?? config.compress.minContextLimit),
    }
}
