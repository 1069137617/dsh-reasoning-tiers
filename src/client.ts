/**
 * `dsh-reasoning-tiers`, browser half — the 模型能力 settings page.
 *
 * 1. The page rides the `settings.section` list slot: additive by contract,
 *    the official sections keep working.
 * 2. Data arrives by injection: the bound settings form and the translate
 *    function cross the inject face as plain values, so this bundle
 *    value-imports no other plugin.
 * 3. 0.2.0 moved settings I/O from the removed `settingsScope` service to the
 *    `configForms` service: `configForms.get(entryId)` hands back one entry's
 *    form controller (read face + fenced write queue), and `whileServed`
 *    registers the page only while the Host actually serves that namespace.
 * 4. `inject` below is cordis SERVICE names, unrelated to the
 *    `dsh.client.inject` package list in package.json.
 *
 * @module dsh-reasoning-tiers/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only, all load-bearing for the type checker rather than the bundle:
// each merges its face into cordis' `Context` or the slot table — `ctx.slots`
// exists only because the renderer package declared it, `ctx.locale` and
// `ctx.configForms` only because the locale/settings domain bases declared
// them, and `settings.section` is merged into SlotMap by the settings
// contract. All erased at build, so none reaches the bundle or the purity gate.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { CapabilitiesPage } from './CapabilitiesPage.tsx'
import { bindScope } from './capabilities.ts'
import { NS, en, zh } from './locales.ts'
import { injectStyles } from './styles.ts'

/** Plugin instance id, matching this bundle's cordis.patch.yml entry. */
export const name = 'reasoning-tiers'

/** Cordis services needed before the body runs. */
export const inject = ['slots', 'locale', 'configForms']

const SLOT = 'settings.section'
const ENTRY_ID = 'model-capabilities'
/** Nav position: after the official pages (they own the low numbers). */
const ORDER = 40
/** The Host plugin entry whose form this page edits. */
const PI_AI_NS = 'llm-pi-ai'

/** Mount the browser half. */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'reasoning-tiers: capabilities styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reasoning-tiers: capabilities dictionaries')
  const translate = ctx.locale.bind(NS)
  const form = ctx.configForms.get(PI_AI_NS)
  // whileServed: a deployment that never composed the pi-ai provider shows no
  // trace of the page — same discipline the official cross-namespace pages use.
  ctx.effect(
    () =>
      ctx.configForms.whileServed([PI_AI_NS], () =>
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: ORDER,
              label: () => translate('pageLabel'),
              locale: NS,
              // bindScope: the page hands getSnapshot/subscribe to React bare, and
              // the controller's methods are prototype slots that need `this`.
              // `t` is NOT injected: declaring `locale:` puts the framework's `t`
              // seat on the entry, and a same-named inject face is refused as a
              // duplicate prop by the renderer's assembly check.
              inject: () => ({ scope: bindScope(form) }),
            },
            CapabilitiesPage,
          ),
        ),
      ),
    'reasoning-tiers: model-capabilities page',
  )
}
