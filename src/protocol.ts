/**
 * Wire-protocol facts: the dialects pi-ai can dispatch reasoning through, the
 * conservative ladder each protocol implies, and the endpoint hosts this plugin
 * is willing to name a dialect for.
 *
 * The format vocabulary is pi-ai's own `OpenAICompletionsCompat['thinkingFormat']`
 * union (`@earendil-works/pi-ai/dist/types.d.ts`), matching the set
 * `dsh-llm-pi-ai` offers as `SUPPORTED_THINKING_FORMATS`. Fallback ladders are
 * deliberately narrower than the seven-level ceiling: they never invent
 * `xhigh` or `max`, because pi-ai treats those two as opt-in evidence of a
 * real tier (`getSupportedThinkingLevels`, `@earendil-works/pi-ai/dist/models.js:551-560`)
 * and a fabricated spelling is an endpoint error mid-turn, not a no-op.
 *
 * @module dsh-reasoning-tiers/protocol
 */

import type { Ladder } from './ladder.ts'

/** Wire protocols pi-ai can stream over. */
export const KNOWN_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
  'mistral-conversations',
  'pi-messages',
] as const

/** One known wire protocol. */
export type KnownProtocol = (typeof KNOWN_PROTOCOLS)[number]

/** Reasoning-dispatch dialects a profile may name. */
export const THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const

/** One reasoning-dispatch dialect. */
export type ThinkingFormat = (typeof THINKING_FORMATS)[number]

/**
 * The route-level compatibility switches this plugin may write. Every field
 * here is offered by `PiAiCompatProfile`; they are written at **route** level on
 * purpose: a route-level switch "skips past models it cannot fit"
 * (`dsh-llm-pi-ai/lib/types/catalog.d.ts`), while a model-level switch its
 * resolved protocol does not declare refuses the whole settings write.
 */
export interface Dialect {
  /** Reasoning parameter format the endpoint expects. */
  thinkingFormat?: ThinkingFormat
  /** Whether the endpoint accepts `reasoning_effort`. */
  supportsReasoningEffort?: boolean
  /** Whether the endpoint accepts the `developer` role for the system prompt. */
  supportsDeveloperRole?: boolean
  /** Whether to force adaptive thinking regardless of model id (`anthropic-messages`). */
  forceAdaptiveThinking?: boolean
}

/**
 * Narrow a configured `api` value to a protocol this module reasons about.
 * @param api - the route's configured wire protocol, when it names one.
 * @returns the protocol, or `undefined` for an unknown or absent spelling.
 */
export function asProtocol(api: unknown): KnownProtocol | undefined {
  return typeof api === 'string' && (KNOWN_PROTOCOLS as readonly string[]).includes(api)
    ? (api as KnownProtocol)
    : undefined
}

/**
 * The conservative ladder a protocol implies when no family entry matched.
 * @param protocol - the route's resolved wire protocol.
 * @returns a ladder to offer, or `undefined` when nothing can be claimed.
 */
export function fallbackLadder(protocol: KnownProtocol | undefined): Ladder | undefined {
  switch (protocol) {
    case 'openai-completions':
      return { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { off: null, low: 'low', medium: 'medium', high: 'high' }
    case 'anthropic-messages':
      // Every current Claude release thinks unless told otherwise: naming `off`
      // here would offer a control the endpoint cannot honour.
      return { low: 'low', medium: 'medium', high: 'high' }
    case 'google-generative-ai':
    case 'google-vertex':
      return { off: null, low: 'low', medium: 'medium', high: 'high' }
    default:
      return undefined
  }
}

/**
 * The dialect switches a protocol needs alongside its fallback ladder.
 * @param protocol - the route's resolved wire protocol.
 * @returns switches safe to write at route level, or `undefined`.
 */
export function fallbackDialect(protocol: KnownProtocol | undefined): Dialect | undefined {
  switch (protocol) {
    case 'openai-completions':
      return { thinkingFormat: 'openai', supportsReasoningEffort: true }
    case 'anthropic-messages':
      return { forceAdaptiveThinking: true }
    default:
      return undefined
  }
}

/**
 * Endpoints whose host name is itself evidence of a dialect. This list is
 * intentionally tiny: pi-ai guesses these from the URL, and guessing wrong for
 * a private gateway is precisely what the `catalog.d.ts` doc calls out. A host
 * joins this table only with a vendor document naming the dialect.
 */
const ENDPOINT_DIALECTS: Readonly<Record<string, Dialect>> = {
  'api.deepseek.com': { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
  'api.openai.com': { thinkingFormat: 'openai', supportsReasoningEffort: true },
  'api.anthropic.com': { forceAdaptiveThinking: true },
}

/**
 * Read the dialect an official endpoint's own host name vouches for.
 * @param baseURL - the configured route endpoint.
 * @returns dialect switches, or `undefined` for an unrecognized host.
 */
export function endpointDialect(baseURL: unknown): Dialect | undefined {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return undefined
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return ENDPOINT_DIALECTS[host]
}
