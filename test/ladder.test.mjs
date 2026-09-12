/**
 * The ladder vocabulary: what a flat ladder looks like from the outside.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSENT_MAP_LEVELS, isFlatLadder, validateLadder } from '../lib/ladder.js'

test('the absent-map fingerprint is the five base levels', () => {
  assert.deepEqual(ABSENT_MAP_LEVELS, ['off', 'minimal', 'low', 'medium', 'high'])
})

test('a flat ladder is recognized whatever the reported order', () => {
  assert.equal(isFlatLadder(['minimal', 'low', 'medium', 'high', 'off']), true)
  assert.equal(isFlatLadder(['high', 'minimal', 'off', 'medium', 'low']), true)
})

test('a ladder with a real wire mapping is not flat', () => {
  // What pi-ai reports for qwen3.8-flash: no `minimal`, and xhigh is mapped.
  assert.equal(isFlatLadder(['off', 'low', 'medium', 'xhigh']), false)
  // What it reports for deepseek-v4-pro.
  assert.equal(isFlatLadder(['high', 'max']), false)
})

test('the fingerprint tolerates a model that cannot switch thinking off', () => {
  assert.equal(isFlatLadder(['minimal', 'low', 'medium', 'high']), false, 'off missing is a different shape')
  assert.equal(isFlatLadder(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']), false)
})

test('an empty or single-tier answer is never flat', () => {
  assert.equal(isFlatLadder([]), false)
  assert.equal(isFlatLadder(['off']), false)
  assert.equal(isFlatLadder(['high']), false)
})

test('a repeated level is not the fingerprint', () => {
  assert.equal(isFlatLadder(['off', 'off', 'minimal', 'low', 'medium', 'high']), false)
})

test('a flat ladder is still a writable declaration', () => {
  assert.deepEqual(validateLadder({ off: null, minimal: 'minimal', high: 'high' }, 'flat'), [])
})
