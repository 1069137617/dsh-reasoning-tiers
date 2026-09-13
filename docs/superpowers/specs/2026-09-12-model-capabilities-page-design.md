# 设计：dsh-reasoning-tiers v0.2.0 — 设置页「模型能力」

日期：2026-09-12 · 状态：已确认（用户批准方案 A 与全部设计节）

## 目标

在 DSH 设置面板新增一个「模型能力」页面，让用户可视化编辑已添加模型的：

1. **上下文窗口**（`contextWindow`）
2. **多模态（图片）能力**（`input` 模态列表）
3. **单次输出上限**（`maxTokens`，用户确认加入）

## 背景与证据

数据层与推理档位同源同写入口——`llm-pi-ai` 的模型条目 schema 原生携带这些字段
（`dsh-llm-pi-ai/lib/index.js:968-976`）：

- `contextWindow: z.number().step(1).min(1)`（:971）
- `maxTokens: z.number().step(1).min(1)`（:972）
- `input: z.array(z.union(MODALITIES))`，`MODALITIES = ['text','image']`（:279-282, :973）

解析优先级 `entry ?? catalog base ?? route default`（:670-682）。模态语义（`declaredInput`
:292-294）：**缺省或空数组 = 跟随 catalog**；`['text']` = 显式纯文本（负能力）；`['text','image']`
= 图片放行。图片闸门在适配器请求路径上：`:1844-1845` 请求含图而 `model.input` 不含
`'image'` → 抛 `UNSUPPORTED_CONTENT`。`contextWindow` 参与溢出判定（`mapStopReason`
:1388-1390）并经 `modelInfo()`（:1807-1815）回显为 `LlmResolvedModelInfo.context` /
`inputModalities`。

设置页插槽：`settings.section`（list 槽，`dsh-client-ui-settings/lib/types/client/contract/
slots.d.ts:67-71`）——每条目一个设置页，registrant 自带 `id`/`order`/`label`（本地化）。
设置域读写服务：`ctx.settingsScope`（`settings-scope.d.ts`）——`bind({ns})` 得到带
revision 围栏的 `set/unset/mutate`，`describe()` 得到共享镜像面。官方 Models 页的写模式：
整条 `models` 数组草稿式编辑、一次 set 写回、未知字段随草稿存活
（`dsh-client-ui-settings-models/lib/types/client/operations.d.ts:70`、
`ModelListEditor.d.ts:20-23`）。

## 范围决定（用户确认）

- 字段集：contextWindow + maxTokens + input（多模态）三态
- 覆盖：全部 pi-ai 路由——手写 `models` 列表走整条数组 set；catalog 路由走
  `modelOverrides` 字典 set（适配器 `:640-650` 校验允许，仅限无 models 列表的路由）
- `llm-deepseek` 路由排除（其模型 schema 不吃这些字段）
- 归属：扩展 `dsh-reasoning-tiers`（方案 A），不出新包

## §1 包结构与构建

```
dsh-reasoning-tiers/
├── src/
│   ├── index.ts             # host 半（不动）
│   ├── client.ts            # 新：apply = 注册 settings.section
│   ├── CapabilitiesPage.tsx # 新：页面组件
│   ├── capabilities.ts      # 新：纯函数（草稿/三态/op 组装/校验）
│   └── locales.ts           # 新：zh/en
├── scripts/build.mjs        # 新：esbuild + ModuleLoader 包装 + 纯净性闸门（复用 slider）
├── tsconfig.client.json     # 新
└── package.json             # 改：exports['./client']、dsh.client、build 拆分
```

`cordis.patch.yml` 不动。react/react-dom 外部化（9 平台种子约束）；类型包仅 devDependencies。
客户端打包硬约束参照 `dsh-reasoning-slider`（单次 `window.__ModuleLoader__.load`、id 与包名
逐字节相等、factory 非 async）。

## §2 数据与写路径

- **读**：`ctx.settingsScope.describe()` 共享镜像 → `namespace('llm-pi-ai')` 用户层视图。
  用户层显式值正常显示；缺省字段灰显「(跟随目录)」。
- **编辑**：contextWindow / maxTokens 正整数输入；图片三态（跟随目录 / 开启 / 关闭）分别
  对应删字段 / `['text','image']` / `['text']`。
- **写**：`ctx.settingsScope.bind({ns:'llm-pi-ai'}).mutate([op])`，revision 围栏：
  - 手写列表路由：一个 set op 整条替换 `providers.<route>.models`（未知字段存活，天然携带
    reasoningEfforts/compat，规避 host 端 applyPathOp 数组下标坑）
  - catalog 路由：一个 set op 整条替换 `providers.<route>.modelOverrides`（每模型
    `{contextWindow?, maxTokens?, input?}`）
- **与 host 半互扰**：无——草稿携带 reasoningEfforts 原样；host autofill 对已有档位的模型跳过。

## §3 UI 形态

- 导航项「模型能力 / Model Capabilities」，`order` 排官方 Models 之后。
- 按 provider 分组的表格：模型 id · 上下文窗口 · 输出上限 · 图片（三态）。
- 每 provider 一个「保存」按钮（整组一次原子写）；结果就地显示（written / conflict 原文 /
  refused 原文）；有未保存变更时提示。
- `writable=false`（只读部署）整页禁用 + 说明。
- catalog 路由显示空态 + 「添加覆盖」流：模型 id 手填；实施时若 `remote.llm` 的 listModels
  面可达则提供下拉（唯一实施期待核对项，不可达则手填，不影响设计）。

## §4 错误处理与降级

- `settingsScope` 服务缺失 → 嵌套 `ctx.inject` 降级，整页不注册（slider 同款模式）。
- 正整数校验在输入端做（对齐 zod :971-972），非法值禁保存。
- 无 per-index 数组 op，只整组 set。

## §5 测试

- 纯函数单测（node --test）：三态↔字段映射、草稿构建（未知字段存活断言）、
  models / modelOverrides 两种 op 组装、校验拒绝。
- wiring 测试：假 ctx + 内存 settingsScope，覆盖挂载→编辑→保存→镜像折叠、conflict 恢复、
  服务缺失降级。
- `verify:install` 离线自检（复用 slider 的宿主解析重放）。

## §6 文档与发布

README（en/zh）新增「模型能力页」章节 + 包描述更新（推理档位 + 模型能力）；版本 0.2.0；
npm publish；GitHub 推送；用户手动重启 `dsh web` 验证。
