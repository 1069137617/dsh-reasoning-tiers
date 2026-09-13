# dsh-reasoning-tiers

为第三方模型提供商的模型补齐**推理档位（reasoning effort / 思考强度）**、并让**模型能力可视化编辑**
的 DeepSeek Harness 插件：按模型名匹配内置知识表，把档位声明写进 `llm-pi-ai` 设置节，让官方的
思考强度选择器真正可用；0.2.0 起新增浏览器半，在设置面板注册「模型能力」页，每个已添加模型的
上下文窗口、输出上限、图片多模态都能直接编辑。English: [README.md](README.md)

MIT。不占用适配器、不拦截请求——档位只写设置，一次性、保守、可撤销；能力页也只走标准设置
通道，改的是提供商自己的命名空间。

---

## 1. 这是结构性问题，不是少了个开关

一个模型可选哪些档位，只来自 `LlmResolvedModelInfo.reasoning`
（`@deepseek-ai/dsh-llm/lib/types/types.d.ts:304-327`）。pi-ai 适配器对**没有推理元数据的模型**
直接省略该字段：

```js
// dsh-llm-pi-ai/lib/index.js:1715-1723
function reasoningInfo(model, defaultLevel) {
  if (!model.reasoning) return {};   // 每个手写的模型都会落到这里
  ...
}
```

没有别的接缝可修：

- 官方模型页没有 `reasoningEfforts` 字段，仅有的 slot（`settings.models.provider-card`、
  `settings.models.footer`）触达不到单个模型行
  （`dsh-client-ui-settings-models/.../slot-contract.d.ts:21-44`）。
- 占用路由也不行：`registerAdapter` 对已占用的 route 抛 `DUPLICATE_ADAPTER`
  （`dsh-llm/lib/types/index.d.ts:241-248`），唯一 waterfall 是 `llm/stream`，而循环构造的
  请求被契约深冻结。

能力即配置，所以本插件写的就是配置。

## 2. 安装

从 npm 安装（推荐）：

```sh
dsh plugin --profile web add dsh-reasoning-tiers
```

或直接从本仓库：

```sh
dsh plugin --profile web add git+https://github.com/1069137617/dsh-reasoning-tiers.git
```

`prepare` 会在安装时构建 `lib/`。**装之前先备份** `~/.dsh/settings.yaml`：插件会改它所装
profile 的 `llm-pi-ai` 节，而且 **bundle 是启动期读取的**，所以装完要重启 DSH
（`patchReload: live` 只热重载 profile 自己的 patch 文件）。重启后插件自报家门：

```
[reasoning-tiers] mounted: autofill=true revert=false diagnose=true widenToGlobalEffort=false extraRules=0
```

> **从本地目录安装时注意**：如果用本地路径（`dsh plugin add <目录>`）装，依赖会从**插件自己的**
> `node_modules` 解析（`peerDependencies` + `devDependencies` 双写，`npm install` 会装）。
> 不要在插件目录执行 `npm ci --omit=dev` / `npm prune` / 删 `node_modules`，否则重启后插件
> 加载失败。从 npm 或 git 安装没有这个问题。

## 3. 它写什么——以及它拒绝写什么

对 `llm-pi-ai.providers.*` 下的每个模型，插件向实时模型接缝探测，然后算出让模型有可用档位的
**最小写入**：

| 情况 | 动作 |
| --- | --- |
| 模型没有档位（手写 id，或不在 pi-ai catalog 里） | 按知识表声明档位；协议已知时用协议兜底档位。 |
| 模型已有档位 | **不动**。声明 `reasoningEfforts` 会*替换*继承能力并把未列档位钉死为不支持，而继承档位的线上拼写只有提供商自己知道。 |
| 知识表条目覆盖该模型 | 档位 + 方言，置信度与来源写进日志。 |
| 无条目且协议未知 | 带原因跳过——绝不猜。 |

每次写入都记进账本 `<DSH_HOME>/dsh-reasoning-tiers/journal.json`（tmp + rename 原子写），
`revert: true` 只回退插件自己写的；用户改过的值记为 `changed-by-user` 原样保留。

## 4. 平档只报告，不改写

一个模型可以"有"档位、但选择在字节上无法区分：catalog 无 `thinkingLevelMap` 且
`compat.supportsReasoningEffort: false` 时，`qwen` 方言只发
`enable_thinking = !!reasoningEffort`（`pi-ai/dist/api/openai-completions.js:645-653`）——
`low`、`medium`、`high` 是同一个请求的三个名字。

声明更宽的 `reasoningEfforts` **修不了这个**：档位拼写只在 compat 已放行 effort 字符串时才被
用到，请求字节不变、只变菜单。自动改写等于拿"3 个看起来诚实的档位"换"4 个骗人的档位"，
所以插件只报告：

```
acme/qwen3.6-flash has a flat ladder (minimal, low, medium, high): every non-"off" choice sends
the same request, so the thinking-intensity control cannot change anything.
```

如果你确认你的网关接受 `reasoning_effort`，显式说出来：

```yaml
- id: reasoning-tiers
  config:
    extraRules:
      - prefix: ["qwen3.6-"]
        ladder: { off: null, low: "low", medium: "medium", high: "high" }
        dialect: { supportsReasoningEffort: true }   # 这一步才是"真的能调"
```

## 5. 模型能力页

0.2.0 起插件带浏览器半，往 `settings.section` 列表槽位注册一个条目：**设置 → 模型能力**。
页面列出 `llm-pi-ai` 下已配置的每条路由，每个模型行可编辑三个字段：

| 字段 | 设置键 | 留空含义 |
| --- | --- | --- |
| 上下文窗口 | `contextWindow` | 继承——删除该字段，回退 catalog 值。 |
| 输出上限 | `maxTokens` | 同上。 |
| 图片输入 | `input` | 三态，见下。 |

两个数字都必须是正整数；非法值就地标红，保存前就被拦下，不会到 Host。

### 图片开关是真三态

- **跟随目录**（`inherit`）——从条目上删除 `input` 字段。适配器把缺失或空的 `input` 视为
  "无答案"，回退 catalog 模型（`dsh-llm-pi-ai/lib/index.js:292-294`）。
- **开启**——写 `input: ["text", "image"]`，图片请求通过逐请求门禁。
- **关闭**——写 `input: ["text"]`，显式的否定能力。带图片的请求会抛
  `UNSUPPORTED_CONTENT`（`dsh-llm-pi-ai/lib/index.js:1844-1845`），而不是被提供商静默降级。

### 两种写法，按路由类型二选一

- **已声明的模型列表**——用户层声明了 `models[]` 的路由。页面整表起草，以**一次** `set` 提交
  `providers.<route>.models`——官方模型页编辑器的同一约定，页面不管的字段（`name`、
  `reasoningEfforts`、任何自定义字段）原样保留。
- **catalog 路由**——页面把 `providers.<route>.modelOverrides` 写成以模型 id 为键的字典。
  「添加覆盖」可以在不声明模型的前提下钉死一个 catalog 模型的能力；字典清空则 `unset`，
  路由回到纯 catalog 继承。

所有写入都走设置作用域带 revision 围栏的 `mutate`；冲突（配置在别处被改）会提示刷新页面重试。
部署不接受浏览器写设置时（memory 模式）页面只读。改动重启后生效。

**不在范围**：`llm-deepseek` 路由（另一个适配器与命名空间），以及 `llm-pi-ai` 以外的所有
命名空间。

## 6. 配置

插件**自己**的配置走 bundle 的 `cordis.patch.yml` 条目。（上面的模型能力页改的是提供商自己的
`llm-pi-ai` 命名空间，不是这份配置。）随包条目**故意不带** `config:`，
让 profile 级覆盖干净地合并：

```yaml
- id: reasoning-tiers
  config:
    autofill: true                # 总开关
    revert: false                 # 一次性撤销；跑完改回 false
    compatAutofill: true          # 允许补路由级 compat（仅白名单字段）
    respectExisting: true         # 已有档位的模型绝不重写
    diagnose: true                # 只读审计：档位、平档、达不到默认档
    widenToGlobalEffort: false    # 可选：给缺默认档的模型补上
    alignGlobalEffort: false      # 可选：新写档位时带上默认档，仅直通方言
    excludeProviders: []
    excludeModels: ["*embed*", "*vision*"]
    maxProbes: 200
    debounceMs: 250
    bootRetryDelaysMs: [1000, 2000, 4000, 8000, 16000, 30000]
    extraRules:                   # 优先级最高，压过内置表
      - pattern: "^my-gateway-model$"
        ladder: { off: null, low: "low", high: "high" }
        dialect: { thinkingFormat: openai, supportsReasoningEffort: true }
```

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `autofill` | `true` | 总开关；`false` 后完全只读。 |
| `revert` | `false` | 按账本跑一遍撤销，跑完改回 `false`。 |
| `compatAutofill` | `true` | 补路由级 compat，仅 `thinkingFormat` / `supportsReasoningEffort` / `supportsDeveloperRole` / `forceAdaptiveThinking`。 |
| `respectExisting` | `true` | 已有档位的模型绝不重写。 |
| `diagnose` | `true` | 只读审计：当前档位、平档、达不到部署默认档的模型。 |
| `widenToGlobalEffort` | `false` | 给缺部署默认档的模型补上该档。按"档位名=线上值"约定重建，日志标 `medium` 置信度。 |
| `alignGlobalEffort` | `false` | 新写档位带上默认档——仅直通方言（`openai` / `openrouter` / `together` / 未指定），厂商专有拼写绝不臆造。 |
| `excludeProviders` / `excludeModels` | `[]` | 路由名精确排除 / 模型 id glob（`*`、`?`，不区分大小写）。 |
| `maxProbes` | `200` | 单次探测预算。 |
| `debounceMs` | `250` | 设置事件去抖窗口。 |
| `bootRetryDelaysMs` | `[1000…30000]` | 启动期重试表。 |
| `extraRules` | `[]` | 自定义规则；每项取 `pattern`（正则）/ `prefix` / `exact` 之一，外加 `ladder`，可选 `dialect` 与 `protocols`。非法规则只丢自己并给出原因。 |

## 7. 内置知识表

随插件带 12 个模型族：Qwen3、DeepSeek V4、DeepSeek R1/V3.1、GLM-5、GLM-4.5V、Kimi K2、
MiniMax M、GPT-5、o-series、Claude、Gemini thinking、Grok-4。每个条目写明档位、可选方言、
接受的协议、置信度和来源。匹配优先级：`extraRules` → 精确 id → 前缀 → 正则 → 协议兜底；
未知协议不继承方言；没有推理分发的协议一个档位都不给——不臆造任何东西，厂商没拼写的
`xhigh`/`max` 绝不发明。

## 8. 开发

```sh
npm install
npm run build        # tsc -> lib/（host 半）+ esbuild -> lib/client.js（浏览器半）
npm run typecheck    # 两份 tsconfig，不产出
npm test             # node --test，85 项
node scripts/dry-run.mjs [--widen] [settings-path]   # 审计一份 settings.yaml，不写任何东西
node scripts/verify-install.mjs web                  # 重放宿主的 bundle 解析链
```

规划器是"原始用户层 + 已解析配置 + 注入探测"的纯函数——这让整套策略不需要 Host、提供商或
网络就能测。能力页同一纪律：编辑/草稿/op 模型在 `src/capabilities.ts`，纯模块配纯 JSON
（`test/capabilities.test.mjs`），React 组件只负责呈现。`test/wiring.test.mjs` 是唯一触碰
宿主接缝的测试（假 Cordis Context）；`test/client-bundle.test.mjs` 把浏览器 bundle 按
加载器契约锁死。

## 9. 已知限制

- **平档无法自动修复**：`reasoningEfforts` 改菜单，改不了适配器是否发 effort 字符串。见 §4。
- **`widenToGlobalEffort` 是断言**：给 catalog 标为不支持的档位（`high: null`）补档，等于断言
  上游接受它。默认关、`medium` 置信度、有账本。
- **`llm-deepseek` 路由不在范围**（`deepseek-official` 走另一个适配器，档位来自路由级
  `thinking`/`reasoningEffort`，其 `models[]` 模式不接受 `reasoningEfforts`）。
- 只覆盖 `llm-pi-ai` 命名空间——档位写入与能力页都是。
- 平档判定是**指纹**不是探测：报告出来的集合恰好是 `off/minimal/low/medium/high` 就判平档
  （`getSupportedThinkingLevels` 对缺失 `thinkingLevelMap` 的处理，`pi-ai/dist/models.js:551-561`）。
  真把五档映射成五种拼写的 provider 会被误判。`scripts/dry-run.mjs` 把指纹和 catalog 两种
  判定都打出来供交叉验证。

## 10. 致谢

先行工作：[`dsh-better-reasoning-effort`](https://www.npmjs.com/package/dsh-better-reasoning-effort)
（HaoyueQin，MIT）功能更多——模型行 DOM 编辑器、`/models` 探测、composer 滑杆。本插件是精简的
Host-only 实现：写设置，让官方选择器消费。同类还有 `dsh-thinking-levels`、
`@hytime/dsh-thinking-effort`、`dsh-models-radar`。

## 许可

[MIT](LICENSE)
