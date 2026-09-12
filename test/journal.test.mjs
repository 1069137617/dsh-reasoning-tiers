/**
 * The write ledger and the undo path.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildRevert,
  emptyJournal,
  journalPath,
  mergeJournal,
  parseJournal,
  readJournal,
  writeJournal,
} from '../lib/journal.js'

const LADDER = { off: null, low: 'low', high: 'high' }

function journalWithLadder(route, model, mode, ladder = LADDER) {
  return { version: 1, ladders: [{ route, model, mode, ladder }], compat: [] }
}

test('a revert removes a ladder this plugin wrote', () => {
  const section = {
    providers: { acme: { api: 'openai-completions', models: [{ id: 'x', contextWindow: 10, reasoningEfforts: LADDER }] } },
  }
  const plan = buildRevert(section, journalWithLadder('acme', 'x', 'models'))
  assert.deepEqual(plan.patch.providers.acme.models, [{ id: 'x', contextWindow: 10 }])
  assert.deepEqual(plan.left, [])
})

test('a ladder the user has since edited is left alone and stays on the ledger', () => {
  const edited = { off: null, high: 'turbo' }
  const section = { providers: { acme: { models: [{ id: 'x', reasoningEfforts: edited }] } } }
  const plan = buildRevert(section, journalWithLadder('acme', 'x', 'models'))
  assert.deepEqual(plan.left, [{ route: 'acme', model: 'x', reason: 'changed-by-user' }])
  assert.deepEqual(plan.patch.providers.acme.models, [{ id: 'x', reasoningEfforts: edited }])
  assert.equal(plan.remaining.ladders.length, 1, 'it may need undoing after the user finishes editing')
})

test('a model the user already deleted is reported, not resurrected', () => {
  const section = { providers: { acme: { models: [{ id: 'other' }] } } }
  const plan = buildRevert(section, journalWithLadder('acme', 'x', 'models'))
  assert.deepEqual(plan.left, [{ route: 'acme', model: 'x', reason: 'absent-already' }])
  assert.deepEqual(plan.patch.providers.acme.models, [{ id: 'other' }])
})

test('an override entry is unset by path, and removed whole when it empties', () => {
  const kept = buildRevert(
    { providers: { acme: { modelOverrides: { 'm-1': { reasoningEfforts: LADDER, maxTokens: 64 } } } } },
    journalWithLadder('acme', 'm-1', 'modelOverrides'),
  )
  assert.deepEqual(kept.ops, [{ op: 'unset', path: ['providers', 'acme', 'modelOverrides', 'm-1', 'reasoningEfforts'] }])

  const emptied = buildRevert(
    { providers: { acme: { modelOverrides: { 'm-1': { reasoningEfforts: LADDER } } } } },
    journalWithLadder('acme', 'm-1', 'modelOverrides'),
  )
  assert.deepEqual(emptied.ops.at(-1), { op: 'unset', path: ['providers', 'acme', 'modelOverrides', 'm-1'] })
})

test('route compat fields are unset only while they still hold what we wrote', () => {
  const journal = {
    version: 1,
    ladders: [],
    compat: [{ route: 'acme', fields: { thinkingFormat: 'openai', supportsReasoningEffort: true } }],
  }
  const ours = buildRevert({ providers: { acme: { compat: { thinkingFormat: 'openai', supportsReasoningEffort: true } } } }, journal)
  assert.deepEqual(ours.ops, [
    { op: 'unset', path: ['providers', 'acme', 'compat', 'thinkingFormat'] },
    { op: 'unset', path: ['providers', 'acme', 'compat', 'supportsReasoningEffort'] },
    { op: 'unset', path: ['providers', 'acme', 'compat'] },
  ], 'a compat block we fully own is removed whole')

  const mixed = buildRevert({ providers: { acme: { compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true } } } }, journal)
  assert.deepEqual(mixed.ops, [{ op: 'unset', path: ['providers', 'acme', 'compat', 'supportsReasoningEffort'] }])
  assert.equal(
    mixed.ops.some((op) => op.path.at(-1) === 'compat'),
    false,
    'the user’s own thinkingFormat keeps the block alive',
  )
})

test('a revert against an empty document changes nothing', () => {
  const plan = buildRevert({}, journalWithLadder('acme', 'x', 'models'))
  assert.deepEqual(plan.patch, {})
  assert.deepEqual(plan.ops, [])
  assert.deepEqual(plan.left, [{ route: 'acme', model: 'x', reason: 'absent-already' }])
})

test('the ledger collapses repeat writes to one record per model', () => {
  let journal = emptyJournal()
  journal = mergeJournal(journal, [{ route: 'acme', model: 'x', mode: 'models', ladder: LADDER }])
  journal = mergeJournal(journal, [{ route: 'acme', model: 'x', mode: 'models', ladder: { high: 'high' } }])
  journal = mergeJournal(journal, [
    { route: 'acme', model: 'y', mode: 'models', ladder: LADDER, dialect: { thinkingFormat: 'openai' } },
    { route: 'acme', model: 'z', mode: 'modelOverrides', ladder: LADDER, dialect: { supportsReasoningEffort: true } },
  ])
  assert.deepEqual(journal.ladders.map((entry) => entry.model), ['x', 'y', 'z'])
  assert.notEqual(journal.ladders.find((entry) => entry.model === 'x'), undefined)
  assert.deepEqual(journal.ladders.find((entry) => entry.model === 'x').ladder, { high: 'high' }, 'latest write wins')
  assert.equal(
    journal.ladders.filter((entry) => entry.model === 'x').length,
    1,
    'a repeat write does not fork a record',
  )
  assert.deepEqual(journal.compat, [
    { route: 'acme', fields: { thinkingFormat: 'openai', supportsReasoningEffort: true } },
  ], 'one compat record per route, fields merged')
})

test('the ledger after a revert holds only what was not undone', () => {
  const journal = {
    version: 1,
    ladders: [
      { route: 'acme', model: 'x', mode: 'models', ladder: LADDER },
      { route: 'acme', model: 'y', mode: 'models', ladder: LADDER },
    ],
    compat: [{ route: 'acme', fields: { thinkingFormat: 'openai' } }],
  }
  const section = {
    providers: {
      acme: {
        models: [{ id: 'x', reasoningEfforts: LADDER }, { id: 'y', reasoningEfforts: { high: 'other' } }],
        compat: { thinkingFormat: 'openai' },
      },
    },
  }
  const plan = buildRevert(section, journal)
  assert.deepEqual(plan.remaining.ladders.map((entry) => entry.model), ['y'])
  assert.deepEqual(plan.remaining.compat, [], 'a compat field we still own exactly is cleared')
  assert.deepEqual(
    plan.ops.filter((op) => op.path.at(-1) === 'compat'),
    [{ op: 'unset', path: ['providers', 'acme', 'compat'] }],
  )
})

test('a route the user deleted entirely is reported, never recreated', () => {
  const plan = buildRevert({ providers: {} }, journalWithLadder('acme', 'x', 'models'))
  assert.deepEqual(plan.patch, {})
  assert.deepEqual(plan.ops, [])
  assert.deepEqual(plan.remaining, emptyJournal())
  assert.deepEqual(plan.left, [{ route: 'acme', model: 'x', reason: 'absent-already' }])
})

test('the ledger round-trips through disk and survives a foreign file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-journal-'))
  const path = join(dir, 'journal.json')
  assert.deepEqual(await readJournal(path), emptyJournal(), 'an absent file reads as empty')

  await writeFile(path, '{ not json', 'utf8')
  assert.deepEqual(await readJournal(path), emptyJournal(), 'a corrupt file reads as empty rather than throwing')

  await writeFile(path, JSON.stringify({ version: 99, ladders: [], compat: [] }), 'utf8')
  assert.deepEqual(await readJournal(path), emptyJournal(), 'a future format is not misread as ours')

  await writeJournal(path, { version: 1, ladders: [{ route: 'a', model: 'b', mode: 'models', ladder: LADDER }], compat: [] })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.ladders[0].model, 'b')
})

test('a parsed journal drops records it cannot trust', () => {
  const parsed = parseJournal({
    version: 1,
    ladders: [
      { route: 'a', model: 'b', mode: 'models', ladder: LADDER },
      { route: 'a', model: 'c', mode: 'nonsense', ladder: LADDER },
      { route: 'a', ladder: LADDER },
      'nope',
    ],
    compat: [{ route: 'a', fields: { thinkingFormat: 'openai' } }, { route: 'b' }],
  })
  assert.deepEqual(parsed.ladders.map((entry) => entry.model), ['b'])
  assert.deepEqual(parsed.compat.map((entry) => entry.route), ['a'])
})

test('the ledger lives under the harness home, honoring DSH_HOME', () => {
  assert.match(journalPath({ DSH_HOME: '/tmp/custom-home' }), /custom-home[/\\]dsh-reasoning-tiers[/\\]journal\.json$/)
})
