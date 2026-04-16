# EPUB / HTML 自动翻译工具

将 EPUB 电子书或单个 HTML 文档翻译为目标语言，尽量保留原有结构与排版。EPUB 模式会额外处理章节顺序、标题格式、目录同步和缓存续跑；HTML 模式适合单文件文档翻译。

## 功能概览

- 支持 `EPUB` 和 `HTML / HTM` 输入
- CLI 支持输入文件、章节选择、源语言、目标语言、并发和调试开关
- 多 Provider 支持：`Gemini`、`Qwen`、`Mimo`、`OpenRouter`
- 支持多语言工作流：英语、西班牙语、法语、俄语、简体中文、日语、韩语
- 自动章节规划：识别 TOC，优先翻译正文，再处理前言/附录类内容
- 标题格式分析与标准化：统一章节编号、目录标题等格式
- 自动术语表生成：按源语言分词/切词后提取高频术语，再由 AI 筛选
- 批处理、重试和单节点回退，提升长文翻译稳定性
- 断点续传：章节级缓存，重跑时自动复用已完成结果
- 提取阶段内容过滤：在进入翻译前丢弃明显 OCR 噪声，并为明显伪表格插入占位符
- 翻译完成后自动同步 EPUB HTML TOC 和 NCX 导航

## 目录结构

```text
wasabi_epub/
├── index.js
├── src/
│   ├── core.js
│   ├── config.js
│   ├── utils.js
│   ├── agent.js
│   ├── content/
│   │   ├── content-classifier.js
│   │   ├── glossary.js
│   │   └── headings.js
│   ├── epub/
│   │   ├── epubSaver.js
│   │   └── tocSync.js
│   ├── support/
│   │   ├── cache.js
│   │   ├── chapterSelection.js
│   │   └── logger.js
│   └── translation/
│       ├── aiProvider.js
│       ├── batchQueue.js
│       └── translator.js
├── prompts/
│   └── epub_translation_prompt.txt
├── input/
├── output/
└── log/
```

主要模块：

- `index.js`：CLI 入口，解析参数并分流到 EPUB / HTML 流程
- `src/core.js`：主流程编排，负责输入、缓存、标题规则、术语表、翻译、保存
- `src/translation/translator.js`：节点收集、翻译批处理、重试和结果回写
- `src/content/content-classifier.js`：提取阶段分类器，过滤 OCR 噪声、伪表格和公式样内容
- `src/content/glossary.js`：按源语言做术语提取与 AI 筛选
- `src/content/headings.js`：标题格式分析与全书标准化

## 环境要求

- Node.js 18+
- npm

安装依赖：

```bash
npm install
```

## 配置

在项目根目录创建 `.env`。

示例：

```env
# 主 provider / model
PRIMARY_PROVIDER=qwen
PRIMARY_MODEL=qwen-plus

# 内容策略命中时的 fallback
FALLBACK_ON_CONTENT_POLICY=true
FALLBACK_PROVIDER=openrouter
FALLBACK_MODEL=x-ai/grok-4.1-fast

# 俄语 glossary 专用 provider / model
RUSSIAN_GLOSSARY_PROVIDER=openrouter
RUSSIAN_GLOSSARY_MODEL=mistralai/mistral-small-3.1-24b-instruct

# 日语 glossary 专用 provider / model
JAPANESE_GLOSSARY_PROVIDER=openrouter
JAPANESE_GLOSSARY_MODEL=anthropic/claude-sonnet-4.5

# API keys
GEMINI_API_KEY=your_gemini_api_key
QWEN_API_KEY=your_qwen_api_key
MIMO_API_KEY=your_mimo_api_key
OPENROUTER_API_KEY=your_openrouter_api_key

# 可选：覆盖 provider 默认模型
# OPENROUTER_MODEL=google/gemini-2.5-pro

# 可选：自定义 base URL
# QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# MIMO_BASE_URL=https://api.xiaomimimo.com/v1
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# 可选：OpenRouter reasoning 开关
# OPENROUTER_REASONING_ENABLED=true
```

说明：

- `PRIMARY_PROVIDER` 默认是 `qwen`
- `FALLBACK_PROVIDER` 默认是 `openrouter`
- 默认源语言是 `English`
- 默认目标语言是 `Chinese (Simplified)`
- `--concurrency` 会覆盖所有 provider 的运行时并发设置
- 如果 glossary 专用 provider 没有可用 API key，会自动回退到主 provider，不会中断任务

如需调整翻译风格，可编辑：

- `src/config.js` 中的 `buildStyleGuide()`
- `prompts/epub_translation_prompt.txt`

## CLI 用法

基本格式：

```bash
node index.js "your-book.epub|your-file.html" [--chap "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]
```

示例：

```bash
node index.js "book.epub"
node index.js "book.epub" --debug
node index.js "book.epub" --to "fr"
node index.js "book.epub" --from "es" --to "zh"
node index.js "book.epub" --from "ja" --to "zh"
node index.js "book.epub" --from "ko" --to "zh"
node index.js "book.epub" --concurrency 5
node index.js "book.epub" --chap "1,3,5"
node index.js "book.epub" --chap "1-3"
node index.js "book.epub" --chap "'Blackhole'-'Gravity'"
node index.js "chapter.html" --to "zh"
node index.js "chapter.htm" --from "en" --to "fr"
```

参数说明：

- `--chap`：只翻译指定章节，仅 EPUB 支持
- `--from`：设置源语言
- `--to`：设置目标语言
- `--concurrency`：设置本次运行并发数，必须为正整数
- `--debug`：保留缓存目录和日志文件，便于排错

支持的常用语言别名：

- 源语言：`en` `es` `fr` `ru` `zh` `ja` `jp` `ko`
- 目标语言：`en` `es` `fr` `ru` `zh` `ja` `jp` `ko`

内部会解析为：

- `English`
- `Spanish`
- `French`
- `Russian`
- `Chinese (Simplified)`
- `Japanese`
- `Korean`

### 章节选择语法

`--chap` 支持：

- `1`：单章
- `1-3`：闭区间范围
- `1,3,5`：离散章节
- `1,1-3`：混合选择
- `'Blackhole'-'Gravity'`：按章节标题精确匹配起止范围

## 输入、输出与缓存

输入文件可以放在：

- 项目根目录
- `input/` 目录

运行成功后：

- 输入文件会被移动到 `input/`
- 输出文件会写入 `output/`

输出命名规则：

```text
book_zh.epub
book_fr.epub
chapter_zh.html
```

如果使用 `--chap`，输出文件会带章节选择后缀，例如：

```text
book_chap-1-3_zh.epub
```

缓存目录规则：

- 整本 EPUB：`.cache_<文件名>/`
- 指定章节 EPUB：`.cache_<文件名>_chap-<selector>/`
- 单 HTML：`.cache_<文件名>_html/`

默认情况下任务结束后会清理缓存和日志。加上 `--debug` 后会保留：

- 缓存目录
- `log/` 下的运行日志

## 翻译流程

### EPUB 模式

```text
Step 1  章节规划        AI 分析章节列表，识别 TOC，生成翻译顺序
Step 2  标题分析        收集标题样本，生成标题格式规则
Step 3  术语表生成      提取高频词组并由 AI 筛选
Step 4  正文翻译        提取节点 -> 分类过滤 -> 分批翻译 -> 失败重试 -> 写入缓存
Step 5  标题标准化      应用标题格式规则
Step 6  TOC 同步        更新 HTML TOC 链接文字
Step 7  NCX 同步        更新 EPUB 导航元数据
Step 8  保存输出        写回 EPUB 并输出到 output/
```

### HTML 模式

```text
Step 1  标题分析        收集标题样本，生成格式规则
Step 2  术语表生成      提取术语并由 AI 筛选
Step 3  正文翻译        提取节点 -> 分类过滤 -> 分批翻译 -> 写入缓存
Step 4  标题标准化      应用标题规则
Step 5  保存输出        写出到 output/
```

## 提取阶段内容过滤

节点在进入翻译前会先经过 `src/content/content-classifier.js`。

当前处理策略：

- 保留正常文本节点
- 丢弃明显 OCR 噪声，例如极短碎片、替换字符 `�`、主要由符号构成的无意义片段、脱离上下文的数字碎片
- 识别明显 caption 标签样文本
- 对明显伪表格插入简单占位符，而不是送去翻译
- 对公式样内容保留占位思路，避免污染翻译上下文

伪表格检测是保守策略，只针对明显的 OCR / ASCII / 像素网格类表格，尽量不误伤真实数据表。

被过滤节点会记录简要日志，格式包含：

```json
{
  "id": "node_12",
  "type": "TABLE_PSEUDO",
  "action": "PLACEHOLDER",
  "reason": "image_like_table",
  "preview": "0 # 0 o ..."
}
```

## 术语表与语言处理

术语提取会根据源语言采用不同分词方案：

- 英语 / 西语 / 法语：基于 `natural`
- 中文：`jieba-wasm`
- 日语：`kuromoji`
- 韩语：`oktjs`
- 俄语：西里尔字母规则 + N-gram

俄语和日语支持单独的 glossary provider / model 配置，用于术语筛选质量优化。

## 日志

每次运行会在 `log/` 下创建独立日志文件，格式类似：

```text
translation_YYYY-MM-DDTHH-MM-SS.log
```

日志会记录：

- AI 请求与响应
- 批处理失败、重试、回退信息
- 术语表和标题规则生成信息
- 内容过滤跳过记录
- 主流程错误信息

## 注意事项

- 翻译质量高度依赖所选模型
- 长书翻译成本较高，建议先用 `--chap` 小范围试跑
- TOC 同步依赖章节内存在可识别标题
- `--chap` 只支持 EPUB，不支持 HTML
- 如果需要强制重跑，删除对应 `.cache_*` 目录后重新执行
