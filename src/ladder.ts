/**
 * Reasoning-effort ladder vocabulary and validation.
 *
 * Every rule here mirrors what the installed `dsh-llm-pi-ai` bundle enforces on
 * a configured `reasoningEfforts` dict, so a ladder this plugin produces is
 * accepted by the provider on the first write instead of being refused and
 * silently retried away. The authority is `resolveModelReasoning()` in
 * `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:562-585`:
 *
 * - keys must be pi-ai thinking levels;
 * - only `off` may carry `null` ("selectable, send nothing");
 * - every other level must name a non-empty wire spelling;
 * - at least one level beyond `off` must be declared.
 *
 * Declaring a dict **replaces** the inherited capability: a level absent from
 * the dict is pinned unsupported, not inherited. That asymmetry is why this
 * plugin never rewrites a model that already offers a tier — see `plan.ts`.
 *
 * @module dsh-reasoning-tiers/ladder
 */

/** Every pi-ai thinking level a profile may declare, in escalation order. */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** One selectable reasoning tier. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * Declared tiers and their wire spellings. A `null` value is legal only for
 * `off`; an absent key means the tier is not offered.
 */
export type Ladder = Partial<Record<ThinkingLevel, string | null>>

/**
 * Narrow a runtime value to a thinking level.
 * @param value - candidate string from configuration or a knowledge table.
 * @returns the value as a level when it names one.
 */
export function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined
}

/**
 * Validate one candidate ladder.
 * @param ladder - the value to check; non-objects are reported rather than thrown on.
 * @param label - human-readable owner (`"family qwen-3.x"`), prefixed onto every message.
 * @returns a list of problems; empty when the ladder is writable.
 */
export function validateLadder(ladder: unknown, label: string): string[] {
  if (!isPlainObject(ladder)) return [`${label}: ladder must be an object of level -> wire value`]
  const problems: string[] = []
  if (Object.keys(ladder).length === 0) problems.push(`${label}: ladder declares no tiers`)
  for (const [key, value] of Object.entries(ladder)) {
    const level = asThinkingLevel(key)
    if (level === undefined) {
      problems.push(`${label}: unknown thinking level "${key}"`)
      continue
    }
    if (value === null) {
      if (level !== 'off') problems.push(`${label}: only "off" may leave its wire value empty`)
      continue
    }
    if (typeof value !== 'string') {
      problems.push(`${label}: ${key} must be a wire string or null`)
      continue
    }
    if (value.length === 0) problems.push(`${label}: ${key} must not be an empty string`)
  }
  if (ladderKeys(ladder).some((level) => level !== 'off')) return problems
  problems.push(`${label}: ladder offers no level beyond "off"`)
  return problems
}

/** The recognized levels among a raw object's keys, in escalation order. */
function ladderKeys(ladder: Record<string, unknown>): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => level in ladder)
}

/**
 * The tiers a ladder actually offers, in escalation order.
 * @param ladder - a validated ladder.
 * @returns every declared level, `off` included when declared.
 */
export function offeredLevels(ladder: Ladder): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => ladder[level] !== undefined)
}

/**
 * Whether a ladder names a thinking tier (not merely `off`).
 * @param ladder - the ladder to inspect.
 * @returns true when at least one level beyond `off` is declared.
 */
export function hasThinkingTier(ladder: Ladder): boolean {
  return offeredLevels(ladder).some((level) => level !== 'off')
}

/**
 * Copy a ladder with only the levels `allowed` names.
 * @param ladder - the source declaration.
 * @param allowed - levels to keep.
 * @returns a new ladder; the source is untouched.
 */
export function restrictLadder(ladder: Ladder, allowed: readonly ThinkingLevel[]): Ladder {
  const kept: Ladder = {}
  for (const level of THINKING_LEVELS) {
    if (ladder[level] !== undefined && allowed.includes(level)) kept[level] = ladder[level] ?? null
  }
  return kept
}

/**
 * The tier set pi-ai reports for a model whose `thinkingLevelMap` is absent.
 *
 * `getSupportedThinkingLevels` (`pi-ai/dist/models.js:551-561`) treats an absent
 * map key as *supported* for the five base levels and as unsupported for
 * `xhigh`/`max`, so a model with no map at all comes back offering exactly these
 * five — and nothing distinguishes them downstream.
 */
export const ABSENT_MAP_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']

/**
 * Whether the tiers a model offers are the fingerprint of an absent
 * `thinkingLevelMap`, i.e. a **flat** ladder.
 *
 * A flat ladder is not a capability: under a non-passthrough `thinkingFormat`
 * every non-`off` choice dispatches the same request. The `qwen` case is
 * documented in the installed adapter — `params.enable_thinking =
 * !!options?.reasoningEffort`, with the effort string sent only when
 * `compat.supportsReasoningEffort` is set
 * (`pi-ai/dist/api/openai-completions.js:645-653`) — so `low`, `medium` and
 * `high` are three names for one request.
 *
 * Detection is a fingerprint rather than a proof: it reads the offered set, not
 * the wire spelling behind it, which is all the Host seam exposes. Declaring a
 * `reasoningEfforts` dict cannot fix a flat ladder on its own — the level's
 * spelling is only consulted when the compat switch already admits an effort,
 * so the request bytes stay identical and only the menu changes.
 *
 * @param offered - the tier ids the model reports, in any order.
 * @returns whether the offered set is exactly the absent-map fingerprint.
 */
export function isFlatLadder(offered: readonly string[]): boolean {
  const unique = new Set(offered)
  if (unique.size !== offered.length) return false
  return ABSENT_MAP_LEVELS.length === unique.size && ABSENT_MAP_LEVELS.every((level) => unique.has(level))
}

/** Whether a value is a plain JSON object (not an array, `null`, or a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Structural equality over JSON data, used to keep writes idempotent.
 * @param a - left operand.
 * @param b - right operand.
 * @returns whether both hold the same JSON value.
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in b && jsonEquals(a[key], b[key]))
    )
  }
  return false
}
