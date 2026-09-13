/**
 * Pure editing logic behind the 模型能力 settings page.
 *
 * Plain functions over plain JSON so the page policy is testable without
 * React, a browser, or a Host. Evidence anchors:
 * - model entry schema fields: dsh-llm-pi-ai/lib/index.js:968-976
 * - resolution precedence entry ?? catalog ?? default, and `declaredInput`
 *   treating absent/empty as "no answer": :670-682, :292-294
 * - the per-request image gate reading model.input: :1844-1845
 * - whole-array commit convention (unknown fields survive): the official
 *   Models editor drafts the entire models list (ModelListEditor.d.ts:20-23)
 *
 * @module dsh-reasoning-tiers/capabilities
 */
import { isPlainObject } from './ladder.ts'

/** Modalities that admit image requests through the adapter gate. */
export const IMAGE_ON: readonly string[] = ['text', 'image']
/** Explicit negative capability: text-only; image requests throw UNSUPPORTED_CONTENT. */
export const IMAGE_OFF: readonly string[] = ['text']

/** Three-state image switch for one model row. */
export type ImageMode = 'inherit' | 'on' | 'off'

/** One editable model row: parsed user-layer view plus the raw entry. */
export interface ModelDraft {
  id: string
  /** Input text for contextWindow; '' = inherit (field removed). */
  contextText: string
  /** Input text for maxTokens; '' = inherit. */
  maxText: string
  image: ImageMode
  /** The original user-layer entry; unknown fields survive edits through it. */
  raw: Record<string, unknown>
}

/** One provider route as the page groups them. */
export interface ProviderDraft {
  route: string
  /** true when the user layer declares a `models` array (vs catalog + overrides). */
  hasModelsList: boolean
  models: readonly ModelDraft[]
}

/** Path-op shape the settings scope takes (structurally typed, no package edge). */
export type PathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

const countPattern = /^\d+$/

/** Whether the text is a valid count field: empty (inherit) or a positive integer. */
export function isValidCountText(text: string): boolean {
  return text === '' || (countPattern.test(text) && Number(text) > 0)
}

/** Resolve count text to a number; '' (inherit) and invalid text resolve to undefined. */
export function countValue(text: string): number | undefined {
  return text !== '' && countPattern.test(text) && Number(text) > 0 ? Number(text) : undefined
}

function imageModeOf(input: unknown): ImageMode {
  if (!Array.isArray(input) || input.length === 0) return 'inherit'
  return input.includes('image') ? 'on' : 'off'
}

function countText(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? String(value) : ''
}

function draftOf(id: string, raw: Record<string, unknown>): ModelDraft {
  return {
    id,
    contextText: countText(raw.contextWindow),
    maxText: countText(raw.maxTokens),
    image: imageModeOf(raw.input),
    raw,
  }
}

/** A blank override row for the add-override flow on catalog routes. */
export function emptyOverrideRow(): ModelDraft {
  return { id: '', contextText: '', maxText: '', image: 'inherit', raw: {} }
}

function isEntry(entry: unknown): entry is Record<string, unknown> & { id: string } {
  if (!isPlainObject(entry)) return false
  const id = entry.id
  return typeof id === 'string' && id.length > 0
}

/**
 * Group the configured pi-ai routes for the page.
 * Routes enumerate from the resolved section (every configured route), while
 * rows come from the USER layer only — `models` arrays make a route declared,
 * `modelOverrides` make it a catalog route, and absence leaves it empty.
 */
export function parseProviders(resolved: unknown, user: unknown): ProviderDraft[] {
  const routes: string[] = []
  const seen = new Set<string>()
  const collect = (section: unknown): void => {
    if (!isPlainObject(section) || !isPlainObject(section.providers)) return
    for (const [route, profile] of Object.entries(section.providers)) {
      if (typeof route === 'string' && route.length > 0 && isPlainObject(profile) && !seen.has(route)) {
        seen.add(route)
        routes.push(route)
      }
    }
  }
  collect(resolved)
  collect(user)

  const userProviders = isPlainObject(user) && isPlainObject(user.providers) ? user.providers : {}
  const drafts: ProviderDraft[] = []
  for (const route of routes) {
    const layer = isPlainObject(userProviders[route]) ? userProviders[route] : undefined
    const models = layer === undefined ? undefined : layer.models
    if (Array.isArray(models)) {
      const rows = models.filter(isEntry).map((entry) => draftOf(entry.id, entry))
      drafts.push({ route, hasModelsList: true, models: rows })
      continue
    }
    const overrides = layer === undefined ? undefined : layer.modelOverrides
    if (isPlainObject(overrides)) {
      const rows = Object.entries(overrides)
        .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === 'string' && entry[0].length > 0 && isPlainObject(entry[1]))
        .map(([id, raw]) => draftOf(id, raw))
      drafts.push({ route, hasModelsList: false, models: rows })
      continue
    }
    drafts.push({ route, hasModelsList: false, models: [] })
  }
  return drafts
}

/** Apply one row's edits to its raw entry: managed fields set/deleted, unknown fields untouched. */
export function rebuildEntry(draft: ModelDraft): Record<string, unknown> {
  const next: Record<string, unknown> = { ...draft.raw }
  next.id = draft.id
  const contextWindow = countValue(draft.contextText)
  if (contextWindow === undefined) delete next.contextWindow
  else next.contextWindow = contextWindow
  const maxTokens = countValue(draft.maxText)
  if (maxTokens === undefined) delete next.maxTokens
  else next.maxTokens = maxTokens
  if (draft.image === 'on') next.input = [...IMAGE_ON]
  else if (draft.image === 'off') next.input = [...IMAGE_OFF]
  else delete next.input
  return next
}

/** The first invalid field of a row, for inline marking; id is validated per route. */
export function invalidField(draft: ModelDraft): 'context' | 'max' | undefined {
  if (!isValidCountText(draft.contextText)) return 'context'
  if (!isValidCountText(draft.maxText)) return 'max'
  return undefined
}

/**
 * The write for one route: a single whole-value op at an object path — the
 * official editor's convention, which keeps unknown fields alive and never
 * addresses an array index. An emptied overrides dict unsets the field so the
 * route returns to pure catalog inheritance.
 */
export function buildMutateOps(draft: ProviderDraft): PathOp[] {
  if (draft.hasModelsList) {
    return [{ op: 'set', path: ['providers', draft.route, 'models'], value: draft.models.map(rebuildEntry) }]
  }
  // Blank-id rows are the UI's in-progress "add override" rows; they carry no
  // capability and the adapter refuses an empty model id outright.
  const rows = draft.models.filter((row) => row.id.trim().length > 0)
  if (rows.length === 0) {
    return [{ op: 'unset', path: ['providers', draft.route, 'modelOverrides'] }]
  }
  const dict: Record<string, unknown> = {}
  for (const row of rows) {
    const entry = rebuildEntry(row)
    delete entry.id // the dict key carries the id (adapter:649)
    dict[row.id.trim()] = entry
  }
  return [{ op: 'set', path: ['providers', draft.route, 'modelOverrides'], value: dict }]
}

/** Stable identity of a draft list for dirty checks (order-sensitive). */
export function draftsKey(models: readonly ModelDraft[]): string {
  return JSON.stringify(models.map((m) => [m.id, m.contextText, m.maxText, m.image]))
}

/** The three calls the page makes on its bound settings scope (structural, so no package edge). */
export interface ScopeShape<Snap> {
  getSnapshot(): Snap
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<void>
}

/**
 * Re-home a scope's methods onto own properties.
 *
 * `useSyncExternalStore` calls `subscribe` and `getSnapshot` with no receiver,
 * while the Host's `SettingsScopeController` keeps them on its prototype and
 * reads `this.store` (`dsh-client-ui-settings/lib/client.js:997-1006`). Detached,
 * that throws — and a `list`-slot entry crash abdicates the entry
 * (`dsh-client-ui-renderer/lib/client.js:790`), so the section renders its empty
 * crash face while the nav row survives: the row reads the raw ledger
 * (`dsh-client-ui-settings-general/lib/client.js:566`). That is the blank-page
 * signature this face exists to prevent.
 *
 * Built once per inject-face creation (the renderer caches the inject result per
 * entry), so the member identities stay stable across renders.
 */
export function bindScope<Snap>(scope: ScopeShape<Snap>): ScopeShape<Snap> {
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
    mutate: (ops, expectedRevision) => scope.mutate(ops, expectedRevision),
  }
}

/** Which count field a preset ladder belongs to. */
export type CountField = 'context' | 'max'

/** One quick-pick step: the byte value written, and the name shown beside it. */
export interface CountPreset {
  readonly value: number
  readonly label: string
}

/**
 * Context-window steps. Values follow whoever actually publishes them: binary
 * where the pi-ai catalog and vendor configs spell them that way (32K=32768,
 * 128K=131072, 256K=262144), decimal where the vendor announcement is decimal
 * (200K=200000, 272K=272000, 400K=400000, 1M=1000000). One nominal step keeps a
 * single value, so no label appears twice with two meanings.
 */
const CONTEXT_PRESETS: readonly CountPreset[] = freeze([
  { value: 32768, label: '32K' },
  { value: 65536, label: '64K' },
  { value: 131072, label: '128K' },
  { value: 200000, label: '200K' },
  { value: 262144, label: '256K' },
  { value: 272000, label: '272K' },
  { value: 400000, label: '400K' },
  { value: 1000000, label: '1M' },
])

/** Output-cap steps: always binary, the convention every provider ships. */
const MAX_PRESETS: readonly CountPreset[] = freeze([
  { value: 1024, label: '1K' },
  { value: 4096, label: '4K' },
  { value: 16384, label: '16K' },
  { value: 32768, label: '32K' },
  { value: 65536, label: '64K' },
  { value: 131072, label: '128K' },
  { value: 262144, label: '256K' },
])

/** Deep-freeze a preset table read on every render. */
function freeze(list: readonly CountPreset[]): readonly CountPreset[] {
  list.forEach((preset) => Object.freeze(preset))
  return Object.freeze(list)
}

/**
 * The preset ladder for one count field, ascending. A stable frozen reference:
 * the page reads it per render to fill its datalists.
 */
export function countPresets(field: CountField): readonly CountPreset[] {
  return field === 'context' ? CONTEXT_PRESETS : MAX_PRESETS
}

/** The `<datalist>` id for one field — used by the list and every input, so they cannot drift. */
export function presetListId(field: CountField): string {
  return `dsh-rt-cap-${field}-presets`
}

/** The human name of an exact preset value; undefined when the number is not one. */
export function presetLabel(value: number, field: CountField): string | undefined {
  return countPresets(field).find((preset) => preset.value === value)?.label
}
