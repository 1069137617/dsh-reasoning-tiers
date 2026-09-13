/**
 * `dsh-reasoning-tiers`, browser half — the 模型能力 settings page.
 *
 * 1. The page rides the `settings.section` list slot: additive by contract,
 *    the official sections keep working.
 * 2. Data arrives by injection: the bound settings scope and the translate
 *    function cross the inject face as plain values, so this bundle
 *    value-imports no other plugin.
 * 3. `inject` below is cordis SERVICE names, unrelated to the
 *    `dsh.client.inject` package list in package.json.
 *
 * @module dsh-reasoning-tiers/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only, all load-bearing for the type checker rather than the bundle:
// each merges its face into cordis' `Context` or the slot table — `ctx.slots`
// exists only because the renderer package declared it, `ctx.locale` and
// `ctx.settingsScope` only because the locale/settings domain bases declared
// them, and `settings.section` is merged into SlotMap by the settings
// contract. All erased at build, so none reaches the bundle or the purity gate.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { CapabilitiesPage } from './CapabilitiesPage.tsx'
import { NS, en, zh } from './locales.ts'
import { injectStyles } from './styles.ts'

/** Plugin instance id, matching this bundle's cordis.patch.yml entry. */
export const name = 'reasoning-tiers'

/** Cordis services needed before the body runs. */
export const inject = ['slots', 'locale']

const SLOT = 'settings.section'
const ENTRY_ID = 'model-capabilities'
/** Nav position: after the official pages (they own the low numbers). */
const ORDER = 40

/** Mount the browser half. */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'reasoning-tiers: capabilities styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reasoning-tiers: capabilities dictionaries')
  // Nested, not top-level: a deployment without the settings domain keeps its
  // other registrations alive and simply loses this page.
  ctx.inject(['settingsScope'], (scope) => {
    const binder = scope.settingsScope
    const translate = scope.locale.bind(NS)
    scope.slots.inject(SLOT, () =>
      scope.slots.register(
        {
          name: SLOT,
          id: ENTRY_ID,
          order: ORDER,
          label: () => translate('pageLabel'),
          locale: NS,
          inject: () => ({ scope: binder.bind({ namespace: 'llm-pi-ai' }), t: translate }),
        },
        CapabilitiesPage,
      ),
    )
  })
}
