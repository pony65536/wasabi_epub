# Wasabi EPUB
[English] | [中文](./README.md)

A command-line translation tool designed for long documents and subtitle workflows. Supports translating `EPUB`, `HTML`, `PDF`, `SRT`, and subtitle-bearing video files into a target language while preserving the original structure, chapter order, table of contents, layout, or subtitle tracks as faithfully as possible.

## Demo

Subtitle example (source / translated):

<p align="center">
  <img src="./assets/Snipaste_2026-04-06_20-20-52.jpg" alt="Subtitle demo source" width="45%" />
  <img src="./assets/Snipaste_2026-04-06_20-19-30.jpg" alt="Subtitle demo translated" width="45%" />
</p>

Ebook example (source page / translated page):

<p align="center">
  <img src="./assets/Screenshot_2026-06-06-16-08-21-811_com.tencent.weread.jpg" alt="Ebook demo source" width="45%" />
  <img src="./assets/Screenshot_2026-06-06-16-04-18-682_com.tencent.weread.jpg" alt="Ebook demo translated" width="45%" />
</p>

PDF example (source page / translated page):

<p align="center">
  <img src="./assets/Sample_pdf_en_page-0001.jpg" alt="Sample PDF English page" width="45%" />
  <img src="./assets/Sample_pdf_zh_page-0001.jpg" alt="Sample PDF Chinese page" width="45%" />
</p>

## Supported Input Formats

- `EPUB`
- `HTML / HTM`
- `PDF`
- `SRT`
- `MKV / MP4 / MOV / M4V / WEBM`

## Key Features

- Automatically selects the appropriate workflow based on file type
- Supports `Gemini`, `Qwen`, `Mimo`, and `OpenRouter` providers
- Chapter selection (EPUB only)
- Page selection (PDF only)
- Resume from checkpoint — cached results are reused on re-run
- Glossary generation and title format normalization
- Extracts subtitle tracks from video, translates them, and muxes them back into the output video
- PDF mode preserves images, graphics, and non-body regions as much as possible

## Requirements

Base requirements:

- Node.js 18+
- npm

Additional requirements for PDF mode:

- A working Python environment
- Python dependencies listed in [src/pdf/requirements.txt](/f:/wasabi/wasabi_fork/wasabi_epub/src/pdf/requirements.txt:1)
- If needed, pin a specific Python via `WASABI_PDF_PYTHON`
- Python selection order is: `WASABI_PDF_PYTHON` -> `python3` -> `python`

Additional requirements for video / subtitle track mode:

- `ffmpeg`
- `ffprobe`
- Both commands must be available in `PATH`

Additional recommendation for PDF Chinese back-fill:

- CJK fonts must be available on the system
- To specify a font manually, set `PDF_FONT_FILE` or `WASABI_PDF_FONT`

## Installation

Install Node dependencies first:

```bash
npm install
```

If you need to process PDFs, also install the PDF Python dependencies:

```bash
python -m pip install -r src/pdf/requirements.txt
```

Or:

```bash
npm run pdf:install
```

You can also run a read-only environment diagnostic first:

```bash
node index.js doctor
```

## Configuration

Create a `.env` file in the project root.

Minimal example:

```env
PRIMARY_PROVIDER=qwen
PRIMARY_MODEL=qwen-plus

FALLBACK_ON_CONTENT_POLICY=true
FALLBACK_PROVIDER=openrouter
FALLBACK_MODEL=x-ai/grok-4.1-fast

QWEN_API_KEY=your_qwen_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
```

For other providers, you can also configure:

```env
GEMINI_API_KEY=your_gemini_api_key
MIMO_API_KEY=your_mimo_api_key

# Optional: override default base URLs
# QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# MIMO_BASE_URL=https://api.xiaomimimo.com/v1
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Optional: toggle OpenRouter reasoning
# OPENROUTER_REASONING_ENABLED=true
```

Default behavior:

- Default source language: `English`
- Default target language: `Chinese (Simplified)`
- Default primary provider: `qwen`
- Default fallback provider: `openrouter`

Optional PDF setting:

```env
# Optional: explicitly choose the Python executable for PDF mode
WASABI_PDF_PYTHON=C:\path\to\python.exe
```

## Usage

Basic format:

```bash
node index.js "input-file" [--chap "<selector>"] [--page "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug] [--install]
```

Common examples:

```bash
node index.js doctor
node index.js setup --pdf

node index.js "book.epub"
node index.js "book.epub" --to "fr"
node index.js "book.epub" --chap "1-3"

node index.js "chapter.html" --to "zh"

node index.js "paper.pdf" --to "zh"
node index.js "paper.pdf" --page "1,3,5" --to "zh"
node index.js "paper.pdf" --install

node index.js "episode.srt" --to "zh"
node index.js "movie.mkv" --from "en" --to "zh"

node index.js "book.epub" --debug
```

Options:

- `--chap`: Translate specific chapters only (EPUB only)
- `--page`: Translate specific pages only (PDF only)
- `--from`: Set the source language
- `--to`: Set the target language
- `--concurrency`: Set concurrency level (must be a positive integer)
- `--debug`: Retain cache directories and log files for debugging
- `--install`: Explicitly allow the current PDF command to enter the install flow; in an interactive terminal, Wasabi will confirm before installing missing Python dependencies

Environment and setup commands:

- `node index.js doctor`: Read-only checks for Node, Python, PDF, video, and API key readiness
- `node index.js setup --pdf`: Installs PDF dependencies using the selected Python

Default behavior when PDF dependencies are missing:

- In an interactive terminal, running `node index.js "paper.pdf"` will prompt to install them
- In a non-interactive environment, Wasabi will report the missing dependencies and exit instead of waiting for input
- With `--install`, Wasabi enters the same confirmation/install flow explicitly

## Selector Syntax

Chapter selection `--chap`:

- `1`
- `1-3`
- `1,3,5`
- `1,1-3`
- `'Blackhole'-'Gravity'`

Page selection `--page`:

- `1`
- `2-4`
- `1,3,5`
- `1,3-5`

## Language Aliases

Supported common aliases:

- `en` / `english`
- `es` / `spanish`
- `fr` / `french`
- `ru` / `russian`
- `zh` / `zh-cn` / `zh-hans`
- `ja` / `jp` / `japanese`
- `ko` / `korean`

## Mode Details

### EPUB

- Output is a new `.epub` file
- Preserves table of contents, chapter order, and original structure as much as possible
- Supports `--chap`

### HTML

- Output is a new `.html` file
- Suitable for single-page websites or exported HTML documents

### PDF

- Output is a new `.pdf` file
- Node handles the main orchestration; Python handles extraction and back-fill
- Supports `--page`
- Preserves images, vector graphics, headers, footers, and other non-body regions as much as possible
- Python selection order is `WASABI_PDF_PYTHON` -> `python3` -> `python`

### SRT

- Output is a new `.srt` file
- Parses subtitle cues first, then runs them through the unified translation pipeline

### Video Subtitles

- Output is always a new `.mkv` file
- Prioritizes embedded subtitle tracks; also detects external subtitle files in the same directory
- If `--from` is not explicitly provided, infers the source language from the subtitle track language or subtitle text
- Currently supports text-based subtitle tracks only; image-based subtitle tracks are not supported

## Input, Output, and Cache

Input files can be placed in:

- The project root directory
- `input/`

After a successful run:

- Final results are written to `output/`
- The original input file is moved to `input/`

Without `--debug`:

- Intermediate cache is automatically cleaned up
- Log files are automatically cleaned up

With `--debug`:

- `.cache_*` directories are retained
- Log files under `log/` are retained

Typical output filenames:

- `book_zh.epub`
- `chapter_zh.html`
- `paper_zh.pdf`
- `episode_zh.srt`
- `movie_zh.mkv`

## Troubleshooting

### 1. PDF mode fails to start

Check:

- Have you run `node index.js doctor`?
- Have you run `node index.js setup --pdf`?
- Is `python3` or `python` available on your system?
- If you use a custom environment, did you set `WASABI_PDF_PYTHON`?

If your Python is not in the default location, set:

- `WASABI_PDF_PYTHON`

You can also let Wasabi install missing PDF dependencies before the run:

```bash
node index.js "paper.pdf" --install
```

In an interactive terminal, the plain command below will also prompt when dependencies are missing:

```bash
node index.js "paper.pdf"
```

### 2. Video subtitle mode errors

Check:

- Have you run `node index.js doctor`?
- Are `ffmpeg` and `ffprobe` installed?
- Can you run both commands directly from the terminal?
- Does the input video have a usable text subtitle track, or is there an external subtitle file in the same directory?

### 3. Keeping logs and intermediate files for debugging

Add the flag:

```bash
--debug
```

## Project Structure

As a user, you typically only need to care about these directories:

```text
input/    Place input files here
output/   Final output files
log/      Debug logs
src/      Program source code
src/pdf/  PDF sub-module
```

If you only want to use the tool, you don't need to understand the internals. If you want to modify the PDF pipeline, start with [src/pdf/README_en.md](./src/pdf/README_en.md).
