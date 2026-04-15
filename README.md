# EPUB 自动翻译工具

将英文 EPUB 电子书自动翻译为简体中文，保留原书排版结构、目录导航和标题格式。

---

## 功能概览

- **多 AI Provider 支持**：内置 Gemini、Qwen（通义千问）、Mimo 三个提供商，通过配置一键切换
- **智能章节规划**：AI Agent 自动识别目录页、分析章节结构，优先翻译正文再翻译前言后记，提升术语一致性
- **标题格式分析**：翻译前提取全书标题样本，生成格式规范（如 `Chapter I` → `第一章`），翻译后统一应用
- **自动术语表**：使用 N-gram 算法提取高频词组，经 AI 筛选生成术语表，确保专业词汇全书译法一致
- **批处理 + 并发**：HTML 节点分批并发发送，支持单批失败自动重试（最多 3 轮）
- **断点续传**：每章翻译完成后写入磁盘缓存，中断后重启自动跳过已完成章节
- **目录同步**：翻译完成后自动将 HTML TOC 页面与 NCX 导航元数据更新为中文标题
- **日志记录**：每次运行生成独立日志文件，记录所有 AI 请求、响应及错误信息

---

## 目录结构

```
epub-translator/
├── index.js                # 主入口，负责流程编排
├── src/
    ├── config.js           # Provider 选择、翻译风格配置
    ├── chapterSelection.js # 命令行章节选择器（--chap）
    ├── logger.js           # 运行日志模块
    ├── aiProvider.js       # AI Provider 工厂（Gemini / OpenAI 兼容接口）
    ├── cache.js            # 断点续传缓存
    ├── utils.js            # 通用工具（HTML 加载、AI 响应清洗、href 索引等）
    ├── batchQueue.js       # 批处理队列与通用批处理逻辑
    ├── agent.js            # 章节规划 Agent
    ├── headings.js         # 标题格式分析与标准化
    ├── glossary.js         # 术语表生成
    ├── translator.js       # 章节翻译
    ├── tocSync.js          # HTML TOC 与 NCX 目录同步
    └── epubSaver.js        # EPUB 文件写入
└── prompts/
    └── epub_translation_prompt.txt # EPUB 正文翻译提示词模板
```

---

## 环境要求

- Node.js >= 18
- npm

### 依赖安装

```bash
npm install
```

---

## 配置

### 1. 环境变量

在项目根目录创建 `.env` 文件。现在主模型、fallback 模型、以及俄语 glossary 专用模型都可以直接在 `.env` 中配置：

```env
# 主流程使用的 provider / model
PRIMARY_PROVIDER=qwen
PRIMARY_MODEL=qwen-plus

# 命中内容策略时的 fallback
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

# 可选：直接指定某个 provider 的默认模型
# OPENROUTER_MODEL=anthropic/claude-sonnet-4.5

# 可选：自定义 base URL
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

OpenRouter 的模型名直接写它的平台标识即可，例如：

- `OPENROUTER_MODEL=x-ai/grok-4.1-fast`
- `OPENROUTER_MODEL=mistralai/mistral-small-3.1-24b-instruct`
- `OPENROUTER_MODEL=google/gemini-2.5-pro`

如果你给俄语或日语 glossary 单独指定了 OpenRouter 模型，但没有配置 `OPENROUTER_API_KEY`，脚本会自动回落到主模型，不会因为 glossary 专用配置缺失而中断。

并发通过命令行参数控制，例如 `--concurrency 5`。

### 2. 可选：自定义翻译风格

修改 `src/config.js` 中的 `buildStyleGuide()`，或编辑 `prompts/epub_translation_prompt.txt`，可调整译文风格要求和正文翻译提示词。
当前脚本默认源语言为英文；如需切换，可使用 `--from`。

---

## 使用方法

### 基本运行

将 EPUB 文件放置在项目根目录，然后执行：

```bash
node index.js "your-book.epub"
node index.js "your-book.epub" --debug
node index.js "your-book.epub" --to "fr"
node index.js "your-book.epub" --from "es" --to "zh"
node index.js "your-book.epub" --from "zh" --to "en"
node index.js "your-book.epub" --from "ja" --to "zh"
node index.js "your-book.epub" --from "ko" --to "zh"
node index.js "your-book.epub" --concurrency 5
```

如果只想翻译指定章节，可使用 `--chap`：

```bash
node index.js "your-book.epub" --chap "1,3,5"
node index.js "your-book.epub" --chap "1-3"
node index.js "your-book.epub" --chap "1,1-3"
node index.js "your-book.epub" --chap "'Blackhole'-'Gravity'"
```

支持的选择格式：

- `1`：第 1 章
- `1-3`：第 1 到第 3 章（含两端）
- `1,3,5`：离散章节
- `'Blackhole'-'Gravity'`：按章节标题匹配起止范围（含两端，标题需精确匹配）
- `--from`：设置源语言，当前先支持 `en`、`es`、`fr`、`ru`、`zh`、`ja`、`ko`
- `--to`：设置目标语言，例如 `en`、`es`、`fr`、`zh`、`ru`、`ko`、`ja`
- `--concurrency`：设置本次运行的并发数，例如 `--concurrency 5`
- `--debug`：保留本次运行生成的 `cache` 和 `log`

翻译完成后，输出文件将出现在项目根目录，文件名格式为：

```
原文件名_语言短码.epub
```

使用 `--chap` 时，输出文件名会附带章节选择后缀，格式类似 `原文件名_chap-1-3_zh.epub`，避免覆盖整本翻译结果。
输入文件在任务完成后会被移动到 `input/`，输出文件会保存到 `output/`。

### 断点续传

翻译过程中如果中断，重新运行相同命令即可自动跳过已完成的章节，从中断处继续。整本翻译与 `--chap` 选择翻译会使用不同缓存目录，互不干扰。
默认运行结束后会清理 `cache` 和 `log`；只有加上 `--debug` 才会保留这些调试产物。

如需强制重新翻译全书，手动删除对应缓存目录（例如 `.cache_your-book/`）后再运行：

```bash
node index.js "your-book.epub"
```

## 翻译流程说明

```
Step 1  章节规划      AI Agent 分析章节列表，识别目录页，排定翻译顺序
Step 2  标题分析      收集全书标题样本，生成格式转换规范（如章节编号格式）
Step 3  术语表生成    N-gram 提取高频词组 → AI 筛选 → 生成术语对照表
Step 4  正文翻译      按规划顺序逐章翻译，使用术语表保证一致性，结果写入缓存
Step 5  标题标准化    对全书已翻译标题统一应用 Step 2 的格式规范
Step 6  同步 HTML TOC 将目录页中的链接文本更新为对应章节的中文标题
Step 7  同步 NCX      更新 EPUB 导航元数据（.ncx 文件）中的标题
Step 8  保存输出      将所有修改写回 EPUB 压缩包并输出
```

---

## 日志

每次运行在 `log/` 目录生成一个日志文件，命名格式为 `translation_YYYY-MM-DDTHH-MM-SS.log`，记录内容包括：

- 每次 AI 请求的 system prompt 和 user content
- AI 返回的原始响应
- 所有警告（如节点回写失败）和错误信息
- 生成的术语表和标题格式样本

---

## 注意事项

- 翻译质量依赖所选模型能力，建议使用 `qwen3-max` 或 `gemini-2.5-pro`
- 单次运行的 API 费用与书籍篇幅和所选模型定价有关，建议先用 `--chap "1-3"` 这类小范围选择做测试
- 目录同步依赖章节内存在可识别的标题标签（`h1`～`h3`），结构不规范的 EPUB 可能无法完整同步
