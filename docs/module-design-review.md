# Wasabi 逐模块设计评审

评审日期：2026-10-03。基于当前工作区，包括尚未提交的 EPUB 修复与任务状态修改。

本次只新增评审文档，没有修改业务实现。P1 表示正确性或数据保护问题，应优先修改；P2 表示恢复能力、成本或契约问题；P3 表示维护性改进。证据分为「离线复现」「静态确认」「设计建议」，不把未运行的实际模型、PDF 渲染或阅读器行为当成已验证结论。

## 1. 总体判断与验证范围

现有模块划分可以保留。更需要修的是三个跨模块契约：

1. **内容契约**：哪个节点需要翻译，哪些标签、锚点、公式、属性必须原样保留。
2. **任务契约**：失败、部分成功、跳过和验收未通过如何聚合，以及续跑如何复原状态。
3. **产物契约**：实际输出位置、验证结果和缓存保留条件必须由程序返回，不能只存在于控制台日志里。

已经通过的检查：

- `node tests/test_translation_status.mjs`，包含无标记的不可信缓存重新翻译与续跑兜底。
- `node tests/test_planning_phases.mjs`。
- `node tests/test_epub_doctor.mjs`：Advances 拆为 36 个条目；5 个被替代的原文件被移除；正文与 spine 顺序保留；244 个 NCX 目标可解析。
- 上一轮新增的合法资源链接校验、NCX 校验、中文角色识别和失败状态已有回归覆盖。

验证限制：

- 本次没有调用真实翻译 API，没有运行 ffmpeg 合流或阅读器验收。
- `python -B tests/test_pdf_formula_heuristics.py` 在导入 `detect_tables` 时失败：当前 Python 缺少 `fitz`。PDF 服务与渲染层的判断主要来自静态检查。
- PDF 测试的 `setUpClass` 还依赖本机 `.cache_2605.08083v1_pdf` 和多个 `output` JSON，安装依赖后也需要准备这些样本。
- 书籍样本未作为仓库固定 fixture 提交；现有书籍测试通过，不代表干净 checkout 必然可重复。

## 2. 模块修改清单

| 模块 | 主要问题 | 优先级 | 建议修改 |
|---|---|---|---|
| CLI / config | 参数解析宽松；模式校验晚；配置依赖导入时全局环境 | P2 | 严格整数解析，先校验模式，显式创建任务配置 |
| core 编排 | 四种 Job 重复状态判断；阶段报告聚合不一致；部分成功未返回机器可读状态 | P1/P2 | 统一结果契约和报告聚合，再按格式拆编排 |
| agent / chapterRoles | 分类依赖标题；AI TOC 判断缺少证据验证；过滤角色不可配置 | P2 | 确定性角色先行，AI 只补充，保留 role/confidence/reason |
| translator | 显式节点与结构回退采用不同判定；完成统计缺少覆盖率；全章同时入队 | P1/P2 | 统一节点模型，覆盖率审计，章节窗口调度 |
| batchQueue | 预处理丢属性；HTML 解析被当成结构校验；字符限额不保证单节点大小 | P1 | 保留 DOM 属性，校验结构与占位符，超长节点显式拆分 |
| aiProvider | 超时没有统一取消；SDK 与业务重试叠加；辅助请求绕过批队列限流 | P2 | 一个请求调度器、取消信号、重试预算与调用统计 |
| content-classifier | 非拉丁文本被当作符号；一个乱码字符影响整段 | P1 | Unicode 与语言感知分类，保守保留不确定文本 |
| inlineSlots | 25 次编码上限；丢 slot 不报错；动态标签和 prompt 契约未统一 | P1 | DOM 编码，完整性验证，返回结构化解码结果 |
| glossary | 全书拼接与频数去重不严谨；失败与空词表不区分 | P2 | 按章节计数、显式优先级、结构化生成报告 |
| director | 抽样依赖角色尚未完善的章节；抽样限制偏前部；JSON 缺少 schema 校验 | P2 | 先分类，分层预算抽样，校验并规范化 Book Bible |
| memory | 仅译文难恢复原文术语；并发完成顺序影响首次写入；缓存恢复不重建检索 | P2 | 保存双语实体证据、冲突策略和可重建记忆 |
| retriever | 源语关键词查目标语文本；全文子串扫描；段落边界丢失 | P2 | 双语索引、保留段落、查询源/译名、去重与限制大小 |
| critic | 校验与审校职责混合；门控使用带标签长度；单节点回退走不同路径 | P2 | 确定性校验先行，语义审校有预算且走统一出口 |
| headings | 第二轮模型可能改文案/行内结构；独立队列和重试实现重复 | P2 | 优先规则转换，仅让模型处理无法规则化的标题 |
| footnotes | 续跑注释重新从 1 编号，重复 id；没有持久化注释契约 | P1 | 使用真实章节 id，加载现有注释并幂等装配 |
| epubDoctor | 新文档丢 html/body 属性和 body 直接文本；候选边界只遍历顶层元素 | P1 | 保留文档壳、直接文本和命名空间，嵌套边界保守处理 |
| linkRewriter / utils | 标题解析优先下一节点；路径大小写、编码和全局锚点兜底不严谨 | P1/P2 | 分开严格验证与修复兜底，统一文件与片段解析 |
| tocSync | 同步所有 a；标题提取可能拿正文；HTML 同步异常仅打印 | P1/P2 | 在 TOC 范围内更新，输出变更与失败报告 |
| epubSaver | 新 itemref 丢原属性；新增 manifest item 没继承语义；直接写最终文件 | P1/P2 | 属性继承策略，按 container 找 OPF，临时文件验证后提交 |
| cache | 状态和 HTML 分开覆盖写；JSON 损坏处理不统一；目录无任务锁 | P2 | 原子写、内容校验、统一损坏处理与每任务写锁 |
| taskIdentity | 小文件摘要也带 mtime；大文件采样有局限；缺少身份的缓存被补写签名 | P2 | 内容摘要与快速指纹分开，未验证缓存显式迁移 |
| archive / logger | 归档存在检查与移动之间有竞争；日志名称仅精确到秒 | P2 | 无覆盖提交策略；runId 用 UUID，结构化日志 |
| environment / subprocess | Python 和视频子进程封装重复；无统一超时/取消/日志上限 | P2 | 共用进程执行器，预检查返回选择结果供后续复用 |
| pdfHtml / pdfBridge | 中间数据未经完整校验；Python fallback 输出路径未返回 Node | P1/P2 | 类型化桥接协议，返回实际路径与块级处理结果 |
| PDF domain / services | core 与星号导入造成隐式耦合；渲染、验收、动作推导相互依赖 | P2/P3 | 明确 Block/RenderResult 契约，输出渲染账本，逐步拆规则 |
| SRT / video | SRT 时间未验证、标识 round-trip 失败；选轨先选后查能力 | P1/P2 | 严格时间检查、统一序列化约定、先过滤可处理轨 |
| tests / package | 没有统一 test 命令；核心测试 stub 跳过真实队列；PDF fixture 非自包含 | P2 | 纯单元、队列集成、格式样本三层测试与固定入口 |

## 3. 各模块详细说明

### 3.1 CLI 与配置：index.js、src/config.js、选择器

**离线复现**：`parsePageSelector("2junk")` 返回 `[2]`。原因是 `parseInt` 接受整数前缀。CLI 的 concurrency 使用相同解析方式；异常值可能被接受而不是报错。

**静态确认**：CLI 在格式参数合法性检查之前执行环境预检查。比如非 PDF 的 `--page` 会先检查翻译依赖，再提示参数不适用。CURRENT_PROVIDER、CONFIG 在模块导入时从环境生成，使注入测试配置和同进程多个不同 provider 的任务比较困难。

修改：

- 正整数先用完整匹配，再用 `Number` 与 `Number.isSafeInteger`；range 也要限制展开量。
- 在启动 provider、环境探测或 AI 请求前检查输入格式、选择器和输出路径。
- 用 `createRuntimeConfig(env, overrides)` 返回包含 primary/fallback 的显式配置，任务内部不要再读取全局 provider 常量。
- 保留 chapterSelection 的引号与范围解析，不必为重构而重写；补 Unicode 标题、非法整数、选择范围上限测试即可。

### 3.2 编排：src/core.js

**离线复现**：将一个包含 complete 和 failed 章节、总体为 partial 的报告传给 `mergeTranslationReports([report])`，结果变为 failed。单阶段与阶段合并对「部分章节失败」的定义不同，EPUB 主流程可能把已有部分成功的任务当成整体失败。

**静态确认**：EPUB / HTML Job 返回值没有 translationStatus；PDF 返回 validationStatus，却没有对应的翻译状态。调用方只能看终端文本判断是否为部分产物。PDF 的 `needs_review` 输出在 translationStatus=complete 时仍会清理缓存和日志，验收问题的复查材料被删除。

修改：

- 用同一个 reducer 汇总节点、章节、阶段结果；`merge([x])` 必须保持 x 的语义。
- 返回 `JobResult { translationStatus, validationStatus, counts, outputPath, reportPath, cacheDir, logFile }`。translationStatus 与 validationStatus 分开维护。
- 只有翻译完整且验收通过才自动清理；needs_review 与 partial 均保留修复材料。
- 状态与产物契约稳定后，将 EPUB / HTML / PDF / subtitle Job 下沉到独立编排文件；共用任务上下文、结果、缓存与发布逻辑。避免只把大文件机械切成多个文件。

验收：完整、部分失败、全失败、恢复已缓存章节、正文/前言混合状态、验收失败、保存失败，都走一次真实 Job 级集成测试。

### 3.3 章节规划：src/agent.js、src/content/chapterRoles.js

新实现的角色排除、漏项补回和阅读顺序选择可以保留。仍有两个契约问题：

- **静态确认**：AI 返回 tocId 时只检查 id 存在，不检查目标确实是目录。正文误标为 TOC 后会被跳过。
- **设计建议**：References / Introduction / Appendix 并不总是应排除或延后；标题规则不能替代书籍类型判断。链接密度兜底也可能命中索引或脚注页。

修改：确定性角色记录 `{role, confidence, reason}`；AI 仅补充低置信度项。tocId 必须验证导航结构或标题证据。提供排除角色策略；阅读顺序、用户选择与执行顺序分别存储。Plan 仅缓存 id / role / order，不把整章 HTML 快照放进计划；加载时绑定当前 chapterMap，保证只有一份正文事实来源。

### 3.4 翻译执行：src/translation/translator.js

缓存无标记漏洞在本次读取时已修复，相关测试通过，应保留这个修复。

**离线复现**：中英混排章节中，英文 p 被收集，中文 p 被过滤；结构回退因为英文覆盖率足够而不触发。最终状态 complete，但中文段落没有发给模型。这说明 complete 目前只代表「已选节点处理完成」，没有保证「应翻内容处理完成」。

**静态确认**：显式节点枚举 p/li/heading 时未统一处理父子重叠；结构收集器与显式路径的分类规则不同。所有章节同时创建 DOM 和批任务，大书内存与辅助请求量没有章节级上限。

修改：

- 统一 `TranslationUnit { id, sourceText, sourceHtml, structuralSlots, decision, reason }`；任何两 unit 不得拥有同一可翻译文本。
- 输出 selected / translated / intentionallyPreserved / unresolved 的节点与字符计数；有可翻译内容却选到 0 个节点不能直接 complete。
- 小窗口调度章节，在模型批次层并发；处理完一个窗口后提交记忆快照，减少完成顺序的不确定性。
- 缓存恢复章节也要进入 retriever，必要时恢复章节记忆；避免续跑与新跑使用不同上下文。

### 3.5 批处理：src/translation/batchQueue.js

**离线复现**：`A<span id="anchor" class="meaningful">word</span>` 在编码前经过 mergeRegex 后变成 `Aword`，锚点和样式均丢失。即使模型完全照抄输入也无法恢复。

**静态确认**：调用 cheerio.load 并不提供严格的 XHTML 结构契约；队列只要求节点存在且内容非空，没有验证返回的保护标签是否完整。sizeLimit=5000 只限制装批过程，单个超过限额的节点仍会完整入队。模型请求、审校和结构写回集中在一个函数，失败分类与批次事务难以测试。

修改：

- 删除通用剥标签合并；只对已识别的装饰性 drop-cap 做专用无损转换。
- 分离构造请求、解析响应、校验结构、提交更新四步；所有目标验证成功后再修改 DOM。
- 按最终 prompt + batch 的预算装批；单个超长 unit 按文本边界拆分，禁止拆断保护对象。
- 对 duplicate / missing / unexpected node id、缺失 slot、属性变化建立错误类别和对应重试策略。

### 3.6 Provider：src/translation/aiProvider.js

**静态确认**：外层 Promise.race 超时不统一取消底层请求。已安装 OpenAI SDK 默认 maxRetries=2，外层批队列每轮最多 3 次，translator 又有多轮与单节点重试，调用次数不是单层「重试三次」。Director、Memory、Glossary、Critic 直接调用 provider，不受正文批队列的整体并发限制。

修改：

- 一个共享请求调度器管理正文和辅助请求，并设置辅助请求优先级与预算。
- 一个明确的重试所有者；区分网络瞬断、429、认证错误、模型不存在、格式不符、结构不完整。认证和永久配置错误快速失败。
- 通过 AbortSignal 或 provider 支持的取消机制终止底层请求；无法取消的 provider 明确记录仍在运行。
- 返回包含模型、usage、耗时、重试次数和原始 finish reason 的调用结果；限制自定义 SSE 解析的输入类型并校验完整响应。

### 3.7 内容分类：src/content/content-classifier.js

**离线复现**：中文、日文、西里尔字母句子在 classifyTextNode 中都得到 TEXT_NOISE / DROP / mostly_symbols。这里的 symbolCount 使用 ASCII 排除表达式，而 translator 的另一套 isMostlySymbols 已使用 Unicode，二者行为矛盾。含一个 `�` 的英文段落也被整段判成 DROP。

修改：采用 Unicode 字母/数字类别，并把语言、节点类型与证据纳入判定。分类器的动作应叫 translate / preserve / uncertain，避免 DROP 被误解为可以删除正文。不确定 OCR 文本保留并记入审计，而不是默认不翻。先修分类器与其调用路径，再调整阈值。

验收：中英混排、中文短标题、日文假名、西里尔字母、带乱码的长段、公式与图例混排。

### 3.8 行内占位符：src/content/inlineSlots.js

**离线复现**：30 个 em 标签只编码 25 个，其余 5 个以原 HTML 发送给模型。模型返回完全没有原 slot 的文本时，decodeInlineTags 直接返回该文本，原链接可以无声消失。

修改：DOM 遍历替代固定迭代的正则编码；记录每个保护对象的 id、标签、属性、必要文本和允许的重排规则。解码返回 `{html, missingSlots, unknownSlots, duplicateSlots, errors}`；调用方必须检查。动态 slot 标签名应显式进入请求契约，不能只在本地变更标签名而让 prompt 继续要求固定 ws-slot。

### 3.9 术语表：src/content/glossary.js

**静态确认**：全书词序列跨章节生成 n-gram，可能产生章节边界上的假短语。候选去重表达式保留第一次出现，并不保证注释所说的最高 count。AI 批失败后只记录日志，调用方得到词表却不知道是否完整；空词表也无法区分没有术语和生成失败。

修改：按章节/段落统计后合并 Map，确定频数和上下文；保留原始大小写与实体形态。Glossary 返回状态、覆盖批次与错误；术语保存 source / target / origin / confidence / approved。Director 与 Extractor 的术语冲突采用显式优先级，避免两份 prompt 同时给模型相反译法。

### 3.10 Director：src/content/director.js

分层抽样是合理的成本控制，可以保留。

**静态确认**：Director 在规划/角色标记之前运行，只能靠标题启发式排除目录等材料。单章先选开头、中间、结尾，最后再 slice 前 3000 字符，可能裁掉后部抽样。返回 JSON 没有 schema 验证，Memory 也直接持有它。

修改：先确定阅读结构与角色，再抽样；给前、中、尾各自固定预算。校验 Book Bible 并补齐数组/对象默认值。人物性别和译名记录证据与 unknown，避免抽样推断被当成不可修正的全书真值。

### 3.11 动态记忆：src/content/memory.js

等待提取任务已接入，先保留该改进。

**静态确认**：Extractor 收到的是译文 HTML 前 4000 字符，却要求返回 Original Name 和 Source Term；原文已经丢失，难以稳定恢复源语键。合并采用首次写入，不解决错误实体或译法冲突；正文并发完成顺序会决定首次写入。已有初始 Book Bible 缺少 characterBible 时，push 路径也不具备完整默认值保护。

修改：从源/译对齐的 TranslationUnit 提取双语实体；传纯文本与章节 id；规范化初始数据；冲突记录 provenance，按角色/审批优先级处理，支持更正而不是永久保留第一次结果。仅在有语义变化时保存，记忆规模和辅助调用数都设预算。

### 3.12 前文检索：src/content/retriever.js

**离线复现**：索引中文「三重障碍」段落后，用 `triple barrier` 查询没有命中，译名查询能命中。当前 translator 的查询键主要来自源语 glossary term，而索引内容是译文。

**静态确认**：实现是全文 includes 计数，并非注释中的 BM25/TF-IDF；调用方用 loadHtml(...).text() 提取全文，段落分隔不一定保留；复用完整缓存的分支没有重建索引。

修改：索引双语段落和实体别名；同时查 source/target term；稳定 paragraphId；按相关性、章节顺序和去重限制上下文字符数。indexChapter 对同一章节幂等，缓存恢复时重建索引。先修跨语查询，不必马上引入向量数据库。

### 3.13 Critic：src/content/critic.js

**静态确认**：门控按带 HTML/slot 的字符串长度判断，格式较多时不能代表语义长度。hasSevereIssue 没进入状态契约；改写结果未通过独立的结构与数值保留验证。队列的单节点纯文本回退不经过相同的 Critic 路径。多语言任务仍有「Chinese readers」固定约束。

修改：把结构校验和语义审校分开；对纯文本计算语言相关长度比，检查数字/实体/公式保护。所有响应走同一校验出口；严重问题可记录 unresolved，不要仅接受非空 improved。限制审校调用量并保留审校原因。

### 3.14 标题：src/content/headings.js

**静态确认**：分析把全书唯一标题一次性发给 AI，没有输入预算；后处理另建一套队列/重试，与正文结构保护不同，返回文本仍可能重写标题正文。格式示例不构成可执行的编号规则。缓存保存的是翻译阶段 HTML，后处理阶段没有独立恢复点。

修改：把标题拆成 ordinal / prefix / title / level，常见编号、标点、空白用确定性规则处理。AI 只生成受校验的特殊格式建议。需要保留的行内标签使用统一 slot 校验；后处理可重跑且幂等，有单独阶段状态。

### 3.15 脚注：src/content/footnotes.js

**离线复现**：第一次装配一个注释、续跑再装配一个，得到两个相同的 noteref-same-1 和 note-same-1。原因是每次 notesCollection 从空数组开始。translator 传入的是 chapterTitle，不是真实 chapterId；不同章节标题也可能被清洗为相同 slug。

修改：以稳定章节 id 和稳定注释 id 建账；从缓存加载现有 note registry；装配前读取已有 section，去重并增量更新。模型产生的 term 使用文本节点写入，注释 HTML 按允许结构处理。注释命名空间、正反向引用与重复 id 一并校验。

### 3.16 EPUB 拆分：src/epub/epubDoctor.js

已有 NCX 边界线索、续文命名、Index 保护和正文顺序审计可保留。

**离线复现**：原 html 的 lang、xmlns:epub 和 body 的 class/id，在生成分片后全部缺失。**静态确认**：使用 body.children() 而不是 contents()，body 直接文本不在分片序列中；只遍历顶层子元素，包在一个大 div 内的真实章节也不能安全切开。

修改：克隆文档壳和必须继承的属性；body id 不能简单复制到所有分片，应保留在原目标所属片并更新映射；保留所有文本节点。嵌套拆分要定义可以拆开的容器，不能直接扁平化。返回原文件→分片、原锚点→目标、边界理由的重建报告；验收比较文字/资源/属性及阅读序列。

### 3.17 路径与链接：src/epub/linkRewriter.js、src/utils.js

**离线复现**：`<h1 id="ch1">Chapter One</h1><p>Opening paragraph.</p>` 的 resolveAnchorHeading("ch1") 返回 Opening paragraph，而不是标题；原因是先取下一节点，再取自身。

**静态确认**：normalizeHref 统一转小写，可能合并 ZIP 中大小写不同的资源；片段编码未与 id 解码统一。直接用 `#${anchor}` 当 CSS 选择器，特殊字符 id 有选择器语义。索引 Map 不报告同文件重复 id。资源索引包含原 ZIP 条目，保存前应明确最终被移除的条目集合。

修改：自身 heading / hgroup 优先，空定位节点才查相邻标题；精确属性匹配或转义选择器。保持路径大小写，以源文件路径规范化相对路径，分开编码与解码。严格验证依据最终资源清单，修复兜底单独报告，不能把「猜到一个目标」等同于「原链接有效」。

### 3.18 TOC 同步：src/epub/tocSync.js

NCX 同步的 ok/error 返回和保存前验证已增加，不再列作缺失。

**静态确认**：HTML TOC 同步修改整页所有 a，而不是指定 toc nav/目录容器；页面混有版权、外部说明、脚注链接时范围过大。HTML 异常仍只打印，不像 NCX 返回错误。只验证跳转目标，没有验证标签文案确实对应该目标。

修改：优先用 manifest nav 属性与 EPUB 导航容器确定范围；保留原目录层级。返回 matched / changed / unresolved / labelFallback / errors；同步失败由编排按是否受重建影响决定是否阻止保存。建立含章节、子节、普通链接和特殊 id 的样本。

### 3.19 EPUB 保存：src/epub/epubSaver.js

**静态确认**：原 spine itemref 被替换时，新 itemref 只写 idref，原 linear 等属性丢失；生成 manifest item 也没有原 item 的语义属性继承策略。查找第一份 .opf，未从 container.xml 确定包文件。最终路径直接 writeZip，没有在临时产物上重新校验包结构。

修改：把 PackageModel / manifest / spine 元数据保存在解析模型中；按拆分属性策略继承，保留非线性阅读项语义。依据 container 选择 OPF。构建完整新包→解包审计 manifest/spine/资源/链接/重复 id→原子提交最终文件。旧文件删除只能来自明确 replacement report。

### 3.20 缓存与任务身份：src/support/cache.js、taskIdentity.js

**静态确认**：HTML、章节状态、TaskMeta 分别直接 writeFileSync，异常退出时可能出现组合不一致。loadPlan/loadGlossary 的坏 JSON 会抛异常，loadChapterStatus/TaskMeta 却静默兜底，恢复策略不统一。未找到 task signature 时 ensureCacheIdentity 直接写入新身份，没有验证已有内容的来源。

**离线复现**：同一小文件只改变 mtime，computeFileDigest 结果就改变；这会使内容没变的缓存失效。大文件摘要是采样指纹，需要明确其不是完整内容证明。

修改：临时文件+提交策略、章节 HTML 摘要/代号与状态关联；统一损坏缓存隔离与恢复。完整内容 hash 不含 mtime；快速文件指纹作为另一个字段，必要时流式计算完整 hash。身份缺失但已有缓存时进入 migration/unverified，不直接赋予新任务身份。每任务加锁，避免两个进程共用缓存目录互相清理。所有写入通过 cache 模块，编排不直接管理内部缓存布局。

### 3.21 归档与日志：src/support/archive.js、logger.js

顺序执行下的同名归档保护已经修复，普通流程可以保留。

**离线复现**：同一秒创建两个 logger，logFile 完全相同；任一任务清理日志都可能删除另一任务的记录。**静态确认**：归档存在检查后再 rename/copy，是检查与提交分开的操作，多进程下不保证不覆盖。原输入路径和输出路径没有统一的冲突策略。

修改：UUID runId，结构化事件包括 taskId / chapterId / batchId / phase；日志按事件等级配置完整内容，不让日志写入异常覆盖业务异常。文件归档用显式无覆盖提交或独占锁，并返回实际归档路径给 JobResult。输出也采用明确的覆盖/版本策略。

### 3.22 环境与子进程：src/support/environment.js、pdfBridge.js、video.js

**静态确认**：Python 和视频各有子进程封装，stdout/stderr 全量累加，没有统一 timeout、AbortSignal、输出上限。PDF 每一步重新选择 Python；错误桥接只保留格式化字符串，部分 code/cause 信息丢失。

修改：一个 ProcessRunner，支持参数数组、cwd、超时、取消、限长日志尾部和结构化退出原因。preflight 返回 Python/ffmpeg 的实际可执行位置与版本并在 JobContext 中复用。JSON 结果与进度日志使用不同通道/文件，不能让日志承担协议。

### 3.23 PDF 中间模型与桥接：src/pdf/pdfHtml.js、pdfBridge.js

**静态确认，P1**：Python fill 在目标被占用时会改存时间戳 fallback 路径，只通过 stdout 告知；Node fillPdfFromJson 仍返回原 outputPath，core 随后也验证原路径。如果原路径存在旧文件，可能验证的是旧输出；否则验证找不到本次实际产物。

此外，pdfHtml 依据 id 对照直接修改传入 JSON；缺失/重复块 id、遗漏公式 placeholder 和不同 schema 版本没有完整的映射报告。剩余 placeholder 的 regex 检查只重置 lastIndex，不会报告未恢复。

修改：Python 返回 `RenderResult { actualOutputPath, written, preserved, review, errors, blockResults }`；Node 用实际路径验证和返回。以独立 Block schema 校验两端输入。HTML→JSON 映射报告 missing/duplicate/unknown blocks、未恢复占位符和每块翻译状态；不能只把非空文本当成功。明确公式与样式索引的字符坐标在转换前后的含义。

### 3.24 PDF domain、services 与工具

覆盖范围：domain/core、layout、preservation、rendering、common；services/extract、fill、strip、validate；infra/vector_extract；detect_tables、annotate_tables；app/CLI、page selection。

**静态确认**：layout 和 rendering 从 3118 行 domain/core 星号导入，core 同时包含依赖加载、文字清洗、公式、字体与排版规则。validate 从 fill 导入多个私有帮助函数并重新推导动作；fill 中局部将 block.action 降为 review，没有统一渲染账本回传。表格检测独立工具与 extraction 的规则也没有统一可版本化契约。

修改：

- 先定义 Block、PreservationDecision、ErasePlan、RenderResult、ValidationIssue；规则需 reason 与 evidence，别仅散布布尔字段。
- 提取、保护判定、擦除、渲染、验收各负责自己的契约；验收结合实际渲染账本，仍保留独立图像/文字检查，避免只重演同一判断算法。
- 将 core 的公式、字体、几何、文字规则逐步拆成显式导入；保留现有 app/services 外层，不做一次性重写。
- 表格与矢量提取输出 schema 和坐标系统一致，输出算法版本与置信度；独立 CLI 使用同一适配接口。
- 页面选择逻辑在 Node/Python 建共同 fixture；大数据清洗与排版阈值需要固定字体、公式、旋转、多栏、图文混排的样本集。

这里的建议主要基于依赖与协议检查；未对全部排版规则作逐行证明，也未验证真实 PDF 渲染效果。

### 3.25 SRT、视频与语言：src/subtitle/*

**离线复现**：

- parseSrt 接受 `99:99:99,999 --> 00:00:00,000`，没有检查分秒合法性或 start<=end。
- 带 `Scene-A` 标识的输入可以解析，但 serializeSrt 写为序号、标识、时间三行，parseSrt 不能读回自己的输出。
- 同一语言下第一个轨为 PGS、第二个为 subrip，选轨挑第一个，再报 unsupported，尽管存在可处理轨。

**静态确认**：映射回字幕时缺失译文回退为 sourceText，但没有 cue 级状态，无法审计实际成功数。显式源语未匹配时可以选另一语言轨，配置中的 sourceLanguage 却仍保持显式值。ASS/SSA→SRT 有意损失部分样式，应作为转换能力报告。自动语言推断是启发式，应能返回 unknown 和置信度。

修改：时间转为毫秒校验，保留可接受的重叠字幕而不是一律禁止；约定是否支持非数字标识，保证 parse/serialize round-trip。选轨前过滤能力，并输出候选理由；显式语言不匹配要明确反馈。每 cue 保留 id、时间、source、target、status；验收 cue 数、id 集与时间一致。视频任务以实际选轨的源语及字幕来源建身份；翻译后不应继续靠变更的 runtimeConfig 隐式传状态。

### 3.26 测试、工程入口与文档

**静态确认**：package.json 仅 pdf:install，没有统一 test 命令，main 指向 bot.js 而当前工作区没有该文件。状态测试采用 StubQueue，不覆盖真实 batchQueue 的编码、预处理和写回。书籍测试读取本机 EPUB；PDF 测试读运行缓存。

修改：

- 增加可独立运行的 unit / integration / sample 三层测试入口；package 入口与实际 CLI 一致。
- 纯单元使用小型合成 fixture，不要求 API、真实书、私人缓存；样本验收明确可选依赖与跳过理由。
- 加入本次复现的 Unicode 分类、属性保留、slot 完整性、脚注续跑、标题定位、SRT round-trip、阶段报告不变量。
- 真实队列配 fake provider 做集成；再配可注入的 ProcessRunner/Provider 做 Job 级失败和恢复测试。
- 文档中的「自动更新 OPF」「BM25/TF-IDF」「完全兼容阅读器」与实际实现、验收范围保持一致。

## 4. 推荐修改顺序

### 第一批：正确性修复

1. Unicode 分类与实际内容覆盖率。
2. 删除 batchQueue 的有损 span 合并；补 slot 完整性和结构校验。
3. 脚注幂等与稳定 id，拆分时保留文档壳与文本节点。
4. 修正标题锚点解析、新 itemref 属性继承、严格最终包验证。
5. 统一阶段报告 reducer、返回 JobResult；PDF 返回真实输出路径，needs_review 保留材料。
6. SRT 时间、标识 round-trip 与选轨能力过滤。

### 第二批：恢复与成本

1. 原子缓存写入、明确任务身份迁移、任务锁与唯一日志 id。
2. 共用请求调度器、取消与总重试预算；长节点和章节窗口。
3. 双语记忆/检索、缓存恢复索引、术语冲突策略。
4. 子进程协议、超时、取消与错误结构。

### 第三批：维护性重构

1. 按格式拆 core，但保留共用的任务上下文与契约。
2. 给中间模型加 JSDoc/类型与运行时 schema 检查，不要求立刻全仓迁移 TypeScript。
3. 去除 PDF 星号导入，分拆 domain/core；固定 fixture 与算法版本。

不要先花主要时间换队列库、引入向量数据库或重写全部模块。先把已经复现的遗漏、结构丢失和状态不一致修掉，再用相同测试保护渐进重构。
