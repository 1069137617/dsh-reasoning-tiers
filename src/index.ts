/**
 * `dsh-reasoning-tiers`: give third-party models their reasoning tiers.
 *
 * The problem is structural, not a missing toggle. A model's selectable efforts
 * come from exactly one place — `LlmResolvedModelInfo.reasoning` — and the
 * pi-ai adapter omits it entirely for a model that carries no reasoning
 * metadata (`dsh-llm-pi-ai/lib/index.js:1726-1740` in 0.2.0, whose own comment
 * names "every hand-declared one" as that case). The official Models page has
 * no field for `reasoningEfforts` and no slot reaching a single model row, so
 * the only remaining lever is the provider's own settings section — which is
 * what this plugin writes, once, conservatively, and with an undo.
 *
 * Host generations differ in two seams, and this module rides the live one:
 * 0.2.0's settings service dropped `get(ns)` (the resolved section now travels
 * on the `describe()` descriptor's `value`), and renamed the change event from
 * `settings/updated` to `settings/document-updated`. Both shapes are read here,
 * so one bundle mounts on either host.
 *
 * Why not an adapter: `registerAdapter` throws `DUPLICATE_ADAPTER` for a route
 * another plugin already owns, and `llm/stream` is the only waterfall — whose
 * loop-built requests are deep-frozen by contract. So there is no interception
 * point, and none is needed: capability is configuration.
 *
 * @module dsh-reasoning-tiers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Plan } from './plan.ts'
import { buildPlan, splitProbeKey } from './plan.ts'
import type { ResolvedConfig } from './config.ts'
import { resolveConfig } from './config.ts'
import type { Journal } from './journal.ts'
import {
  buildRevert,
  journalPath,
  mergeJournal,
  readJournal,
  writeJournal,
} from './journal.ts'
import { isFlatLadder, isPlainObject } from './ladder.ts'
import { validateKnowledgeTable } from './knowledge.ts'

/** Plugin instance id, matching this bundle's `cordis.patch.yml` entry. */
export const name = 'reasoning-tiers'

/** Services this plugin needs: the settings seam it writes and the model seam it reads. */
export const inject = ['settings', 'llm']

/** The provider namespace whose model entries carry reasoning efforts. */
const PI_AI_NS = 'llm-pi-ai'

/** Where the deployment's default effort lives, read only to warn or to align. */
const DEFAULT_MODEL_NS = 'agent-default-model'

/** A named logger, as `ctx.logger(name)` hands back. */
type Logger = ReturnType<Context['logger']>

/**
 * Mount the plugin.
 * @param ctx - the Cordis context, with `settings` and `llm` injected.
 * @param raw - this bundle entry's `config:` block.
 */
export function apply(ctx: Context, raw: unknown = void 0): void {
  const logger = ctx.logger(name)
  const config = resolveConfig(raw)
  const table = validateKnowledgeTable()

  for (const problem of table) logger.warn(`built-in knowledge table is invalid: ${problem}`)
  for (const problem of config.problems) logger.warn(`configuration: ${problem}`)
  if (table.length > 0) logger.warn('the built-in table is broken; refusing to autofill — fix the plugin first')

  if (!config.autofill && !config.revert) {
    logger.info('disabled (autofill: false, revert: false) — nothing will be written')
    return
  }

  // One line at mount, because the only other evidence of a healthy pass is the
  // absence of a write: a user asking "is it running?" needs a log to point at.
  logger.info(
    `mounted: autofill=${String(config.autofill)} revert=${String(config.revert)} ` +
      `diagnose=${String(config.diagnose)} widenToGlobalEffort=${String(config.widenToGlobalEffort)} ` +
      `extraRules=${String(config.rules.length)}`,
  )

  const timers = new Set<NodeJS.Timeout>()
  const later = (delay: number, fn: () => void): void => {
    const handle = setTimeout(() => {
      timers.delete(handle)
      fn()
    }, delay)
    timers.add(handle)
  }
  ctx.effect(() => () => {
    for (const handle of timers) clearTimeout(handle)
    timers.clear()
  })

  let running = false
  let queued: NodeJS.Timeout | undefined

  /** Collapse a burst of settings events into one pass. */
  const schedule = (why: string): void => {
    if (queued !== void 0) clearTimeout(queued)
    const handle = setTimeout(() => {
      timers.delete(handle)
      queued = void 0
      void pass(why)
    }, config.debounceMs)
    queued = handle
    timers.add(handle)
  }

  const pass = async (why: string): Promise<void> => {
    if (running) return
    running = true
    try {
      if (config.revert) await revertOnce(ctx, config, logger, why)
      else await autofillOnce(ctx, config, logger, why, table.length > 0)
    } catch (error) {
      // A failed pass must never take the host down with it: the settings
      // document is still valid, and the next change retries.
      logger.warn(`pass (${why}) failed: ${errorMessage(error)}`)
    } finally {
      running = false
    }
  }

  // 0.2.0 renamed the document event: `settings/document-updated` announces the
  // raw section moving as `(ns, revision)`, while 0.1.x's `settings/updated`
  // carried the resolved value as `(ns, next, prev, source)`. Both name the
  // namespace first, which is all this listener reads, so both are registered:
  // a host emits exactly one of them, and an event with no emitter is inert.
  const onSettingsChanged = (ns: unknown): void => {
    if (String(ns) !== PI_AI_NS) return
    // Guard against self-excitation: our own write lands while `running` is
    // still set, and a pass with nothing left to write emits nothing anyway.
    if (running) return
    schedule('settings')
  }
  ctx.on('settings/document-updated', (ns) => {
    onSettingsChanged(ns)
  })
  ;(ctx as unknown as { on(name: string, listener: (ns: unknown) => void): unknown }).on(
    'settings/updated',
    onSettingsChanged,
  )

  /** Wait for the provider namespace to register, then run the boot pass. */
  const boot = (index: number): void => {
    if (readLayer(ctx) !== undefined) {
      void pass('boot')
      return
    }
    const delays = config.bootRetryDelaysMs
    if (index >= delays.length) {
      logger.warn(`"${PI_AI_NS}" never registered after ${String(delays.length)} retries; nothing to do`)
      return
    }
    later(delays[index] ?? 0, () => boot(index + 1))
  }
  boot(0)
}

/**
 * Read the raw **user** layer for the provider namespace.
 *
 * `redactSecrets` is left off because a rebuilt `models` array must reproduce
 * every field the user configured, and a redacted view would silently delete a
 * secret slot the wire never returned. This is a same-process Host read, which
 * is exactly the case that verbatim view exists for; nothing here logs a value.
 *
 * @returns the layer plus its revision, or `undefined` while unregistered.
 */
function readLayer(ctx: Context): { section: Record<string, unknown> | undefined; revision: number } | undefined {
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === PI_AI_NS)
  if (descriptor === void 0) return void 0
  return {
    section: isPlainObject(descriptor.user) ? descriptor.user : void 0,
    revision: descriptor.revision,
  }
}

/** The effort the deployment asks for by default, when one is configured. */
function globalEffort(ctx: Context): string | undefined {
  // 0.1.x hosts answered a namespace's resolved section through `get(ns)`;
  // 0.2.0 dropped it and the resolved value rides the `describe()` descriptor.
  const service = ctx.settings as Context['settings'] & { get?: (ns: string) => unknown }
  const value =
    typeof service.get === 'function'
      ? service.get(DEFAULT_MODEL_NS)
      : ctx.settings.describe().find((entry) => entry.ns === DEFAULT_MODEL_NS)?.value
  if (!isPlainObject(value)) return undefined
  const effort = value.reasoningEffort
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined
}

/** Ask the live model seam which tiers this exact route offers today. */
async function tiers(ctx: Context, route: string, model: string): Promise<readonly string[]> {
  try {
    const info: LlmResolvedModelInfo = await ctx.llm.resolveModelInfo(route, model)
    return (info.reasoning?.efforts ?? []).map((effort) => String(effort.id))
  } catch {
    return []
  }
}

/** The model ids one route advertises, for a catalog route the user did not list. */
async function catalogModelIds(ctx: Context, route: string): Promise<string[]> {
  try {
    return (await ctx.llm.listModels(route)).map((model: { id: string }) => model.id)
  } catch {
    return []
  }
}

/** Model ids for routes whose catalog comes from pi-ai rather than the user. */
async function gatherCatalog(ctx: Context, section: Record<string, unknown> | undefined) {
  const catalogModels: Record<string, readonly string[]> = {}
  const providers = isPlainObject(section) ? section.providers : void 0
  if (!isPlainObject(providers)) return catalogModels
  for (const [route, profile] of Object.entries(providers)) {
    if (!isPlainObject(profile) || Array.isArray(profile.models)) continue
    const ids = await catalogModelIds(ctx, route)
    if (ids.length > 0) catalogModels[route] = ids
  }
  return catalogModels
}

/** Compute one pass's plan, reading everything it needs from the Host. */
async function planPass(ctx: Context, config: ResolvedConfig): Promise<{ plan: Plan; revision: number } | undefined> {
  const layer = readLayer(ctx)
  if (layer === undefined) return void 0
  const catalogModels = await gatherCatalog(ctx, layer.section)
  const plan = await buildPlan(
    layer.section,
    {
      rules: config.rules,
      respectExisting: config.respectExisting,
      compatAutofill: config.compatAutofill,
      excludeProviders: config.excludeProviders,
      excludeModels: config.excludeModels,
      alignGlobalEffort: config.alignGlobalEffort,
      diagnose: config.diagnose,
      widenToGlobalEffort: config.widenToGlobalEffort,
      ...(config.alignGlobalEffort || config.widenToGlobalEffort ? { globalEffort: globalEffort(ctx) } : {}),
      maxProbes: config.maxProbes,
      catalogModels,
    },
    { tiers: (route, model) => tiers(ctx, route, model) },
  )
  return { plan, revision: layer.revision }
}

/** One autofill pass: plan, write, record, report. */
async function autofillOnce(
  ctx: Context,
  config: ResolvedConfig,
  logger: Logger,
  why: string,
  tableBroken: boolean,
): Promise<void> {
  if (tableBroken) return
  const outcome = await planPass(ctx, config)
  if (outcome === undefined) return
  const { plan, revision } = outcome

  report(logger, plan, why)
  if (config.diagnose) reportTierAudit(ctx, plan, logger)
  if (Object.keys(plan.patch).length === 0) return

  const path = journalPath()
  const journal = await readJournal(path)
  if (!(await commit(ctx, config, plan.patch, revision, logger, 0))) return
  await writeJournal(path, mergeJournal(journal, plan.writes))
  logger.info(`ledger updated at ${path}`)
}

/**
 * Write one patch, refusing to leave a partial edit behind.
 * @returns whether the settings document now carries the patch.
 */
async function commit(
  ctx: Context,
  config: ResolvedConfig,
  patch: Record<string, unknown>,
  revision: number,
  logger: Logger,
  depth: number,
): Promise<boolean> {
  try {
    await ctx.settings.update(PI_AI_NS, patch, revision)
    return true
  } catch (error) {
    const message = errorMessage(error)
    if (isConflict(error) && depth < 1) {
      // The user wrote while this pass was running: recompute against their
      // document rather than overwrite it with a stale one.
      logger.info('settings moved mid-pass; recomputing once')
      const again = await planPass(ctx, config)
      if (again === undefined || Object.keys(again.plan.patch).length === 0) return false
      return commit(ctx, config, again.plan.patch, again.revision, logger, depth + 1)
    }
    if (depth < 1 && config.compatAutofill) {
      // The provider refuses a compat switch its model's protocol does not
      // take. Retry with ladders only: the tier list is what restores the
      // control, and a rejected dialect guess should not cost it.
      logger.warn(`write refused (${message}); retrying without compat switches`)
      return commit(
        ctx,
        { ...config, compatAutofill: false },
        stripCompat(patch),
        revision,
        logger,
        depth + 1,
      )
    }
    logger.error(`settings write refused, nothing was changed: ${message}`)
    return false
  }
}

/** Remove every route-level `compat` block from a patch. */
function stripCompat(patch: Record<string, unknown>): Record<string, unknown> {
  const providers = isPlainObject(patch.providers) ? patch.providers : void 0
  if (providers === undefined) return {}
  const next: Record<string, unknown> = {}
  for (const [route, value] of Object.entries(providers)) {
    if (!isPlainObject(value)) continue
    const { compat: _removed, ...kept } = value
    next[route] = kept
  }
  return { providers: next }
}

/**
 * Report what each configured model can actually do, and say out loud what
 * today leaves silent.
 *
 * Three failures are invisible in the stock UI. A configured default effort that
 * no longer names a selectable tier fails mid-turn with
 * `UNSUPPORTED_REASONING_EFFORT` (`dsh-llm-pi-ai/lib/index.js:1708`); a
 * *flat* ladder — several tiers offered, all of them dispatching the same
 * request — shows a control that appears to do nothing; and a model outside the
 * catalog offers no tier at all. All three are named here, so the next
 * troubleshooting pass starts from a log line instead of a guess.
 *
 * A flat ladder is reported, never rewritten: declaring `reasoningEfforts`
 * replaces the inherited capability but cannot change the request bytes while
 * the route's compat still withholds the effort string
 * (`pi-ai/dist/api/openai-completions.js:645-653`), so an automatic rewrite
 * would only trade three honest-looking tiers for four misleading ones.
 *
 * @param ctx - the plugin context.
 * @param plan - the pass that just ran.
 * @param logger - this plugin's logger.
 */
function reportTierAudit(ctx: Context, plan: Plan, logger: Logger): void {
  if (plan.checked.size === 0) return
  const effort = globalEffort(ctx)
  for (const [key, offered] of plan.checked) {
    const parts = splitProbeKey(key)
    if (parts === undefined) continue
    const [route, model] = parts
    const written = plan.writes.find((write) => write.route === route && write.model === model)
    const tiers = (written === undefined ? offered : Object.keys(written.ladder)).filter((tier) => tier !== 'off')
    if (written === undefined) logger.debug(`${route}/${model} offers: ${tiers.join(', ') || 'nothing'}`)
    if (written === undefined && isFlatLadder(offered))
      logger.warn(
        `${route}/${model} has a flat ladder (${tiers.join(', ')}): every non-"off" choice sends the same request, ` +
          'so the thinking-intensity control cannot change anything. Give the model its own reasoningEfforts and a ' +
          'route compat that admits the effort string if the endpoint really accepts one.',
      )
    if (effort === undefined) continue
    if (tiers.includes(effort) || (written === undefined && offered.includes('off') && tiers.length === 0)) continue
    if (tiers.length === 0) {
      logger.warn(`${route}/${model} offers no thinking tier at all, but ${DEFAULT_MODEL_NS} asks for "${effort}"`)
      continue
    }
    if (!tiers.includes(effort))
      logger.warn(
        `${route}/${model} has no "${effort}" tier (${DEFAULT_MODEL_NS}); available: ${tiers.join(', ')}`,
      )
  }
}

/** One revert pass: undo exactly what the ledger says this plugin wrote. */
async function revertOnce(ctx: Context, config: ResolvedConfig, logger: Logger, why: string): Promise<void> {
  const path = journalPath()
  const journal: Journal = await readJournal(path)
  if (journal.ladders.length === 0 && journal.compat.length === 0) {
    logger.info(`${why}: revert requested but the ledger is empty`)
    return
  }
  const layer = readLayer(ctx)
  if (layer === undefined) return
  const plan = buildRevert(layer.section, journal)
  for (const entry of plan.left) logger.info(`left ${entry.route}/${entry.model} in place (${entry.reason})`)

  const quiet: ResolvedConfig = { ...config, compatAutofill: false }
  if (Object.keys(plan.patch).length > 0)
    await commit(ctx, quiet, plan.patch, layer.revision, logger, 0)
  if (plan.ops.length > 0) await mutate(ctx, plan.ops, logger)

  await writeJournal(path, plan.remaining)
  if (plan.remaining.ladders.length === 0 && plan.remaining.compat.length === 0)
    logger.info('revert complete; ledger cleared')
}

/** Apply path-addressed unsets; a merge alone cannot delete a dict key. */
async function mutate(ctx: Context, ops: readonly SettingsPathOp[], logger: Logger): Promise<void> {
  const layer = readLayer(ctx)
  if (layer === undefined) return
  try {
    await ctx.settings.mutate(PI_AI_NS, ops, layer.revision)
  } catch (error) {
    logger.error(`revert write refused: ${errorMessage(error)}`)
  }
}

/** Log one pass: what changed, and what was left alone for which reason. */
function report(logger: Logger, plan: Plan, why: string): void {
  if (plan.writes.length === 0 && plan.skips.length === 0) return
  if (plan.writes.length > 0) {
    const lines = plan.writes.map(
      (write) =>
        `${write.route}/${write.model} [${Object.keys(write.ladder).join(' ')}] via ${write.source} (${write.confidence})`,
    )
    logger.info(`${why}: declared reasoning tiers for ${String(lines.length)} model(s):\n  ${lines.join('\n  ')}`)
  }
  const byReason = new Map<string, number>()
  for (const skip of plan.skips) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1)
  const summary = [...byReason.entries()].map(([reason, count]) => `${reason}=${String(count)}`).join(', ')
  logger.debug(`${why}: left ${String(plan.skips.length)} model(s) alone: ${summary}`)
  for (const skip of plan.skips)
    if (skip.detail !== undefined) logger.debug(`  skip ${skip.route}/${skip.model}: ${skip.reason} — ${skip.detail}`)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}

export default { apply, inject, name }
