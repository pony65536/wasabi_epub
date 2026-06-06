# Wasabi EPUB
[English](./README_en.md) | [中文]

一个面向长文档和字幕场景的命令行翻译工具，支持把 `EPUB`、`HTML`、`PDF`、`SRT` 和带字幕的视频翻译成目标语言，并尽量保留原始结构、章节顺序、目录、版式或字幕轨。

## Demo

字幕示例（原字幕 / 翻译后字幕）：

<p align="center">
  <img src="./assets/Snipaste_2026-04-06_20-20-52.jpg" alt="Subtitle demo source" width="45%" />
  <img src="./assets/Snipaste_2026-04-06_20-19-30.jpg" alt="Subtitle demo translated" width="45%" />
</p>

电子书示例（英文原页 / 中文输出）：

<p align="center">
  <img src="./assets/Screenshot_2026-06-06-16-08-21-811_com.tencent.weread.jpg" alt="Ebook demo source" width="45%" />
  <img src="./assets/Screenshot_2026-06-06-16-04-18-682_com.tencent.weread.jpg" alt="Ebook demo translated" width="45%" />
</p>

PDF 示例（英文原页 / 中文输出）：

<p align="center">
  <img src="./assets/Sample_pdf_en_page-0001.jpg" alt="Sample PDF English page" width="45%" />
  <img src="./assets/Sample_pdf_zh_page-0001.jpg" alt="Sample PDF Chinese page" width="45%" />
</p>

## 支持的输入

- `EPUB`
- `HTML / HTM`
- `PDF`
- `SRT`
- `MKV / MP4 / MOV / M4V / WEBM`

## 主要能力

- 按文件类型自动选择对应工作流
- 支持 `Gemini`、`Qwen`、`Mimo`、`OpenRouter`
- 支持章节选择，仅 `EPUB`
- 支持页码选择，仅 `PDF`
- 支持断点续跑，重跑时优先复用缓存
- 支持术语表生成与标题格式标准化
- 支持把视频中的字幕轨提取出来翻译，再封装回输出视频
- `PDF` 模式会尽量保留图片、图形和非正文区域

## 环境要求

基础要求：

- Node.js 18+
- npm

PDF 模式额外要求：

- 可用的 Python 环境
- Python 依赖安装自 [src/pdf/requirements.txt](/f:/wasabi/wasabi_fork/wasabi_epub/src/pdf/requirements.txt:1)
- 如需固定使用某个 Python，可在 `.env` 中设置 `WASABI_PDF_PYTHON`

视频 / 字幕轨模式额外要求：

- `ffmpeg`
- `ffprobe`
- 这两个命令需要在 `PATH` 中可用

PDF 中文回填额外建议：

- 系统中需要可用的 CJK 字体
- 如需手动指定字体，可设置 `PDF_FONT_FILE` 或 `WASABI_PDF_FONT`

## 安装

先安装 Node 依赖：

```bash
npm install
```

如果你要处理 PDF，再安装 PDF 的 Python 依赖：

```bash
python -m pip install -r src/pdf/requirements.txt
```

或者：

```bash
npm run pdf:install
```

## 配置

在项目根目录创建 `.env`。

最小示例：

```env
PRIMARY_PROVIDER=qwen
PRIMARY_MODEL=qwen-plus

FALLBACK_ON_CONTENT_POLICY=true
FALLBACK_PROVIDER=openrouter
FALLBACK_MODEL=x-ai/grok-4.1-fast

QWEN_API_KEY=your_qwen_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
```

如果你使用别的 provider，也可以配置：

```env
GEMINI_API_KEY=your_gemini_api_key
MIMO_API_KEY=your_mimo_api_key

# 可选：覆盖默认 base URL
# QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# MIMO_BASE_URL=https://api.xiaomimimo.com/v1
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# 可选：OpenRouter reasoning 开关
# OPENROUTER_REASONING_ENABLED=true
```

默认行为：

- 默认源语言：`English`
- 默认目标语言：`Chinese (Simplified)`
- 默认主 provider：`qwen`
- 默认 fallback provider：`openrouter`

PDF 模式可选配置：

```env
# Optional: explicitly choose the Python executable for PDF mode
WASABI_PDF_PYTHON=C:\path\to\python.exe
```

## 用法

基本格式：

```bash
node index.js "input-file" [--chap "<selector>"] [--page "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]
```

常见示例：

```bash
node index.js "book.epub"
node index.js "book.epub" --to "fr"
node index.js "book.epub" --chap "1-3"

node index.js "chapter.html" --to "zh"

node index.js "paper.pdf" --to "zh"
node index.js "paper.pdf" --page "1,3,5" --to "zh"

node index.js "episode.srt" --to "zh"
node index.js "movie.mkv" --from "en" --to "zh"

node index.js "book.epub" --debug
```

参数说明：

- `--chap`：只翻译指定章节，仅 `EPUB`
- `--page`：只翻译指定页码，仅 `PDF`
- `--from`：设置源语言
- `--to`：设置目标语言
- `--concurrency`：设置并发数，必须为正整数
- `--debug`：保留缓存目录和日志文件，便于排错

## 选择器语法

章节选择 `--chap`：

- `1`
- `1-3`
- `1,3,5`
- `1,1-3`
- `'Blackhole'-'Gravity'`

页码选择 `--page`：

- `1`
- `2-4`
- `1,3,5`
- `1,3-5`

## 语言别名

支持的常用别名：

- `en` / `english`
- `es` / `spanish`
- `fr` / `french`
- `ru` / `russian`
- `zh` / `zh-cn` / `zh-hans`
- `ja` / `jp` / `japanese`
- `ko` / `korean`

## 各模式说明

### EPUB

- 输出为新的 `.epub`
- 会尽量保留目录、章节顺序和原始结构
- 支持 `--chap`

### HTML

- 输出为新的 `.html`
- 适合单文件网页或导出的 HTML 文档

### PDF

- 输出为新的 `.pdf`
- 使用 Node 做主流程编排，Python 负责提取和回填
- 支持 `--page`
- 会尽量保留图片、矢量图、页眉页脚等非正文区域
- Python 环境优先使用 `WASABI_PDF_PYTHON`，否则回退到系统 `python`

### SRT

- 输出为新的 `.srt`
- 会先解析字幕 cue，再走统一翻译流程

### 视频字幕

- 输出统一为新的 `.mkv`
- 会优先探测内嵌字幕轨，也会识别同目录下的外部字幕文件
- 如果没有显式传 `--from`，会优先用字幕轨语言或字幕文本推断源语言
- 当前只支持文本类字幕轨，不支持图片字幕轨

## 输入、输出与缓存

输入文件可以放在：

- 项目根目录
- `input/`

运行成功后：

- 最终结果写入 `output/`
- 原输入文件会被移动到 `input/`

非 `--debug` 模式：

- 中间缓存会自动清理
- 日志文件会自动清理

`--debug` 模式：

- 会保留 `.cache_*` 目录
- 会保留 `log/` 下的日志文件

典型输出文件名：

- `book_zh.epub`
- `chapter_zh.html`
- `paper_zh.pdf`
- `episode_zh.srt`
- `movie_zh.mkv`

## 常见问题

### 1. PDF 跑不起来

优先检查：

- 是否执行过 `python -m pip install -r src/pdf/requirements.txt`
- `python` 命令是否可用
- 如果你在用自定义环境，是否设置了 `WASABI_PDF_PYTHON`

如果你的 Python 不在默认位置，也可以设置：

- `WASABI_PDF_PYTHON`
- `PYTHON`
- `PYTHON_BIN`

### 2. 视频字幕模式报错

优先检查：

- `ffmpeg` 和 `ffprobe` 是否已安装
- 是否在命令行里直接执行这两个命令
- 输入视频里是否有可用的文本字幕轨，或同目录是否有外部字幕文件

### 3. 想保留日志和中间文件方便排错

加上：

```bash
--debug
```

## 项目结构

用户通常只需要关心这些目录：

```text
input/    放输入文件
output/   放最终输出
log/      调试日志
src/      程序源码
src/pdf/  PDF 子模块
```

如果你只想使用，不需要理解内部实现；如果你要继续改 PDF 流程，可以从 [src/pdf/README.md](/f:/wasabi/wasabi_fork/wasabi_epub/src/pdf/README.md:1) 开始看。
