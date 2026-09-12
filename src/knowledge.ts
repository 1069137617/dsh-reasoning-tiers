/**
 * The built-in model knowledge table and the matcher that turns a model id into
 * a reasoning ladder.
 *
 * Entries are **family-level claims**: which tiers a model line exposes, the
 * exact string the endpoint expects for each, and the dialect its reasoning
 * parameter travels in. They are seeded for the model families this plugin's
 * users actually put behind third-party gateways, and every entry names its
 * confidence and its source so a wrong claim is traceable — a ladder is an
 * assertion about an endpoint, not a check of it.
 *
 * The table deliberately does **not** copy pi-ai's own catalog. For a route
 * whose models pi-ai already describes, that catalog is inherited at runtime and
 * this plugin stays out of the way (`plan.ts` skips any model that already
 * offers a tier). The table earns its keep on model ids pi-ai has never heard
 * of: dated snapshots, a gateway's own naming, and hand-declared routes.
 *
 * Families with no effort-style control at all (Llama, Phi, Nova, Cohere,
 * Perplexity sonar) get **no entry**: a low-confidence generic suggestion for a
 * model that cannot honour it is worse than silence, because the endpoint then
 * answers the user's next turn with a 400.
 *
 * @module dsh-reasoning-tiers/knowledge
 */

import type { Ladder, ThinkingLevel } from './ladder.ts'
import { hasThinkingTier, isPlainObject, validateLadder } from './ladder.ts'
import type { Dialect, KnownProtocol } from './protocol.ts'
import {
  THINKING_FORMATS,
  asProtocol,
  endpointDialect,
  fallbackDialect,
  fallbackLadder,
} from './protocol.ts'
import type { ThinkingFormat } from './protocol.ts'

/** How far this plugin trusts one claim. Surfaced verbatim in the log. */
export type Confidence = 'high' | 'medium' | 'low'

/** One family's declaration. */
export interface FamilyEntry {
  /** Stable identifier for logs and tests. */
  readonly id: string
  /** Full model ids (normalized) this entry answers for. Checked first. */
  readonly exact?: readonly string[]
  /** Normalized id prefixes. Checked second. */
  readonly prefix?: readonly string[]
  /** Source text of a case-insensitive regular expression. Checked last. */
  readonly pattern?: string
  /** Declared tiers and their wire spellings. */
  readonly ladder: Ladder
  /** Dialect switches, applied only to a protocol that can carry them. */
  readonly dialect?: Dialect
  /** Protocols this entry may serve; absent means any protocol. */
  readonly protocols?: readonly KnownProtocol[]
  readonly confidence: Confidence
  /** Where the claim comes from. */
  readonly source: string
}

/** A user-supplied rule, mirroring {@link FamilyEntry} but read from config. */
export interface UserRule {
  readonly id?: string | undefined
  readonly exact?: readonly string[] | undefined
  readonly prefix?: readonly string[] | undefined
  readonly pattern?: string | undefined
  readonly ladder: Ladder
  readonly dialect?: Dialect | undefined
  readonly protocols?: readonly KnownProtocol[] | undefined
}

/** The outcome of matching one model. */
export interface Suggestion {
  readonly ladder: Ladder
  readonly dialect?: Dialect
  readonly confidence: Confidence
  readonly origin: 'rule' | 'knowledge' | 'protocol'
  readonly source: string
}

/** What a suggestion was asked about. */
export interface SuggestInput {
  /** Provider route key. */
  readonly route: string
  /** Model id exactly as configured. */
  readonly model: string
  /** The route's resolved wire protocol. */
  readonly protocol: KnownProtocol | undefined
  /** The route's configured endpoint, when it overrides one. */
  readonly baseURL?: unknown
  /** User rules, which outrank the built-in table. */
  readonly rules?: readonly UserRule[]
  /** Whether a generic protocol ladder may answer at all. */
  readonly allowProtocolFallback: boolean
}

/**
 * Normalize an id for matching: trim, lowercase, and squeeze runs of
 * separators, so `MiniMax-M2.5`, `minimax_m2.5`, and `MiniMax M2.5` agree.
 * @param model - the configured model id.
 * @returns the matching key.
 */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/**
 * The built-in table, most specific family first.
 *
 * `off: null` means "tier selectable, send nothing" — the correct dispatch where
 * not thinking is the absence of a parameter. A wire spelling equal to the level
 * name is the plain OpenAI convention; anything else is a vendor-specific value
 * the entry records on purpose.
 */
export const BUILTIN_FAMILIES: readonly FamilyEntry[] = [
  {
    id: 'qwen3',
    prefix: ['qwen3', 'qwen-3', 'qwq'],
    ladder: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    dialect: { thinkingFormat: 'qwen' },
    protocols: ['openai-completions'],
    confidence: 'high',
    source: 'Qwen3 thinking-mode parameter set; matches the pi-ai qwen catalog ladders',
  },
  {
    id: 'deepseek-v4',
    pattern: '^deepseek-(v4|flash)',
    ladder: { off: null, high: 'high', max: 'max' },
    dialect: { thinkingFormat: 'deepseek' },
    protocols: ['openai-completions'],
    confidence: 'high',
    source: 'DeepSeek V4 enumerates Off / low / high / max',
  },
  {
    id: 'deepseek-r1-v31',
    pattern: '^deepseek-(r1|v3\\.1|reasoner)',
    ladder: { off: null, high: 'high' },
    dialect: { thinkingFormat: 'deepseek' },
    protocols: ['openai-completions'],
    confidence: 'medium',
    source: 'R1-family thinking toggle exposed as a single effort on most gateways',
  },
  {
    id: 'glm-5',
    pattern: '^glm-?[5-9]',
    ladder: { off: null, high: 'high', max: 'max' },
    dialect: { thinkingFormat: 'zai' },
    protocols: ['openai-completions'],
    confidence: 'high',
    source: 'GLM-5.x reasoning effort ladder',
  },
  {
    id: 'glm-4.5v',
    pattern: '^glm-4\\.[5-9]',
    ladder: { off: null, low: 'low', medium: 'medium', high: 'high' },
    dialect: { thinkingFormat: 'zai' },
    protocols: ['openai-completions'],
    confidence: 'medium',
    source: 'GLM-4.5/4.6 thinking family',
  },
  {
    id: 'kimi-k2',
    pattern: '^kimi-?k2',
    ladder: { off: null, low: 'low', high: 'high' },
    protocols: ['openai-completions'],
    confidence: 'medium',
    source: 'Kimi K2.x thinking on/off plus effort; spellings vary by gateway',
  },
  {
    id: 'minimax-m',
    pattern: '^minimax-?m[0-9]',
    ladder: { off: null, low: 'low', high: 'high' },
    protocols: ['openai-completions'],
    confidence: 'medium',
    source: 'MiniMax M-series thinking switch',
  },
  {
    id: 'gpt-5',
    pattern: '^gpt-5',
    ladder: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    protocols: ['openai-responses', 'openai-completions'],
    confidence: 'high',
    source: 'OpenAI GPT-5 reasoning_effort set',
  },
  {
    id: 'o-series',
    pattern: '^o[1-9](-|$)',
    ladder: { low: 'low', medium: 'medium', high: 'high' },
    protocols: ['openai-responses', 'openai-completions'],
    confidence: 'high',
    source: 'o-series reasons continuously: no off tier is declared',
  },
  {
    id: 'claude',
    pattern: '^claude-',
    ladder: { off: null, low: 'low', medium: 'medium', high: 'high' },
    dialect: { forceAdaptiveThinking: true },
    protocols: ['anthropic-messages'],
    confidence: 'medium',
    source: 'Anthropic extended-thinking budget tiers on effort-capable releases',
  },
  {
    id: 'gemini-thinking',
    pattern: '^gemini-[2-9]',
    ladder: { off: null, low: 'low', medium: 'medium', high: 'high' },
    protocols: ['google-generative-ai', 'google-vertex'],
    confidence: 'medium',
    source: 'Gemini thinking-budget family',
  },
  {
    id: 'grok-4',
    pattern: '^grok-4',
    ladder: { off: null, low: 'low', medium: 'medium', high: 'high' },
    protocols: ['openai-completions', 'openai-responses'],
    confidence: 'medium',
    source: 'Grok 4 reasoning-effort family',
  },
]

/** Whether one entry's matcher claims this model id. */
function entryMatches(
  entry: {
    exact?: readonly string[] | undefined
    prefix?: readonly string[] | undefined
    pattern?: string | undefined
  },
  key: string,
): boolean {
  if (entry.exact?.some((id) => normalizeModelId(id) === key)) return true
  if (entry.prefix?.some((head) => key.startsWith(normalizeModelId(head)))) return true
  if (entry.pattern !== undefined) {
    let expression: RegExp
    try {
      expression = new RegExp(entry.pattern, 'i')
    } catch {
      return false
    }
    if (expression.test(key)) return true
  }
  return false
}

/** Whether an entry may serve a protocol. Unknown protocol narrows, not blocks. */
function protocolAccepts(
  protocols: readonly KnownProtocol[] | undefined,
  protocol: KnownProtocol | undefined,
): boolean {
  if (protocols === undefined || protocols.length === 0) return true
  if (protocol === undefined) return true
  return protocols.includes(protocol)
}

/** The dialect to carry, or nothing when the protocol could refuse it. */
function dialectFor(
  entry: { dialect?: Dialect | undefined; protocols?: readonly KnownProtocol[] | undefined },
  protocol: KnownProtocol | undefined,
): Dialect | undefined {
  if (entry.dialect === undefined) return undefined
  // Without a known protocol the switch could be refused by the compat gate, so
  // the ladder is written and the dialect is left to the route's own settings.
  if (protocol === undefined) return undefined
  if (entry.protocols !== undefined && entry.protocols.length > 0 && !entry.protocols.includes(protocol))
    return undefined
  return entry.dialect
}

/** Read and validate one user rule. Invalid rules are reported, never applied. */
export function readRule(raw: unknown, index: number): { rule?: UserRule; problem?: string } {
  const label = `extraRules[${index}]`
  if (!isPlainObject(raw)) return { problem: `${label} must be an object` }
  const ladder = raw.ladder
  if (!isPlainObject(ladder)) return { problem: `${label} needs a ladder object` }
  const problems = validateLadder(ladder, label)
  if (problems.length > 0) return { problem: problems.join('; ') }
  const pattern = typeof raw.pattern === 'string' ? raw.pattern : undefined
  if (pattern !== undefined) {
    try {
      new RegExp(pattern, 'i')
    } catch (error) {
      return { problem: `${label}.pattern is not a valid regular expression: ${String(error)}` }
    }
  }
  const exact = Array.isArray(raw.exact) ? raw.exact.filter((v): v is string => typeof v === 'string') : undefined
  const prefix = Array.isArray(raw.prefix) ? raw.prefix.filter((v): v is string => typeof v === 'string') : undefined
  if ((exact?.length ?? 0) + (prefix?.length ?? 0) + (pattern ? 1 : 0) === 0)
    return { problem: `${label} declares no matcher (exact, prefix, or pattern)` }
  const protocols = Array.isArray(raw.protocols)
    ? raw.protocols.map(asProtocol).filter((v): v is KnownProtocol => v !== undefined)
    : undefined
  const dialect = readDialect(raw.dialect)
  return {
    rule: {
      id: typeof raw.id === 'string' ? raw.id : undefined,
      exact,
      prefix,
      pattern,
      ladder: ladder as Ladder,
      dialect,
      protocols,
    },
  }
}

/**
 * Validate a dialect block, dropping fields it cannot name.
 * @param raw - the configured `dialect` value.
 * @returns usable switches, or `undefined` when nothing survived.
 */
export function readDialect(raw: unknown): Dialect | undefined {
  if (!isPlainObject(raw)) return undefined
  const dialect: Dialect = {}
  const format = raw.thinkingFormat
  if (typeof format === 'string' && (THINKING_FORMATS as readonly string[]).includes(format))
    dialect.thinkingFormat = format as ThinkingFormat
  if (typeof raw.supportsReasoningEffort === 'boolean') dialect.supportsReasoningEffort = raw.supportsReasoningEffort
  if (typeof raw.supportsDeveloperRole === 'boolean') dialect.supportsDeveloperRole = raw.supportsDeveloperRole
  if (typeof raw.forceAdaptiveThinking === 'boolean') dialect.forceAdaptiveThinking = raw.forceAdaptiveThinking
  return Object.keys(dialect).length > 0 ? dialect : undefined
}

/**
 * Decide the tiers one model should expose.
 * @param input - the model, its route's protocol, and the caller's rules.
 * @returns a suggestion, or `undefined` when nothing can be claimed.
 */
export function suggest(input: SuggestInput): Suggestion | undefined {
  const key = normalizeModelId(input.model)
  const rules = input.rules ?? []

  for (const rule of rules) {
    if (!entryMatches(rule, key) || !protocolAccepts(rule.protocols, input.protocol)) continue
    const dialect = dialectFor(rule, input.protocol)
    return {
      ladder: rule.ladder,
      ...(dialect === undefined ? {} : { dialect }),
      confidence: 'high',
      origin: 'rule',
      source: `extraRules:${rule.id ?? key}`,
    }
  }

  for (const entry of BUILTIN_FAMILIES) {
    if (!entryMatches(entry, key) || !protocolAccepts(entry.protocols, input.protocol)) continue
    const dialect = dialectFor(entry, input.protocol)
    return {
      ladder: entry.ladder,
      ...(dialect === undefined ? {} : { dialect }),
      confidence: entry.confidence,
      origin: 'knowledge',
      source: `family:${entry.id}`,
    }
  }

  if (!input.allowProtocolFallback) return undefined
  const ladder = fallbackLadder(input.protocol)
  if (ladder === undefined || !hasThinkingTier(ladder)) return undefined
  const dialect = endpointDialect(input.baseURL) ?? fallbackDialect(input.protocol)
  return {
    ladder,
    ...(dialect === undefined ? {} : { dialect }),
    confidence: 'low',
    origin: 'protocol',
    source: `protocol:${input.protocol ?? 'unknown'}`,
  }
}

/**
 * The dialect a route should carry, independent of any single model.
 * @param protocol - the route's wire protocol.
 * @param baseURL - the route's endpoint.
 * @returns switches plus their provenance, or `undefined`.
 */
export function suggestRouteDialect(
  protocol: KnownProtocol | undefined,
  baseURL?: unknown,
): { dialect: Dialect; confidence: Confidence; source: string } | undefined {
  const fromHost = endpointDialect(baseURL)
  if (fromHost !== undefined) return { dialect: fromHost, confidence: 'high', source: 'endpoint-host' }
  const fromProtocol = fallbackDialect(protocol)
  if (fromProtocol !== undefined)
    return { dialect: fromProtocol, confidence: 'low', source: `protocol:${protocol ?? 'unknown'}` }
  return undefined
}

/**
 * Check every built-in entry, so a table edit that the provider would refuse
 * fails the test suite instead of a user's settings write.
 * @returns one problem per invalid entry; empty when the table is writable.
 */
export function validateKnowledgeTable(entries: readonly FamilyEntry[] = BUILTIN_FAMILIES): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const label = `family ${entry.id}`
    if (seen.has(entry.id)) problems.push(`${label}: duplicate id`)
    seen.add(entry.id)
    problems.push(...validateLadder(entry.ladder, label))
    if (entry.pattern !== undefined) {
      try {
        new RegExp(entry.pattern, 'i')
      } catch (error) {
        problems.push(`${label}: pattern is not a valid regular expression: ${String(error)}`)
      }
    }
    if (
      (entry.exact?.length ?? 0) + (entry.prefix?.length ?? 0) + (entry.pattern ? 1 : 0) ===
      0
    )
      problems.push(`${label} declares no matcher`)
  }
  return problems
}

/**
 * The levels one ladder offers, in escalation order.
 * @param ladder - a declared ladder.
 * @returns its level names.
 */
export function ladderLevels(ladder: Ladder): ThinkingLevel[] {
  return (Object.keys(ladder) as ThinkingLevel[]).filter((level) => ladder[level] !== undefined)
}
