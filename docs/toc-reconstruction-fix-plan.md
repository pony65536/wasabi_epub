# EPUB 目录/章节重建修复计划（v2 修订版）

> 针对「单个 XHTML 塞多章 + 锚点目录」类电子书的重建缺陷
> 实测样本：
> - `Advances in Financial Machine Learning`（触发拆分，6 个 137–259KB 文件，0 个 h1-h3，891 条内部锚点链接，NCX 目录）
> - `The Chrysanthemum and the Sword`（触发拆分，3 个大文件，0 条内部锚点链接，NCX 目录）
> - `visa_chap-..._zh.epub`（不触发拆分，36 章，仅作回归）

## 0. v1 计划的缺陷（本次修订原因）

| # | v1 缺陷 | 修订 |
|---|---------|------|
| 1 | 只重映射 NCX/TOC，未处理全书 891 条内部链接；Phase 3 删原文件后会留断链 | 新增「全书引用重写契约」，覆盖所有 `a[href]`（正文引用 + Index） |
| 2 | 只按 id 命中锚点，忽略「锚点必须跟着标题走」；拆分把标题前 `<span id="filepos…"/>` 留在上一片；`<p>`→`<h1>` 丢 id/class | 新增「锚点归属契约」，标题前锚点/空节点随标题迁入新片，转 h1 保留属性 |
| 3 | 原文件边界≠章节边界，续片会被标成 Front Matter | 新增「续片继承契约」：按 `N.M` 小节号 + 上一强标题跨文件继承，标为「Chapter N（续）」 |
| 4 | 锚点索引键、输出相对路径契约未定义；saver 用 `path.basename()` 注册 manifest，嵌套目录（如 `OPS/Text/`）会写错 | 索引键 = `原文件路径#anchor`；manifest/正文链接一律按所在目录计算相对路径 |
| 5 | 缓存指纹太弱，且放在最后收尾；`sanitizeCachedPlan` 只删无效 id | 指纹 = 算法版本 + 源内容摘要 + 拆分边界摘要；加载 plan/章节缓存**之前**校验 |
| 6 | 验收标准失真：Chrysanthemum 实际会触发；`--chap` 部分翻译不能要求全书目录译文；短 PART/版权页被 1.5K 合并误伤 | 逐条修订（见第四节） |
| 7 | Notes/Exercises/Bibliography 一律当强边界过激 | 默认不拆；仅当 NCX 顶级 navPoint + 位于文件边界时才作为边界 |

## 1. 实测问题清单

| # | 问题 | 证据/位置 |
|---|------|-----------|
| 1 | NCX 目录 100% 失效 | Advances 244/244 navPoint 无法解析；`src/epub/tocSync.js:9` `findBySrc` 无兜底 |
| 2 | 全书内部链接未重写 | Advances 891 条 `xxx.html#filepos…` 引用（正文 + Index），拆分会全部悬空 |
| 3 | 锚点归属错误 | 标题前是独立 `<span id="filepos…">`（如 `text00000.html` 节点 [228] 属于 CHAPTER 2，却留在 PART 1 分片）；`epubDoctor.js:129` 重建 `<h1>` 丢属性 |
| 4 | 续片标题错误 | `text00001` 从 3.5 开始、`text00002` 从 9.4 开始、`text00004` 从 19.3 开始，均为上一章续文 |
| 5 | 原文件残留 | `epubSaver.js:22` 不删被替代的原 entry/OPF item/spine itemref，阅读顺序追加到末尾 |
| 6 | 嵌套目录 manifest 写错 | `epubSaver.js:27` `path.basename(data.entryName)` |
| 7 | 误切分 | 脚注行、Index 被当标题（Index 拆出 31 个碎片） |
| 8 | 缓存不可靠 | `.cache_*` 复用旧分片 id 可能读到另一段正文的译文；`sanitizeCachedPlan`（`core.js:533`）只兜底 |

## 2. 先定契约（Phase A 前置）

### 2.1 拆分与锚点归属契约（`src/epub/epubDoctor.js`）

**边界分级**
- `STRONG`（触发拆分）：`CHAPTER N` / `PART N`；前置页（About the Author、Preamble、Index、EULA）仅在文件首/尾或 NCX 顶级 navPoint 时成立。
- `SECTION`（不拆）：`N.M`、`N.M.K` 小节（`1.1`、`16.A.1`）。
- `NEVER`（默认不拆）：Notes、Exercises、References、Bibliography 等章内材料，除非同时满足「NCX 顶级 navPoint + 文件边界」。
- Index 文件整体保护：首节点为 `Index` 且子节点以 `<ul>` 为主 → 不拆，保留为单章。
- 删除宽松数字模式 `/^[0-9]+[\.、\s]+[A-Za-z...]/`（脚注误报来源）。

**锚点归属**
- 开始新分片时，向前吞并「连续的空节点 + 无可见文本且含 `[id]` 的锚点节点」，保证标题前 `filepos` span 随标题进入新片。
- `<p>` 升级 `<h1>` 必须保留原节点全部属性（id/class/epub:type）；实现上直接改 tagName 或重建时复制属性。
- 验收断言：NCX 中每个 `anchor` 所在分片的首个强标题，与其 navPoint 层级一致。

**续片继承（跨文件）**
- 按 spine/entryName 顺序处理原文件，维护 `lastStrongChapterContext`。
- 新文件首片：有强标题 → 用它；否则若首节点是 `N.M` 小节 → 推断 `Chapter N（续）`；否则用 `lastStrongChapterContext` 标「Chapter X（续）」。
- 禁止把正文续片标成 Front Matter；Front Matter 仅用于真正的前置页。

**碎片合并**
- 正文 < 1500 字符的片段并入上一片；豁免：PART 页、封面、版权页、About the Author 等合法短页。
- 合并后重算分片 id 与边界摘要（供指纹）。

**输出字段**
- 每个分片携带 `originalChapterId`、`originalEntryName`、`originalId`、`boundaryAnchorIds`（供链接重写与 saver 使用）。

### 2.2 锚点索引契约（新模块 `src/epub/linkRewriter.js`）

- `AnchorIndex`：`Map<"normEntryPath#anchorId", { chapterId, title }>`，键必须带原文件路径，避免跨文件重复 id 冲突。
- `OriginParts`：`Map<"normOriginalEntry", chapterId[]>`，按分片顺序。
- 构建时机：拆分完成后、任何链接/目录重写之前。
- 定位优先级：精确文件+anchor → 原文件分片+anchor → 原文件首片 → null（不抛错）。

### 2.3 全书内部链接重写契约

- 统一入口 `rewriteInternalLinks(chapterMap)`：遍历**所有**章节 HTML 的 `a[href]`。
- 解析 `[path][#anchor]`：目标路径相对**源文件所在目录**解析（用 `path.posix`），支持同文件 `#anchor`。
- 输出 href：`path.posix.relative(dirname(sourceEntry), targetEntry) + (anchor ? "#"+anchor : "")`。
- 覆盖范围：正文交叉引用、Index 链接、HTML TOC、NCX（`content@src`）。
- 只改 `href` 属性，不改链接文本（目录/NCX 的 `navLabel` 文案单独按译文更新）。

### 2.4 输出路径契约（`src/epub/epubSaver.js`）

- zip 条目名：完整 POSIX 路径，沿用原目录（`splitLargeChapter` 已基于 `chapter.entryName` 生成）。
- OPF manifest `href` = `path.posix.relative(opfDir, entryName)`，禁止 `path.basename()`。
- 正文链接 = 相对源文件目录（见 2.3）。

### 2.5 缓存指纹契约（`src/support/cache.js`、`src/core.js`）

- `repairFingerprint = sha1(算法版本 + 源 entry 内容摘要 + 拆分边界摘要 + 分片 id 序列)`。
- 存入 `translation_plan.json` 与章节缓存元数据；**在 `loadPlan` / 章节缓存加载之前**校验。
- 指纹不匹配 → 丢弃旧 plan + 相关章节译文缓存，重算；`sanitizeCachedPlan` 仅作兜底。
- 说明：仅「是否修复 + 章节数」不够，必须包含边界摘要，防止「数量相同、边界变化」复用错译文。

## 3. 实施阶段（顺序调整）

### Phase A — 契约落地 + 拆分/锚点归属（`epubDoctor.js`）
1. 边界分级 + Index 保护 + 续片继承 + 碎片合并（含豁免）。
2. 锚点随标题迁移；h1 转换保留属性。
3. 返回 `report`：`{ fingerprint, replaced: [{ id, entryName, partIds }] }`。

### Phase B — AnchorIndex + 全书引用重写（新 `src/epub/linkRewriter.js`，`tocSync.js` 复用）
1. `buildAnchorIndex` / `buildOriginParts`。
2. `rewriteInternalLinks(chapterMap)` 处理全部 `a[href]`。
3. `tocSync` 改用同一解析器，同时改写 NCX `content@src` + navLabel 译文、HTML TOC `href` + 文案。

### Phase C — 缓存指纹（`cache.js` / `core.js`）
1. 指纹计算与写入。
2. 加载前校验，不匹配即清理旧 plan 与章节缓存。

### Phase D — 输出清理与顺序（`epubSaver.js` / `core.js`）※必须在 A–C 之后
1. 按 report `zip.deleteFile()` 删除被替代原文件。
2. OPF 删除原 item/itemref；新分片 itemref 插入原位置，保持阅读顺序。
3. manifest href 按 2.4 计算。

### Phase E — 离线打包审计（不调 API）
1. 测试脚本直接跑：`load → repair → rewriteInternalLinks → saveEpub`（译文用原文占位），实际打包。
2. 重新解包逐项断言（见第四节）。
3. 样本：Advances（触发）、visa（不触发）、Chrysanthemum（触发，仅结构回归）。

### Phase F — 付费翻译 + 阅读器验收（人工）
- `--chap 1-3 --debug` 小成本验证 → 全量 → 微信读书/Calibre 点击目录。

## 4. 离线验收标准（修订）

| # | 检查项 | 判定 |
|---|--------|------|
| 1 | 正文无丢失 | 源/输出所有 xhtml 可见文本节点多重集 hash 一致（允许重排，不允许丢失） |
| 2 | 锚点归属正确 | 每个被引用 anchor 所在分片标题与 NCX 层级一致（如 Chapter 2 的锚点必须在 Chapter 2 分片） |
| 3 | 内部引用全可解析 | 输出 epub 内每条 `href`（含 `#anchor`）都能在目标文件找到对应 id；0 悬空 |
| 4 | spine 顺序一致 | 移除被替代文件后，章节顺序与源文本顺序一致 |
| 5 | 旧文件清理 | **无「已被分片替代」的旧文件**（封面/版权页等非替代文件允许保留，不要求全书无大文件） |
| 6 | 短页豁免 | PART 页、版权页、封面、About the Author 不受 1500 字符合并限制 |
| 7 | 样本回归 | `visa` 不触发拆分；Chrysanthemum 允许触发，只回归「结构/链接不坏」 |
| 8 | `--chap` 部分翻译 | 仅要求选中章节范围内的目录项为译文；未选章节允许保留原文目录 |

## 5. 风险与对策

| 风险 | 对策 |
|------|------|
| anchor 归属误判 | NCX 层级 + 标题位置双重校验；无法判定时 anchor 跟随最近强标题 |
| 链接重写破坏正文 | 只改 href、不动文本；打包审计断言 0 悬空 |
| 跨文件重复 id | 索引键带路径边（2.2） |
| 嵌套目录路径错误 | 统一 `path.posix.relative`（2.3/2.4），审计脚本覆盖 |
| 缓存指纹开销 | sha1 只算一次，存 plan 元数据 |
| Chrysanthemum 无内部锚点 | 走简化路径（无 anchor 映射），仅验证章节/顺序 |
| 过度合并 | 仅合并 < 1500 字符正文片，短页豁免 |

## 6. 涉及文件

- `src/epub/epubDoctor.js`（拆分/归属/属性保留/续片继承/report）
- `src/epub/linkRewriter.js`（新增：AnchorIndex、OriginParts、全书链接重写）
- `src/epub/tocSync.js`（复用 linkRewriter）
- `src/epub/epubSaver.js`（删替代文件、OPF/spine 原位、相对路径）
- `src/core.js`（编排、指纹、report 透传）
- `src/support/cache.js`（指纹存取）
- `tests/test_epub_doctor.mjs`（新增，离线打包审计）
- `tests/audit_output_epub.py`（扩展解包审计）

## 7. 执行顺序

Phase A（契约+拆分/锚点） → Phase B（引用重写） → Phase C（缓存指纹） → Phase D（输出清理） → Phase E（离线打包审计，必须实际打包/解包） → Phase F（付费翻译+阅读器）。
A–E 全部离线通过前，不启动付费翻译。

## 8. 实施状态（A–E 已完成）

| Phase | 状态 | 落地 |
|-------|------|------|
| A 拆分/锚点归属 | ✅ | `epubDoctor.js`：NCX 提示边界、Index 保护、锚点随标题迁移、跨文件锚点迁移、续片继承、碎片合并、h1 属性保留、report+fingerprint |
| B 全书引用重写 | ✅ | 新增 `linkRewriter.js`；`tocSync.js` 复用解析器，NCX 同步改写 `content@src` + 文案 |
| C 缓存指纹 | ✅ | `cache.js` `repair_meta.json` 存取；`core.js` 在加载 plan/章节缓存前校验并清理 |
| D 输出清理 | ✅ | `epubSaver.js`：删除替代文件、OPF item/itemref 清理、spine 原位重建（保留 itemref 属性）、相对路径 |
| E 离线审计 | ✅ | `tests/test_epub_doctor.mjs`：指纹稳定性 + 三样本实际打包/解包审计 |

离线实测结果（`node tests/test_epub_doctor.mjs`）：

- Advances：7 → 36 章；886 条内部链接重写、0 悬空；NCX 244/244 可解析；正文/顺序无损；5 个原文件被清理；锚点归属正确
- Chrysanthemum：检测到大文件但无安全边界，保持原结构，审计通过
- visa：不触发拆分，回归通过

待办（Phase F）：付费翻译全量跑 + 微信读书/Calibre 阅读器验收。

## 9. 完成状态 / 缓存 / 失败恢复（评审 1–7）

评审结论：各阶段缺少明确状态契约，导致「请求结束、翻译完成、输出合格」被混为一件事。

### 已实施（优先级 1–3）

| # | 修复 | 落地 |
|---|------|------|
| 1 | 翻译状态契约 | `enqueueChapterTranslation` 返回 `{status, failedNodeIds, totalNodes, translatedNodes}`；失败节点保留 `data-t-id` 标记；`performTranslation` 返回 `complete/partial/failed`，缓存写 `chapter_status.json`，partial 续跑只补失败节点；仅 complete 才打印 ✅ |
| 2 | 失败保留缓存 | EPUB/HTML 与 PDF/字幕统一：`completed && status==complete && !debug` 才清理缓存与日志，失败/部分成功一律保留 |
| 3 | 缓存任务身份 | 缓存目录加入目标语言；新增 `task_meta.json`，签名 = 流程版本 + 源内容摘要 + 源/目标语言 + 提示词摘要（+ EPUB 修复指纹 / PDF 页选）；四种模式加载缓存前校验并清理 |

离线验证：`tests/test_translation_status.mjs`（模拟全失败 → partial 缓存 → 续跑只补失败节点 → complete；签名随目标语言/源内容/提示词变化）。

### 已实施（优先级 4–7）

| # | 修复 | 落地 |
|---|------|------|
| 4 | 规划器角色契约 | 新增 `chapterRoles.js`（toc/index/bibliography/front/content）；`agent.js` 不再把 AI 未返回章节无脑追加：排除角色不进翻译列表，TOC 独立标记且可不在 order 中，缺失正文按角色回填（正文在前、前置材料在后）；plan 持久化 `roles/excluded` |
| 5 | 阅读顺序/翻译顺序/选择分离 + 阶段调度 | `createChapterMap` 按 OPF spine 排序；`--chap` 编号基于 spine 阅读顺序（与 AI 重排无关）；正文与前言分两阶段执行，正文完成并沉淀记忆后再翻前言；`mergeTranslationReports` 汇总 |
| 6 | 动态记忆接入 | 记忆提取 Promise 被 await（不再与缓存清理竞争）；`formatBookBibleForPrompt` 输出 glossary，翻译 Prompt 使用 LivingMemoryStore 实时快照；正文阶段术语并入 glossary 供前言阶段；`ContextRetriever` 接入：已译章节建索引、批次 Prompt 追加前文线索 |
| 7 | 保存前验收 + 安全归档 | EPUB 保存前 `validateInternalLinks`（含锚点）+ 重写 unresolved 双重校验，不通过则不写输出、保留缓存；新增 `support/archive.js`，归档遇同名追加序号保留两份，绝不覆盖 |

离线验证：`tests/test_planning_phases.mjs`（角色分类、排除/回填、spine 编号、阶段汇总、检索器、动态术语入 Prompt、悬空链接拦截、安全归档）。

目标流程已全部落地：解析并建立阅读顺序 → 识别章节角色与选择范围 → 校验缓存 → 按阶段翻译并记录状态 → 等待记忆任务 → 后处理 → 验证覆盖率及引用 → 保存 → 安全归档。

## 10. 第二轮评审修正（状态与验收）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 全部请求失败仍报 complete/partial 并保存 | `enqueueChapterTranslation` 新增第三态：`translatedNodes === 0 && totalNodes > 0` → `failed`；`performTranslation` 聚合「全部失败 = failed、部分成功 = partial」；主流程 failed 不写输出，partial 写输出但提示 ⚠️（不再打印 ✅），终端与状态一致 |
| 2 | failed/未验证缓存被跳过 | 只有「状态 complete 且 HTML 无 `data-t-id` 标记」才允许跳过；partial/failed/状态缺失/状态与 HTML 不一致一律续翻；章节 HTML 先落盘、状态后落盘，每章完成即持久化 |
| 3 | 资源链接（图片等）被误判悬空 | `buildLinkContext(chapterMap, zipEntries)` 建立 ZIP 资源索引；`resolveLinkTarget` 识别资源链接，重写时保持原样，验收时视为合法 |
| 4 | 保存前不校验 NCX | `synchronizeNcx` 返回 `ok`；新增 `validateNcxLinks` 校验 NCX 文件+锚点；同步失败或目录悬空均阻止写输出并保留缓存 |
| 5 | 视频字幕先复用缓存后校验身份 | 身份校验移到复用提取结果之前；签名加入所选字幕轨（kind/index/language）与外部字幕内容摘要；SRT 输入在语言推断后校验 |
| 6 | 中文标题 `\b` 失效 | `chapterRoles.js` 模式改用 `(?=\b|[\s:：]|$)` 前瞻，目录/索引/参考文献正确归类 |
| 7 | 测试被 .gitignore 忽略 | `.gitignore` 改为 `tests/*` + `!tests/*.mjs`，三份离线测试可随普通提交入库 |
| 8 | 状态非 complete 但 HTML 无失败标记 → 零请求误判完成 | 续翻只接受「存在 `data-t-id` 失败标记」的缓存；无标记的 failed/partial/状态缺失一律重翻原始章节；`enqueueChapterTranslation` 兜底：无标记的续翻请求返回 `failed` 并说明原因；`countCachedChapters` 只统计验证过的 complete |

反例测试：`test_translation_status.mjs`（全失败=failed、部分成功=partial、failed/未验证缓存续翻、verified complete 才跳过、failed/partial/missing 且无标记 → 重翻源码、无标记续翻请求被拒）；`test_planning_phases.mjs`（CJK 角色、资源链接、NCX 校验）；`test_epub_doctor.mjs`（输出 NCX 244 项校验通过）。
