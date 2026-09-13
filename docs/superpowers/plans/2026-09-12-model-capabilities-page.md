# 模型能力设置页（dsh-reasoning-tiers v0.2.0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-reasoning-tiers` 增加浏览器半：设置面板新页「模型能力」，可视化编辑每个已添加模型的 `contextWindow` / `maxTokens` / 图片模态三态。

**Architecture:** 客户端半注册 `settings.section` 槽位渲染页面；数据读自 `ctx.settingsScope.describe()` 共享镜像的 `llm-pi-ai` 用户层，写回走 `bind({namespace:'llm-pi-ai'})` 的 `mutate`（revision 围栏，整条数组/字典 set，不用 per-index op）。编辑策略为纯函数（`capabilities.ts`），React 组件只做呈现。

**Tech Stack:** TypeScript + React 18（外部化）+ esbuild 打包 + node --test。

## Global Constraints

- 浏览器半：单次 `window.__ModuleLoader__.load({id, factory})`，`id` 与包名逐字节相等，factory 同步。
- bundle `require` 只允许 9 个平台种子：`react`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
- 禁止跨插件**值**导入（cordis 服务协作）；类型导入在构建前被擦除。
- 不使用 per-index 数组路径 op；只整条 `models` 数组 / `modelOverrides` 字典 set（空字典用 unset）。
- `@deepseek-ai/*` 依赖钉死 `0.1.5-rc.2`（npmmirror 的 latest 是过期的 rc.1）。
- 现有 74 项测试必须保持绿色。

---

### Task 1: capabilities.ts 纯函数（TDD）

**Files:**
- Create: `src/capabilities.ts`
- Modify: `tsconfig.json`（include 加 `src/capabilities.ts`）
- Test: `test/capabilities.test.mjs`

**Interfaces:**
- Consumes: `isPlainObject` from `./ladder.ts`（已存在）
- Produces: `ImageMode`、`ModelDraft`、`ProviderDraft`、`PathOp`、`parseProviders(resolved, user)`、`rebuildEntry(draft)`、`invalidField(draft)`、`buildMutateOps(providerDraft)`、`draftsKey(drafts)`、`isValidCountText(text)`、`countValue(text)`、`emptyOverrideRow()`

- [ ] **Step 1: 写失败测试** `test/capabilities.test.mjs`

```mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProviders, rebuildEntry, invalidField, buildMutateOps, draftsKey,
  isValidCountText, countValue, emptyOverrideRow,
} from '../lib/capabilities.js'

const RESOLVED = { providers: { 'qwen-cn': { apiKeyEnv: 'QWEN_KEY' }, 'openai': { apiKeyEnv: 'O' } } }
const USER = {
  providers: {
    'qwen-cn': { models: [
      { id: 'qwen3.8-flash', name: 'Flash', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 262144 },
      { id: 'qwen3.6-plus', input: ['text'], custom: 7 },
    ] },
  },
}

test('parse: declared models list carries raw entries and tri-state image', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(p.route, 'qwen-cn')
  assert.equal(p.hasModelsList, true)
  assert.equal(p.models.length, 2)
  assert.equal(p.models[0].id, 'qwen3.8-flash')
  assert.equal(p.models[0].contextText, '262144')
  assert.equal(p.models[0].image, 'inherit')
  assert.equal(p.models[1].image, 'off')
  assert.deepEqual(p.models[0].raw.reasoningEfforts, { off: null, high: 'high' })
})

test('parse: catalog route without user layer is empty and override-shaped', () => {
  const [openai] = parseProviders(RESOLVED, { providers: {} })
  assert.equal(openai.route, 'openai')
  assert.equal(openai.hasModelsList, false)
  assert.deepEqual(openai.models, [])
})

test('parse: modelOverrides rows take id from the dict key', () => {
  const [p] = parseProviders(RESOLVED, { providers: { openai: { modelOverrides: { 'gpt-5': { contextWindow: 400000 } } } } })
  assert.equal(p.hasModelsList, false)
  assert.equal(p.models[0].id, 'gpt-5')
  assert.equal(p.models[0].contextText, '400000')
})

test('parse: resolved absent falls back to user-layer routes; junk tolerated', () => {
  assert.deepEqual(parseProviders(undefined, USER).map(p => p.route), ['qwen-cn'])
  assert.deepEqual(parseProviders(null, null), [])
})

test('image tri-state mapping and count text', () => {
  assert.equal(isValidCountText(''), true)
  assert.equal(isValidCountText('131072'), true)
  assert.equal(isValidCountText('1.5'), false)
  assert.equal(isValidCountText('-3'), false)
  assert.equal(countValue(''), undefined)
  assert.equal(countValue('4096'), 4096)
  assert.equal(emptyOverrideRow().id, '')
})

test('rebuildEntry preserves unknown fields and applies set/delete semantics', () => {
  const [p] = parseProviders(RESOLVED, USER)
  const kept = { ...p.models[0], contextText: '131072', maxText: '32768', image: 'on' }
  const out = rebuildEntry(kept)
  assert.equal(out.contextWindow, 131072)
  assert.equal(out.maxTokens, 32768)
  assert.deepEqual(out.input, ['text', 'image'])
  assert.deepEqual(out.reasoningEfforts, { off: null, high: 'high' })
  assert.equal(out.name, 'Flash')
  const inherit = rebuildEntry({ ...p.models[0], contextText: '', maxText: '', image: 'inherit' })
  assert.ok(!('contextWindow' in inherit))
  assert.ok(!('maxTokens' in inherit))
  assert.ok(!('input' in inherit))
  assert.equal(inherit.custom, undefined)
  const off = rebuildEntry({ ...p.models[1], image: 'off' })
  assert.deepEqual(off.input, ['text'])
  assert.equal(off.custom, 7)
})

test('invalidField flags non-positive-integer text', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(invalidField({ ...p.models[0], contextText: 'x' }), 'context')
  assert.equal(invalidField({ ...p.models[0], maxText: '0' }), 'max')
  assert.equal(invalidField({ ...p.models[0], contextText: '', maxText: '' }), undefined)
})

test('ops: declared route = one whole-array set', () => {
  const [p] = parseProviders(RESOLVED, USER)
  const ops = buildMutateOps({ ...p, models: p.models.map((m, i) => i === 0 ? { ...m, contextText: '99' } : m) })
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].op === 'set' && ops[0].path, ['providers', 'qwen-cn', 'models'])
  const arr = ops[0].op === 'set' ? ops[0].value : undefined
  assert.equal(arr[0].contextWindow, 99)
  assert.ok(!('contextWindow' in arr[1]))
  assert.deepEqual(arr[0].reasoningEfforts, { off: null, high: 'high' })
})

test('ops: override route = dict set; empty dict = unset', () => {
  const [openai] = parseProviders(RESOLVED, { providers: {} })
  const rows = [emptyOverrideRow(), { ...emptyOverrideRow(), id: '', contextText: '', maxText: '', image: 'inherit' }]
  const withId = [{ ...emptyOverrideRow(), id: 'gpt-5', contextText: '400000', image: 'off' }]
  const ops = buildMutateOps({ ...openai, models: withId })
  assert.equal(ops[0].op, 'set')
  assert.deepEqual(ops[0].path, ['providers', 'openai', 'modelOverrides'])
  const dict = ops[0].value
  assert.equal(dict['gpt-5'].contextWindow, 400000)
  assert.deepEqual(dict['gpt-5'].input, ['text'])
  assert.ok(!('id' in dict['gpt-5']))
  assert.equal(buildMutateOps({ ...openai, models: rows.map(r => ({ ...r, id: '' })) })[0].op, 'unset')
})

test('draftsKey is stable and order-sensitive', () => {
  const [p] = parseProviders(RESOLVED, USER)
  assert.equal(draftsKey(p.models), draftsKey([...p.models]))
  assert.notEqual(draftsKey(p.models), draftsKey(p.models.map(m => ({ ...m, image: 'on' }))))
})
```

- [ ] **Step 2: 跑测试确认失败** — `npm run build:host && node --test test/capabilities.test.mjs` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `src/capabilities.ts`

```ts
/**
 * Pure editing logic behind the 模型能力 settings page.
 *
 * Plain functions over plain JSON so the page policy is testable without
 * React, a browser, or a Host. Evidence anchors:
 * - model entry schema fields: dsh-llm-pi-ai/lib/index.js:968-976
 * - resolution precedence entry ?? catalog ?? default, and `declaredInput`
 *   treating absent/empty as "no answer": :670-682, :292-294
 * - the per-request image gate reading model.input: :1844-1845
 * - whole-array commit convention (unknown fields survive): the official
 *   Models editor drafts the entire models list (ModelListEditor.d.ts:20-23)
 *
 * @module dsh-reasoning-tiers/capabilities
 */
import { isPlainObject } from './ladder.ts'

/** Modalities that admit image requests through the adapter gate. */
export const IMAGE_ON: readonly string[] = ['text', 'image']
/** Explicit negative capability: text-only; image requests throw UNSUPPORTED_CONTENT. */
export const IMAGE_OFF: readonly string[] = ['text']

/** Three-state image switch for one model row. */
export type ImageMode = 'inherit' | 'on' | 'off'

/** One editable model row: parsed user-layer view plus the raw entry. */
export interface ModelDraft {
  id: string
  /** Input text for contextWindow; '' = inherit (field removed). */
  contextText: string
  /** Input text for maxTokens; '' = inherit. */
  maxText: string
  image: ImageMode
  /** The original user-layer entry; unknown fields survive edits through it. */
  raw: Record<string, unknown>
}

/** One provider route as the page groups them. */
export interface ProviderDraft {
  route: string
  /** true when the user layer declares a `models` array (vs catalog + overrides). */
  hasModelsList: boolean
  models: readonly ModelDraft[]
}

/** Path-op shape the settings scope takes (structurally typed, no package edge). */
export type PathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

const countPattern = /^\d+$/

/** Whether the text is a valid count field: empty (inherit) or a positive integer. */
export function isValidCountText(text: string): boolean {
  return text === '' || (countPattern.test(text) && Number(text) > 0)
}

/** Resolve count text to a number; '' (inherit) and invalid text resolve to undefined. */
export function countValue(text: string): number | undefined {
  return text !== '' && countPattern.test(text) && Number(text) > 0 ? Number(text) : undefined
}

function imageModeOf(input: unknown): ImageMode {
  if (!Array.isArray(input) || input.length === 0) return 'inherit'
  return input.includes('image') ? 'on' : 'off'
}

function countText(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? String(value) : ''
}

function draftOf(id: string, raw: Record<string, unknown>): ModelDraft {
  return { id, contextText: countText(raw.contextWindow), maxText: countText(raw.maxTokens), image: imageModeOf(raw.input), raw }
}

/** A blank override row for the add-override flow on catalog routes. */
export function emptyOverrideRow(): ModelDraft {
  return { id: '', contextText: '', maxText: '', image: 'inherit', raw: {} }
}

/**
 * Group the configured pi-ai routes for the page.
 * Routes enumerate from the resolved section (every configured route), while
 * rows come from the USER layer only — `models` arrays make a route declared,
 * `modelOverrides` make it a catalog route, and absence leaves it empty.
 */
export function parseProviders(resolved: unknown, user: unknown): ProviderDraft[] {
  const routes: string[] = []
  const seen = new Set<string>()
  const collect = (section: unknown): void => {
    if (!isPlainObject(section) || !isPlainObject(section.providers)) return
    for (const [route, profile] of Object.entries(section.providers)) {
      if (typeof route === 'string' && route.length > 0 && isPlainObject(profile) && !seen.has(route)) {
        seen.add(route)
        routes.push(route)
      }
    }
  }
  collect(resolved)
  collect(user)

  const userProviders = isPlainObject(user) && isPlainObject(user.providers) ? user.providers : {}
  const drafts: ProviderDraft[] = []
  for (const route of routes) {
    const layer = isPlainObject(userProviders[route]) ? userProviders[route] : undefined
    const models = layer === undefined ? undefined : layer.models
    if (Array.isArray(models)) {
      const rows = models.filter((entry): entry is Record<string, unknown> => isPlainObject(entry) && typeof entry.id === 'string' && entry.id.length > 0)
        .map((entry) => draftOf(entry.id, entry))
      drafts.push({ route, hasModelsList: true, models: rows })
      continue
    }
    const overrides = layer === undefined ? undefined : layer.modelOverrides
    if (isPlainObject(overrides)) {
      const rows = Object.entries(overrides).filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === 'string' && entry[0].length > 0 && isPlainObject(entry[1]))
        .map(([id, raw]) => draftOf(id, raw))
      drafts.push({ route, hasModelsList: false, models: rows })
      continue
    }
    drafts.push({ route, hasModelsList: false, models: [] })
  }
  return drafts
}

/** Apply one row's edits to its raw entry: managed fields set/deleted, unknown fields untouched. */
export function rebuildEntry(draft: ModelDraft): Record<string, unknown> {
  const next: Record<string, unknown> = { ...draft.raw }
  next.id = draft.id
  const contextWindow = countValue(draft.contextText)
  if (contextWindow === undefined) delete next.contextWindow
  else next.contextWindow = contextWindow
  const maxTokens = countValue(draft.maxText)
  if (maxTokens === undefined) delete next.maxTokens
  else next.maxTokens = maxTokens
  if (draft.image === 'on') next.input = [...IMAGE_ON]
  else if (draft.image === 'off') next.input = [...IMAGE_OFF]
  else delete next.input
  return next
}

/** The first invalid field of a row, for inline marking; id is validated per route. */
export function invalidField(draft: ModelDraft): 'context' | 'max' | undefined {
  if (!isValidCountText(draft.contextText)) return 'context'
  if (!isValidCountText(draft.maxText)) return 'max'
  return undefined
}

/**
 * The write for one route: a single whole-value op at an object path — the
 * official editor's convention, which keeps unknown fields alive and never
 * addresses an array index. An emptied overrides dict unsets the field so the
 * route returns to pure catalog inheritance.
 */
export function buildMutateOps(draft: ProviderDraft): PathOp[] {
  if (draft.hasModelsList) {
    return [{ op: 'set', path: ['providers', draft.route, 'models'], value: draft.models.map(rebuildEntry) }]
  }
  if (draft.models.length === 0) {
    return [{ op: 'unset', path: ['providers', draft.route, 'modelOverrides'] }]
  }
  const dict: Record<string, unknown> = {}
  for (const row of draft.models) {
    const entry = rebuildEntry(row)
    delete entry.id // the dict key carries the id (adapter:649)
    dict[row.id] = entry
  }
  return [{ op: 'set', path: ['providers', draft.route, 'modelOverrides'], value: dict }]
}

/** Stable identity of a draft list for dirty checks (order-sensitive). */
export function draftsKey(models: readonly ModelDraft[]): string {
  return JSON.stringify(models.map((m) => [m.id, m.contextText, m.maxText, m.image]))
}
```

- [ ] **Step 4:** `tsconfig.json` 的 `include` 改为 `["src/index.ts", "src/ladder.ts", "src/capabilities.ts"]`（注意：现有 include 可能已含其它文件，保持原样只加 capabilities.ts；ladder.ts 若已在 include 里则不动）
- [ ] **Step 5: 跑测试通过** — `npm run build:host && node --test test/capabilities.test.mjs` → PASS
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(capabilities): pure edit/draft/op model for the capabilities page"`

### Task 2: 客户端源码（locales / styles / Page / client.ts）

**Files:**
- Create: `src/locales.ts`, `src/styles.ts`, `src/CapabilitiesPage.tsx`, `src/client.ts`, `tsconfig.client.json`
- Test: typecheck only（`npm run typecheck`）

**Interfaces:**
- Consumes: Task 1 全部导出；`ctx.settingsScope.bind({namespace})`（`SettingsScopeBinder` 服务）；`ctx.slots.inject/register`；`ctx.locale.register/bind`
- Produces: `apply(ctx)`（esbuild 入口的默认导出语义，named `apply` 同 slider）

- [ ] **Step 1:** 写 `src/locales.ts`

```ts
/** Registrant-localized copy for the capabilities page. @module dsh-reasoning-tiers/locales */
export const NS = 'reasoning-tiers'

export const en = {
  pageLabel: 'Model Capabilities',
  contextWindow: 'Context window',
  maxTokens: 'Max output tokens',
  imageInput: 'Image input',
  imageOn: 'On',
  imageOff: 'Off',
  imageInherit: 'Follow catalog',
  inheritMark: 'inherit',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  readOnlyHint: 'This deployment does not accept settings writes from the browser.',
  restartHint: 'Applies after a restart.',
  unsavedHint: 'Unsaved changes in this group.',
  saveConflict: 'The configuration changed elsewhere — reload the page and re-apply.',
  saveFailed: 'Save failed',
  addOverride: 'Add override',
  modelIdPlaceholder: 'model id as the endpoint accepts it',
  modelIdRequired: 'Every row needs a model id.',
  remove: 'Remove',
  invalidNumber: 'Must be a positive integer.',
  catalogEmpty: 'Catalog route with no overrides — add one to pin a capability.',
  declaredHint: 'Declared models list',
  overridesHint: 'Catalog overrides',
} as const

export const zh: typeof en = {
  pageLabel: '模型能力',
  contextWindow: '上下文窗口',
  maxTokens: '输出上限',
  imageInput: '图片输入',
  imageOn: '开启',
  imageOff: '关闭',
  imageInherit: '跟随目录',
  inheritMark: '继承',
  save: '保存',
  saving: '保存中…',
  saved: '已保存。',
  readOnlyHint: '当前部署不接受浏览器写入设置。',
  restartHint: '重启后生效。',
  unsavedHint: '该分组有未保存的修改。',
  saveConflict: '配置已在别处被修改——请刷新页面后重试。',
  saveFailed: '保存失败',
  addOverride: '添加覆盖',
  modelIdPlaceholder: '端点接受的模型 id',
  modelIdRequired: '每一行都需要模型 id。',
  remove: '移除',
  invalidNumber: '必须是正整数。',
  catalogEmpty: 'catalog 路由，暂无覆盖——添加一条以固定能力。',
  declaredHint: '已声明的模型列表',
  overridesHint: '目录模型覆盖',
}
```

- [ ] **Step 2:** 写 `src/styles.ts`

```ts
/** Scoped styles for the capabilities page. @module dsh-reasoning-tiers/styles */
const STYLE_ID = 'dsh-reasoning-tiers-capabilities'

const CSS = `
.dsh-rt-cap-group{border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:12px;margin:0 0 16px}
.dsh-rt-cap-title{font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.dsh-rt-cap-tag{font-size:11px;opacity:.6;font-weight:400}
.dsh-rt-cap-table{width:100%;border-collapse:collapse}
.dsh-rt-cap-table th{text-align:left;font-weight:500;opacity:.7;padding:4px 8px}
.dsh-rt-cap-table td{padding:4px 8px;border-top:1px solid rgba(128,128,128,.2)}
.dsh-rt-cap-input{width:110px}
.dsh-rt-cap-invalid{border-color:#d33 !important}
.dsh-rt-cap-actions{margin-top:8px;display:flex;gap:8px;align-items:center}
.dsh-rt-cap-msg{font-size:12px}
.dsh-rt-cap-msg.ok{color:#2a7}
.dsh-rt-cap-msg.conflict{color:#d70}
.dsh-rt-cap-msg.error{color:#d33}
.dsh-rt-cap-hint{font-size:12px;opacity:.65;margin:2px 0 8px}
.dsh-rt-cap-empty{opacity:.65;padding:8px 4px}
`

/** Append the stylesheet once; returns a disposer for ctx.effect. */
export function injectStyles(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
```

- [ ] **Step 3:** 写 `src/CapabilitiesPage.tsx`

```tsx
/**
 * The 模型能力 settings page: one grouped editor over the llm-pi-ai user layer.
 *
 * Data flows through the inject face (a bound settings scope + translate), so
 * this file value-imports no other plugin. The body remounts per namespace
 * revision: the mirror fold after a save arrives as a new revision, which is
 * the fresh parse — local draft state never has to merge server truth.
 *
 * @module dsh-reasoning-tiers/CapabilitiesPage
 */
import type { ReactNode } from 'react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ImageMode, ModelDraft, PathOp, ProviderDraft } from './capabilities.ts'
import { buildMutateOps, draftsKey, invalidField, parseProviders } from './capabilities.ts'

/** Raw snapshot face the bound settings scope serves (structurally typed). */
export interface CapabilitiesSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

/** What the section's inject face hands the page. */
export interface CapabilitiesFace {
  scope: {
    getSnapshot(): CapabilitiesSnapshot
    subscribe(listener: () => void): () => void
    mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<void>
  }
  t: (key: string) => string
}

type Message = { readonly route: string; readonly kind: 'ok' | 'conflict' | 'error'; readonly text: string }

/** The settings-page entry: subscribes the scope and remounts the body per revision. */
export function CapabilitiesPage(props: CapabilitiesFace): ReactNode {
  const snapshot = useSyncExternalStore(props.scope.subscribe, props.scope.getSnapshot, props.scope.getSnapshot)
  return <CapabilitiesBody key={String(snapshot.revision ?? 'none')} {...props} snapshot={snapshot} />
}

function CapabilitiesBody(props: CapabilitiesFace & { snapshot: CapabilitiesSnapshot }): ReactNode {
  const { scope, t, snapshot } = props
  const providers = parseProviders(snapshot.value, snapshot.user)
  const [drafts, setDrafts] = useState<Record<string, readonly ModelDraft[]>>({})
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const writable = snapshot.writable && snapshot.status === 'ready'

  const rowsOf = useCallback((p: ProviderDraft) => drafts[p.route] ?? p.models, [drafts])
  const dirtyOf = useCallback((p: ProviderDraft) => draftsKey(rowsOf(p)) !== draftsKey(p.models), [rowsOf])

  const update = useCallback((route: string, rows: readonly ModelDraft[]) => {
    setDrafts((prev) => ({ ...prev, [route]: rows }))
  }, [])

  const save = useCallback(async (p: ProviderDraft) => {
    const rows = rowsOf(p)
    if (rows.some((row) => row.id.trim() === '')) {
      setMessage({ route: p.route, kind: 'error', text: t('modelIdRequired') })
      return
    }
    const bad = rows.map((row) => invalidField(row)).find((flag) => flag !== undefined)
    if (bad !== undefined) {
      setMessage({ route: p.route, kind: 'error', text: t('invalidNumber') })
      return
    }
    setBusy(p.route)
    setMessage(undefined)
    try {
      await scope.mutate(buildMutateOps({ ...p, models: rows.map((row) => ({ ...row, id: row.id.trim() })) }), snapshot.revision)
      setMessage({ route: p.route, kind: 'ok', text: t('saved') })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setMessage({ route: p.route, kind: /conflict|revision|stale/i.test(text) ? 'conflict' : 'error', text: `${t('saveFailed')}: ${text}` })
    } finally {
      setBusy(undefined)
    }
  }, [rowsOf, scope, snapshot.revision, t])

  const numberCell = useCallback((p: ProviderDraft, index: number, draft: ModelDraft, field: 'contextText' | 'maxText', label: string) => {
    const invalid = invalidField(draft) === (field === 'contextText' ? 'context' : 'max')
    return (
      <input
        className={`dsh-rt-cap-input${invalid ? ' dsh-rt-cap-invalid' : ''}`}
        inputMode="numeric"
        placeholder={t('inheritMark')}
        title={label}
        value={draft[field]}
        disabled={!writable}
        onChange={(event) => update(p.route, rowsOf(p).map((row, i) => i === index ? { ...row, [field]: event.target.value } : row))}
      />
    )
  }, [rowsOf, t, update, writable])

  return (
    <div>
      {!snapshot.writable && <p className="dsh-rt-cap-hint">{t('readOnlyHint')}</p>}
      {snapshot.writable && <p className="dsh-rt-cap-hint">{t('restartHint')}</p>}
      {providers.map((p) => {
        const rows = rowsOf(p)
        const dirty = dirtyOf(p)
        return (
          <fieldset key={p.route} className="dsh-rt-cap-group" disabled={!writable || busy === p.route}>
            <legend className="dsh-rt-cap-title">
              {p.route}
              <span className="dsh-rt-cap-tag">{p.hasModelsList ? t('declaredHint') : t('overridesHint')}</span>
            </legend>
            {rows.length === 0 && <p className="dsh-rt-cap-empty">{t('catalogEmpty')}</p>}
            {rows.length > 0 && (
              <table className="dsh-rt-cap-table">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>{t('contextWindow')}</th>
                    <th>{t('maxTokens')}</th>
                    <th>{t('imageInput')}</th>
                    {p.hasModelsList ? null : <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${index}:${row.id}`}>
                      <td>
                        {p.hasModelsList
                          ? row.id
                          : <input className="dsh-rt-cap-input" placeholder={t('modelIdPlaceholder')} value={row.id} disabled={!writable}
                              onChange={(event) => update(p.route, rows.map((r, i) => i === index ? { ...r, id: event.target.value } : r))} />}
                      </td>
                      <td>{numberCell(p, index, row, 'contextText', t('contextWindow'))}</td>
                      <td>{numberCell(p, index, row, 'maxText', t('maxTokens'))}</td>
                      <td>
                        <select value={row.image} disabled={!writable}
                          onChange={(event) => update(p.route, rows.map((r, i) => i === index ? { ...r, image: event.target.value as ImageMode } : r))}>
                          <option value="inherit">{t('imageInherit')}</option>
                          <option value="on">{t('imageOn')}</option>
                          <option value="off">{t('imageOff')}</option>
                        </select>
                      </td>
                      {p.hasModelsList ? null : (
                        <td>
                          <button type="button" disabled={!writable}
                            onClick={() => update(p.route, rows.filter((_, i) => i !== index))}>{t('remove')}</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="dsh-rt-cap-actions">
              {!p.hasModelsList && (
                <button type="button" disabled={!writable || busy === p.route}
                  onClick={() => update(p.route, [...rows, { id: '', contextText: '', maxText: '', image: 'inherit', raw: {} }])}>
                  {t('addOverride')}
                </button>
              )}
              <button type="button" disabled={!writable || busy === p.route || !dirty} onClick={() => { void save(p) }}>
                {busy === p.route ? t('saving') : t('save')}
              </button>
              {dirty && <span className="dsh-rt-cap-msg">{t('unsavedHint')}</span>}
              {message?.route === p.route && <span className={`dsh-rt-cap-msg ${message.kind}`}>{message.text}</span>}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}
```

> 实施注：`useSyncExternalStore` 挂在入口组件上——镜像折叠/外部写入带来新 revision 时快照换引用，body 以 `key={revision}` 重挂，本地草稿永不与服务器真相合并。

- [ ] **Step 4:** 写 `src/client.ts`

```ts
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
// Type-only: each merges its face into cordis' Context — `ctx.settingsScope`
// exists only because the settings domain base declared it; all erased at build.
import type {} from '@deepseek-ai/dsh-client-locale/client'
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
```

- [ ] **Step 5:** 写 `tsconfig.client.json`（typecheck-only，esbuild 负责 emit）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "jsx": "react-jsx",
    "types": ["node"]
  },
  "include": ["src/client.ts", "src/CapabilitiesPage.tsx", "src/locales.ts", "src/styles.ts", "src/capabilities.ts"]
}
```

- [ ] **Step 6:** 安装类型依赖（钉死版本）`npm install -D esbuild@^0.28.2 react@^18.2.0 react-dom@^18.2.0 @types/react@~18.3.1 @types/react-dom@~18.3.0 @deepseek-ai/dsh-client-locale@0.1.5-rc.2 @deepseek-ai/dsh-client-ui-slots@0.1.5-rc.2 @deepseek-ai/dsh-client-ui-settings@0.1.5-rc.2`
- [ ] **Step 7: typecheck 过** — `npm run typecheck`（host tsconfig 此刻尚未含 client 文件；如 host tsc 因 include 误扫 src/client.ts 报错，确认 host include 是显式列表而非 `src/**`）
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(client): capabilities page sources (locales/styles/page/section registration)"`

### Task 3: 构建脚本 + package.json 改造

**Files:**
- Create: `scripts/build.mjs`
- Modify: `package.json`（exports / dsh.client / scripts / devDependencies）
- Test: 构建自检 + bundle contract 测试（Task 4）

**Interfaces:**
- Consumes: `src/client.ts`
- Produces: `lib/client.js`（ModuleLoader 包装 + 纯净性闸门通过）

- [ ] **Step 1:** 复制 slider 的 `scripts/build.mjs` 到本仓库，仅改三处：文件头注释的 `@module` 改 `dsh-reasoning-tiers/scripts/build`；`watch` 日志前缀改 `[dsh-reasoning-tiers]`；`entryPoints` 已是 `src/client.ts` 不变。`PLATFORM_SEED`、包装 banner/footer、`purityGate`、`verify()` 逐字保留。
- [ ] **Step 2:** 改 `package.json`：
  - `version` → `0.2.0`
  - `description` → 追加「…并让设置页可编辑模型上下文/输出上限/多模态。Also adds a settings page for per-model context window, output cap and image modality.」
  - `exports` 加 `"./client": { "default": "./lib/client.js" }`
  - `dsh` 加 `"client": { "platform": "web", "inject": [] }`
  - `scripts`：`"build": "npm run build:host && npm run build:client"`、`"build:host": "tsc -p tsconfig.json"`、`"build:client": "node scripts/build.mjs"`、`"watch": "node scripts/build.mjs --watch"`、`"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json"`、`"verify:install": "node scripts/verify-install.mjs"`
- [ ] **Step 3: 构建** — `npm run build` → 输出 `[dsh-reasoning-tiers] lib/client.js ok — id="dsh-reasoning-tiers", requires=[…]` 且只列种子
- [ ] **Step 4: Commit** — `git add -A && git commit -m "build(client): esbuild wrapper with purity gate; dual-half manifest"`

### Task 4: verify-install + bundle 契约测试

**Files:**
- Create: `scripts/verify-install.mjs`、`test/client-bundle.test.mjs`
- Test: `npm test`

- [ ] **Step 1:** 复制 slider 的 `scripts/verify-install.mjs`，仅改 `@module` 标签与末尾提示（`Restart dsh web and reload the page to load ${pluginId}.` 保留亦可）。校验逻辑逐字保留（它按 `package.json` 动态工作，无需改动）。
- [ ] **Step 2:** 写 `test/client-bundle.test.mjs`

```mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const SEEDS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

test('client bundle exists and satisfies the loader contract', () => {
  const path = join(root, 'lib/client.js')
  assert.ok(existsSync(path), 'lib/client.js missing — run npm run build:client')
  const code = readFileSync(path, 'utf8')
  assert.ok(code.startsWith('window.__ModuleLoader__.load({'), 'bundle must open with the loader registration')
  assert.ok(code.includes(`id: ${JSON.stringify(pkg.name)}`), 'bundle must register the package name byte for byte')
  const requested = [...code.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  for (const specifier of new Set(requested)) {
    assert.ok(SEEDS.includes(specifier), `bundle requires non-seed module: ${specifier}`)
  }
})
```

- [ ] **Step 3: 全量测试** — `npm test` → 原 74 + 新增全绿
- [ ] **Step 4: 安装自检** — `node scripts/verify-install.mjs web` → 全 ok（依赖 link: 安装的既有 profile 行）
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test(client): bundle contract + offline install verification"`

### Task 5: 文档 + 发布

**Files:**
- Modify: `README.md`、`README.zh.md`、`package.json`

- [ ] **Step 1:** 两份 README 增加「Model Capabilities page / 模型能力页」章节：页面入口（设置 → 模型能力）、三字段语义（重点写三态：跟随=删字段、关=`['text']` 显式拒绝、开=`['text','image']`）、手写列表 vs modelOverrides 两种写法、`llm-deepseek` 不在范围。
- [ ] **Step 2:** 确认 `package.json` version=0.2.0；`npm test` 绿；`git add -A && git commit -m "docs: model-capabilities page; release 0.2.0"`；`git push origin master`；`npm publish`（prepublishOnly 测试门禁自动跑）。
- [ ] **Step 3:** 提醒用户手动重启 `dsh web`，设置面板应出现「模型能力」页；`[reasoning-tiers]` 启动行不变（host 半未动）。
