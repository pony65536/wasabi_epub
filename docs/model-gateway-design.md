# 模型 API 统一设计：Connections + Models + Gateway（v2）

> 目标：把散在 `config.js`、`aiProvider.js`、`core.js`、`batchQueue.js` 的 provider/模型/重试/限流收敛为
> 「可配置连接列表 + 模型配置 + 阶段路由 + 单一网关」。不绑定固定服务名，不引新依赖，不改 prompt 与格式流程。

## 0. v1 修订点

| # | v1 问题 | v2 处理 |
|---|---------|---------|
| 1 | 路由优先级自相矛盾（CLI 全局 vs 仅正文） | 明确 CLI 只覆盖 `translation`；`<PROVIDER>_MODEL` 仅存在于 legacy 合成；阶段只引用完整模型配置，禁止跨连接继承模型 ID |
| 2 | capability/thinking 绑在服务上 | registry 只描述**连接**；`jsonMode/reasoning/maxOutputTokens/timeoutMs` 属于**模型配置**，由适配器转换 |
| 3 | 阶段接入与实际调用点不符 | 明确 Critic（`batchQueue.js:241`）与 Memory（`translator.js:1864`）如何拿到专用 provider；补 `planner` 阶段 |
| 4 | 重试预算无执行责任 | SDK `maxRetries:0`；网关负责网络重试 + 总预算；业务层负责 JSON/结构修复与拆批；截断返回结构化错误 |
| 5 | fallback 无执行规则 | 定义触发错误、阶段是否允许、能力校验、深度 ≤1、计入预算；补"同连接主 A 备 B"反例 |
| 6 | 缓存验收用"可审计"替代"不串" | 指纹必须含实际连接标识/模型/thinking/输出预算/阶段路由（不含密钥）；换配置不得复用旧译文 |
| 7 | 单一网关被误解为单并发数 | 双层调度：全局 limiter + 连接 limiter 同时生效 |

## 1. 配置：connections + models + routing

配置来源优先级：`WASABI_MODELS_FILE` 指定的 JSON > 项目根 `models.json` > legacy env 合成（保持现有 `.env` 行为）。

```json
{
  "connections": {
    "main": {
      "url": "https://example.com/v1",
      "format": "openai-chat",
      "tokenEnv": "MODEL_API_KEY",
      "concurrency": 3,
      "timeoutMs": 90000
    },
    "gemini-direct": {
      "url": "https://generativelanguage.googleapis.com",
      "format": "gemini-native",
      "tokenEnv": "GEMINI_API_KEY"
    }
  },
  "models": {
    "normal":  { "connection": "main", "model": "model-A", "jsonMode": true, "reasoning": false, "maxOutputTokens": 4096 },
    "careful": { "connection": "main", "model": "model-B", "reasoning": false },
    "backup":  { "connection": "main", "model": "model-C", "jsonMode": true }
  },
  "routing": {
    "primary": "normal",
    "fallback": "backup",
    "stages": {
      "planner": "normal",
      "translation": "normal",
      "director": "normal",
      "glossary": "careful",
      "memory": "normal",
      "critic": "careful",
      "headings": "normal"
    },
    "stageFallback": {
      "translation": "backup",
      "critic": null
    }
  }
}
```

契约：

- **连接**只含 `url / format / tokenEnv / concurrency / timeoutMs`；密钥永远来自环境变量（`tokenEnv` 只存变量名）。
- **模型**引用一个连接，并声明该模型的 `model`、`jsonMode`、`reasoning`、`maxOutputTokens`、`timeoutMs`（可选覆盖）。同一连接可有多个模型。
- **格式只决定适配器**：`openai-chat` → OpenAI 兼容适配器；`gemini-native` → Gemini 适配器。`OpenRouter`、`qwen`、`mimo` 都只是连接名，无专门代码分支。
- **同格式 ≠ 同能力**：JSON/thinking 由模型配置决定，适配器只做参数转换，不按服务名推断。
- **阶段只引用完整模型配置**：不存在"只指定 provider 就继承主模型"；换连接必须新建模型配置。

## 2. 路由解析契约

`resolveModelRouting({ projectRoot, env, cli, sourceLanguage })` → 解析结果：

```
{
  primary:  modelConfigName,
  fallback: modelConfigName | null,
  stages: { [stage]: { modelName, connection, model, jsonMode, reasoning, maxOutputTokens, timeoutMs, fallback } },
  fingerprint,
  warnings
}
```

优先级（逐项明确）：

1. **CLI `--model <name>` 只覆盖 `translation` 阶段**；不改变其它阶段、不改变 fallback。
2. 其它阶段：`routing.stages[stage]` > `routing.primary`。
3. fallback：`routing.stageFallback[stage]`（显式 `null` 表示禁用）> `routing.fallback`。
4. legacy 合成时，`<PROVIDER>_MODEL` / `PRIMARY_MODEL` / `FALLBACK_MODEL` 只用于生成模型配置；解析后不再参与运行时优先级。
5. 校验：primary 存在、每个 stage 引用的模型存在、每个模型引用的连接存在；不合法直接报错（启动即失败）。
6. **禁止跨连接继承**：阶段切换连接必须通过新模型配置，避免把 A 服务的模型 ID 发到 B 服务。

## 3. 阶段与真实调用点

| 阶段 | 调用点 | 接入方式 |
|------|--------|----------|
| `planner` | `src/agent.js planTranslationOrder`（core 调用） | core 传 `gateway.forStage("planner")` |
| `translation` | `batchQueue` 批次调用 | 处理器对象带 `provider = forStage("translation")` |
| `critic` | **`src/translation/batchQueue.js:241`** 内 `reviewAndCorrectNode(..., aiProvider, ...)` | batchQueue 任务新增 `criticProvider` 字段（translator 从 `bookTranslationOptions.criticProvider` 传入）；缺省回退 translation provider |
| `memory` | **`src/translation/translator.js:1864`** `extractChapterMemory(..., aiProvider, ...)` | translator 使用 `bookTranslationOptions.memoryProvider`（core 注入），缺省回退 translation provider |
| `director` | `runDirectorAgent` | core 传 `forStage("director")` |
| `glossary` | `generateInitialGlossary` | core 传 `forStage("glossary")`（替代 `createGlossaryProvider` 特例） |
| `headings` | `analyzeHeadingFormats` / `standardizeHeadingsByRules` | core 传 `forStage("headings")` |

验收必须包含：配置 `critic: careful` 时，Critic 请求实际打到 `careful` 模型；Memory 同理。

## 4. 重试与预算执行责任

| 层 | 责任 | 规则 |
|----|------|------|
| SDK 客户端 | 不做重试 | `maxRetries: 0` |
| 网关 | 单次调用的网络/服务级重试 | 每个 `call()` 的 `maxAttempts`（默认 2，含对同一模型的有界重试）；**不含 fallback**，fallback 尝试另行计数 |
| 网关 | 任务停止条件 | 不使用"固定失败总数"；使用可配置的 **成本上限**（`maxFailedRequests`，默认 200）或 **连续故障阈值**（`consecutiveFailureThreshold`，默认 10），任一触发才停止发起新请求 |
| 业务层 | 语义/格式修复 | `callAIWithRetry` 负责 JSON 解析修复；batchQueue/translator 负责拆批与章节重试；截断由业务层缩批（`nodeLimit`），网关对 `OUTPUT_TRUNCATED` 返回结构化错误 |
| 计数规则 | JSON/结构失败如何计入 | 每次网关调用失败（含 `format` / `thinking_only` / `output_truncated`）计 1 次失败请求，计入 `maxFailedRequests`；连续阈值只在连续失败时累加，一旦成功即清零 |
| 预算耗尽 | 停止发请求 | 网关抛 `TASK_COST_LIMIT_REACHED` 或 `CONSECUTIVE_FAILURES`，章节按 partial/failed 记录 |

设计意图：零散故障（个别批次失败但后续章节正常）不应终止全书；只有成本失控或连续失败才停。

结构化错误：

```js
{ code, category, retryable, provider, model, attempts, usage }
```

## 5. Fallback 执行规则

- 触发错误：`content_policy`、`model_missing`、`auth`（认证错误通常两边都失败，仍允许尝试一次以便主/备不同密钥）。
- 不触发：`format`、`thinking_only`、`output_truncated`（属模型行为，交给业务层缩批/重试）、预算类终止错误。
- 网络/`rate_limit`/`timeout`：先在原模型内重试（计入 `maxAttempts`），预算内仍失败才 fallback。
- 阶段开关：`stageFallback[stage] === null` 时禁用；未配置则用 `routing.fallback`。
- 能力校验：fallback 模型必须满足该阶段要求（如阶段需要 `jsonMode`）；不满足则拒绝 fallback 并返回结构化错误，不静默降级。
- 防循环：**允许对同一模型有界重试**；fallback 每个 `call()` 最多进入一次，禁止备→备或主↔备循环；fallback 尝试不计入 `maxAttempts`，单独计入任务成本上限。
- 总开关：`fallbackOnContentPolicy=false` 时，内容策略错误不触发 fallback（保留 legacy 语义）。

验收反例：**同一连接、主模型 A、备用模型 B，A 触发 `content_policy` 时必须实际调用 B**（这是现网已复现的问题）。

## 6. 并发模型：全局 + 连接双层

- 全局 limiter：任务级总并发（`WASABI_GLOBAL_CONCURRENCY`，默认取 translation 模型连接的 concurrency）。
- 连接 limiter：每个连接自己的并发上限（`connections.<name>.concurrency`），防止同账号/同中转被打爆。
- 一次请求同时占用两个 limiter，任一不足则排队；释放时同时归还。
- `batchQueue` 的 `concurrency` = `min(global, translation 连接并发)`；辅助阶段同样经过两层调度。
- 不再存在"每个 `createAIProvider` 实例一个 limiter"的情况。

## 7. 缓存身份

`taskSignature` 指纹必须覆盖**所有影响译文的有效阶段配置**（初期策略，后续再细分依赖）：

- `planner / translation / director / glossary / memory / critic / headings` 每阶段的：
  - 连接标识：`url + format + tokenEnv 变量名`
  - 模型：`model`、`jsonMode`、`reasoning`、`maxOutputTokens`、`timeoutMs`
  - 该阶段的 fallback（含是否因能力不足被禁用）
- `fallbackOnContentPolicy`（影响是否切换模型）
- 适配器版本 + 配置版本 + prompt 摘要 + EPUB 修复指纹（沿用现有）

原因：Critic 直接改写译文，glossary/Director/Memory 影响术语与文风，planner 影响章节顺序与范围；这些配置变化都必须使旧译文缓存失效。

解析结果并入 `taskSignature`；**不一致必须清理缓存**，不允许"记录了模型但继续复用旧译文"。

验收反例：改任一阶段模型、`reasoning`、`maxOutputTokens`、连接 `url/format`、`fallbackOnContentPolicy`，旧翻译缓存都不得被判定可复用；指纹不包含任何密钥值。

## 8. 文件与迁移

```
src/models/
  config.js     loadModelConfig()：models.json / WASABI_MODELS_FILE / legacy env 合成 + 校验
  routing.js    resolveModelRouting()：优先级、fallback 解析、指纹、describe()
  gateway.js    createModelGateway()：双层 limiter、重试预算、fallback 规则、能力组装、usage、结构化错误
  adapters/
    openaiChat.js
    geminiNative.js
```

迁移顺序：

1. **配置解析 + 路由原型**（本次先做）：`config.js`、`routing.js`、单测；不接入运行时。
2. 适配器 + 网关：搬运现有 `aiProvider` 逻辑，`maxRetries:0`、结构化错误、usage；`createAIProvider` 变薄壳。
3. 阶段接入：core 注入 `forStage`；batchQueue 增加 `criticProvider`；translator 增加 `memoryProvider`；删除 `createGlossaryProvider` 特例。
4. 缓存指纹 + JobResult（`modelRouting`、`usage`）。
5. CLI `--model`（仅 translation）与启动路由打印；文档/`.env_example` 更新。

## 9. 验收清单（新增四类硬性）

1. **阶段确实调用指定模型**：critic/memory/planner 各自打到配置的模型（fake provider 捕获）。
2. **重试总次数受控**：SDK `maxRetries=0`；同一任务失败尝试不超过 `taskRetryBudget`（含 fallback）。
3. **同连接主备切换**：主 A 触发 `content_policy` → 实际调用 B；B 能力不满足时明确报错。
4. **换模型不复用旧译文**：改 model/reasoning/maxOutputTokens/连接后，旧缓存不被复用。

其余：双层并发同时生效；legacy env 合成行为与现状一致；routing 指纹不含密钥且对键序稳定。

## 10. 明确不做

- 不做 provider 插件市场、动态负载均衡、类继承 provider 体系。
- 不把 OpenRouter/qwen/mimo 做成固定类型；只保留两个协议适配器。
- 不改 prompt、不改各格式流程、不引新依赖。

## 11. 实施状态（阶段 1 已完成 + 评审修订）

| 项 | 状态 | 落地 |
|----|------|------|
| 配置解析 | ✅ | `src/models/config.js`：`WASABI_MODELS_FILE`（指向不存在的文件直接报错）> `models.json` > legacy env 合成；未知连接/模型/阶段/能力、非法 format、错误类型（如 `reasoning:"false"`、负预算）均在解析期报错 |
| 阶段路由 | ✅ | `src/models/routing.js`：`planner/translation/director/glossary/memory/critic/headings`；CLI `--model` 只覆盖 translation；`stageFallback`（显式 null 禁用）> `fallback`；fallback 能力校验；禁止跨连接继承；输出 `fallbackOnContentPolicy` |
| legacy 兼容 | ✅ | 模型 env 优先级恢复为 `<PROVIDER>_MODEL` > `PRIMARY_MODEL/FALLBACK_MODEL` 并给出迁移 warning；同一连接不同模型保留为主备；`FALLBACK_ON_CONTENT_POLICY` 语义保留；俄/日 glossary 特例保留（无 key 回落 primary） |
| 缓存指纹 | ✅ | 覆盖全部影响译文的阶段（含 planner/critic/glossary/memory/director/headings）与 `fallbackOnContentPolicy`；含连接/模型/能力/预算；不含密钥；任一阶段配置变化都会改变指纹 |
| 重试预算契约 | ✅（文档） | 单次 `maxAttempts`、业务层修复预算、任务级成本上限/连续故障阈值分层；JSON/结构失败计数规则已写明 |
| 测试 | ✅ | `tests/test_model_routing.mjs` 并入 `npm test`：legacy 合成/优先级 warning/同连接主备/策略保留、显式文件缺失报错、严格类型与未知阶段、全阶段指纹敏感项、fallback 能力；八套全绿 |

未做（阶段 2–5）：协议适配器、网关（双层 limiter/重试预算/fallback 执行/usage/结构化错误）、`forStage` 接入实际调用点（含 batchQueue `criticProvider`、translator `memoryProvider`）、缓存指纹并入 `taskSignature`、CLI/文档收尾。

### 阶段 2 已完成（适配器 + 网关）

| 项 | 状态 | 落地 |
|----|------|------|
| 共享模块 | ✅ | `src/models/errors.js`（错误分类，aiProvider 改为复用/再导出）、`src/models/response.js`（SSE/正文/完成度判定，aiProvider 再导出） |
| 协议适配器 | ✅ | `adapters/openaiChat.js`（`maxRetries:0`、jsonMode→response_format、reasoning 非 null 才传、max_tokens、SSE 字符串兜底）、`adapters/geminiNative.js`（不传不支持的参数） |
| Model Gateway | ✅ | `src/models/gateway.js`：全局 + 连接双层 limiter；同模型有界重试；`FALLBACK_CATEGORIES` 白名单与 `fallbackOnContentPolicy` 开关；`maxFailedRequests` / `consecutiveFailureThreshold`（成功清零）；结构化错误（`category/attempts/stage/model`，`TASK_COST_LIMIT_REACHED` / `CONSECUTIVE_FAILURES`）；usage 记账；`forStage/describe/getLimiterStats` |
| 测试 | ✅ | `tests/test_model_gateway.mjs`：同模型重试、auth 快速失败、同连接主备真实切换、policy=false 禁候补、格式错误不候补、成本上限、连续故障+成功清零、双层并发串行、请求参数与 usage、forStage 形状、缺 key 报错；九套全绿 |

未做（阶段 3–5）：core 用 `forStage` 接入 planner/director/glossary/headings、batchQueue `criticProvider`、translator `memoryProvider`；routing 指纹并入 `taskSignature`；CLI `--model` 与启动路由打印；删除 legacy `createAIProvider` 调用。

### 阶段 3–5 已完成（接入、审计、CLI）

| 项 | 状态 | 落地 |
|----|------|------|
| 阶段接入 | ✅ | core 四个 Job 统一 `createJobGateway`（`resolveModelRouting` + `createModelGateway`），一次网关、阶段共用；`planner/director/headings/glossary` 各自 `forStage`；`batchQueue` 使用 `processor.criticProvider`（translator 从 `bookTranslationOptions.criticProvider` 注入）；Memory 使用 `memoryProvider`；删除 `createGlossaryProvider`/`createAIProvider` 调用 |
| 双层并发与 CLI | ✅ | `runtimeConfig.concurrencyOverride` → 网关全局/连接并发；`--model <name>` 只覆盖 translation 阶段；启动打印 `🧭 Routing`（每阶段 model@connection->fallback） |
| 缓存指纹 | ✅ | EPUB/HTML/PDF/字幕的 `taskSignature` 均加入 `modelRoutingFingerprint`（覆盖全部阶段 + fallbackOnContentPolicy，不含密钥）；换模型/推理/预算/连接即失效缓存 |
| JobResult | ✅ | 四种 Job 的 `extra` 增加 `modelRouting`（`gateway.describe()`）与 `usage`（requests/failures/tokens/byStage/byModel） |
| 文档 | ✅ | README 中英文补充 `--model` 与 `models.json` 说明；`.env_example` 增加 connections/models/routing 示例与 `WASABI_GLOBAL_CONCURRENCY` |
| 测试 | ✅ | 新增 `tests/test_model_gateway.mjs`；九套全绿；CLI 解析、路由接入均通过语法与冒烟检查（`resolveModelRouting + createModelGateway + forStage`） |

剩余清理（非阻塞）：`src/translation/aiProvider.js` 仍保留旧实现供兼容/测试（test_recovery_contracts 使用其超时取消探针），后续可整体删除；`createRuntimeConfig` 的 provider 配置块在路由完全切换后也可精简。
