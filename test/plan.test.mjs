/**
 * The write plan: what gets declared, what is deliberately left alone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildPlan,
  globMatch,
  probeKey,
  splitProbeKey,
  widenExisting,
  withGlobalEffort,
} from '../lib/plan.js'

const BASE = {
  rules: [],
  respectExisting: true,
  compatAutofill: true,
  excludeProviders: [],
  excludeModels: [],
  alignGlobalEffort: false,
  maxProbes: 200,
}

/** A plan context where nothing offers a tier yet. */
const noneOffered = { tiers: async () => [] }

/** A plan context that reports the given tiers per `route/model`. */
function withTiers(map) {
  return {
    tiers: async (route, model) => map[`${route}\u0000${model}`] ?? [],
  }
}

test('a tier-less model gets a ladder and the route its dialect', async () => {
  const section = {
    providers: {
      'my-gateway': {
        api: 'openai-completions',
        baseURL: 'https://gateway.example/v1',
        models: [{ id: 'mystery-9000', contextWindow: 100000, maxTokens: 4096 }],
      },
    },
  }
  const plan = await buildPlan(section, BASE, noneOffered)
  const profile = plan.patch.providers['my-gateway']
  assert.equal(profile.models.length, 1)
  assert.deepEqual(Object.keys(profile.models[0]).sort(), ['contextWindow', 'id', 'maxTokens', 'reasoningEfforts'])
  assert.equal(profile.models[0].reasoningEfforts.high, 'high')
  assert.deepEqual(profile.compat, { thinkingFormat: 'openai', supportsReasoningEffort: true })
  assert.equal(plan.writes.length, 1)
  assert.equal(plan.writes[0].confidence, 'low', 'a generic ladder is labelled low confidence')
})

test('a model that already offers a tier is never rewritten', async () => {
  const section = {
    providers: {
      acme: {
        api: 'openai-completions',
        models: [{ id: 'deepseek-v4-pro', contextWindow: 1000, maxTokens: 10 }],
      },
    },
  }
  const plan = await buildPlan(section, BASE, withTiers({ 'acme\u0000deepseek-v4-pro': ['high', 'max'] }))
  assert.deepEqual(plan.patch, {})
  assert.deepEqual(plan.skips.map((s) => s.reason), ['existing-capability'])
})

test('a user-declared ladder wins even when it disables reasoning', async () => {
  const section = {
    providers: {
      acme: {
        api: 'openai-completions',
        models: [{ id: 'qwen3.9-plus', reasoningEfforts: false }, { id: 'qwen3.9-max', reasoningEfforts: { high: 'h' } }],
      },
    },
  }
  const plan = await buildPlan(section, BASE, noneOffered)
  assert.deepEqual(plan.patch, {}, 'nothing is written over an explicit declaration')
  assert.deepEqual(plan.skips.map((s) => s.reason), ['user-declared', 'user-declared'])
})

test('a rebuilt models array preserves every other configured field', async () => {
  const entry = {
    id: 'qwen3.9-plus',
    name: 'Qwen 3.9 Plus',
    contextWindow: 1000000,
    maxTokens: 131072,
    input: ['text', 'image'],
    compat: { thinkingFormat: 'zai' },
  }
  const section = { providers: { acme: { api: 'openai-completions', models: [entry, { id: 'deepseek-v4-pro' }] } } }
  // The second row already offers tiers from the provider's own catalog, so it
  // must come back byte-for-byte while the first one is widened.
  const plan = await buildPlan(section, BASE, withTiers({ 'acme\u0000deepseek-v4-pro': ['high', 'max'] }))
  const [first, second] = plan.patch.providers.acme.models
  assert.deepEqual(
    { ...first, reasoningEfforts: undefined },
    { ...entry, reasoningEfforts: undefined },
    'the original entry survives untouched',
  )
  assert.equal(first.compat.thinkingFormat, 'zai', 'a model-level dialect the user set is kept')
  assert.deepEqual(second, { id: 'deepseek-v4-pro' }, 'an untouched entry rides along verbatim')
  assert.notEqual(plan.patch.providers.acme.compat, undefined, 'route dialect is added beside the models')
})

test('route-level dialect never overwrites a field the user already set', async () => {
  const section = {
    providers: {
      acme: {
        api: 'openai-completions',
        compat: { supportsReasoningEffort: false },
        models: [{ id: 'mystery-9000' }],
      },
    },
  }
  const plan = await buildPlan(section, BASE, noneOffered)
  assert.deepEqual(plan.patch.providers.acme.compat, { thinkingFormat: 'openai' })
})

test('a catalog route is corrected through modelOverrides, never a new models list', async () => {
  const section = {
    providers: {
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', modelOverrides: { 'deepseek-r1': { maxTokens: 64 } } },
    },
  }
  const plan = await buildPlan(
    section,
    { ...BASE, catalogModels: { deepseek: ['deepseek-v4-pro', 'deepseek-r1', 'brand-new-x'] } },
    noneOffered,
  )
  const profile = plan.patch.providers.deepseek
  assert.equal(profile.models, undefined, 'the catalog stays untouched')
  assert.deepEqual(Object.keys(profile.modelOverrides).sort(), ['deepseek-r1', 'deepseek-v4-pro'])
  assert.equal(profile.modelOverrides['deepseek-r1'].maxTokens, 64, 'the user override survives')
  assert.equal(profile.modelOverrides['deepseek-r1'].reasoningEfforts.high, 'high')
  assert.equal(
    plan.skips.find((skip) => skip.model === 'brand-new-x')?.reason,
    'no-suggestion',
    'a catalog route gets no generic ladder',
  )
})

test('a catalog route gets no generic protocol ladder', async () => {
  const section = { providers: { somevendor: { apiKeyEnv: 'K' } } }
  const plan = await buildPlan(
    section,
    { ...BASE, catalogModels: { somevendor: ['brand-new-model-x'] } },
    noneOffered,
  )
  assert.deepEqual(plan.patch, {})
  assert.deepEqual(plan.skips.map((s) => s.reason), ['no-suggestion'])
})

test('a second pass writes nothing', async () => {
  const section = {
    providers: { acme: { api: 'openai-completions', models: [{ id: 'mystery-9000' }] } },
  }
  const first = await buildPlan(section, BASE, noneOffered)
  assert.ok(Object.keys(first.patch).length > 0)

  // Simulate the committed document, then re-plan against the live capability
  // the provider would now report for that same model.
  const written = first.patch.providers.acme.models
  const after = { providers: { acme: { api: 'openai-completions', models: written } } }
  const tiers = Object.keys(written[0].reasoningEfforts).filter((level) => level !== 'off')
  const second = await buildPlan(after, BASE, withTiers({ 'acme\u0000mystery-9000': tiers }))
  assert.deepEqual(second.patch, {}, 'the pass is idempotent')
})

test('exclusions are honoured', async () => {
  const section = {
    providers: {
      acme: { api: 'openai-completions', models: [{ id: 'qwen3.9-plus' }] },
      other: { api: 'openai-completions', models: [{ id: 'mystery-9000' }] },
    },
  }
  const plan = await buildPlan(
    section,
    { ...BASE, excludeProviders: ['acme'], excludeModels: ['mystery-*'] },
    noneOffered,
  )
  assert.deepEqual(plan.patch, {})
  assert.deepEqual(plan.skips.map((s) => s.reason).sort(), ['excluded-model', 'excluded-provider'])
})

test('malformed input is reported, never half-applied', async () => {
  assert.deepEqual((await buildPlan('nope', BASE, noneOffered)).patch, {})
  assert.deepEqual((await buildPlan({}, BASE, noneOffered)).patch, {})
  const bad = await buildPlan({ providers: 'nope' }, BASE, noneOffered)
  assert.deepEqual(bad.skips.map((s) => s.reason), ['malformed'])
  assert.deepEqual(bad.patch, {})
})

test('a malformed provider profile is skipped while its siblings still get a ladder', async () => {
  const section = {
    providers: {
      broken: 'not-an-object',
      good: { api: 'openai-completions', models: [{ id: 'mystery-9000' }] },
    },
  }
  const plan = await buildPlan(section, BASE, noneOffered)
  assert.equal(plan.patch.providers.broken, undefined)
  assert.ok(plan.patch.providers.good.models.length === 1)
  assert.deepEqual(plan.skips.map((s) => s.reason), ['malformed'])
})

test('the probe budget stops a runaway scan without corrupting the plan', async () => {
  const models = Array.from({ length: 10 }, (_unused, index) => ({ id: `mystery-${String(index)}` }))
  const section = { providers: { acme: { api: 'openai-completions', models } } }
  const plan = await buildPlan(section, { ...BASE, maxProbes: 3 }, noneOffered)
  assert.equal(plan.probes, 3)
  assert.equal(plan.writes.length, 3)
  assert.equal(plan.patch.providers.acme.models.length, 10, 'every original entry still ships')
  assert.equal(plan.skips.filter((s) => s.reason === 'probe-limit').length, 7)
})

test('a non-object entry in the models list rides through untouched', async () => {
  const plan = await buildPlan(
    { providers: { acme: { api: 'openai-completions', models: ['just-a-string', { id: 'mystery-9000' }] } } },
    BASE,
    noneOffered,
  )
  const models = plan.patch.providers.acme.models
  assert.equal(models[0], 'just-a-string', 'a malformed row is not deleted by our edit')
  assert.ok(models[1].reasoningEfforts, 'the valid row still gets its ladder')
})

test('glob matching reads the way model ids look', () => {
  assert.ok(globMatch('*embed*', 'text-embedding-v3'))
  assert.ok(globMatch('qwen3.6-*', 'Qwen3.6-Flash'))
  assert.ok(!globMatch('qwen3.6-*', 'qwen3.8-flash'))
  assert.ok(globMatch('glm-?', 'glm-5'))
  assert.ok(!globMatch('glm-?', 'glm-5.2'))
})

test('aligning the global effort only widens a passthrough dialect', () => {
  const ladder = { off: null, low: 'low', high: 'high' }
  assert.deepEqual(
    Object.keys(withGlobalEffort(ladder, { thinkingFormat: 'openai' }, 'xhigh')),
    ['off', 'low', 'high', 'xhigh'],
  )
  assert.deepEqual(
    withGlobalEffort(ladder, { thinkingFormat: 'qwen' }, 'xhigh'),
    ladder,
    'a vendor-specific spelling is never guessed',
  )
  assert.deepEqual(withGlobalEffort(ladder, undefined, undefined), ladder)
})

test('probe keys round-trip and cannot collide', () => {
  assert.deepEqual(splitProbeKey(probeKey('acme', 'qwen3.9-plus')), ['acme', 'qwen3.9-plus'])
  assert.notEqual(probeKey('a\u0000', 'b'), probeKey('a', '\u0000b'))
  assert.equal(splitProbeKey('not-a-key'), undefined)
  assert.deepEqual(splitProbeKey(probeKey('', 'x')), ['', 'x'])
})

test('widening rebuilds the offered tiers and refuses an unknown one', () => {
  assert.deepEqual(widenExisting(['low', 'medium', 'high'], 'xhigh'), {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
  })
  assert.deepEqual(widenExisting(['off', 'high'], 'max'), { off: null, high: 'high', max: 'max' })
  assert.equal(widenExisting(['low', 'high'], 'ultra'), undefined, 'an invented level is refused')
  assert.equal(widenExisting(['low', 'mystery'], 'high'), undefined, 'an unknown offered tier is refused')
})

test('a curated entry never replaces a ladder the model already has', async () => {
  const section = {
    providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.6-flash' }] } },
  }
  const flat = withTiers({ 'acme\u0000qwen3.6-flash': ['off', 'minimal', 'low', 'medium', 'high'] })
  const plan = await buildPlan(section, BASE, flat)
  assert.deepEqual(plan.writes, [], 'a declared ladder cannot change the bytes, so it is never written')
  assert.deepEqual(plan.skips.map((skip) => skip.reason), ['existing-capability'])
  assert.deepEqual(plan.patch, {})
})

test('widenToGlobalEffort adds the deployment default to an existing ladder', async () => {
  const section = {
    providers: { acme: { api: 'openai-completions', models: [{ id: 'deepseek-v4-pro' }] } },
  }
  const offered = withTiers({ 'acme\u0000deepseek-v4-pro': ['high', 'max'] })

  assert.equal((await buildPlan(section, { ...BASE, globalEffort: 'xhigh' }, offered)).writes.length, 0)
  const widened = await buildPlan(section, { ...BASE, globalEffort: 'xhigh', widenToGlobalEffort: true }, offered)
  assert.deepEqual(widened.writes.map((write) => write.source), ['widen:xhigh'])
  assert.deepEqual(Object.keys(widened.patch.providers.acme.models[0].reasoningEfforts), [
    'high',
    'max',
    'xhigh',
  ])
})

test('a model that already offers the deployment default is still left alone', async () => {
  const section = {
    providers: { acme: { api: 'openai-completions', models: [{ id: 'deepseek-v4-pro' }] } },
  }
  const plan = await buildPlan(
    section,
    { ...BASE, globalEffort: 'high', widenToGlobalEffort: true },
    withTiers({ 'acme\u0000deepseek-v4-pro': ['high', 'max'] }),
  )
  assert.deepEqual(plan.writes, [])
  assert.deepEqual(plan.skips.map((skip) => skip.reason), ['existing-capability'])
})

test('a ladder the user declared is never probed when no audit reads the answer', async () => {
  const section = {
    providers: {
      acme: {
        api: 'openai-completions',
        models: [
          { id: 'qwen3.6-flash' },
          { id: 'qwen3.6-plus', reasoningEfforts: { off: null, high: 'high' } },
        ],
      },
    },
  }
  const offered = withTiers({
    'acme\u0000qwen3.6-flash': ['minimal', 'low', 'medium', 'high'],
    'acme\u0000qwen3.6-plus': ['low', 'high'],
  })

  const quiet = await buildPlan(section, { ...BASE, diagnose: false }, offered)
  assert.equal(quiet.probes, 1, 'only the model that could be written is probed')
  assert.deepEqual(quiet.skips.find((skip) => skip.model === 'qwen3.6-plus').reason, 'user-declared')

  const audited = await buildPlan(section, { ...BASE, diagnose: true }, offered)
  assert.equal(audited.probes, 2, 'the audit needs every ladder, including the ones it must not touch')
  assert.deepEqual(audited.checked.get(probeKey('acme', 'qwen3.6-plus')), ['low', 'high'])
  assert.deepEqual(audited.skips.filter((skip) => skip.model === 'qwen3.6-plus').length, 1)
})
