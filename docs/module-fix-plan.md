# 模块正确性与契约修复计划（v2 修订版）

> 依据：`docs/module-design-review.md` + 本轮独立复现 + 计划评审 6 点修订
> 只覆盖确认成立的问题，不改模块划分；离线验收（未调真实 API / ffmpeg / PDF 渲染器）

## 0. 已独立复现的问题（计划事实基础）

| 复现项 | 结果 |
|--------|------|
| `mergeTranslationReports([partial+failed])` | 返回 `failed`，与单阶段聚合不一致 |
| `classifyTextNode` 中文/日文/西里尔 | 全部 `DROP / mostly_symbols` |
| `resolveAnchorHeading(<h1 id="ch1">)` | 返回下一段正文而非标题 |
| 35 个 `<em>`：编码 25 上限 + 解码 30 上限 | 编码后剩 5 个原样外发；解码后仍残留 `</ws-slot>` |
| `parseSrt("99:99:99,999 ...")` | 接受非法时间 |
| `parseSrt(serializeSrt(x))` | 带标识 SRT 往返失败 |
| `computeFileDigest` 同内容改 mtime | 摘要变化 |
| `parsePageSelector("2junk")` | 返回 `[2]` |

静态确认：batchQueue `mergeRegex` 丢 span 属性、epubDoctor 丢 `html/body` 属性与 body 直接文本、footnotes 续跑重复 id、logger 同秒同文件、PDF fallback 路径未回传、epubSaver 替换 itemref 不继承属性、tocSync 改目录页所有 `<a>`、agent tocId 只验证 id、director 先于角色分类、memory 拿译文找原文键、retriever 源语词查译文。

## 1. 目标契约

1. **内容契约**：逐文本单元记录「选没选、翻没翻、为什么保留」，任何应翻未翻不得 complete。
2. **任务契约**：complete / partial / failed / 跳过 / 验收未过 使用同一个 reducer；续跑只复原已验证状态。
3. **产物契约**：`JobResult { translationStatus, validationStatus, counts, outputPath, reportPath, cacheDir, logFile }` 由函数返回；needs_review / partial 均保留材料。

---

## 2. 批次一：正确性修复（按评审修订顺序）

### 2.0 测试入口与合成 fixture（开工第一步）
- `package.json` 增 `"test": "node tests/run_all.mjs"`；`main` 指向真实 CLI。
- 新增 `tests/fixtures/`：合成 EPUB（含 body 直接文本、html/body 属性、EPUB2 NCX+HTML TOC、嵌套 span 锚点）、合成 SRT（非法时间/带标识/多轨描述）、slot 样本（35 个 `<em>`、嵌套 slot）。
- `tests/run_all.mjs` 依次跑：`test_content_classifier`、`test_structure_fidelity`、`test_srt`、`test_translation_status`、`test_planning_phases`、`test_epub_doctor`；无书籍样本时明确 skip 理由。
- 验收：干净 checkout 下不依赖私人缓存即可跑单元层；书籍样本层允许跳过。

### 2.1 统一状态 reducer（P1，回归）
- 根因：`performTranslation` 用「全部失败才 failed」，`mergeTranslationReports` 用「有 failed 即 failed」。
- 修法：抽出 `aggregateTranslationResults(chapters)`，两个入口共用。
- 验收：`merge([mixed])===partial`、`merge([complete,failed])===partial`、`merge([failed])===failed`、`merge([])===complete`。
- 文件：`src/translation/translator.js`；测试 `tests/test_translation_status.mjs`。

### 2.2 Unicode 内容分类 + 逐单元覆盖率（P1）
- 修法：
  - `classifyTextNode` 改用 Unicode 属性：`\p{L}` / `\p{N}` / `\p{P}` / `\p{S}`；CJK/假名/西里尔按字母计。
  - 「词」判定：拉丁 `[A-Za-z]{3,}`；CJK/假名/韩文连续 2+ 字视为可翻文本。
  - `�` 不再整段 DROP：有足够字母则 KEEP 并记 `uncertain`。
  - 覆盖率审计：为每个可见文本单元记录 `{unitId, selected, translated, decision, reason, charCount}`；输出 selected / translated / intentionallyPreserved / unresolved 汇总。
  - **完成条件**：只要存在 `decision=translate` 却未 translated 的单元，章节不得 complete（按未处理数量记 partial/failed）。不仅防 selected=0，也防「英文选到了、其他正文漏了」。
- 验收：中/日/西里尔短句 KEEP；中英混排全量进入翻译；单乱码长段不整段丢；`selected>0 但仍有漏选` 的反例必须判 partial 且列出漏选单元。
- 文件：`src/content/content-classifier.js`、`src/translation/translator.js`；测试 `tests/test_content_classifier.mjs`。

### 2.3 占位符与队列保真（P1）
- inlineSlots：
  - 编码、解码都去掉固定次数上限（改为「循环到无变化」，上限按 `slotMap` 规模推导，仅作死循环保护）。
  - 解码返回 `{html, missingSlots, unknownSlots, duplicateSlots}`，并保证还原后无 `<slotTag` / `</slotTag` 残留；嵌套关系正确。
  - 保留返回字符串的兼容包装，调用方逐步迁移。
- batchQueue：
  - 删除通用 `mergeRegex` 剥标签合并；drop-cap 专用无损转换（本批可先不合并）。
  - 写回前统一校验出口 `validateProtectedStructure(before, after)`：受保护标签名/属性（`id/href/class/name/epub:type` 等）与值一致、嵌套关系一致、slot 完整；数量相同但值变化也要拦。
  - 批量写回、单节点回退、Critic 改写**三条路径都走同一校验出口**，全部通过后才修改 DOM。
- 验收：`A<span id="anchor" class="x">word</span>` 翻译后锚点/class 不变；35 个 `<em>` 往返无残留；模型漏 slot / 改 id / 改嵌套时该批失败重试。
- 文件：`src/content/inlineSlots.js`、`src/translation/batchQueue.js`、`src/content/critic.js`；测试 `tests/test_structure_fidelity.mjs`。

### 2.4 EPUB 拆分文档壳 + 目录兼容（P1/P2）
- epubDoctor：
  - 克隆原 `<html>` 属性（lang、dir、xmlns:epub）到各分片。
  - body 属性按语义拆分：`class/style/lang/dir` 等视觉/语言属性保留到各分片；原 `id` 只保留在 body 起点所在分片，并维护「原 id → 目标分片」映射供链接解析。
  - 遍历改 `contents()`，body 直接文本节点归入当前分片。
  - 嵌套容器拆分不在本批（遗留清单）。
- tocSync：
  - 不依赖 EPUB3 nav；保留传统目录容器识别：EPUB2 NCX + HTML 目录（manifest nav / guide reference / 内部链接密度 + 标题模式）。
  - 只处理识别出的目录容器内链接；返回 `{matched, changed, unresolved, errors}`；HTML 同步异常与 NCX 一样可阻止保存。
- epubSaver：
  - 替换出的新 `<itemref>` 按语义继承 `linear` / `properties`；原 `id` 单独处理（分片不复用原 id，避免重复标识；如需引用则重映射）。
- 验收：Advances（EPUB2）目录可同步；拆分后各片有原 `lang`，首片保留 body id，class/style 各片保留；合成样本覆盖 body 直接文本；`linear="no"` 保留且无重复 id。
- 文件：`src/epub/epubDoctor.js`、`src/epub/tocSync.js`、`src/epub/epubSaver.js`；测试 `tests/test_epub_doctor.mjs`、`tests/test_structure_fidelity.mjs`。

### 2.5 脚注幂等与稳定 id（P1）
- 根因：`notesCollection` 每次从空数组开始；slug 用 `chapterTitle`；`appendFootnotesSection` 直接追加。
- 修法：
  - translator 传稳定 `ch.id`（`chapterTranslationOptions.chapterId`，回退 title）。
  - `extractAndFormatNotes` 支持 `startIndex`：扫描已有 `a[id^="noteref-<slug>-"]` 最大序号后继续。
  - `appendFootnotesSection` 复用已有 `section[epub:type="footnotes"]`，按 `noteId` 去重后只追加新 aside。
  - `term` 写入前实体转义。
- 验收：连续装配两次 id 唯一；partial 续跑（已有 refs + 新 ws-note）不重复且编号连续。
- 文件：`src/content/footnotes.js`、`src/translation/translator.js`；测试 `tests/test_structure_fidelity.mjs`。

### 2.6 SRT 时间、往返与选轨（P1）
- 时间转毫秒校验：分/秒 0-59、毫秒 0-999、`start<=end`。
- 解析支持 `[序号] [标识] 时间` 两种前导；序列化非数字标识时用标识替代序号，保证 `parse(serialize(x))` 往返。
- `core.js` 选轨前按 codec 白名单过滤候选，`assertSubtitleCodecSupported` 仅作最后防线。
- 验收：`99:99:99` 报错；`Scene-A` 往返一致；PGS+subrip 同语言时选中 subrip。
- 文件：`src/subtitle/srt.js`、`src/core.js`；测试 `tests/test_srt.mjs`。

### 2.7 PDF 实际输出路径与显式失败（P1）
- Python fill 增 `--result-json <path>`，写 `{ actualOutputPath, usedFallback, protocolVersion }`。
- Node：结果文件存在且结构合法 → 用实际路径做 validate/JobResult/归档；**缺失或损坏 → 直接失败**（保留缓存），不回退请求路径。
- 仅当探测到旧脚本（CLI 不支持 `--result-json`，由版本/能力探测确认）才进入兼容分支，并打 WARN 标注「无法确认实际产物路径」。
- 验收：伪造 result json 的单测（正常/缺失/损坏三态）；真实渲染由有 `fitz` 环境回归。
- 文件：`src/pdf/pdfBridge.js`、`src/pdf/app/pdf_cli.py`、`src/pdf/services/pdf_fill_impl.py`、`src/core.js`。

### 2.8 统一 JobResult（P1）
- 四种 Job 统一返回 `{ translationStatus, validationStatus, counts, outputPath, reportPath, cacheDir, logFile }`。
- PDF 的 `needs_review` 是 `validationStatus`，与 `translationStatus` 分开维护；调用方不再靠终端文本判断。
- 验收：Job 级集成测试断言返回字段（可用注入 provider/runner 的离线 harness）。
- 文件：`src/core.js`。

### 2.9 needs_review / partial 保留材料（P1）
- 只有「translationStatus=complete 且 validationStatus=ok」才自动清理缓存与日志。
- `needs_review`、partial、验收失败一律保留并返回路径；`--debug` 行为不变。
- 验收：needs_review 时缓存与日志存在；JobResult 指向保留目录。
- 文件：`src/core.js`；测试并入 `tests/test_translation_status.mjs` 或新增 Job 级 harness。

---

## 3. 批次二：恢复与成本（P2）

1. **缓存原子化**：临时文件 + rename；所有 loader 统一损坏处理（返回 null + 隔离坏文件）；章节 HTML 摘要写入 status；每任务写锁。
2. **任务身份迁移**：完整内容 hash 不含 mtime，mtime/size 作为独立快速指纹；已有缓存但缺签名时进入 `unverified/migration`，不直接补写新身份。
3. **请求调度器**：正文与辅助请求共用限流与总重试预算；区分网络/429/认证/模型不存在/格式错误；支持 AbortSignal；返回 usage/耗时/重试次数。
4. **章节窗口调度**：按阅读顺序小窗口处理，窗口内批次并发；窗口结束提交记忆快照。
5. **抽样与记忆顺序**：director 在角色分类后运行、只抽正文、前中尾固定预算；memory 输入改源/译对照，术语键用源语；retriever 双语索引、查询源语与译名、缓存恢复重建索引。
6. **子进程统一**：ProcessRunner（参数数组、cwd、超时、取消、日志尾部限长、结构化退出原因）；preflight 结果在 JobContext 复用。
7. **日志与归档**：runId 用 UUID；归档无覆盖提交并返回实际路径。

## 4. 批次三：维护性

1. core 按格式拆编排文件，共用任务上下文/结果/缓存/发布逻辑。
2. PDF：去星号导入，定义 Block / RenderResult / ValidationIssue；HTML→JSON 映射报告 missing/duplicate/unknown 与未恢复占位符。
3. 分类动作改名 `translate/preserve/uncertain`；文档与实现口径对齐。
4. 嵌套容器拆分、SSE 响应校验、表格/矢量 schema 版本等遗留项按需排期。

## 5. 明确不做

- 不换队列库、不引入向量数据库、不全仓 TypeScript 迁移。
- 不在本计划重写 PDF 排版规则；只补协议与账本。
- 不把未验证的模型/渲染器行为当成已知结论。

## 6. 执行顺序与验收

1. **2.0 测试入口与 fixture**（提前）
2. 2.1 状态 reducer → 2.2 Unicode 分类与覆盖率 → 2.3 占位符与队列保真 → 2.4 EPUB 拆分与目录 → 2.5 脚注 → 2.6 SRT → 2.7 PDF → 2.8/2.9 JobResult 与材料保留
3. 批次二 → 批次三
4. 每个修复必须带反例测试；三套既有测试保持全绿；新增 `test_content_classifier.mjs`、`test_structure_fidelity.mjs`、`test_srt.mjs` 并入 `npm test`。
5. 批次一、二完成后进入真实翻译与阅读器验收；PDF 需补 `fitz` 环境后单独回归。

## 7. 实施状态（批次一已落地）

| 项 | 状态 | 落地 |
|----|------|------|
| 2.0 测试入口/fixture | ✅ | `package.json` 增 `test` 并修正 `main`；`tests/run_all.mjs` 统一入口（无书籍样本自动 skip）；`tests/helpers/fixtures.mjs` 合成 EPUB/HTML/SRT/slot 样本 |
| 2.1 统一 reducer | ✅ | `aggregateTranslationResults` 被单阶段与 `mergeTranslationReports` 共用；反例：`merge([mixed])===partial`、`merge([complete,failed])===partial`、`merge([failed])===failed`、`merge([])===complete` |
| 2.2 Unicode 分类 + 覆盖率 | ✅ | `\p{L}/\p{N}/\p{S}/\p{P}` 判定；CJK/假名/西里尔 KEEP；`�` 长段 KEEP+uncertain；新增 `src/translation/coverage.js`，可疑保留项计 gap，章节状态不得 complete；中英混排 4 段全部进入翻译 |
| 2.3 占位符与队列保真 | ✅ | 编解码去掉固定上限并报告 missing/unknown/duplicate/residual；删除有损 span 合并；新增 `structureGuard`（id/href/class/嵌套多重集），批量/单节点/Critic 共用；35 个 `<em>` 往返无残留，锚点/属性/嵌套变化被拦截 |
| 2.4 EPUB 拆分与目录 | ✅ | 分片保留 `html` 属性与 body 的 class/style 等，原 body id 只在首片；`contents()` 保留直接文本；`tocSync` 支持 EPUB3 nav + EPUB2 传统目录容器并返回 `{ok,stats}`；替换 itemref 继承 `linear/properties` 不继承 id |
| 2.5 脚注幂等 | ✅ | 稳定章节 id + `startIndex` 续编号；`appendFootnotesSection` 复用已有脚注区按 id 去重；term 实体转义；续跑不重复 |
| 2.6 SRT | ✅ | 时间分量与 start<=end 校验；`[序号][标识]` 两种前导解析；序列化非数字标识替代序号，往返一致；选轨前按 codec 白名单过滤 |
| 2.7 PDF 协议 | ✅ | Python fill 返回实际路径并写 `--result-json`；Node `readPdfFillResult` 三态（正常/缺失/损坏）测试；缺失/损坏显式失败，旧协议才走兼容；core 用实际路径验证与返回 |
| 2.8 JobResult | ✅ | 四种 Job 返回 `translationStatus/validationStatus/counts/outputPath/reportPath/cacheDir/logFile` |
| 2.9 材料保留 | ✅ | 仅 `translation=complete && validation=ok` 才清理；PDF needs_review、partial 一律保留 |

验收：`npm test` 全部通过（content-classifier / structure-fidelity / srt / translation-status / planning-phases / epub-doctor 含书籍样本）；Advances 36 章、NCX 244 项、资源/锚点校验保持通过。

未做/待办：批次二（原子缓存、任务身份迁移、请求调度、章节窗口、双语记忆/检索、子进程统一）；PDF 真实渲染回归需 `fitz` 环境；嵌套容器拆分、SSE 响应校验等遗留项。

## 8. 实施状态（批次二已落地）

| 项 | 状态 | 落地 |
|----|------|------|
| 原子缓存 + 损坏隔离 | ✅ | `cache.js` 全部 JSON/HTML 写入改「临时文件 + rename」；损坏 JSON 统一返回 null 并重命名为 `.corrupt-<ts>`；章节 HTML 摘要 `htmlDigest` 写入 status，摘要不符则重翻 |
| 任务身份迁移 | ✅ | `computeFileDigest` 只哈希内容（不含 mtime）；新增 `computeFastFingerprint`（size+mtime）；`ensureCacheIdentity` 对「有缓存但无签名」显式清理并告警，不直接赋新身份 |
| 任务锁 | ✅ | `acquireTaskLock/releaseTaskLock`（pid+时间戳，6h 过期回收）；四种 Job 启动即取锁，冲突直接报错；`clear()` 保留当前锁 |
| 请求调度 | ✅（部分） | 新增 `requestLimiter` 共享限流（正文 + Director/Glossary/Memory/Critic）；超时用 AbortController 取消底层请求（OpenAI 支持）；`classifyProviderError` 区分 auth/model_missing（不重试）与 network/rate_limit/timeout/format（可重试），batchQueue 对永久错误快速失败 |
| 章节窗口调度 | ✅ | `performTranslation` 按阅读顺序 4 章一窗口，窗口内并发、窗口间串行，窗口结束提交记忆快照并落盘状态 |
| 抽样与记忆顺序 | ✅ | Director 移到规划之后，只喂正文（排除 TOC/Index/Bibliography/front）；记忆提取使用源/译对照，术语键要求源语；`ContextRetriever` 支持术语双语扩展、同章节幂等重建、缓存恢复章节重建索引 |
| 子进程统一 | ✅（部分） | 新增 `support/process.js`（参数数组、cwd、超时 kill、取消、输出上限、结构化退出）；`video.js` 已切换到共享执行器；`pdfBridge` 仍走 `runSelectedPython`，待后续统一 |
| 日志与归档 | ✅ | logger 文件名加 8 位 UUID；`moveFileIfNeeded` 返回实际归档路径，四种 JobResult 增加 `archivedInputPath` |

验收：新增 `tests/test_recovery_contracts.mjs`（摘要稳定性、损坏隔离、任务锁、限流上限、错误分类、子进程退出/超时/输出上限、双语检索、记忆 Prompt）；`npm test` 七套全绿。

遗留：请求「总重试预算」仍是分层预算（已通过永久错误快速失败缓解）；pdfBridge 子进程未切换；批次三维护性重构。

## 9. 实施状态（批次三已落地）

| 项 | 状态 | 落地 |
|----|------|------|
| 共用任务运行时 | ✅ | 新增 `src/support/jobRuntime.js`：`createJobCache`（缓存+任务锁）、`finalizeJobArtifacts`（统一清理/保留策略）、`buildJobResult`（统一结果契约）；四种 Job 已切换到共用实现 |
| PDF 映射报告 | ✅ | `applyTranslatedHtmlToPdfJson` 输出 `translationReport { matchedBlocks, missingBlockIds, unknownBlockIds, duplicateBlockIds, unrecoveredPlaceholders }`，core 打印并写入 JobResult.extra |
| 分类口径 | ✅ | `classifyTextNode` 新增 `decision: translate/preserve/uncertain`（`action` 保留兼容），文档与实现口径对齐 |
| SSE 防护 | ✅ | 第三方中转站返回巨大字符串（>10MB）跳过 SSE 解析；解析结果校验 `choices[].delta/message.content` 类型 |
| 文档 | ✅ | `docs/architecture.md` 新增「任务契约与状态模块」章节（内容/任务/产物契约 + 验收入口） |
| 延迟项 | ⏳ | PDF domain `from domain.core import *` 显式化（core.py 3k+ 行，无 fitz 环境不宜盲改）；core 按格式彻底拆分；嵌套容器拆分；PDF Block/RenderResult 类型契约 |

验收：`npm test` 七套全绿；新增断言覆盖 decision 映射、PDF 映射报告、JobResult/清理策略。

## 10. 第四轮评审修正（7 处）

| # | 问题 | 修复 |
|---|------|------|
| 1 | `tests/helpers/fixtures.mjs` 被 .gitignore 忽略 | `.gitignore` 增加 `!tests/helpers/` 与 `!tests/helpers/*.mjs`，fixture 可随提交入库 |
| 2 | 超时 signal 未传给 OpenAI SDK | `signal` 从请求正文移出，改为 `create(body, { signal })`；本地 HTTP 服务器反例验证超时后底层请求被 abort 且限流名额释放 |
| 3 | 覆盖率只审计被枚举节点、零节点绕过 | `computeCoverageAudit` 增加 `candidateUnits`（全部可见文本）；未被已选/保留单元覆盖且有字母的候选记为 `not_selected` gap；零节点分支同样审计，不再直接 complete |
| 4 | 结构校验只比父标签名、忽略无属性行内标签 | 保护对象扩展到全部行内标签；元素身份 = 标签+全部属性（排序）；嵌套关系以父元素身份为键；交换不同 span 下的链接、em/strong 反转均可拦截 |
| 5 | 任务锁同进程可重入、检查后写入竞争 | 改为 `wx` 独占创建 + 唯一 token；同进程重入被拒；只释放自己的 token；删除缓存时先 `removeDir`（连同锁）再清理，保留时才释放锁 |
| 6 | 续跑缓存成功章节未进入结果聚合 | 缓存跳过分支写入 `results`（`cached: true`）；「缓存成功 + 另一章失败」返回 partial，counts 含缓存章节 |
| 7 | 记忆 SOURCE 可能已是译文 | pending 阶段保存 `sourceHtml` 快照；记忆提取使用快照而非可能被覆写的 `ch.html` |

验收：`npm test` 七套全绿，新增反例：本地超时取消、同一进程锁重入、缓存+失败聚合、div 零节点漏翻、span 链接互换、em/strong 反转、fixture 可入库。

## 11. 第五轮评审修正（3 处）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 子串匹配掩盖漏翻（同文字 div 加新正文仍 complete） | 覆盖率改为文本节点级审计：`collectTextNodeGaps` 遍历全部文本节点，按「是否位于已选/保留标记内」判定；选中/保留元素打临时 `data-wasabi-audit` 标记，审计后清除；不再依赖候选子串匹配 |
| 2 | 续跑丢失覆盖率缺口 | 续跑也执行文本节点审计（失败节点重新标记为 selected）；`previousCoverageGaps` 从 `chapterStatus.coverage.gaps` 传入，仍存在于正文且未被覆盖的旧 gap 会 `carriedOver` 保留并重新核对；「失败节点修复 + 漏选段落仍在」续跑后仍为 partial |
| 3 | 锁只按时间判过期，活跃任务被抢 | 新增 `isProcessAlive(pid)`（`process.kill(pid,0)`，EPERM 视为存活）；只有持有进程已退出且超龄才回收；活跃进程的锁无论多旧都不抢 |

验收：`npm test` 七套全绿，新增反例：同文字 div 漏翻、续跑保留 gap、7 小时锁龄但进程存活不被抢、死进程锁可回收。

## 12. 第六轮评审修正（续跑审计回归）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 续跑只给失败节点加审计标记，已译成功节点丢失审计状态，误报 `not_selected` gap | 缓存 partial 章节时保留 `data-wasabi-audit` 标记（新增 `cacheHtml` 字段，`html` 始终为干净输出）；续跑加载缓存即恢复「已译/已保留」审计状态；输出与 complete 缓存仍剥离标记；`stripTranslationMarkers` 同步清理审计属性 |

回归测试：首跑「一段成功 + 一段失败」→ partial 且 gaps=0；续跑补译失败段 → complete 且不再误报已译段落为漏选；原有「真实 gap 跨续跑保留」测试仍通过。

## 13. 第七轮评审修正（缓存摘要一致性）

| # | 问题 | 修复 |
|---|------|------|
| 1 | `htmlDigest` 用 `result.html` 计算，缓存保存的却是带审计标记的 `result.cacheHtml`，续跑判缓存损坏 → 全章重翻 | 摘要与缓存统一使用同一字符串：`const cacheHtml = result.cacheHtml ?? result.html`，`htmlDigest: computeTextDigest(cacheHtml)` 且 `cache.save(ch.id, cacheHtml)` |

回归断言：续跑只发送失败节点——`resumeCalls.length === 1`，批次包含 `Beta` 且不含已译的 `Alpha`；日志路径从「Cache digest mismatch」恢复为「Resuming partial cache」。
