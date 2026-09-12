/**
 * Turn the user's own settings layer into the smallest write that gives
 * tier-less third-party models a reasoning ladder.
 *
 * Everything here is a pure function of its inputs: the raw user section, the
 * resolved config, and one injected capability probe. That is what makes the
 * whole policy testable without a Host, a provider, or a network — and it is
 * why the probe arrives as a callback rather than an `ctx.llm` import.
 *
 * Three rules carry the safety of the design:
 *
 * 1. **Read only the user layer.** The resolved settings value already has
 *    composition defaults folded in; writing that back would bake inherited
 *    numbers into `settings.yaml` and freeze them against future catalog
 *    updates.
 * 2. **Never rewrite a model that already offers a tier.** Declaring a
 *    `reasoningEfforts` dict *replaces* the inherited capability and pins every
 *    unlisted level unsupported (`resolveModelReasoning`,
 *    `dsh-llm-pi-ai/lib/index.js:562-585`). Only the provider knows the wire
 *    spelling behind an inherited tier, so a rewrite could only ever lose
 *    information.
 * 3. **Arrays are replaced wholesale.** `mergeLayers` treats anything that is
 *    not a plain object as a leaf (`dsh-settings/lib/index.js:104-108`), so a
 *    route with a configured `models` list is rebuilt entry by entry, with an
 *    integrity check that no original field was dropped.
 *
 * @module dsh-reasoning-tiers/plan
 */

import type { Ladder } from './ladder.ts'
import { asThinkingLevel, isPlainObject, jsonEquals, validateLadder } from './ladder.ts'
import type { Confidence, Suggestion, UserRule } from './knowledge.ts'
import { normalizeModelId, suggest, suggestRouteDialect } from './knowledge.ts'
import type { Dialect, KnownProtocol } from './protocol.ts'
import { asProtocol } from './protocol.ts'

/** Why a model was left alone. */
export type SkipReason =
  | 'excluded-provider'
  | 'excluded-model'
  | 'existing-capability'
  | 'user-declared'
  | 'no-suggestion'
  | 'probe-limit'
  | 'malformed'
  | 'invalid-ladder'

/** One field group this plugin is about to add. */
export interface WriteRecord {
  readonly route: string
  readonly model: string
  /** Which user-layer shape carried the entry. */
  readonly mode: 'models' | 'modelOverrides'
  readonly ladder: Ladder
  /** Dialect switches added to the route by this pass. */
  readonly dialect?: Dialect
  readonly confidence: Confidence
  readonly source: string
}

/** One model this plugin deliberately did not touch. */
export interface SkipRecord {
  readonly route: string
  readonly model: string
  readonly reason: SkipReason
  readonly detail?: string | undefined
}

/** The resolved knobs this plugin runs with, as `config.ts` produces them. */
export interface PlanOptions {
  readonly rules: readonly UserRule[]
  readonly respectExisting: boolean
  readonly compatAutofill: boolean
  readonly excludeProviders: readonly string[]
  readonly excludeModels: readonly string[]
  readonly alignGlobalEffort: boolean
  readonly globalEffort?: string | undefined
  /** Probe every configured model so the pass can audit ladders it does not write. */
  readonly diagnose: boolean
  /** Add the deployment's default effort to a ladder that lacks it. */
  readonly widenToGlobalEffort: boolean
  readonly maxProbes: number
  /** Model ids for routes whose catalog comes from pi-ai rather than the user. */
  readonly catalogModels?: Readonly<Record<string, readonly string[]>>
}

/** The one effect the caller must supply: what tiers does this route/model offer today? */
export interface PlanContext {
  /**
   * The tier ids one exact route currently offers.
   * @param route - provider route key.
   * @param model - configured model id.
   * @returns offered effort ids; empty when the route cannot answer.
   */
  tiers(route: string, model: string): Promise<readonly string[]>
}

/** What a pass decided. */
export interface Plan {
  /** Patch for `settings.update('llm-pi-ai', patch)`, empty when nothing changed. */
  readonly patch: Record<string, unknown>
  readonly writes: readonly WriteRecord[]
  readonly skips: readonly SkipRecord[]
  /** Every probed route/model and the tiers it offered before this pass. */
  readonly checked: ReadonlyMap<string, readonly string[]>
  /** How many capability probes were answered before `maxProbes` stopped it. */
  readonly probes: number
}

/**
 * The key one `checked` entry is filed under.
 *
 * The route is length-prefixed rather than delimited, so no pair of real ids
 * can produce the same key — an id containing the separator would otherwise
 * collide with a different split of the same string.
 */
export function probeKey(route: string, model: string): string {
  return `${String(route.length)}:${route}${model}`
}

/**
 * Recover the route and model one probe key was built from.
 * @param key - a {@link probeKey} result.
 * @returns the pair, or `undefined` when the key is not one.
 */
export function splitProbeKey(key: string): [route: string, model: string] | undefined {
  const colon = key.indexOf(':')
  if (colon < 0) return void 0
  const length = Number(key.slice(0, colon))
  if (!Number.isInteger(length) || length < 0) return void 0
  const body = key.slice(colon + 1)
  if (body.length < length) return void 0
  return [body.slice(0, length), body.slice(length)]
}

/**
 * Match a configured exclusion pattern against a model id. `*` and `?` are the
 * only wildcards, so a pattern reads the way the id does.
 * @param pattern - glob, case-insensitive.
 * @param model - the id to test.
 * @returns whether the model is excluded.
 */
export function globMatch(pattern: string, model: string): boolean {
  const escaped = normalizeModelId(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return expression.test(normalizeModelId(model))
}

function excluded(model: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, model))
}

/** The user's own dialect switches for a route, so none is overwritten. */
function userCompatKeys(profile: Record<string, unknown>): Set<string> {
  const compat = profile.compat
  return isPlainObject(compat) ? new Set(Object.keys(compat)) : new Set()
}


/**
 * Compute the write plan for one settings pass.
 * @param userSection - the raw `llm-pi-ai` user layer, exactly as stored.
 * @param options - resolved plugin knobs.
 * @param context - injected capability probe.
 * @returns the patch plus a full account of what was written and skipped.
 */
export async function buildPlan(
  userSection: unknown,
  options: PlanOptions,
  context: PlanContext,
): Promise<Plan> {
  const writes: WriteRecord[] = []
  const skips: SkipRecord[] = []
  const checked = new Map<string, readonly string[]>()
  const providersPatch: Record<string, unknown> = {}

  if (!isPlainObject(userSection)) return { patch: {}, writes, skips, checked, probes: 0 }
  const providers = userSection.providers
  if (providers === undefined) return { patch: {}, writes, skips, checked, probes: 0 }
  if (!isPlainObject(providers))
    return {
      patch: {},
      writes,
      skips: [{ route: '(section)', model: '(all)', reason: 'malformed', detail: 'providers is not an object' }],
      checked,
      probes: 0,
    }

  let probes = 0

  for (const [route, rawProfile] of Object.entries(providers)) {
    if (options.excludeProviders.includes(route)) {
      skips.push({ route, model: '(all)', reason: 'excluded-provider' })
      continue
    }
    if (!isPlainObject(rawProfile)) {
      skips.push({ route, model: '(all)', reason: 'malformed', detail: 'provider profile is not an object' })
      continue
    }
    const protocol: KnownProtocol | undefined = asProtocol(rawProfile.api)
    const allowProtocolFallback = Array.isArray(rawProfile.models)
    const candidates = collectCandidates(rawProfile, options.catalogModels?.[route] ?? [])

    if (candidates.entries.length === 0 && candidates.overrides.size === 0) continue

    /** Ladders keyed by the id as configured, for whichever list carried it. */
    const ladders = new Map<string, { ladder: Ladder; dialect?: Dialect; confidence: Confidence; source: string }>()

    for (const candidate of [...candidates.entries, ...candidates.overrides.values()]) {
      const model = candidate.id
      if (model === undefined) continue
      if (excluded(model, options.excludeModels)) {
        skips.push({ route, model, reason: 'excluded-model' })
        continue
      }

      // A model that declares its own ladder is never written, so probing it
      // only serves the audit. Skipping the probe when nobody reads the audit
      // keeps a large configuration from asking the Host for facts it discards.
      const declaresItsOwn = candidate.carrier.reasoningEfforts !== undefined
      if (declaresItsOwn && !options.diagnose) {
        skips.push({ route, model, reason: 'user-declared' })
        continue
      }

      // Probe next. `diagnose` wants an audit of every model, including the
      // ones this pass will not touch, and the ladder we choose depends on what
      // the model already offers — so there is nothing to gain by postponing it.
      const key = probeKey(route, model)
      let offered = checked.get(key)
      if (offered === undefined) {
        if (probes >= options.maxProbes) {
          skips.push({ route, model, reason: 'probe-limit' })
          continue
        }
        probes += 1
        offered = await context.tiers(route, model)
        checked.set(key, offered)
      }
      const hasTier = offered.some((tier) => tier !== 'off')

      if (candidate.carrier.reasoningEfforts !== undefined) {
        skips.push({ route, model, reason: 'user-declared' })
        continue
      }

      const suggestion = suggest({
        route,
        model,
        protocol,
        baseURL: rawProfile.baseURL,
        rules: options.rules,
        allowProtocolFallback,
      })

      if (hasTier) {
        const widened =
          options.widenToGlobalEffort && options.globalEffort !== undefined && !offered.includes(options.globalEffort)
            ? widenExisting(offered, options.globalEffort)
            : undefined
        if (widened !== undefined) {
          const problems = validateLadder(widened, `${route}/${model}`)
          if (problems.length === 0) {
            ladders.set(model, {
              ladder: widened,
              confidence: 'medium',
              source: `widen:${options.globalEffort}`,
            })
            continue
          }
          skips.push({ route, model, reason: 'invalid-ladder', detail: problems.join('; ') })
          continue
        }
        if (options.respectExisting) {
          skips.push({ route, model, reason: 'existing-capability' })
          continue
        }
      }

      if (suggestion === undefined) {
        skips.push({
          route,
          model,
          reason: 'no-suggestion',
          ...(protocol === undefined ? { detail: 'unknown protocol' } : {}),
        })
        continue
      }
      const ladder = options.alignGlobalEffort
        ? withGlobalEffort(suggestion.ladder, suggestion.dialect, options.globalEffort)
        : suggestion.ladder
      const problems = validateLadder(ladder, `${route}/${model}`)
      if (problems.length > 0) {
        skips.push({ route, model, reason: 'invalid-ladder', detail: problems.join('; ') })
        continue
      }
      ladders.set(model, {
        ladder,
        ...(suggestion.dialect === undefined ? {} : { dialect: suggestion.dialect }),
        confidence: suggestion.confidence,
        source: suggestion.source,
      })
    }

    if (ladders.size === 0) continue

    const dialect = options.compatAutofill ? routeDialectFor(protocol, rawProfile, ladders) : undefined

    if (candidates.entries.length > 0) {
      const rebuilt: unknown[] = []
      let integrityFailure: string | undefined
      for (const entry of candidates.entries) {
        const found = entry.id === undefined ? undefined : ladders.get(entry.id)
        if (found === undefined) {
          rebuilt.push(entry.carrier)
          continue
        }
        const next = { ...entry.carrier, reasoningEfforts: found.ladder }
        if (!preserves(entry.carrier, next)) {
          integrityFailure = `model "${String(entry.id)}" would lose a configured field`
          break
        }
        rebuilt.push(next)
        writes.push({
          route,
          model: String(entry.id),
          mode: 'models',
          ladder: found.ladder,
          ...(dialect === undefined ? {} : { dialect }),
          confidence: found.confidence,
          source: found.source,
        })
      }
      if (integrityFailure !== undefined) {
        dropsWritesFor(writes, route)
        skips.push({ route, model: '(all)', reason: 'malformed', detail: integrityFailure })
        continue
      }
      providersPatch[route] = dialect === undefined ? { models: rebuilt } : { models: rebuilt, compat: dialect }
    } else {
      const overrides: Record<string, unknown> = { ...(isPlainObject(rawProfile.modelOverrides) ? rawProfile.modelOverrides : {}) }
      for (const [model, found] of ladders) {
        const existing = overrides[model]
        overrides[model] = isPlainObject(existing)
          ? { ...existing, reasoningEfforts: found.ladder }
          : { reasoningEfforts: found.ladder }
        writes.push({
          route,
          model,
          mode: 'modelOverrides',
          ladder: found.ladder,
          ...(dialect === undefined ? {} : { dialect }),
          confidence: found.confidence,
          source: found.source,
        })
      }
      providersPatch[route] =
        dialect === undefined ? { modelOverrides: overrides } : { modelOverrides: overrides, compat: dialect }
    }
  }

  const patch = Object.keys(providersPatch).length > 0 ? { providers: providersPatch } : {}
  return { patch, writes, skips, checked, probes }
}

interface Candidate {
  /** The model id as configured. */
  readonly id?: string | undefined
  /** The user-layer object that carries this model's fields. */
  readonly carrier: Record<string, unknown>
}

/** Read the models one route's user layer declares, in whichever shape. */
function collectCandidates(
  profile: Record<string, unknown>,
  catalogModelIds: readonly string[],
): { entries: Candidate[]; overrides: Map<string, Candidate> } {
  const entries: Candidate[] = []
  const overrides = new Map<string, Candidate>()
  const models = profile.models

  if (Array.isArray(models)) {
    for (const raw of models) {
      if (!isPlainObject(raw)) {
        entries.push({ carrier: raw as unknown as Record<string, unknown> })
        continue
      }
      entries.push({ id: typeof raw.id === 'string' ? raw.id : undefined, carrier: raw })
    }
    return { entries, overrides }
  }

  const declared = isPlainObject(profile.modelOverrides) ? Object.keys(profile.modelOverrides) : []
  for (const model of declared) {
    const value = (profile.modelOverrides as Record<string, unknown>)[model]
    overrides.set(model, { id: model, carrier: isPlainObject(value) ? value : {} })
  }
  for (const model of catalogModelIds) {
    if (overrides.has(model)) continue
    overrides.set(model, { id: model, carrier: {} })
  }
  return { entries, overrides }
}

/** Whether a rebuilt entry still carries every field the original declared. */
function preserves(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return Object.keys(before).every((key) => key in after && jsonEquals(before[key], after[key]))
}

/** Drop every write attributed to a route that failed its integrity check. */
function dropsWritesFor(writes: WriteRecord[], route: string): void {
  for (let index = writes.length - 1; index >= 0; index -= 1) if (writes[index]?.route === route) writes.splice(index, 1)
}

/**
 * Rebuild a ladder from tier ids a provider already reports.
 *
 * The seam reports which levels a model offers but not the string each one
 * dispatches, so widening has to assume the identity convention (level name =
 * wire value). That is true of the OpenAI-style ladders this is used for and is
 * why the option is opt-in and logged at `medium` confidence.
 */
export function widenExisting(offered: readonly string[], extraTier: string): Ladder | undefined {
  const ladder: Ladder = {}
  for (const tier of offered) {
    const level = asThinkingLevel(tier)
    if (level === undefined) return void 0
    ladder[level] = level === 'off' ? null : level
  }
  const extra = asThinkingLevel(extraTier)
  if (extra === undefined) return void 0
  ladder[extra] = extra === 'off' ? null : extra
  return ladder
}

/**
 * Add the effort the deployment asks for by default, when the ladder can carry
 * it. Only dialects that pass the level name straight through are widened:
 * a `qwen` or chat-template dialect maps levels onto a vendor-specific token,
 * and inventing one there is a 400 waiting in the user's next turn.
 */
export function withGlobalEffort(ladder: Ladder, dialect: Dialect | undefined, effort: string | undefined): Ladder {
  if (effort === undefined || effort.length === 0) return ladder
  const passthrough = dialect?.thinkingFormat === undefined || dialect.thinkingFormat === 'openai' || dialect.thinkingFormat === 'openrouter' || dialect.thinkingFormat === 'together'
  if (!passthrough) return ladder
  if (ladder[effort as keyof Ladder] !== undefined) return ladder
  return { ...ladder, [effort]: effort }
}

/** The route-level dialect fields to add, skipping any the user already set. */
function routeDialectFor(
  protocol: KnownProtocol | undefined,
  profile: Record<string, unknown>,
  ladders: Map<string, { dialect?: Dialect }>,
): Record<string, unknown> | undefined {
  const fromModel = [...ladders.values()].map((entry) => entry.dialect).find((entry) => entry !== undefined)
  const dialect: Dialect | undefined = fromModel ?? suggestRouteDialect(protocol, profile.baseURL)?.dialect
  if (dialect === undefined) return undefined
  const held = userCompatKeys(profile)
  const added: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(dialect)) {
    if (!ROUTE_COMPAT_FIELDS.has(field) || held.has(field)) continue
    added[field] = value
  }
  return Object.keys(added).length > 0 ? added : undefined
}

/** The compat switches this plugin is allowed to name at route level. */
const ROUTE_COMPAT_FIELDS: ReadonlySet<string> = new Set([
  'thinkingFormat',
  'supportsReasoningEffort',
  'supportsDeveloperRole',
  'forceAdaptiveThinking',
])
