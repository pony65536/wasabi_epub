# 本地 main 与 origin/main 合并方案与实施记录

## 评估基线

- 本地：`833e370`，远程：`e4fdfef`，共同祖先：`395ab0c`。
- 本地独有 5 个提交，远程独有 27 个提交。
- 当前未提交内容：`index.js` 将 dotenv 初始化替换为 `src/support/env.js`；后者让 `.env` 覆盖系统环境变量。
- 三方合并预览显示 8 个文件、16 处文本冲突；本次仅评估，没有开始 merge 或修改业务代码。
- 本地 `npm test` 已通过全部 9 组测试，包括当前仓库中的 EPUB 样本检查。远程测试尚未在合并版本上执行。

## 推荐方向

使用 merge 保留两边提交历史，在独立集成分支处理冲突。采用远程的目录拆分，把本地新增能力迁移进对应模块。

模型配置建议采用远程的 `config/wasabi.local.json` 作为主要用户入口，内部保留本地模型网关的阶段路由、并发限制、错误分类和用量统计。需要显式设计配置适配层，不能让两个加载器各自决定运行时配置。

这是模块迁移和接口整合；消除冲突标记只是其中一步。

## 冲突文件处理

| 文件 | 文本冲突数 | 处理方式 |
| --- | ---: | --- |
| `.gitignore` | 1 | 同时保留本地模型配置、远程本地配置文件、测试临时目录的忽略规则；保证 `tests/js`、`tests/fixtures`、`tests/helpers` 和原有 `.mjs` 测试可跟踪。 |
| `README.md` | 1 | 以远程 JSON 配置教程为基础，补充阶段路由、中转站兼容和旧配置迁移说明；同步检查无文本冲突的英文文档。 |
| `docs/architecture.md` | 4 | 按最终模块组织重写，描述拆分后的格式任务、网关、恢复协议和清理策略。 |
| `package.json` | 1 | 保留远程 Node 版本、lint 和 Python 测试入口；默认测试必须同时执行本地审计套件和远程 JS 单测。合并后重新核对依赖并生成一致的 lockfile。 |
| `src/config.js` | 1 | 保留公共常量和样式指南；统一 runtime config 入口，并接入配置迁移与网关适配。 |
| `src/core.js` | 1 | 最终采用远程的四个格式任务 re-export；先把本地实现迁入各格式模块，再移除原实现。 |
| `src/translation/aiProvider.js` | 5 | 保留远程 resolved-model API 与可注入 SDK 工厂，使其与网关适配；统一超时、重试、fallback、响应解析的职责，避免重复执行。 |
| `src/translation/translator.js` | 2 | 保留本地节点级状态、覆盖检查、结构保护和恢复逻辑；从同一份章节结果派生远程需要的统计字段。 |

## 必须一起处理的行为差异

### 1. 模型配置和调用

本地 `src/models/config.js` 读取 `WASABI_MODELS_FILE`、`models.json` 或旧环境变量，输出 connections/models/routing。远程 `src/config/loader.js` 读取 `WASABI_CONFIG` 或 `config/wasabi.local.json`，输出 resolved models/selection，两者不是同一数据结构。

推荐整合步骤：

1. 以远程配置校验和 resolved-model 结构为基础，明确支持 planner、translation、director、glossary、memory、critic、headings 的配置方式，并更新严格字段校验和示例。
2. 让 `resolveModelRouting` 接收已加载的配置，避免任务中再次从环境或其他文件加载一份不同配置。
3. 旧 `models.json` 和旧环境变量提供明确的兼容适配或迁移入口；显式配置路径错误必须报错，不能悄悄降级。
4. 迁移时覆盖模型能力、requestOptions、超时、并发及 fallback 语义。远程默认只在内容安全错误时 fallback，本地还支持若干其他错误类别，需要明确统一策略并测试。
5. 保留同一连接上不同主备模型、共享连接并发上限、成本限制、usage 和路由指纹。
6. 中转站 SSE、reasoning 内容剥离和截断响应识别必须覆盖最终实际使用的 SDK 调用路径。保留一份未被使用的兼容实现不能算迁移完成。
7. 只有一层负责重试预算；SDK、provider、gateway 多层重试不能无意叠加。超时取消仍应传递到底层请求。
8. CLI、doctor、预检、glossary 和各格式任务使用同一份配置解析结果。保留当前未提交的 `.env` 覆盖行为，并验证 `--model` 只覆盖翻译阶段。

### 2. 格式任务拆分

| 目标模块 | 必须迁入的本地能力 |
| --- | --- |
| `src/pipeline/jobContext.js` | 创建共享 gateway、batch queue、带任务锁的 cache；暴露各阶段 provider；统一任务结果和资源释放。 |
| `src/epub/translationJob.js` | EPUB Doctor、repair fingerprint、先规划再运行 Director、Book Bible、Living Memory、Retriever、前后章节分阶段翻译、链接与 NCX 保存前校验。 |
| `src/epub/chapterMap.js` | 本地按 OPF spine 建立阅读顺序的逻辑；远程版本仍按 manifest 顺序。`--chap` 编号必须保持阅读顺序。 |
| `src/html/translationJob.js` | 任务签名、完整/部分/失败状态、覆盖检查及失败续跑。 |
| `src/pdf/translationJob.js`、`src/pdf/repair.js` | 缓存签名、HTML 到 PDF JSON 映射报告、填充结果协议校验和状态汇总；核对抽取后的 PDF 修复函数有无遗漏本地变化。 |
| `src/subtitle/translationJob.js` | 字幕语言推断后的路由选择、任务签名、状态汇总及视频/字幕处理的本地修复。 |

### 3. 缓存和结果协议

- 远程 `translateDocument` 在 document cache 存在时直接复用 HTML；本地要求检查章节状态、协议版本、内容摘要和残留标记。合并后统一由经过验证的恢复路径判断能否复用。
- 远程结果主要是 `total/skipped/translated/failed/failedIds`，本地结果包含 `status/chapters/failedChapters/partialChapters`。保留本地详细报告，从它派生兼容统计，不能让部分成功变成完整成功。
- 缓存目录命名已有差异。本地按目标语言隔离，并用源文件、prompt、修复和模型路由指纹验证身份；保留这些边界，旧目录中的文件不能未经验证直接视为成功缓存。
- 本地策略是完整成功且非 debug 才清理。远程 HTML/EPUB 有失败后清理的路径，`finishJob` 必须接入失败或部分完成时保留现场的规则，并释放任务锁。
- 远程 `src/support/files.js` 的归档函数会先删除同名目标；使用本地 `src/support/archive.js` 的追加序号行为，并统一各任务的调用，避免出现两套归档规则。

### 4. 测试调整

保留两边测试覆盖，但按最终行为更新过时的断言：

- `tests/js/jobCleanup.test.js` 中 HTML 失败后删除缓存的断言，应改为保留失败现场并释放锁。
- `tests/js/epubJob.test.js`、workflow fixtures 中旧缓存路径与缺少状态元数据的缓存，需补全有效签名/状态，或显式验证旧缓存会被重建。
- `tests/js/translateDocument.test.js` 中仅提供 load/save 的 mock cache 不满足本地恢复协议，应补齐；统计字段与详细状态必须一致。
- 保留本地模型路由、网关、规划、状态、结构保护和恢复测试；新增跨配置适配层到实际格式任务的集成覆盖。
- 补充 manifest 与 spine 顺序不同、归档同名、partial 续跑、显式错误配置、共享连接并发和中转 SSE 的跨模块回归。
- lint 应覆盖最终新增模块。Python 测试按远程的依赖/fixture 跳过规则执行，并记录实际跳过项。

## 实施顺序和验收

1. 给当前 HEAD 建立备份引用，单独保存 `index.js` 和未跟踪的 `src/support/env.js`，在集成分支开始非快进 merge。
2. 先整合配置、SDK/provider 与 gateway，验证配置解析、CLI/doctor、路由和调用层。
3. 整合 jobContext、任务锁、缓存身份、状态报告、清理与归档。
4. 迁移 EPUB，再迁移 HTML、PDF、字幕；保留 core 的原有对外导出名称。
5. 处理测试发现、依赖锁文件、忽略规则与文档；恢复并核对原有未提交改动。
6. 执行两边 JS 测试、lint、适用的 Python 测试和已有 EPUB 样本检查。执行过程中用临时目录与 mock provider，避免真实模型调用影响结果或产生费用。
7. 所有冲突和验收检查完成后提交 merge，再将集成结果快进到 main；保留本地原有 5 个提交及远程 27 个提交，不需要 push。

## 实施记录

- 在 `integrate/upstream-20261102` 上执行非快进合并，保留 `backup/pre-upstream-merge-20261102` 和原始 stash。
- 四个格式任务已迁出 core，使用共享 jobContext、网关与翻译入口；保留本地 EPUB 增强、状态恢复、缓存锁和安全归档。
- JSON 模型配置已适配阶段路由、共享连接、模型能力、fallback 策略与旧文件/环境配置。SDK 调用层统一，并禁止额外 SDK 重试。
- 未提交的 `.env` 覆盖改动将在合并提交后恢复为未提交状态，不写入此次合并提交。
- `npm test` 已通过 67 项 JS 单测/集成测试与本地九组审计，包括真实 EPUB 样本打包与链接校验。`npm run lint` 为 0 错误、6 条原有未使用代码警告。Python PDF 测试在当前环境因缺少 `fitz` 依赖跳过。
- 已验证本机旧 `.env` 配置能通过统一加载器解析，并保留当前翻译模型选择；检查没有调用外部模型服务。
