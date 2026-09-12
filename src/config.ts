/**
 * Plugin configuration, read from this bundle's composition entry.
 *
 * The knobs arrive through `cordis.patch.yml` rather than a settings namespace
 * on purpose: a profile's patch layer reloads live (`patchReload: live`), so an
 * edit takes effect without a restart, and the plugin owns no settings page —
 * the one thing it changes lives in the provider's own section, where the user
 * can read and undo it.
 *
 * Hand-rolled instead of schema-backed for the same reason it is host-only: one
 * fewer peer contract to drift against, and every rule is a plain function a
 * test can call.
 *
 * @module dsh-reasoning-tiers/config
 */

import type { UserRule } from './knowledge.ts'
import { isPlainObject, validateLadder } from './ladder.ts'
import { readRule } from './knowledge.ts'

/** Defaults for every knob, spelled out so the README can quote them. */
export const DEFAULTS = {
  autofill: true,
  revert: false,
  compatAutofill: true,
  respectExisting: true,
  alignGlobalEffort: false,
  diagnose: true,
  widenToGlobalEffort: false,
  excludeProviders: [] as string[],
  excludeModels: [] as string[],
  bootRetryDelaysMs: [1000, 2000, 4000, 8000, 16000, 30000],
  debounceMs: 250,
  maxProbes: 200,
}

/** The resolved knobs the plugin runs with. */
export interface ResolvedConfig {
  autofill: boolean
  revert: boolean
  compatAutofill: boolean
  respectExisting: boolean
  alignGlobalEffort: boolean
  diagnose: boolean
  widenToGlobalEffort: boolean
  rules: UserRule[]
  excludeProviders: string[]
  excludeModels: string[]
  bootRetryDelaysMs: number[]
  debounceMs: number
  maxProbes: number
  /** Every way the supplied configuration was ignored, with its reason. */
  problems: string[]
}

/**
 * Resolve one raw composition config.
 * @param raw - the `config:` block from the patch entry, possibly absent.
 * @returns defaults overlaid with every accepted value, plus what was refused.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const problems: string[] = []
  if (raw !== undefined && !isPlainObject(raw))
    problems.push(`config must be an object, got ${describe(raw)}; using defaults`)
  const source = isPlainObject(raw) ? raw : {}

  const config: ResolvedConfig = {
    ...DEFAULTS,
    rules: [],
    problems,
  }

  config.autofill = boolean(source.autofill, DEFAULTS.autofill, 'autofill', problems)
  config.revert = boolean(source.revert, DEFAULTS.revert, 'revert', problems)
  config.compatAutofill = boolean(source.compatAutofill, DEFAULTS.compatAutofill, 'compatAutofill', problems)
  config.respectExisting = boolean(source.respectExisting, DEFAULTS.respectExisting, 'respectExisting', problems)
  config.alignGlobalEffort = boolean(source.alignGlobalEffort, DEFAULTS.alignGlobalEffort, 'alignGlobalEffort', problems)
  config.diagnose = boolean(source.diagnose, DEFAULTS.diagnose, 'diagnose', problems)
  config.widenToGlobalEffort = boolean(source.widenToGlobalEffort, DEFAULTS.widenToGlobalEffort, 'widenToGlobalEffort', problems)
  config.excludeProviders = stringList(source.excludeProviders, 'excludeProviders', problems)
  config.excludeModels = stringList(source.excludeModels, 'excludeModels', problems)
  config.bootRetryDelaysMs = numberList(source.bootRetryDelaysMs, DEFAULTS.bootRetryDelaysMs, 'bootRetryDelaysMs', problems)
  config.debounceMs = number(source.debounceMs, DEFAULTS.debounceMs, 'debounceMs', problems)
  config.maxProbes = number(source.maxProbes, DEFAULTS.maxProbes, 'maxProbes', problems)

  const rawRules = source.extraRules
  if (rawRules !== undefined) {
    if (!Array.isArray(rawRules)) {
      problems.push(`extraRules must be an array, got ${describe(rawRules)}; ignored`)
    } else {
      rawRules.forEach((entry, index) => {
        const { rule, problem } = readRule(entry, index)
        if (problem !== undefined) {
          problems.push(problem)
          return
        }
        if (rule !== undefined) config.rules.push(rule)
      })
    }
  }

  return config
}

function boolean(value: unknown, fallback: boolean, key: string, problems: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    problems.push(`${key} must be true or false, got ${describe(value)}; using ${String(fallback)}`)
    return fallback
  }
  return value
}

function number(value: unknown, fallback: number, key: string, problems: string[]): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    problems.push(`${key} must be a non-negative finite number, got ${describe(value)}; using ${String(fallback)}`)
    return fallback
  }
  return value
}

function numberList(value: unknown, fallback: number[], key: string, problems: string[]): number[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    problems.push(`${key} must be an array of milliseconds, got ${describe(value)}; using the defaults`)
    return [...fallback]
  }
  const kept = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0)
  if (kept.length !== value.length) problems.push(`${key} dropped ${String(value.length - kept.length)} non-numeric entries`)
  return kept
}

function stringList(value: unknown, key: string, problems: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push(`${key} must be an array of strings, got ${describe(value)}; ignored`)
    return []
  }
  const kept = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (kept.length !== value.length) problems.push(`${key} dropped ${String(value.length - kept.length)} non-string entries`)
  return kept
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`
}

/**
 * Lint a ladder supplied outside the built-in table. Re-exported so a caller
 * can validate a hand-built rule without importing the knowledge module.
 * @param ladder - candidate ladder.
 * @param label - owner name for each problem.
 * @returns problems, empty when writable.
 */
export function checkLadder(ladder: unknown, label: string): string[] {
  return validateLadder(ladder, label)
}
