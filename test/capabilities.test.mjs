import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProviders, rebuildEntry, invalidField, buildMutateOps, draftsKey,
  isValidCountText, countValue, emptyOverrideRow,
} from '../lib/capabilities.js'

const RESOLVED = { providers: { 'qwen-cn': { apiKeyEnv: 'QWEN_KEY' }, 'openai': { apiKeyEnv: 'O' } } }
const USER = {
  providers: {
    'qwen-cn': { models: [
      { id: 'qwen3.8-flash', name: 'Flash', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 262144 },
      { id: 'qwen3.6-plus', input: ['text'], custom: 7 },
    ] },
  },
}

test('parse: declared models list carries raw entries and tri-state image', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(p.route, 'qwen-cn')
  assert.equal(p.hasModelsList, true)
  assert.equal(p.models.length, 2)
  assert.equal(p.models[0].id, 'qwen3.8-flash')
  assert.equal(p.models[0].contextText, '262144')
  assert.equal(p.models[0].image, 'inherit')
  assert.equal(p.models[1].image, 'off')
  assert.deepEqual(p.models[0].raw.reasoningEfforts, { off: null, high: 'high' })
})

test('parse: catalog route without user layer is empty and override-shaped', () => {
  const [openai] = parseProviders(RESOLVED, { providers: {} }).filter((p) => p.route === 'openai')
  assert.equal(openai.route, 'openai')
  assert.equal(openai.hasModelsList, false)
  assert.deepEqual(openai.models, [])
})

test('parse: modelOverrides rows take id from the dict key', () => {
  const [p] = parseProviders(RESOLVED, { providers: { openai: { modelOverrides: { 'gpt-5': { contextWindow: 400000 } } } } }).filter((p) => p.route === 'openai')
  assert.equal(p.hasModelsList, false)
  assert.equal(p.models[0].id, 'gpt-5')
  assert.equal(p.models[0].contextText, '400000')
})

test('parse: resolved absent falls back to user-layer routes; junk tolerated', () => {
  assert.deepEqual(parseProviders(undefined, USER).map(p => p.route), ['qwen-cn'])
  assert.deepEqual(parseProviders(null, null), [])
})

test('image tri-state mapping and count text', () => {
  assert.equal(isValidCountText(''), true)
  assert.equal(isValidCountText('131072'), true)
  assert.equal(isValidCountText('1.5'), false)
  assert.equal(isValidCountText('-3'), false)
  assert.equal(countValue(''), undefined)
  assert.equal(countValue('4096'), 4096)
  assert.equal(emptyOverrideRow().id, '')
})

test('rebuildEntry preserves unknown fields and applies set/delete semantics', () => {
  const [p] = parseProviders(RESOLVED, USER)
  const kept = { ...p.models[0], contextText: '131072', maxText: '32768', image: 'on' }
  const out = rebuildEntry(kept)
  assert.equal(out.contextWindow, 131072)
  assert.equal(out.maxTokens, 32768)
  assert.deepEqual(out.input, ['text', 'image'])
  assert.deepEqual(out.reasoningEfforts, { off: null, high: 'high' })
  assert.equal(out.name, 'Flash')
  const inherit = rebuildEntry({ ...p.models[0], contextText: '', maxText: '', image: 'inherit' })
  assert.ok(!('contextWindow' in inherit))
  assert.ok(!('maxTokens' in inherit))
  assert.ok(!('input' in inherit))
  const off = rebuildEntry({ ...p.models[1], image: 'off' })
  assert.deepEqual(off.input, ['text'])
  assert.equal(off.custom, 7)
})

test('invalidField flags non-positive-integer text', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(invalidField({ ...p.models[0], contextText: 'x' }), 'context')
  assert.equal(invalidField({ ...p.models[0], maxText: '0' }), 'max')
  assert.equal(invalidField({ ...p.models[0], contextText: '', maxText: '' }), undefined)
})

test('ops: declared route = one whole-array set', () => {
  const [p] = parseProviders(RESOLVED, USER)
  const ops = buildMutateOps({ ...p, models: p.models.map((m, i) => i === 0 ? { ...m, contextText: '99' } : m) })
  assert.equal(ops.length, 1)
  assert.equal(ops[0].op, 'set')
  assert.deepEqual(ops[0].path, ['providers', 'qwen-cn', 'models'])
  const arr = ops[0].value
  assert.equal(arr[0].contextWindow, 99)
  assert.ok(!('contextWindow' in arr[1]))
  assert.deepEqual(arr[0].reasoningEfforts, { off: null, high: 'high' })
})

test('ops: override route = dict set; empty dict = unset', () => {
  const [openai] = parseProviders(RESOLVED, { providers: {} }).filter((p) => p.route === 'openai')
  const rows = [emptyOverrideRow(), { ...emptyOverrideRow(), contextText: '', maxText: '', image: 'inherit' }]
  const withId = [{ ...emptyOverrideRow(), id: 'gpt-5', contextText: '400000', image: 'off' }]
  const ops = buildMutateOps({ ...openai, models: withId })
  assert.equal(ops[0].op, 'set')
  assert.deepEqual(ops[0].path, ['providers', 'openai', 'modelOverrides'])
  const dict = ops[0].value
  assert.equal(dict['gpt-5'].contextWindow, 400000)
  assert.deepEqual(dict['gpt-5'].input, ['text'])
  assert.ok(!('id' in dict['gpt-5']))
  assert.equal(buildMutateOps({ ...openai, models: rows.map(r => ({ ...r, id: '' })) })[0].op, 'unset')
})

test('draftsKey is stable and order-sensitive', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(draftsKey(p.models), draftsKey([...p.models]))
  assert.notEqual(draftsKey(p.models), draftsKey(p.models.map(m => ({ ...m, image: 'on' }))))
})
