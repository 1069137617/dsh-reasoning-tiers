/**
 * Wiring: `apply()` against a fake Cordis context.
 *
 * Everything else in this suite tests a pure function. This file is the only
 * place the seams are exercised — `settings.describe/get/update/mutate`, the
 * live model probe, the boot retry, and the on-disk ledger — so a broken
 * integration fails here instead of in the user's profile.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Deep-merge a settings patch the way `mergeLayers` does for plain objects. */
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merge(current, value)
      continue
    }
    target[key] = value
  }
}

/**
 * A fake Host: one settings namespace, one model probe, recorded log lines.
 * @param user - the raw `llm-pi-ai` user layer, mutated by `update`.
 * @param tiers - offered effort ids per `route/model`.
 * @param globalEffort - the deployment's `agent-default-model.reasoningEffort`.
 */
function fakeHost(user, tiers, globalEffort) {
  const state = { user, revision: 1 }
  const log = { info: [], warn: [], debug: [], error: [] }
  const probes = []
  const updates = []
  const context = {
    logger: () => ({
      info: (message) => log.info.push(message),
      warn: (message) => log.warn.push(message),
      debug: (message) => log.debug.push(message),
      error: (message) => log.error.push(message),
    }),
    effect: () => () => {},
    on: () => () => {},
    settings: {
      describe: () => [state],
      get: (ns) => (ns === 'agent-default-model' ? { reasoningEffort: globalEffort } : undefined),
      update: async (_ns, patch) => {
        updates.push(patch)
        merge(state.user, patch)
        state.revision += 1
      },
      mutate: async (_ns, ops) => {
        updates.push({ ops })
      },
    },
    llm: {
      resolveModelInfo: async (route, model) => {
        probes.push(`${route}/${model}`)
        const offered = tiers[`${route}/${model}`] ?? []
        return { provider: route, id: model, name: model, reasoning: { efforts: offered.map((id) => ({ id, name: id })) } }
      },
    },
  }
  // The ns entry carries both the layer and its revision, as the real
  // descriptor does.
  Object.defineProperty(state, 'ns', { value: 'llm-pi-ai', enumerable: false })
  return { context, state, log, probes, updates }
}

/** Poll until a condition holds, so a test never depends on a bare tick. */
async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Run one `apply` with `DSH_HOME` pointed at a throwaway directory. */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'reasoning-tiers-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('the plugin names itself and declares the two seams it needs', () => {
  assert.equal(name, 'reasoning-tiers')
  assert.deepEqual(inject, ['settings', 'llm'])
})

test('a boot pass declares tiers, writes the ledger, and then stays quiet', async () => {
  await withHome(async (home) => {
    const user = {
      providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.6-flash', name: 'Qwen3.6 Flash' }] } },
    }
    const { context, state, log, updates } = fakeHost(user, { 'acme/qwen3.6-flash': [] }, 'high')

    apply(context, { debounceMs: 0 })
    await until(() => updates.length > 0, 'the first write')
    await until(() => log.info.some((line) => line.includes('ledger updated')), 'the ledger note')

    const written = state.user.providers.acme.models[0]
    assert.deepEqual(Object.keys(written.reasoningEfforts), ['off', 'low', 'medium', 'high', 'xhigh'])
    assert.equal(written.name, 'Qwen3.6 Flash', 'no configured field is lost')
    assert.deepEqual(state.user.providers.acme.compat, { thinkingFormat: 'qwen' })

    const journal = JSON.parse(await readFile(join(home, 'dsh-reasoning-tiers', 'journal.json'), 'utf8'))
    assert.equal(journal.version, 1)
    assert.deepEqual(journal.ladders.map((entry) => `${entry.route}/${entry.model}`), ['acme/qwen3.6-flash'])

    // Second pass: the model now offers a tier, so the plugin must not write.
    apply(context, { debounceMs: 0 })
    await until(() => log.debug.length > 0, 'the second pass report')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(updates.length, 1, 'a settled configuration is never rewritten')
  })
})

test('the audit names a model that cannot reach the deployment default', async () => {
  await withHome(async () => {
    const user = {
      providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.8-flash' }] } },
    }
    const { context, log } = fakeHost(user, { 'acme/qwen3.8-flash': ['off', 'low', 'medium', 'xhigh'] }, 'high')

    apply(context, { debounceMs: 0 })
    await until(() => log.warn.length > 0, 'the audit warning')
    assert.match(log.warn.join('\n'), /acme\/qwen3\.8-flash has no "high" tier/)
    assert.match(log.warn.join('\n'), /available: low, medium, xhigh/)
  })
})

test('the audit names a flat ladder and writes nothing for it', async () => {
  await withHome(async () => {
    const user = {
      providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.6-flash' }] } },
    }
    const { context, log, updates } = fakeHost(
      user,
      { 'acme/qwen3.6-flash': ['off', 'minimal', 'low', 'medium', 'high'] },
      undefined,
    )

    apply(context, { debounceMs: 0 })
    await until(() => log.warn.length > 0, 'the flat-ladder warning')
    assert.match(log.warn.join('\n'), /acme\/qwen3\.6-flash has a flat ladder \(minimal, low, medium, high\)/)
    assert.match(log.warn.join('\n'), /every non-"off" choice sends the same request/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(updates.length, 0, 'a rewrite could not change the bytes, so none is made')
  })
})

test('a revert pass undoes what the ledger recorded and clears it', async () => {
  await withHome(async (home) => {
    const user = {
      providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.6-flash' }] } },
    }
    const { context, state, log, updates } = fakeHost(user, { 'acme/qwen3.6-flash': [] }, undefined)

    apply(context, { debounceMs: 0 })
    await until(() => updates.length > 0, 'the autofill write')
    await until(() => log.info.some((line) => line.includes('ledger updated')), 'the ledger note')
    assert.ok(state.user.providers.acme.models[0].reasoningEfforts, 'the ladder is in place')

    apply(context, { debounceMs: 0, revert: true })
    await until(() => log.info.some((line) => line.includes('ledger cleared')), 'the revert to finish')

    assert.equal(state.user.providers.acme.models[0].reasoningEfforts, undefined, 'the ladder is gone')
    const journal = JSON.parse(await readFile(join(home, 'dsh-reasoning-tiers', 'journal.json'), 'utf8'))
    assert.deepEqual(journal.ladders, [])
  })
})

test('a rejected extra rule is reported without poisoning the built-in table', async () => {
  await withHome(async () => {
    const user = { providers: { acme: { api: 'openai-completions', models: [{ id: 'qwen3.6-flash' }] } } }
    const { context, state, log, updates } = fakeHost(user, { 'acme/qwen3.6-flash': [] }, undefined)

    apply(context, { debounceMs: 0, extraRules: [{ pattern: '^acme$', ladder: { off: null } }] })
    await until(() => updates.length > 0, 'the write the built-in table still makes')

    assert.match(log.warn.join('\n'), /extraRules\[0\]: ladder offers no level beyond "off"/, 'the reason is named')
    assert.deepEqual(
      Object.keys(state.user.providers.acme.models[0].reasoningEfforts),
      ['off', 'low', 'medium', 'high', 'xhigh'],
      'the built-in entry wrote the ladder, not the rejected rule',
    )
  })
})
