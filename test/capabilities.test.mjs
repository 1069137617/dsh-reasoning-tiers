import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProviders, rebuildEntry, invalidField, buildMutateOps, draftsKey,
  isValidCountText, countValue, emptyOverrideRow, bindScope,
  countPresets, presetLabel,
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

// Regression: the page hands scope.getSnapshot / scope.subscribe to
// useSyncExternalStore as bare functions, and React calls them with no
// receiver. The real SettingsScopeController keeps those on its PROTOTYPE and
// reads `this.store` (dsh-client-ui-settings/lib/client.js:997-1006), so a
// detached call threw TypeError and the list-slot entry abdicated: the nav row
// stayed (it reads the raw ledger) while the section went blank. The bound face
// must therefore own its members and survive being called bare.
class ControllerLike {
  constructor() { this.store = { snapshot: { status: 'ready', revision: 7 } } }
  getSnapshot() { return this.store.snapshot }
  subscribe(listener) { (this.listeners ??= []).push(listener); return () => { this.listeners = [] } }
  mutate(ops, expectedRevision) { return Promise.resolve({ count: ops.length, expectedRevision }) }
}

test('bindScope: detached calls work on a controller whose methods need `this`', () => {
  const controller = new ControllerLike()
  const face = bindScope(controller)
  const { getSnapshot, subscribe } = face
  assert.deepEqual(getSnapshot(), { status: 'ready', revision: 7 })
  assert.equal(typeof subscribe(() => {}), 'function')
  assert.equal(controller.listeners.length, 1)
})

test('bindScope: members are own properties, not inherited prototype slots', () => {
  const face = bindScope(new ControllerLike())
  for (const key of ['getSnapshot', 'subscribe', 'mutate']) {
    assert.ok(Object.prototype.hasOwnProperty.call(face, key), `${key} must be an own property`)
  }
})

test('bindScope: mutate forwards ops and the optional revision fence', async () => {
  const face = bindScope(new ControllerLike())
  const { mutate } = face
  const ops = [{ op: 'unset', path: ['providers', 'openai', 'modelOverrides'] }]
  assert.deepEqual(await mutate(ops, 3), { count: 1, expectedRevision: 3 })
  assert.deepEqual(await mutate(ops), { count: 1, expectedRevision: undefined })
})

// The quick-pick datalist: presets are a data table, so its shape is a
// contract — every row must be a value the number field itself would accept,
// or a click would write something the save gate rejects.
test('countPresets: ascending, value-unique, every value a valid count', () => {
  for (const field of ['context', 'max']) {
    const list = countPresets(field)
    assert.ok(list.length > 3, `${field} presets should offer a real ladder`)
    const values = list.map((p) => p.value)
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `${field} presets must ascend`)
    assert.equal(new Set(values).size, values.length, `${field} preset values must be unique`)
    assert.equal(new Set(list.map((p) => p.label)).size, values.length, `${field} preset labels must be unique`)
    for (const preset of list) {
      assert.ok(Number.isInteger(preset.value) && preset.value > 0, `${field} ${preset.value} must be a positive integer`)
      assert.ok(isValidCountText(String(preset.value)), `${field} ${preset.value} must round-trip through the field parser`)
      assert.ok(preset.label.length > 0)
    }
  }
})

test('countPresets: covers the values real configurations and catalogs use', () => {
  const context = countPresets('context').map((p) => p.value)
  // Binary steps as the pi-ai catalog spells them, decimal steps as vendors publish them.
  for (const value of [32768, 131072, 200000, 262144, 272000, 400000, 1000000]) {
    assert.ok(context.includes(value), `context presets must offer ${value}`)
  }
  const max = countPresets('max').map((p) => p.value)
  for (const value of [1024, 4096, 32768, 131072]) {
    assert.ok(max.includes(value), `max presets must offer ${value}`)
  }
  assert.ok(!max.includes(1000000), 'an output cap of 1M is not a step anyone ships')
})

test('countPresets: stable frozen identity (the component reads it per render)', () => {
  const first = countPresets('context')
  assert.equal(first, countPresets('context'))
  assert.ok(Object.isFrozen(first))
  assert.ok(first.every((preset) => Object.isFrozen(preset)))
})

test('presetLabel: resolves a step, declines anything else', () => {
  assert.equal(presetLabel(262144, 'context'), '256K')
  assert.equal(presetLabel(1000000, 'context'), '1M')
  assert.equal(presetLabel(131072, 'max'), '128K')
  assert.equal(presetLabel(131072, 'context'), '128K')
  assert.equal(presetLabel(152000, 'context'), undefined)
  assert.equal(presetLabel(4, 'max'), undefined)
})
