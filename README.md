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
└── src/
    ├── config.js           # 输入文件、Provider 选择、翻译风格配置
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

在项目根目录创建 `.env` 文件，填入需要使用的 Provider 的 API Key：

```env
# 按需填写，只需填写实际使用的 Provider
GEMINI_API_KEY=your_gemini_api_key
QWEN_API_KEY=your_qwen_api_key
MIMO_API_KEY=your_mimo_api_key
```

### 2. 修改 `src/config.js`

```js
// 输入文件名（放在项目根目录）
export const INPUT_FILE_NAME = "your-book.epub";

// 选择 AI Provider：'gemini' | 'qwen' | 'mimo'
export const CURRENT_PROVIDER = "qwen";

// 测试模式：null 表示翻译全部章节，数字表示只翻译前 N 章（用于调试）
export const TEST_MODE_LIMIT = null;
```

### 3. 可选：自定义翻译风格

修改 `src/config.js` 中的 `STYLE_GUIDE` 字符串，可调整译文风格要求，例如正式程度、成语使用频率、长句拆分策略等。

---

## 使用方法

### 基本运行

将 EPUB 文件放置在项目根目录，确认 `config.js` 中 `INPUT_FILE_NAME` 与文件名一致，然后执行：

```bash
node index.js
```

翻译完成后，输出文件将出现在项目根目录，文件名格式为：

```
原文件名_模型名.epub
```

### 断点续传

翻译过程中如果中断，重新运行 `node index.js` 即可自动跳过已完成的章节，从中断处继续。缓存目录为 `.cache_原文件名/`，翻译全部完成后会自动清除。

如需强制重新翻译全书，删除缓存目录后再运行：

```bash
rm -rf .cache_your-book/
node index.js
```

### 测试模式

在 `config.js` 中设置 `TEST_MODE_LIMIT` 可只翻译前 N 章，方便快速验证效果：

```js
export const TEST_MODE_LIMIT = 3; // 只翻译前 3 章
```

---

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
- 单次运行的 API 费用与书籍篇幅和所选模型定价有关，建议先用 `TEST_MODE_LIMIT` 小批量测试
- 目录同步依赖章节内存在可识别的标题标签（`h1`～`h3`），结构不规范的 EPUB 可能无法完整同步
