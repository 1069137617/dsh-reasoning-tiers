# dsh-reasoning-tiers

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-93%20passing-brightgreen.svg)](#development)

**Give third-party models a working reasoning-effort ladder — and editable model capabilities — in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

A DSH plugin that matches third-party model ids against a built-in knowledge table and declares
their reasoning tiers in the `llm-pi-ai` settings section — so the effort selector that ships with
DSH finally does something for models the pi-ai catalog does not describe. New in 0.2.0: a browser
half that adds a **Model Capabilities** page to the settings panel, where each added model's
context window, output cap, and image modality become editable fields.

0.3.1 adapts to **DSH 0.2.0** (desktop 0.2.0-rc.2): the host half rides the renamed
`settings/document-updated` event and reads resolved sections off `describe()` (0.2.0 dropped
`settings.get`), and the browser half registers through the `configForms` service that replaced
`settingsScope`. The 0.1.x event and `get()` stay supported in the host half; the capabilities
page requires a 0.2.0 host.

No adapter takeover, no request interception. The tier writes happen once, conservatively, and
with an undo; the capabilities page only edits the provider's own settings through the standard
settings transport. 中文文档：[README.zh.md](README.zh.md)

---

## The problem is structural, not a missing toggle

A model's selectable efforts come from exactly one place —
`LlmResolvedModelInfo.reasoning` (`@deepseek-ai/dsh-llm/lib/types/types.d.ts:377-382`) — and the
pi-ai adapter omits it entirely for a model that carries no reasoning metadata:

```js
// dsh-llm-pi-ai/lib/index.js:1726-1740 (0.2.0)
function reasoningInfo(model, defaultLevel) {
  if (!model.reasoning) return {};   // every hand-declared model lands here
  ...
}
```

There is no other seam to fix this from:

- The official Models page has no field for `reasoningEfforts`, and its only slots
  (`settings.models.provider-card`, `settings.models.footer`) cannot reach a model row
  (`dsh-client-ui-settings-models/.../slot-contract.d.ts:21-44`).
- Taking over the route is impossible: `registerAdapter` throws `DUPLICATE_ADAPTER`
  (`dsh-llm/lib/types/index.d.ts:241-248`), and `llm/stream` is the only waterfall, whose
  loop-built requests are deep-frozen by contract.

Capability is configuration, so that is what this plugin writes.

## Install

From npm (recommended):

```sh
dsh plugin --profile web add dsh-reasoning-tiers
```

or straight from this repository:

```sh
dsh plugin --profile web add git+https://github.com/1069137617/dsh-reasoning-tiers.git
```

`prepare` builds `lib/` on install. Back up the profile's `cordis.patch.yml` first: the plugin
edits the `llm-pi-ai` section of the profile it is installed into, and **bundle changes are read
at boot**, so restart DSH afterwards (`patchReload: live` only hot-reloads the profile's own patch
file). On 0.2.0 that profile patch is the settings document (a legacy `~/.dsh/settings.yaml` is
imported once at startup and renamed `.imported`). After a restart the plugin announces itself:

```
[reasoning-tiers] mounted: autofill=true revert=false diagnose=true widenToGlobalEffort=false extraRules=0
```

> **Developing from a local checkout**: if you install with a local path (`dsh plugin add <dir>`),
> dependencies resolve from the plugin's *own* `node_modules` (`peerDependencies` +
> `devDependencies`, installed by `npm install` inside the checkout). Do not run
> `npm ci --omit=dev`, `npm prune`, or delete that `node_modules`, or the plugin will fail to
> load on the next boot. Installing from npm or git does not have this caveat.

## What it writes — and what it refuses to

For every model configured under `llm-pi-ai.providers.*`, the plugin probes the live model seam
and computes the smallest write that gives the model a usable ladder:

| Situation | Action |
| --- | --- |
| Model offers no tier (hand-declared id, or outside the pi-ai catalog) | Declare a ladder from the knowledge table, or a protocol fallback for the wire protocol. |
| Model already offers a tier | **Left alone.** Declaring `reasoningEfforts` *replaces* the inherited capability and pins every unlisted level unsupported, and the wire spelling behind an inherited tier is only known to the provider. |
| A family table entry covers the model | Ladder + dialect, with its confidence and source recorded in the log. |
| No entry and no protocol | Skipped with the reason in the log — never guessed. |

Every write is journaled to `<DSH_HOME>/dsh-reasoning-tiers/journal.json` (atomic tmp + rename),
so `revert: true` undoes exactly what the plugin wrote and leaves anything the user edited since
(`changed-by-user`) in place.

## Flat ladders are reported, never rewritten

A model can *have* tiers whose choices are indistinguishable on the wire. When the catalog has no
`thinkingLevelMap` and `compat.supportsReasoningEffort` is `false`, the `qwen` dialect dispatch
sends only `enable_thinking = !!reasoningEffort`
(`pi-ai/dist/api/openai-completions.js:645-653`) — `low`, `medium` and `high` are three names for
one request.

Declaring a richer `reasoningEfforts` dict **cannot fix this**: the level's spelling is only
consulted when the compat switch already admits an effort string, so the request bytes stay
identical and only the menu changes. An automatic rewrite would trade three honest-looking tiers
for four misleading ones, so the plugin reports it and stops:

```
acme/qwen3.6-flash has a flat ladder (minimal, low, medium, high): every non-"off" choice sends
the same request, so the thinking-intensity control cannot change anything.
```

If you know your gateway accepts `reasoning_effort`, say so explicitly:

```yaml
- id: reasoning-tiers
  config:
    extraRules:
      - prefix: ["qwen3.6-"]
        ladder: { off: null, low: "low", medium: "medium", high: "high" }
        dialect: { supportsReasoningEffort: true }   # this is the part that actually works
```

## Model Capabilities page

Since 0.2.0 the plugin ships a browser half that registers one entry into the `settings.section`
list slot: **Settings → Model Capabilities** (设置 → 模型能力). It lists every route configured
under `llm-pi-ai` and edits three fields per model row:

| Field | Settings key | Empty cell means |
| --- | --- | --- |
| Context window | `contextWindow` | Inherit — the field is removed and the catalog value applies. |
| Max output tokens | `maxTokens` | Inherit, same rule. |
| Image input | `input` | Three states, see below. |

Both counts must be a positive integer; anything else is marked invalid inline and the save is
refused before it reaches the Host.

### Quick-pick steps

Since 0.3.0 both number cells carry a `<datalist>`: focus the field (or use its dropdown arrow)
and pick a step, or keep typing any value you like — the list is a suggestion, never a constraint.
The step a typed value lands on shows in the field's tooltip (`Context window · 128K`).

| Context window | 32768 | 65536 | 131072 | 200000 | 262144 | 272000 | 400000 | 1000000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| label | 32K | 64K | 128K | 200K | 256K | 272K | 400K | 1M |
| **Max output** | 1024 | 4096 | 16384 | 32768 | 65536 | 131072 | 262144 | |
| label | 1K | 4K | 16K | 32K | 64K | 128K | 256K | |

Values follow whoever actually publishes the number: binary where the pi-ai catalog and vendor
configs spell it that way (128K = 131072, 256K = 262144), decimal where the announcement is decimal
(200K = 200000, 1M = 1000000). Each nominal step appears exactly once, so no label carries two
meanings. The table is one array in `src/capabilities.ts` — edit it there to add a step.

### The image switch is a true tri-state

- **Follow catalog** (`inherit`) — the `input` field is deleted from the entry. The adapter treats
  an absent or empty `input` as "no answer" and falls back to the catalog model
  (`dsh-llm-pi-ai/lib/index.js:292-294`).
- **On** — writes `input: ["text", "image"]`; image requests pass the per-request gate.
- **Off** — writes `input: ["text"]`, an explicit negative capability. An image-bearing request
  then throws `UNSUPPORTED_CONTENT` (`dsh-llm-pi-ai/lib/index.js:1844-1845`) instead of being
  silently degraded by the provider.

### Two write shapes, one per route kind

- **Declared models list** — routes whose user layer declares a `models[]` array. The page drafts
  the entire array and commits it as one `set` of `providers.<route>.models` — the official Models
  editor's convention, so fields the page does not manage (`name`, `reasoningEfforts`, anything
  custom) survive untouched.
- **Catalog routes** — the page writes `providers.<route>.modelOverrides` as a dict keyed by model
  id. An "Add override" row pins a capability for a catalog model without declaring it; an emptied
  dict is `unset`, returning the route to pure catalog inheritance.

All writes go through the settings form's revision-fenced `mutate`; a refusal (the configuration
changed elsewhere) resolves `false` — the form re-reads the document and the page asks you to
re-apply. Where the deployment does not accept browser settings writes (memory mode) the page
renders read-only. Writes take effect on the next request — no restart.

**Out of scope:** `llm-deepseek` routes (a different adapter and namespace), and every namespace
other than `llm-pi-ai`.

## Configuration

The plugin's *own* configuration lives in the bundle's `cordis.patch.yml` entry. (The Model
Capabilities page above edits the provider's own `llm-pi-ai` namespace, not this config.)
The shipped bundle declares **no** `config:` block on purpose, so profile-level overrides merge
cleanly:

```yaml
- id: reasoning-tiers
  config:
    autofill: true                # master switch
    revert: false                 # one-shot undo pass; set back to false afterwards
    compatAutofill: true          # may add route-level compat (whitelisted fields only)
    respectExisting: true         # never rewrite a model that already offers a tier
    diagnose: true                # read-only audit: tiers, flat ladders, unreachable default
    widenToGlobalEffort: false    # opt-in: add the deployment's default effort to a ladder
    alignGlobalEffort: false      # opt-in: include it in new ladders, passthrough dialects only
    excludeProviders: []
    excludeModels: ["*embed*", "*vision*"]
    maxProbes: 200
    debounceMs: 250
    bootRetryDelaysMs: [1000, 2000, 4000, 8000, 16000, 30000]
    extraRules:                   # highest precedence, above the built-in table
      - pattern: "^my-gateway-model$"
        ladder: { off: null, low: "low", high: "high" }
        dialect: { thinkingFormat: openai, supportsReasoningEffort: true }
```

| Key | Default | Effect |
| --- | --- | --- |
| `autofill` | `true` | Master switch. `false` makes the plugin fully read-only. |
| `revert` | `false` | Run one undo pass from the ledger, then set this back to `false`. |
| `compatAutofill` | `true` | Add route-level compat, only `thinkingFormat` / `supportsReasoningEffort` / `supportsDeveloperRole` / `forceAdaptiveThinking`. |
| `respectExisting` | `true` | Never rewrite a model that already offers a tier. |
| `diagnose` | `true` | Read-only audit: current tiers, flat ladders, and models that cannot reach the deployment's default effort. |
| `widenToGlobalEffort` | `false` | Add the deployment's default effort to a ladder that lacks it. Rebuilds on the "level name = wire value" convention and is logged at `medium` confidence. |
| `alignGlobalEffort` | `false` | Include the default effort in newly written ladders — passthrough dialects only (`openai`, `openrouter`, `together`, unset); a vendor-specific spelling is never invented. |
| `excludeProviders` / `excludeModels` | `[]` | Exact route names / model-id globs (`*`, `?`, case-insensitive). |
| `maxProbes` | `200` | Probe budget per pass. |
| `debounceMs` | `250` | Settings-event debounce window. |
| `bootRetryDelaysMs` | `[1000…30000]` | Boot retry schedule while the provider namespace registers. |
| `extraRules` | `[]` | Custom rules; each takes one of `pattern` (regex) / `prefix` / `exact`, plus `ladder`, optional `dialect` and `protocols`. An invalid rule is dropped with its reason, never silently. |

## Built-in knowledge table

Twelve families ship with the plugin: Qwen3, DeepSeek V4, DeepSeek R1/V3.1, GLM-5, GLM-4.5V,
Kimi K2, MiniMax M, GPT-5, o-series, Claude, Gemini thinking, and Grok-4. Each entry names its
ladder, optional dialect, accepted protocols, confidence, and the source of the claim. Matching
precedence is `extraRules` → exact id → prefix → pattern → protocol fallback, and an unknown
protocol never inherits a dialect. A protocol with no reasoning dispatch gets no ladder at all —
nothing is invented, and `xhigh`/`max` are never fabricated where a vendor does not spell them.

## Development

```sh
npm install
npm run build        # tsc -> lib/ (host) + esbuild -> lib/client.js (browser half)
npm run typecheck    # both tsconfigs, no emit
npm test             # node --test, 93 tests
node scripts/dry-run.mjs [--widen] [settings-path]   # audit a settings.yaml, writes nothing
node scripts/verify-install.mjs web                  # replay the host's bundle resolution
```

The planner is a pure function of the raw user layer, the resolved config, and one injected
capability probe — which is what makes the whole policy testable without a Host, a provider, or a
network. The capabilities page follows the same discipline: its edit/draft/op model is
`src/capabilities.ts`, a plain module over plain JSON (`test/capabilities.test.mjs`), and the
React component only renders. `test/wiring.test.mjs` is the one place the host seams are
exercised, against a fake Cordis context; `test/client-bundle.test.mjs` holds the browser bundle
to its loader contract.

## Known limitations

- **A flat ladder cannot be repaired automatically.** `reasoningEfforts` changes the menu, not
  whether the adapter sends an effort string. See above.
- **`widenToGlobalEffort` is an assertion.** Adding a tier the catalog marks unsupported
  (`high: null`) claims the upstream accepts it. Opt-in, `medium` confidence, journaled.
- **`llm-deepseek` routes are out of scope** (`deepseek-official` uses another adapter whose tier
  set comes from route-level `thinking`/`reasoningEffort`, and whose `models[]` schema does not
  accept `reasoningEfforts`).
- Only the `llm-pi-ai` namespace is covered — by both the tier writes and the capabilities page.
- Flat-ladder detection is a **fingerprint**, not a probe: an offered set of exactly
  `off/minimal/low/medium/high` is the shape `getSupportedThinkingLevels` produces for an absent
  `thinkingLevelMap` (`pi-ai/dist/models.js:551-561`). A provider that genuinely maps all five
  base levels to distinct spellings would be misjudged. `scripts/dry-run.mjs` prints both the
  fingerprint and the catalog verdict so the two can be cross-checked.

## Acknowledgments

Prior art: [`dsh-better-reasoning-effort`](https://www.npmjs.com/package/dsh-better-reasoning-effort)
(HaoyueQin, MIT) does more — a model-row DOM editor, `/models` probing, a composer slider. This
plugin is the lean, host-only take: write settings, let the stock selector consume them. Also see
`dsh-thinking-levels`, `@hytime/dsh-thinking-effort`, `dsh-models-radar`.

## License

[MIT](LICENSE)
