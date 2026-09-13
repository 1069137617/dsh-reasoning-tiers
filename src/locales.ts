/**
 * Registrant-localized copy for the capabilities page, in the two locales the
 * shell ships.
 *
 * The dictionary is registered through `ctx.locale.register(NS, ...)` and the
 * framework then synthesizes the `t` seat on the component from this
 * registration's `locale: NS` — which is why the namespace is also merged into
 * `LocaleNamespaceMap` below. Declaring the merge is what makes a missing or
 * misspelled key a compile error instead of a key echoed to the user at runtime.
 *
 * @module dsh-reasoning-tiers/locales
 */

/** Dictionary namespace of this plugin's own copy. */
export const NS = 'reasoning-tiers'

/** Every key this plugin's dictionary must define, in both locales. */
export type ReasoningTiersKey =
  | 'pageLabel'
  | 'contextWindow'
  | 'maxTokens'
  | 'imageInput'
  | 'imageOn'
  | 'imageOff'
  | 'imageInherit'
  | 'inheritMark'
  | 'save'
  | 'saving'
  | 'saved'
  | 'readOnlyHint'
  | 'restartHint'
  | 'unsavedHint'
  | 'saveConflict'
  | 'saveFailed'
  | 'addOverride'
  | 'modelIdPlaceholder'
  | 'modelIdRequired'
  | 'remove'
  | 'invalidNumber'
  | 'catalogEmpty'
  | 'declaredHint'
  | 'overridesHint'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The model-capabilities settings page's own copy. */
    'reasoning-tiers': ReasoningTiersKey
  }
}

/** English dictionary. */
export const en: Record<ReasoningTiersKey, string> = {
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
  restartHint: 'Restart DSH to apply.',
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
}

/** Chinese dictionary. */
export const zh: Record<ReasoningTiersKey, string> = {
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
  restartHint: '重启 DSH 后生效。',
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
