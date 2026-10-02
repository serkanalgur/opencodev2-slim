/**
 * Session-state persistence.
 *
 * Primary store is the v2 plugin storage domain (`ctx.storage`), which scopes
 * values per plugin instance and per project directory — so two projects, or
 * two checkouts, no longer share one global `~/.config/opencode/slim`
 * directory, and one project's session state cannot collide with another's.
 *
 * The legacy flat directory stays as a MIGRATION FALLBACK: on first read for a
 * session with nothing in storage, the old `<dir>/<sessionId>.json` is loaded
 * and immediately re-written into storage, so an upgrade keeps every session's
 * compression history and adaptive state instead of silently starting blank.
 * The legacy file is left in place — deleting user data is not this plugin's
 * call to make.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs"
import { join } from "path"
import type { SessionState } from "./types"

/** The subset of the v2 storage domain this module needs. */
export interface SlimStorage {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
}

/** Key prefix for session state inside the plugin-scoped storage namespace. */
const STATE_PREFIX = "sessions/"

/**
 * Make a project path safe to embed in a storage key.
 *
 * Storage keys are opaque strings, but `/` is our own namespace separator, so a
 * raw path would collide keys. Hashing the canonical path keeps keys flat,
 * bounded in length (a deeply nested checkout path can be long), and stable
 * across runs — which is all a scope identifier has to be.
 */
export function projectScopeKey(canonicalPath: string | undefined): string {
    if (!canonicalPath) return "global"
    let hash = 5381
    for (let i = 0; i < canonicalPath.length; i++) {
        hash = ((hash << 5) + hash + canonicalPath.charCodeAt(i)) | 0
    }
    return `p${(hash >>> 0).toString(36)}`
}

/** The storage key holding one session's state. */
export function sessionStateKey(projectScope: string, sessionId: string): string {
    return `${STATE_PREFIX}${projectScope}/${sessionId}`
}

/**
 * The write-recency marker carried inside every persisted payload.
 *
 * Both layers (plugin storage and the on-disk mirror) record WHEN they were
 * written, so a reader can tell which copy is newer instead of guessing from
 * which layer happened to answer first. Underscore-prefixed to stay clear of
 * `SessionState`'s own fields.
 */
export const WRITTEN_AT = "__slimWrittenAt"

/** Serialize a state to plain JSON (the Map is not JSON-native). */
export function serializeState(
    state: SessionState,
    writtenAt: number = Date.now(),
): Record<string, unknown> {
    return {
        ...state,
        [WRITTEN_AT]: writtenAt,
        toolCalls: Array.from(state.toolCalls.entries()),
    }
}

/** Read the recency recorded inside a payload, if it has one. */
export function writtenAtOf(payload: Record<string, unknown>): number | undefined {
    const value = payload[WRITTEN_AT]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A legacy entry together with when it was written. */
export interface LegacyEntry {
    data: Record<string, unknown>
    /**
     * Best available write time: the marker inside the payload, else the file's
     * mtime. The marker is preferred because a copied or restored file keeps
     * its original meaning, whereas mtime merely reflects the last copy.
     */
    writtenAt: number
}

/**
 * Read `<dir>/<sessionId>.json` with its write time.
 *
 * Falls back to the file mtime for payloads written before the marker existed,
 * so an upgraded install still compares sanely rather than treating every old
 * file as infinitely old.
 */
export function readLegacyEntry(
    sessionId: string,
    legacyDir: string,
): LegacyEntry | undefined {
    const statePath = join(legacyDir, `${sessionId}.json`)
    if (!existsSync(statePath)) return undefined
    try {
        const parsed = JSON.parse(readFileSync(statePath, "utf-8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
        const data = parsed as Record<string, unknown>
        let writtenAt = writtenAtOf(data)
        if (writtenAt === undefined) {
            writtenAt = statSync(statePath).mtimeMs
        }
        return { data, writtenAt }
    } catch {
        // Unreadable legacy file: fall through to defaults rather than throwing
        // on every request for the rest of the session.
        return undefined
    }
}

/** Read the legacy `<dir>/<sessionId>.json`, or `undefined` if absent/corrupt. */
export function readLegacyState(
    sessionId: string,
    legacyDir: string,
): Record<string, unknown> | undefined {
    return readLegacyEntry(sessionId, legacyDir)?.data
}

/**
 * Write a payload to the legacy directory (used only as a safety mirror).
 *
 * Takes an already-serialized payload rather than a state so that the mirror
 * and the storage copy carry the SAME write time — otherwise the two layers
 * disagree about which was written last, and the reader would oscillate.
 */
export function writeLegacyPayload(
    payload: Record<string, unknown>,
    sessionId: string,
    legacyDir: string,
): void {
    try {
        if (!existsSync(legacyDir)) mkdirSync(legacyDir, { recursive: true })
        writeFileSync(join(legacyDir, `${sessionId}.json`), JSON.stringify(payload, null, 2), "utf-8")
    } catch {
        // Best-effort mirror only; storage is the source of truth.
    }
}