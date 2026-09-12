/**
 * Knowledge table and matcher.
 *
 * Run with `npm test`, which builds `lib/` first.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUILTIN_FAMILIES,
  ladderLevels,
  normalizeModelId,
  suggest,
  validateKnowledgeTable,
} from '../lib/knowledge.js'
import { validateLadder } from '../lib/ladder.js'
import { fallbackLadder } from '../lib/protocol.js'

test('the built-in table is writable under the provider’s own rules', () => {
  assert.deepEqual(validateKnowledgeTable(), [])
})

test('every entry declares a matcher and at least one tier beyond off', () => {
  for (const entry of BUILTIN_FAMILIES) {
    const declared = (entry.exact?.length ?? 0) + (entry.prefix?.length ?? 0) + (entry.pattern ? 1 : 0)
    assert.ok(declared > 0, `${entry.id} declares no matcher`)
    assert.ok(
      ladderLevels(entry.ladder).some((level) => level !== 'off'),
      `${entry.id} offers no thinking tier`,
    )
  }
})

test('the table never pins a non-off tier to an empty wire value', () => {
  for (const entry of BUILTIN_FAMILIES) {
    for (const [level, value] of Object.entries(entry.ladder)) {
      if (level === 'off') continue
      assert.equal(typeof value, 'string', `${entry.id}.${level} must name a wire value`)
      assert.ok(value.length > 0, `${entry.id}.${level} is an empty string`)
    }
  }
})

test('model id normalization folds case, separators, and padding', () => {
  assert.equal(normalizeModelId('  MiniMax-M2.5 '), 'minimax-m2.5')
  assert.equal(normalizeModelId('MiniMax_M2.5'), 'minimax-m2.5')
  assert.equal(normalizeModelId('MiniMax M2.5'), 'minimax-m2.5')
})

test('a user rule outranks the built-in table', () => {
  const rules = [
    {
      id: 'mine',
      exact: ['qwen3.8-flash'],
      ladder: { off: null, high: 'turbo' },
      dialect: { thinkingFormat: 'openai' },
    },
  ]
  const found = suggest({
    route: 'acme',
    model: 'qwen3.8-flash',
    protocol: 'openai-completions',
    rules,
    allowProtocolFallback: true,
  })
  assert.equal(found?.origin, 'rule')
  assert.equal(found?.ladder.high, 'turbo')
  assert.equal(found?.confidence, 'high')
})

test('knowledge answers a model pi-ai’s catalog has never heard of', () => {
  const found = suggest({
    route: 'mirror',
    model: 'qwen3.9-turbo',
    protocol: 'openai-completions',
    allowProtocolFallback: false,
  })
  assert.equal(found?.origin, 'knowledge')
  assert.equal(found?.source, 'family:qwen3')
  assert.equal(found?.dialect?.thinkingFormat, 'qwen')
})

test('an unknown protocol keeps the ladder but drops the dialect switch', () => {
  const found = suggest({
    route: 'mystery',
    model: 'glm-6-flash',
    protocol: undefined,
    allowProtocolFallback: false,
  })
  assert.equal(found?.origin, 'knowledge')
  assert.equal(found?.dialect, undefined, 'a switch the protocol may not carry must not be written')
})

test('a family entry refuses a protocol it does not name', () => {
  const found = suggest({
    route: 'gateway',
    model: 'glm-5.2',
    protocol: 'anthropic-messages',
    allowProtocolFallback: false,
  })
  assert.equal(found, undefined)
})

test('the protocol fallback never invents xhigh or max', () => {
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    const ladder = fallbackLadder(protocol)
    assert.ok(ladder !== undefined, protocol)
    assert.equal(ladder.xhigh, undefined, `${protocol} must not claim xhigh`)
    assert.equal(ladder.max, undefined, `${protocol} must not claim max`)
  }
  const found = suggest({
    route: 'hand-declared',
    model: 'totally-unknown-9000',
    protocol: 'openai-completions',
    allowProtocolFallback: true,
  })
  assert.equal(found?.origin, 'protocol')
  assert.equal(found?.confidence, 'low')
})

test('a catalog route gets no generic ladder', () => {
  const found = suggest({
    route: 'catalog-route',
    model: 'totally-unknown-9000',
    protocol: 'openai-completions',
    allowProtocolFallback: false,
  })
  assert.equal(found, undefined)
})

test('a forced-thinking family declares no off tier', () => {
  const found = suggest({
    route: 'openai',
    model: 'o4-mini',
    protocol: 'openai-responses',
    allowProtocolFallback: false,
  })
  assert.equal(found?.source, 'family:o-series')
  assert.equal(found?.ladder.off, undefined)
})

test('a ladder naming only off is refused, matching the provider’s rule', () => {
  assert.ok(validateLadder({ off: null }, 'x').length > 0)
  assert.deepEqual(validateLadder({ off: null, high: 'high' }, 'x'), [])
  assert.ok(validateLadder({ high: null }, 'x').some((p) => p.includes('only "off"')))
  assert.ok(validateLadder({ high: '' }, 'x').some((p) => p.includes('empty string')))
  assert.ok(validateLadder({ ultrathink: 'ultra' }, 'x').some((p) => p.includes('unknown thinking level')))
  assert.ok(validateLadder({}, 'x').some((p) => p.includes('no tiers')))
})
