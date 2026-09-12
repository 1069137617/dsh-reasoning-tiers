/**
 * The write ledger and the undo path.
 *
 * This plugin edits a document the user owns, so every write is recorded and
 * `revert: true` takes them back. Undo is deliberately conservative: a field is
 * removed only while it still holds exactly what this plugin wrote. Once the
 * human has edited it, it is theirs, and the revert reports it as left in place
 * rather than deleting their work.
 *
 * Storage follows the in-tree convention of a plugin-owned directory under the
 * harness home (`resolveDshHome()` plus the plugin's own folder name, as
 * `dsh-llm-deepseek` does with `llm-deepseek/files-v3.json`).
 *
 * @module dsh-reasoning-tiers/journal
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Ladder } from './ladder.ts'
import { isPlainObject, jsonEquals } from './ladder.ts'
import type { Dialect } from './protocol.ts'

/** Schema tag so a future format change refuses an old file instead of misreading it. */
export const JOURNAL_VERSION = 1

/** One model field this plugin added. */
export interface LadderRecord {
  readonly route: string
  readonly model: string
  readonly mode: 'models' | 'modelOverrides'
  readonly ladder: Ladder
}

/** One route-level compat field group this plugin added. */
export interface CompatRecord {
  readonly route: string
  readonly fields: Readonly<Record<string, unknown>>
}

/** The whole ledger. */
export interface Journal {
  version: number
  ladders: LadderRecord[]
  compat: CompatRecord[]
}

/** Why one ledger record survived a revert. */
export interface RevertReport {
  readonly route: string
  readonly model: string
  readonly reason: 'changed-by-user' | 'absent-already'
}

/** The undo instructions, computed from the ledger and the live user layer. */
export interface RevertPlan {
  /** Merge patch: rebuilt `models` arrays with this plugin's field removed. */
  readonly patch: Record<string, unknown>
  /** Path edits, which a merge alone cannot express: nested keys to delete. */
  readonly ops: readonly SettingsPathOp[]
  /** Records deliberately left alone, for the log. */
  readonly left: readonly RevertReport[]
  /** The ledger to keep once this revert is applied: exactly what was not undone. */
  readonly remaining: Journal
}

/** Where the ledger lives. */
export function journalPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), 'dsh-reasoning-tiers', 'journal.json')
}

/** An empty ledger. */
export function emptyJournal(): Journal {
  return { version: JOURNAL_VERSION, ladders: [], compat: [] }
}

/**
 * Read the ledger, tolerating absence and corruption.
 * @param path - journal location.
 * @returns the stored ledger, or an empty one.
 */
export async function readJournal(path: string): Promise<Journal> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return emptyJournal()
  }
  try {
    return parseJournal(JSON.parse(raw))
  } catch {
    return emptyJournal()
  }
}

/**
 * Validate a parsed journal object, dropping every record it cannot trust.
 * @param value - freshly parsed JSON.
 * @returns the ledger, or an empty one when the file is not ours.
 */
export function parseJournal(value: unknown): Journal {
  if (!isPlainObject(value) || value.version !== JOURNAL_VERSION) return emptyJournal()
  const ladders: LadderRecord[] = []
  for (const entry of Array.isArray(value.ladders) ? value.ladders : []) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.route !== 'string' || typeof entry.model !== 'string') continue
    if (entry.mode !== 'models' && entry.mode !== 'modelOverrides') continue
    if (!isPlainObject(entry.ladder)) continue
    ladders.push({ route: entry.route, model: entry.model, mode: entry.mode, ladder: entry.ladder as Ladder })
  }
  const compat: CompatRecord[] = []
  for (const entry of Array.isArray(value.compat) ? value.compat : []) {
    if (!isPlainObject(entry) || typeof entry.route !== 'string' || !isPlainObject(entry.fields)) continue
    compat.push({ route: entry.route, fields: entry.fields })
  }
  return { version: JOURNAL_VERSION, ladders, compat }
}

/**
 * Persist the ledger atomically: a half-written journal would turn the next
 * revert into a partial one.
 * @param path - journal location.
 * @param journal - the whole next ledger.
 */
export async function writeJournal(path: string, journal: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.tmp`
  await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** One pass's writes, as `plan.ts` reports them. */
export interface WriteLike {
  route: string
  model: string
  mode: 'models' | 'modelOverrides'
  ladder: Ladder
  dialect?: Dialect | undefined
}

/**
 * Fold one pass into the ledger.
 * @param journal - the ledger so far (mutated and returned, for chaining).
 * @param writes - what this pass added.
 * @returns the same ledger, with repeats collapsed.
 */
export function mergeJournal(journal: Journal, writes: readonly WriteLike[]): Journal {
  for (const write of writes) {
    const at = journal.ladders.findIndex(
      (entry) => entry.route === write.route && entry.model === write.model && entry.mode === write.mode,
    )
    const record: LadderRecord = {
      route: write.route,
      model: write.model,
      mode: write.mode,
      ladder: write.ladder,
    }
    if (at === -1) journal.ladders.push(record)
    else journal.ladders[at] = record

    if (write.dialect !== undefined) {
      const existing = journal.compat.find((entry) => entry.route === write.route)
      if (existing === undefined) journal.compat.push({ route: write.route, fields: { ...write.dialect } })
      else
        journal.compat[journal.compat.indexOf(existing)] = {
          route: write.route,
          fields: { ...existing.fields, ...write.dialect },
        }
    }
  }
  return journal
}

/**
 * Compute the undo for one ledger against the settings as they now stand.
 *
 * The caller supplies the merge patch and the path ops separately because the
 * settings seam merges arrays wholesale but cannot delete a nested key: a
 * rebuilt `models` array goes through `update`, while an emptied
 * `modelOverrides` entry or `compat` field goes through `mutate`.
 *
 * @param userSection - the raw user layer for the provider namespace.
 * @param journal - the ledger.
 * @returns the writes to issue and the ledger that survives them.
 */
export function buildRevert(userSection: unknown, journal: Journal): RevertPlan {
  const patch: Record<string, unknown> = {}
  const ops: SettingsPathOp[] = []
  const left: RevertReport[] = []
  const keptLadders: LadderRecord[] = []
  const keptCompat: CompatRecord[] = []
  const providersPatch: Record<string, unknown> = {}
  const routes = new Set<string>([...journal.ladders.map((entry) => entry.route), ...journal.compat.map((entry) => entry.route)])
  const providers = isPlainObject(userSection) ? userSection.providers : undefined

  for (const route of routes) {
    const rawProfile = isPlainObject(providers) ? providers[route] : undefined
    const routeLadders = journal.ladders.filter((entry) => entry.route === route)
    const compatRecord = journal.compat.find((entry) => entry.route === route)

    if (!isPlainObject(rawProfile)) {
      // The route is gone, or the user rewrote it wholesale. Nothing here is
      // ours to remove, and recreating the route would be the worse mistake.
      for (const record of routeLadders) left.push({ route, model: record.model, reason: 'absent-already' })
      continue
    }
    const profile: Record<string, unknown> = rawProfile
    const routePatch: Record<string, unknown> = {}

    // `models` is an array: rebuild it from the current document, minus ours.
    const modelRecords = routeLadders.filter((entry) => entry.mode === 'models')
    if (modelRecords.length > 0 && Array.isArray(profile.models)) {
      const pending = new Map(modelRecords.map((entry) => [entry.model, entry]))
      const rebuilt = profile.models.map((raw) => {
        if (!isPlainObject(raw) || typeof raw.id !== 'string') return raw
        const record = pending.get(raw.id)
        if (record === undefined) return raw
        pending.delete(raw.id)
        const outcome = undoField(raw, record.ladder)
        if (outcome === 'kept') {
          keptLadders.push(record)
          left.push({ route, model: raw.id, reason: 'changed-by-user' })
        } else if (outcome === 'absent-already') {
          left.push({ route, model: raw.id, reason: 'absent-already' })
        }
        return outcome === 'removed' ? withoutReasoningEfforts(raw) : raw
      })
      for (const record of pending.values()) {
        left.push({ route, model: record.model, reason: 'absent-already' })
      }
      routePatch.models = rebuilt
    } else {
      keptLadders.push(...modelRecords)
    }

    // `modelOverrides` is a dict: a path unset is the only way to remove a key.
    const overrides = isPlainObject(profile.modelOverrides) ? profile.modelOverrides : {}
    for (const record of routeLadders.filter((entry) => entry.mode === 'modelOverrides')) {
      const existing = overrides[record.model]
      if (!isPlainObject(existing)) {
        left.push({ route, model: record.model, reason: 'absent-already' })
        continue
      }
      const outcome = undoField(existing, record.ladder)
      if (outcome === 'kept') {
        keptLadders.push(record)
        continue
      }
      if (outcome === 'removed') {
        ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides', record.model, 'reasoningEfforts'] })
        if (Object.keys(existing).length === 1)
          ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides', record.model] })
      } else {
        left.push({ route, model: record.model, reason: 'absent-already' })
      }
    }

    if (compatRecord !== undefined) {
      const heldCompat = isPlainObject(profile.compat) ? profile.compat : undefined
      const stillHeld: Record<string, unknown> = {}
      let undid = false
      for (const [field, wrote] of Object.entries(compatRecord.fields)) {
        if (heldCompat === undefined || !(field in heldCompat)) continue
        if (!jsonEquals(heldCompat[field], wrote)) {
          stillHeld[field] = wrote
          continue
        }
        undid = true
        ops.push({ op: 'unset', path: ['providers', route, 'compat', field] })
      }
      if (Object.keys(stillHeld).length > 0) {
        keptCompat.push({ route, fields: stillHeld })
      } else if (undid) {
        // Drop the whole block only when every field still in it was ours.
        const everyFieldIsOurs =
          heldCompat !== undefined && Object.keys(heldCompat).every((field) => field in compatRecord.fields)
        if (everyFieldIsOurs) ops.push({ op: 'unset', path: ['providers', route, 'compat'] })
      }
    }

    if (Object.keys(routePatch).length > 0) providersPatch[route] = routePatch
  }

  if (Object.keys(providersPatch).length > 0) patch.providers = providersPatch
  return {
    patch,
    ops,
    left,
    remaining: { version: JOURNAL_VERSION, ladders: keptLadders, compat: keptCompat },
  }
}

/** What to do with one recorded field: remove it, keep it, or it is already gone. */
function undoField(entry: Record<string, unknown>, wrote: Ladder): 'removed' | 'kept' | 'absent-already' {
  if (entry.reasoningEfforts === undefined) return 'absent-already'
  return jsonEquals(entry.reasoningEfforts, wrote) ? 'removed' : 'kept'
}

function withoutReasoningEfforts(entry: Record<string, unknown>): Record<string, unknown> {
  const { reasoningEfforts: _removed, ...kept } = entry
  return kept
}
