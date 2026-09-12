/**
 * Protocol facts: fallback ladders, dialects, and the endpoint host whitelist.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateLadder } from '../lib/ladder.js'
import {
  KNOWN_PROTOCOLS,
  asProtocol,
  endpointDialect,
  fallbackDialect,
  fallbackLadder,
} from '../lib/protocol.js'

test('every fallback ladder is itself writable', () => {
  for (const protocol of KNOWN_PROTOCOLS) {
    const ladder = fallbackLadder(protocol)
    if (ladder === undefined) continue
    assert.deepEqual(validateLadder(ladder, protocol), [])
  }
})

test('a forced-thinking protocol declares no off tier', () => {
  const ladder = fallbackLadder('anthropic-messages')
  assert.equal(ladder?.off, undefined)
  assert.deepEqual(fallbackDialect('anthropic-messages'), { forceAdaptiveThinking: true })
})

test('the openai-completions dialect is the one a gateway most often speaks', () => {
  assert.deepEqual(fallbackLadder('openai-completions'), {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
  })
  assert.deepEqual(fallbackDialect('openai-completions'), {
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
  })
})

test('a protocol with no reasoning dispatch gets no ladder', () => {
  assert.equal(fallbackLadder('bedrock-converse-stream'), undefined)
  assert.equal(fallbackLadder('mistral-conversations'), undefined)
  assert.equal(fallbackLadder(undefined), undefined)
  assert.equal(fallbackDialect('openai-responses'), undefined)
})

test('only recognized official hosts vouch for a dialect', () => {
  assert.deepEqual(endpointDialect('https://api.deepseek.com/v1'), {
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: true,
  })
  assert.equal(endpointDialect('https://gateway.acme.example/v1'), undefined)
  assert.equal(endpointDialect('https://api.deepseek.com.evil.example/'), undefined)
  assert.equal(endpointDialect('not a url'), undefined)
  assert.equal(endpointDialect(undefined), undefined)
  assert.equal(endpointDialect(''), undefined)
})

test('an unknown api string is not coerced into a protocol', () => {
  assert.equal(asProtocol('openai'), undefined)
  assert.equal(asProtocol('openai-completions'), 'openai-completions')
  assert.equal(asProtocol(42), undefined)
})
