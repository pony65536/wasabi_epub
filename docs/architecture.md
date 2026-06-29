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
Core Orchestration
  src/core.js
    ->
Content Pipelines
  EPUB / HTML / PDF / Subtitle / Video
    ->
Translation Engine
  src/translation/*
  src/content/*
    ->
Provider Abstraction
  src/translation/aiProvider.js
    ->
External Services
  Gemini / Qwen / Mimo / OpenRouter

PDF Special Path
  src/core.js
    -> src/pdf/pdfBridge.js
    -> src/pdf/translate_pdf.py
    -> src/pdf/app|services|domain|infra
```

## 3. 目录结构

```text
.
├─ index.js                  # CLI 入口
├─ src/
│  ├─ core.js                # 各类输入的主编排
│  ├─ config.js              # Provider、模型、语言与运行时配置
│  ├─ agent.js               # EPUB 章节顺序规划
│  ├─ utils.js               # 通用工具与 AI 调用辅助
│  ├─ translation/           # 翻译执行引擎、队列与 provider 适配
│  ├─ content/               # 术语、标题、内容分类等增强能力
│  ├─ support/               # 缓存、日志、环境检查、选择器解析
│  ├─ epub/                  # EPUB TOC 同步与保存
│  ├─ subtitle/              # SRT/视频字幕处理
│  └─ pdf/                   # PDF 子系统（Node + Python）
├─ prompts/                  # 各模式 Prompt 模板
├─ input/                    # 输入文件归档目录
├─ output/                   # 最终输出目录
├─ log/                      # 调试日志目录
└─ docs/                     # 项目文档
```

## 4. 核心设计原则

- 单入口，多工作流：所有模式统一从 `index.js` 进入，再按扩展名分派。
- 编排与实现分离：`src/core.js` 负责流程控制，具体解析/保存/字幕/PDF 能力下沉到子模块。
- Provider 抽象统一：不同模型供应商通过统一 `callAI` 接口接入。
- 中间表示驱动：HTML、PDF、字幕都尽量转换为可翻译的中间结构后再走统一翻译引擎。
- 缓存优先：章节、术语表、翻译计划、PDF 提取结果都可复用，支持断点续跑。
- 保守输出：遇到无法稳定处理的内容，优先保留原文或原结构，而不是冒险破坏文档。

## 5. 运行流程

### 5.1 CLI 层

`index.js` 负责：

- 解析命令：`translate`、`doctor`、`setup --pdf`
- 解析参数：`--chap`、`--page`、`--from`、`--to`、`--concurrency`、`--debug`
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

### 5.3 主编排层

`src/core.js` 是系统的主调度器，暴露四类入口：

- `runTranslationJob`：EPUB
- `runHtmlTranslationJob`：HTML
- `runPdfTranslationJob`：PDF
- `runSubtitleTranslationJob`：SRT / 视频字幕

它的职责包括：

- 建立 `input/`、`output/`、`log/`、`.cache_*`
- 创建 logger、provider、batch queue、cache
- 决定是否复用缓存
- 串联术语生成、正文翻译、后处理、输出保存
- 结束后根据 `--debug` 决定是否清理缓存和日志

## 6. 翻译引擎

### 6.1 Provider 抽象

`src/translation/aiProvider.js` 封装所有模型调用差异：

- `gemini` 使用 `@google/generative-ai`
- `qwen`、`mimo`、`openrouter` 统一走 OpenAI 兼容接口
- 主 Provider 调用失败时，如果命中内容安全策略，可自动回退到 fallback provider
- 对废弃模型、不可用模型追加更明确的配置提示

运行时配置由 `src/config.js` 生成，支持：

- 主 provider / fallback provider
- 模型名覆盖
- 并发数覆盖
- OpenRouter reasoning 开关
- 术语表专用模型配置

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

- `src/core.js`
- `src/agent.js`
- `src/epub/tocSync.js`
- `src/epub/epubSaver.js`

### 8.2 HTML

HTML 是最轻量的路径：

1. 读取单文件 HTML
2. 转成单章 `chapterMap`
3. 生成 glossary
4. 收集可见文本节点并翻译
5. 直接输出新的 `.html`

它复用了大部分通用翻译引擎，只是不需要 EPUB 的目录同步和打包。

### 8.3 PDF

PDF 是最复杂的一条链路，采用 Node + Python 双层架构。

Node 侧：

1. `src/core.js` 创建 cache 和输出路径
2. `src/pdf/pdfBridge.js` 调用 Python CLI
3. Python 将 PDF 提取为 JSON block 结构
4. Node 把 JSON 转成 HTML 中间表示并复用统一翻译引擎
5. 翻译后的 HTML 再映射回 PDF JSON
6. 执行额外的 PDF block repair
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

- `src/subtitle/srt.js`
- `src/core.js`

### 8.5 视频字幕

视频模式在 SRT 流程外多了一层媒体处理：

1. `ffprobe` 探测内嵌字幕轨
2. 扫描同目录外部字幕文件
3. 选择最合适的文本字幕轨
4. 用 `ffmpeg` 抽取或转成 SRT
5. 走统一字幕翻译流程
6. 再用 `ffmpeg` mux 回输出视频

相关模块：

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

缓存目录采用 `.cache_*` 命名，按输入文件或选择器区分。

### 9.2 日志

`src/support/logger.js` 记录：

- 请求与响应内容
- 警告与错误
- glossary 与 heading 相关中间数据
- 外部进程标准输出与错误输出

默认非 `--debug` 模式会自动清理日志；调试模式下保留。

### 9.3 输入输出约定

- 输入文件可从项目根目录或 `input/` 读取
- 成功后产物写入 `output/`
- 原始输入文件会被移动到 `input/`

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

- `src/core.js` 体量较大，仍是显著的编排中心，后续继续扩展时容易膨胀
- 翻译引擎高度依赖 prompt 与启发式，行为稳定性受模型变化影响较大
- HTML/EPUB 的“可翻译节点判定”规则较复杂，修改时需要小心回归
- PDF 仍然是最脆弱链路，跨语言回填、块边界恢复、字体覆盖都可能受样本影响
- 视频字幕依赖本机工具链与字幕轨质量，环境差异明显
- 当前缓存文件较多，但缺少更强的版本化约束，旧缓存命中时需要谨慎

## 14. 建议的后续演进方向

- 将 `src/core.js` 进一步拆成按输入类型分离的 orchestrator
- 为中间表示定义更明确的数据契约，减少 HTML/JSON 来回映射的隐式假设
- 给缓存引入更清晰的 schema version 与失效机制
- 为 EPUB/HTML/字幕工作流补充更系统的回归样本
- 继续压缩 PDF Python 子系统中仍然偏大的共享模块

## 15. 新开发者阅读顺序

如果要快速理解项目，建议按下面顺序阅读：

1. `README.md`
2. `index.js`
3. `src/core.js`
4. `src/config.js`
5. `src/translation/translator.js`
6. `src/translation/aiProvider.js`
7. `src/content/glossary.js`
8. `src/subtitle/video.js`
9. `src/pdf/README.md`
10. `src/pdf/pdfBridge.js` 与 `src/pdf/translate_pdf.py`

这样能先理解系统边界，再进入各个复杂子模块。
