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

- [Node.js](https://nodejs.org/) 20.18.1+
- [npm](https://www.npmjs.com/)
- [Python](https://www.python.org/) 3.10+
- Video subtitle workflows require `ffmpeg` and `ffprobe` in `PATH`
- For better Chinese PDF back-fill, a usable CJK font is recommended

## Installation

Install Node dependencies first:

```bash
npm install
```

## Configuration

Model registration and selection live in `config/wasabi.local.json`; API keys live in `.env`.

Start from the template:

```bash
cp config/wasabi.example.json config/wasabi.local.json
```

Keep only keys and machine-local settings in `.env` (each key name must match the model's `apiKeyEnv`):

```env
QWEN_API_KEY=your_qwen_api_key
OPENROUTER_API_KEY=your_openrouter_api_key

# Optional:
# GEMINI_API_KEY=your_gemini_api_key
# MIMO_API_KEY=your_mimo_api_key
# WASABI_CONFIG=config/wasabi.local.json
```

Each model in `config/wasabi.local.json` declares `sdk`, `baseURL`, `apiKeyEnv`, `modelName`, `concurrency`, and `timeoutMs`. The `selection` block chooses `primary`, an optional `fallback`, the default glossary model, and Russian/Japanese glossary models. See [config/wasabi.example.json](./config/wasabi.example.json).

Default behavior:

- Default source language: `English`
- Default target language: `Chinese (Simplified)`
- If `config/wasabi.local.json` is missing, the CLI fails before any model request and prints the copy instructions

Optional PDF setting:

```env
# Optional: explicitly choose the Python executable for PDF mode
WASABI_PDF_PYTHON=C:\path\to\python.exe
```

## Usage

Basic format:

```bash
node index.js "input-file" [--chap "<selector>"] [--page "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]
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

Environment and setup commands:

- `node index.js doctor`: Read-only checks for Node, Python, PDF, video, and API key readiness
- `node index.js setup --pdf`: Manually installs PDF dependencies using the selected Python

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

## Development and Testing

Node.js 20.18.1+ is required.

```bash
npm ci
npm test              # Node unit tests and workflow fixtures
npm run lint
npm run test:python   # Requires PyMuPDF/pikepdf; skips when fixtures are absent
```

See [docs/architecture.md](./docs/architecture.md) for the architecture and cleanup policy.

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
