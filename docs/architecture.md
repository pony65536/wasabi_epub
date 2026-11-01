# Wasabi 架构文档

## 1. 项目定位

Wasabi 是一个面向长文档与字幕场景的命令行翻译工具。它统一接收 `EPUB`、`HTML`、`PDF`、`SRT` 与带字幕的视频文件，按输入类型选择对应工作流，调用大模型完成翻译，并尽量保留原始结构、目录、版式或字幕轨。

当前实现采用：

- `Node.js` 负责 CLI、运行时配置、主流程编排、AI 调用、缓存与文件输出
- `Python` 负责 PDF 的提取、保留规则判断与回填渲染
- 多种 AI Provider 通过统一抽象接入，支持主模型与内容安全回退模型

## 2. 顶层架构

```text
CLI / Runtime
  index.js
    ->
Dispatch
  src/core.js                      # 仅保留 4 个兼容导出
    ->
Format Orchestrators
  src/epub/translationJob.js
  src/html/translationJob.js
  src/pdf/translationJob.js
  src/subtitle/translationJob.js
    ->
Shared Pipeline
  src/pipeline/jobContext.js
  src/pipeline/translateDocument.js
  src/pipeline/artifactPolicy.js
    ->
Translation Engine
  src/translation/*
  src/content/*
    ->
Model Gateway / SDK
  src/models/gateway.js
  src/translation/aiProvider.js
  src/translation/sdk/*
    ->
External Services
  Gemini / Qwen / Mimo / OpenRouter

PDF Special Path
  src/pdf/translationJob.js
    -> src/pdf/repair.js
    -> src/pdf/pdfBridge.js
    -> src/pdf/translate_pdf.py
    -> src/pdf/app|services|domain|infra
```

## 3. 目录结构

```text
.
├─ index.js                  # CLI 入口
├─ src/
│  ├─ core.js                # 薄分发层，只导出四个格式入口
│  ├─ config.js              # Provider、模型、语言与运行时配置
│  ├─ agent.js               # EPUB 章节顺序规划
│  ├─ utils.js               # 通用工具与 AI 调用辅助
│  ├─ pipeline/              # 任务上下文、共享翻译内核、产物保留策略
│  ├─ models/                # 阶段路由、共享限流、错误分类、用量与连接适配
│  ├─ translation/           # 翻译执行引擎、队列、provider 与术语 provider
│  ├─ content/               # 术语、标题、内容分类等增强能力
│  ├─ support/               # 缓存、日志、文件、命名、环境检查、选择器
│  ├─ epub/                  # EPUB job、chapterMap、TOC 同步与保存
│  ├─ html/                  # HTML job
│  ├─ subtitle/              # 字幕 job 与 SRT/视频处理
│  └─ pdf/                   # PDF job、repair、HTML 映射与 Python 子系统
├─ config/                   # 模型登记与选型（example 提交，local 忽略）
├─ prompts/                  # 各模式 Prompt 模板
├─ tests/                    # Node 单测、工作流 fixture 与 Python 测试
├─ input/                    # 输入文件归档目录
├─ output/                   # 最终输出目录
├─ log/                      # 调试日志目录
└─ docs/                     # 项目文档
```

## 4. 核心设计原则

- 单入口，多工作流：所有模式统一从 `index.js` 进入，再按扩展名分派。
- 薄分发 + 格式编排：`src/core.js` 只做兼容导出；每种格式的生命周期放在各自的 `translationJob.js`。
- 共享边界显式化：目录/日志/provider/队列/缓存的初始化集中在 `pipeline/jobContext.js`，翻译主循环集中在 `pipeline/translateDocument.js`。
- Provider 抽象统一：不同模型供应商通过统一 `callAI` 接口接入。
- 中间表示驱动：HTML、PDF、字幕都尽量转换为可翻译的中间结构后再走统一翻译引擎。
- 缓存优先：章节、术语表、翻译计划、PDF 提取结果都可复用，支持断点续跑。
- 保守输出：遇到无法稳定处理的内容，优先保留原文或原结构，而不是冒险破坏文档。

## 5. 运行流程

### 5.1 CLI 层

`index.js` 负责：

- 解析命令：`translate`、`doctor`、`setup --pdf`
- 解析参数：`--chap`、`--page`、`--from`、`--to`、`--model`、`--concurrency`、`--debug`
- 根据输入扩展名选择后端
- 在执行前做环境预检查
- 在 PDF 模式下按需触发 Python 依赖安装

### 5.2 预检查层

`src/support/environment.js` 负责：

- 检查当前主 Provider 的 API Key 是否存在
- 检查 PDF 所需 Python、`PyMuPDF`、`pikepdf`
- 检查视频字幕所需 `ffmpeg`、`ffprobe`
- 输出 `doctor` 报告
- 统一格式化环境错误信息

### 5.3 分发与编排

`src/core.js` 只保留四个兼容导出，实际流程位于：

- `src/epub/translationJob.js`：`runTranslationJob`
- `src/html/translationJob.js`：`runHtmlTranslationJob`
- `src/pdf/translationJob.js`：`runPdfTranslationJob`
- `src/subtitle/translationJob.js`：`runSubtitleTranslationJob`

共享模块：

- `src/pipeline/jobContext.js`：建立 `input/`、`output/`、`log/`、`.cache_*`，创建 logger、共享 gateway、各阶段 provider、batch queue 和带任务锁的 cache，并提供 banner 与结束清理
- `src/pipeline/translateDocument.js`：各格式共用的翻译与队列收敛入口；缓存有效性及节点级恢复统一交给 translator 判断
- `src/pipeline/artifactPolicy.js`：成功/失败、debug on/off 下的缓存与日志保留策略

职责划分：

- 格式 job 负责计算输出名、选择缓存模式、准备 glossary/plan/heading，并在翻译后执行格式专属的 apply/save
- 格式 job 不再直接创建 logger、主 provider、batch queue 或 cache
- 输入文件仅在任务成功后归档到 `input/`
- EPUB、HTML、PDF 在初始化时创建 glossary provider；字幕延迟到语言推断后创建

## 6. 翻译引擎

### 6.1 Provider 抽象

`src/models/gateway.js` 编排阶段调用、全局/连接双层限流、重试预算、fallback 与用量统计。`src/translation/aiProvider.js` 保留独立 provider 接口；两者共用 `src/translation/sdk/*`：

- SDK 由模型条目的 `sdk` 决定：`openai` 或 `@google/generative-ai`
- JSON 配置默认在内容安全错误时 fallback；可通过 `onErrors` 扩展类别，按阶段覆盖或禁用候补
- 对废弃模型追加指向 `config/wasabi.local.json` 模型条目的提示

运行时配置由 `src/config.js` 的 `loadRuntimeConfig` 生成：

- 读取 `config/wasabi.local.json`，或由 `WASABI_CONFIG` 指定路径
- 校验模型登记、SDK、URL、`requestOptions` 与 `selection` 引用
- 解析 `primary`、可选 `fallback`、`glossary.default`、`stages`、`stageFallback`、`stageRequirements`，再生成统一的连接/模型路由
- 俄/日 glossary 模型只保存 ID，在源语言确定后再解析 Key
- `--concurrency` 只覆盖本次运行，不回写配置
- 网关和独立 facade 各自承担其调用路径的超时取消；SDK 不额外重试，响应解析拒绝空正文与截断内容
- JSON 为主要入口，旧模型文件与环境配置经适配后复用同一运行时；显式配置错误直接报错

### 6.2 批处理与重试

翻译执行主要在 `src/translation/translator.js` 中完成：

- 根据模式选择 prompt 模板
- 从 HTML/中间文档中收集可翻译节点
- 将节点拆成 batch 并并发提交
- 对失败节点进行多轮重试
- 字幕模式下进一步降批重试，最后退化到单节点翻译
- 仍失败时保留原内容，避免破坏输出结构

### 6.3 内容筛选

翻译器不是“整页全量替换”，而是先做节点筛选：

- 对明显的导航、表单、脚本、装饰性区域进行排除
- 识别正文主导节点，减少重复翻译父子节点
- EPUB 在必要时启用 structural fallback，避免因为标记结构异常漏掉正文
- HTML 模式采用可见文本优先的收集策略

这个设计直接服务两个目标：

- 降低无意义 token 消耗
- 尽量避免破坏原文档 DOM 结构

## 7. 内容增强模块

### 7.1 章节规划

`src/agent.js` 只在 EPUB 模式中使用。它会调用 AI 对章节做轻量规划：

- 标记目录页 `tocId`
- 将目录、索引、参考等章节从主翻译顺序中移除
- 优先主内容，后处理前言、版权页等前后置材料

如果规划失败，则回退到原始章节顺序。

### 7.2 术语表生成

`src/content/glossary.js` 负责在翻译前构建初始 glossary：

- 从章节文本中抽取候选 unigram / n-gram
- 针对中、日、韩、俄等语言使用不同分词策略
- 将候选词分批发送给 AI，筛出值得全书统一的术语
- 在后续 batch prompt 中按需注入相关 glossary 项

这一步的目标不是做完整术语库，而是优先解决“跨章节一致性”问题。

### 7.3 标题格式标准化

`src/content/headings.js` 提供两个能力：

- 分析标题编号、章节前缀等格式样例
- 在翻译后再次统一 heading 格式

这个后处理存在的原因是：大模型对正文翻译相对稳定，但对 `Chapter I`、`1.2`、`A.` 这类结构前缀的风格一致性并不天然可靠。

## 8. 各输入类型工作流

### 8.1 EPUB

EPUB 流程大致如下：

1. 解压并读取 `.opf`
2. 建立章节映射 `chapterMap`
3. 规划翻译顺序
4. 生成 glossary
5. 翻译章节并逐章写缓存
6. 同步 TOC / NCX
7. 重新打包为新的 `.epub`

相关模块：

- `src/epub/translationJob.js`
- `src/epub/chapterMap.js`
- `src/agent.js`
- `src/epub/tocSync.js`
- `src/epub/epubSaver.js`
- `src/pipeline/translateDocument.js`

### 8.2 HTML

HTML 是最轻量的路径：

1. 读取单文件 HTML
2. 转成单章 `chapterMap`
3. 生成 glossary
4. 收集可见文本节点并翻译
5. 直接输出新的 `.html`

它复用了大部分通用翻译引擎，只是不需要 EPUB 的目录同步和打包。

相关模块：

- `src/html/translationJob.js`
- `src/pipeline/translateDocument.js`

### 8.3 PDF

PDF 是最复杂的一条链路，采用 Node + Python 双层架构。

Node 侧：

1. `src/pdf/translationJob.js` 创建 cache 和输出路径
2. `src/pdf/pdfBridge.js` 调用 Python CLI
3. Python 将 PDF 提取为 JSON block 结构
4. Node 把 JSON 转成 HTML 中间表示并复用统一翻译引擎
5. 翻译后的 HTML 再映射回 PDF JSON
6. `src/pdf/repair.js` 执行额外的 PDF block repair
7. 再调用 Python 将翻译文本回填成 PDF

Python 侧分层：

- `translate_pdf.py`：稳定 CLI 入口
- `app/`：命令参数与入口分发
- `services/`：用例编排
- `domain/layout.py`：块识别、布局与类型判断
- `domain/preservation.py`：哪些区域保留原样
- `domain/rendering.py`：文本回填与渲染
- `infra/`：底层 PDF / 向量能力

PDF 设计的关键点：

- 使用 JSON / HTML 中间层复用 Node 侧通用翻译逻辑
- 对图像、矢量图、页眉页脚等非正文区域采用保守保留策略
- 对可疑的跨块合并翻译结果执行 repair，尽量恢复 block 边界

### 8.4 SRT

SRT 流程：

1. 解析 cue
2. 组装为 subtitle JSON
3. 转换成 HTML 中间表示
4. 复用统一翻译引擎
5. 再映射回 cue JSON
6. 序列化回 `.srt`

相关模块：

- `src/subtitle/translationJob.js`
- `src/subtitle/srt.js`
- `src/pipeline/translateDocument.js`

### 8.5 视频字幕

视频模式在 SRT 流程外多了一层媒体处理：

1. `ffprobe` 探测内嵌字幕轨
2. 扫描同目录外部字幕文件
3. 选择最合适的文本字幕轨
4. 用 `ffmpeg` 抽取或转成 SRT
5. 走统一字幕翻译流程
6. 再用 `ffmpeg` mux 回输出视频

相关模块：

- `src/subtitle/translationJob.js`
- `src/subtitle/video.js`
- `src/subtitle/language.js`

## 9. 缓存、日志与中间产物

### 9.1 缓存

`src/support/cache.js` 提供统一缓存抽象。缓存内容包括：

- 章节翻译 HTML
- `translation_plan.json`
- `glossary.json`
- `heading_rules.json`
- PDF 提取 JSON、翻译后 JSON
- 字幕抽取文件与 JSON

缓存目录采用 `.cache_*` 命名，按输入文件、目标语言和选择器区分。`task_meta.json` 校验源内容、语言、提示词、修复与模型路由；`chapter_status.json` 校验流程版本、HTML 摘要、失败节点和覆盖缺口。无签名旧缓存不能直接复用，损坏 JSON 会隔离后重建。`task.lock` 防止并行任务修改同一缓存。

### 9.2 日志

`src/support/logger.js` 记录：

- 请求与响应内容
- 警告与错误
- glossary 与 heading 相关中间数据
- 外部进程标准输出与错误输出

清理策略统一由 `src/pipeline/artifactPolicy.js` 决定：

| 格式 | 成功、非 debug | 成功、debug | 失败、非 debug | 失败、debug |
|---|---|---|---|---|
| EPUB / HTML | 删除 cache/log | 保留 | 保留 cache/log | 保留 |
| PDF / 字幕 | 删除 cache/log | 保留 | 保留 cache/log | 保留 |

部分完成或验证未通过也会保留 cache/log。退出时释放任务锁，后续任务可以恢复未完成节点。

### 9.3 输入输出约定

- 输入文件可从项目根目录或 `input/` 读取
- 成功后产物写入 `output/`
- 原始输入文件会被移动到 `input/`，目标同名时追加序号保留两份

这套约定让 CLI 使用和批量归档更简单，但也意味着它不是“纯只读”处理工具。

## 10. 并发模型

系统的并发主要体现在 AI 请求层：

- provider 配置中有 `concurrency`
- batch queue 会按并发上限调度多个批次
- 多章节翻译可并发入队
- 单章完成后立即写缓存，不需要等待整本书结束

这个模型的优点是吞吐量高，断点恢复友好；代价是：

- 日志时序不完全线性
- Provider 限流或模型抖动时，失败重试会更频繁

## 11. 外部依赖边界

核心外部依赖包括：

- AI Provider API
- `ffmpeg` / `ffprobe`
- Python 3.10+
- `PyMuPDF`、`pikepdf`
- 可选的 `docling`

在架构上，这些依赖都被隔离在边界模块中：

- AI API -> `src/translation/aiProvider.js`
- 媒体工具 -> `src/subtitle/video.js`
- Python / PDF -> `src/support/environment.js` + `src/pdf/pdfBridge.js`

这样做的好处是主流程不会直接散落大量外部调用细节。

## 12. 当前架构优点

- 入口简单，CLI 使用门槛低
- 不同文档类型共享一套翻译引擎，复用度高
- PDF 被单独隔离成子系统，没有把复杂度直接压进 Node 主流程
- 缓存、预检查、回退模型、失败保留原文等机制让长流程更稳
- glossary 与 heading 标准化补足了“大模型直接翻译”常见的一致性问题

## 13. 当前架构权衡与风险

- 四种格式仍保留各自的 orchestrator；共享的是上下文与翻译内核，apply/save 仍按格式分开
- 翻译引擎高度依赖 prompt 与启发式，行为稳定性受模型变化影响较大
- HTML/EPUB 的“可翻译节点判定”规则较复杂，修改时需要小心回归
- PDF 仍然是最脆弱链路，跨语言回填、块边界恢复、字体覆盖都可能受样本影响
- 视频字幕依赖本机工具链与字幕轨质量，环境差异明显
- 旧缓存缺少签名或版本状态时会重建，首次升级可能需要重新翻译

## 14. 建议的后续演进方向

- 为中间表示定义更明确的数据契约，减少 HTML/JSON 来回映射的隐式假设
- 持续维护缓存协议版本、身份指纹与迁移回归
- 为 EPUB/PDF 工作流补充与 HTML/字幕同等规模的无网络回归样本
- 继续压缩 PDF Python 子系统中仍然偏大的共享模块
- 暂不引入通用 adapter runner：字幕的 preload、PDF 的 validate、EPUB 的 TOC/NCX 仍需要明显的格式专属阶段；如果新增第五种格式再重新评估

## 15. 新开发者阅读顺序

如果要快速理解项目，建议按下面顺序阅读：

1. `README.md`
2. `index.js`
3. `src/core.js` 与 `src/pipeline/jobContext.js`
4. `src/pipeline/translateDocument.js`
5. 任一格式的 `translationJob.js`（建议从 `src/html/` 开始）
6. `src/config.js` 与 `config/wasabi.example.json`
7. `src/translation/translator.js`
8. `src/models/gateway.js`、`src/models/routing.js` 与 `src/translation/aiProvider.js`
9. `src/translation/sdk/*`
10. `src/content/glossary.js`
11. `src/subtitle/video.js`
12. `src/pdf/README.md`
13. `src/pdf/pdfBridge.js` 与 `src/pdf/translate_pdf.py`

这样能先理解系统边界，再进入各个复杂子模块。

## 16. EPUB 增强与合并回归

EPUB 任务在 chapter map 建立后运行 Doctor，在内存中修复超大/非标准章节，再按 OPF spine 建立阅读顺序。Planner 先确定角色与顺序，Director 基于正文生成 Book Bible；正文阶段积累 Living Memory 与双语检索上下文后，再翻译前置材料。Inline Slots、结构保护、覆盖审计和脚注处理保留在共享翻译引擎中。保存前重写并验证内部链接及 HTML/NCX 目录。

`npm test` 显式运行远程 JS 单测、合并交界处集成测试及本地九组审计；有 EPUB 样本时执行真实打包与链接检查。测试夹具包含有效任务签名与章节状态，另有无签名缓存失效、部分完成续跑、共享连接限流、中转 SSE 和同名归档的回归。`npm run lint` 校验 JS，`npm run test:python` 执行 Python 检查；缺少 PDF 依赖或专用 fixture 时按测试说明跳过。
