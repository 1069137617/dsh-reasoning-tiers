/**
 * Configuration resolution: every knob, every refusal explained.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, resolveConfig } from '../lib/config.js'

test('an absent config takes every default', () => {
  const config = resolveConfig(void 0)
  assert.equal(config.autofill, true)
  assert.equal(config.revert, false)
  assert.equal(config.respectExisting, true)
  assert.equal(config.compatAutofill, true)
  assert.equal(config.alignGlobalEffort, false)
  assert.deepEqual(config.problems, [])
  assert.deepEqual(config.rules, [])
})

test('a non-object config is reported and defaulted, not half-applied', () => {
  const config = resolveConfig('nope')
  assert.equal(config.autofill, DEFAULTS.autofill)
  assert.equal(config.problems.length, 1)
  assert.match(config.problems[0], /config must be an object/)
})

test('a wrong-typed knob falls back with its reason named', () => {
  const config = resolveConfig({ autofill: 'yes', maxProbes: -1, excludeModels: 'qwen*' })
  assert.equal(config.autofill, true)
  assert.equal(config.maxProbes, DEFAULTS.maxProbes)
  assert.deepEqual(config.excludeModels, [])
  assert.equal(config.problems.length, 3)
  assert.match(config.problems.join('\n'), /must be true or false/)
  assert.match(config.problems.join('\n'), /non-negative finite number/)
  assert.match(config.problems.join('\n'), /must be an array of strings/)
})

test('a valid extra rule is parsed into a real regular expression matcher', () => {
  const config = resolveConfig({
    extraRules: [
      { pattern: '^my-model$', ladder: { off: null, high: 'ultra' }, dialect: { thinkingFormat: 'openai' } },
    ],
  })
  assert.deepEqual(config.problems, [])
  assert.equal(config.rules.length, 1)
  assert.deepEqual(config.rules[0].ladder, { off: null, high: 'ultra' })
  assert.deepEqual(config.rules[0].dialect, { thinkingFormat: 'openai' })
})

test('an unusable extra rule is refused with its reason, leaving the valid ones', () => {
  const config = resolveConfig({
    extraRules: [
      { pattern: '(', ladder: { off: null, high: 'h' } },
      { ladder: { high: null } },
      { ladder: { high: 'h' } },
      { prefix: ['a'], ladder: {} },
      'nope',
      { prefix: ['good-'], ladder: { off: null, high: 'h' } },
    ],
  })
  assert.deepEqual(config.rules.map((rule) => rule.prefix?.[0]), ['good-'])
  assert.equal(config.problems.length, 5)
  assert.match(config.problems.join('\n'), /regular expression/)
  assert.match(config.problems.join('\n'), /only "off"/)
  assert.match(config.problems.join('\n'), /no matcher/)
  assert.match(config.problems.join('\n'), /declares no tiers/)
  assert.match(config.problems.join('\n'), /must be an object/)
})

test('an unknown dialect field is dropped rather than written', () => {
  const config = resolveConfig({
    extraRules: [
      { prefix: ['x'], ladder: { high: 'h' }, dialect: { thinkingFormat: 'telepathy', supportsReasoningEffort: true } },
    ],
  })
  assert.deepEqual(config.rules[0].dialect, { supportsReasoningEffort: true })
})

test('a retry schedule may be shortened to a single attempt', () => {
  const config = resolveConfig({ bootRetryDelaysMs: [] })
  assert.deepEqual(config.bootRetryDelaysMs, [])
  assert.equal(resolveConfig({ bootRetryDelaysMs: 'fast' }).bootRetryDelaysMs.length, DEFAULTS.bootRetryDelaysMs.length)
})

test('the audit runs by default while widening stays opt-in', () => {
  const config = resolveConfig(void 0)
  assert.equal(config.diagnose, true, 'a read-only audit is safe to run everywhere')
  assert.equal(config.widenToGlobalEffort, false, 'guessing a wire spelling is never a default')
})

test('the widening knob is coerced with its reason named', () => {
  const config = resolveConfig({ diagnose: 'yes', widenToGlobalEffort: 1 })
  assert.equal(config.diagnose, true)
  assert.equal(config.widenToGlobalEffort, false)
  assert.equal(config.problems.length, 2)
  assert.match(config.problems.join('\n'), /diagnose must be true or false/)
  assert.match(config.problems.join('\n'), /widenToGlobalEffort must be true or false/)
})

test('an explicit widening opt-in is accepted verbatim', () => {
  const config = resolveConfig({ diagnose: false, widenToGlobalEffort: true })
  assert.equal(config.diagnose, false)
  assert.equal(config.widenToGlobalEffort, true)
  assert.deepEqual(config.problems, [])
})
