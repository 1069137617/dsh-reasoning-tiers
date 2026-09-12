/**
 * Dry run: apply the plugin's own decision procedure to the real
 * `~/.dsh/settings.yaml`, without a Host and without writing anything.
 *
 * The effective capability of each configured model is computed exactly the way
 * the installed stack computes it, so this is evidence about the user's actual
 * configuration rather than a fixture:
 *
 *   - `dsh-llm-pi-ai` `resolveModelReasoning` (lib/index.js:562-585): an entry
 *     with no `reasoningEfforts` inherits the installed catalog model of the
 *     same id, and a hand-declared id with no catalog entry gets `reasoning: false`;
 *   - pi-ai `getSupportedThinkingLevels` (dist/models.js:551-560): a `null` map
 *     value means unsupported, and `xhigh`/`max` additionally require a
 *     non-undefined spelling;
 *   - pi-ai `openai-completions` dispatch (dist/api/openai-completions.js:646):
 *     under `thinkingFormat: "qwen"` the request carries
 *     `enable_thinking = !!reasoningEffort`, so a level only means something on
 *     top of that when `supportsReasoningEffort` is set.
 *
 * Usage: node scripts/dry-run.mjs [--widen] [settings-path]
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { load as parseYaml } from 'js-yaml'
import { isFlatLadder } from '../lib/ladder.js'
import { buildPlan } from '../lib/plan.js'
import { validateLadder } from '../lib/ladder.js'

const EXTENDED = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** pi-ai's own filter, transcribed. */
function supportedLevels(model) {
  if (!model.reasoning) return ['off']
  return EXTENDED.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** The tiers one configured entry actually has today. */
function effectiveTiers(entry, catalogModels) {
  if (entry === undefined) return []
  if (entry.reasoningEfforts === false) return []
  if (entry.reasoningEfforts !== undefined) {
    const declared = entry.reasoningEfforts
    return EXTENDED.filter((level) => {
      const wire = declared[level]
      if (wire === undefined || wire === null) return level === 'off'
      return true
    })
  }
  const base = catalogModels.get(entry.id)
  if (base === undefined) return []
  return supportedLevels(base).filter((level) => level !== 'off')
}

/** The tiers one configured entry actually has today, `off` included. */
function offeredIncludingOff(entry, catalogModels) {
  if (entry === undefined) return []
  if (entry.reasoningEfforts === false) return ['off']
  if (entry.reasoningEfforts !== undefined) {
    const declared = entry.reasoningEfforts
    return EXTENDED.filter((level) => level === 'off' || (declared[level] !== undefined && declared[level] !== null))
  }
  const base = catalogModels.get(entry.id)
  if (base === undefined) return []
  return supportedLevels(base)
}

/** Whether one catalog entry's non-off levels all dispatch the same bytes. */
function isFlatCatalogEntry(model) {
  if (!model.reasoning) return false
  const map = model.thinkingLevelMap
  const live = supportedLevels(model).filter((level) => level !== 'off')
  if (live.length < 2) return false
  if (map === undefined || Object.keys(map).length === 0) return model.compat?.supportsReasoningEffort !== true
  const spellings = new Set(live.map((level) => map[level]))
  return spellings.size <= 1
}

async function main() {
  const argv = process.argv.slice(2)
  const widen = argv.includes('--widen')
  const settingsPath = argv.find((arg) => !arg.startsWith('--')) ?? join(homedir(), '.dsh', 'settings.yaml')
  const document = parseYaml(await readFile(settingsPath, 'utf8'))
  const section = document?.['llm-pi-ai']
  if (section === undefined) {
    console.log(`no "llm-pi-ai" section in ${settingsPath}`)
    return
  }
  const globalEffort = document?.['agent-default-model']?.reasoningEffort

  const catalogDir = join(
    homedir(),
    '.dsh',
    'profiles',
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
  )

  const rows = []
  for (const [route, profile] of Object.entries(section.providers ?? {})) {
    let catalogModels = new Map()
    try {
      const data = JSON.parse(await readFile(join(catalogDir, `${route}.json`), 'utf8'))
      for (const byApi of Object.values(data)) for (const [id, model] of Object.entries(byApi)) catalogModels.set(id, model)
    } catch {
      catalogModels = new Map()
    }
    profile.__catalog = catalogModels
    for (const entry of Array.isArray(profile.models) ? profile.models : []) {
      const base = catalogModels.get(entry.id)
      rows.push({
        route,
        model: entry.id,
        inPiAiCatalog: base !== undefined,
        tiersToday: effectiveTiers(entry, catalogModels),
        flat: base !== undefined && isFlatCatalogEntry(base),
        // What the plugin can see at runtime: the offered set alone.
        flatByFingerprint: isFlatLadder(offeredIncludingOff(entry, catalogModels)),
        format: base?.compat?.thinkingFormat ?? '(none)',
        acceptsEffort: base?.compat?.supportsReasoningEffort ?? false,
      })
    }
  }

  console.log(`=== ${settingsPath} ===`)
  console.log(`agent-default-model.reasoningEffort = ${String(globalEffort)}\n`)
  for (const row of rows) {
    const marks = []
    if (row.flat) marks.push('FLAT: tiers send identical bytes')
    if (row.flat !== row.flatByFingerprint) marks.push('fingerprint disagrees with the catalog')
    if (globalEffort !== undefined && !row.tiersToday.includes(globalEffort)) marks.push(`no "${globalEffort}" tier`)
    const state = row.tiersToday.length === 0
      ? row.inPiAiCatalog ? 'catalog declares no tier' : 'not in the pi-ai catalog'
      : row.tiersToday.join(', ')
    console.log(`  ${row.route}/${row.model}: ${state}  [dialect ${row.format}, reasoning_effort ${row.acceptsEffort ? 'yes' : 'no'}]${marks.length > 0 ? `\n      ⚠ ${marks.join('; ')}` : ''}`)
  }

  const tierReader = {
    tiers: async (route, model) => {
      const profile = section.providers?.[route]
      const entry = (profile?.models ?? []).find((candidate) => candidate.id === model)
      return effectiveTiers(entry, profile?.__catalog ?? new Map())
    },
  }

  const planOpts = {
    rules: [],
    respectExisting: true,
    compatAutofill: true,
    excludeProviders: [],
    excludeModels: [],
    alignGlobalEffort: false,
    diagnose: true,
    widenToGlobalEffort: widen,
    ...(globalEffort === undefined ? {} : { globalEffort }),
    maxProbes: 500,
  }

  console.log(`\n=== what the plugin would write (widenToGlobalEffort=${String(widen)}) ===\n`)
  const outcome = await buildPlan(section, planOpts, tierReader)
  if (outcome.writes.length === 0) console.log('  (nothing)')
  for (const write of outcome.writes) {
    const problems = validateLadder(write.ladder, `${write.route}/${write.model}`)
    console.log(
      `  + ${write.route}/${write.model}: [${Object.keys(write.ladder).join(' ')}] via ${write.source} (${write.confidence})${problems.length > 0 ? `  ⚠ ${problems.join('; ')}` : ''}`,
    )
    if (write.dialect !== undefined) console.log(`      route compat += ${JSON.stringify(write.dialect)}`)
  }

  const byReason = new Map()
  for (const skip of outcome.skips) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1)
  console.log(`\n=== left alone (${String(outcome.skips.length)}): ${[...byReason.entries()].map(([k, v]) => `${k}=${String(v)}`).join(', ')} ===`)
  for (const skip of outcome.skips.filter((entry) => entry.reason !== 'existing-capability'))
    console.log(`  - ${skip.route}/${skip.model}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ''}`)

  // Prove idempotence against the post-write document.
  const after = structuredClone(section)
  for (const [route, profile] of Object.entries(outcome.patch.providers ?? {})) {
    if (Array.isArray(profile.models)) after.providers[route].models = profile.models
    if (profile.compat !== undefined) after.providers[route].compat = { ...(after.providers[route].compat ?? {}), ...profile.compat }
  }
  const afterTiers = new Map(outcome.writes.map((write) => [`${write.route}/${write.model}`, Object.keys(write.ladder).filter((level) => level !== 'off')]))
  const second = await buildPlan(after, planOpts, {
    tiers: async (route, model) => afterTiers.get(`${route}/${model}`) ?? tierReader.tiers(route, model),
  })
  console.log(`\nidempotence: second pass writes ${String(second.writes.length)} model(s) — ${second.writes.length === 0 ? 'OK' : 'FAIL'}`)
  console.log(`probe calls: ${String(outcome.probes)}`)
}

await main()
