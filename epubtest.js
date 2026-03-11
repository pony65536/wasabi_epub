import "dotenv/config";
import { EPub } from "epub2";
import AdmZip from "adm-zip";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import Queue from "better-queue";
import fs from "fs";
import pkg from "natural";

const { NGrams, WordTokenizer } = pkg;

// =================== 1. ESM 环境兼容设置 ===================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 导入拆分模块
import { createLogger } from "./src/logger.js";
import { createProgressCache } from "./src/cache.js";
import { createAIProvider } from "./src/ai-provider.js";
import {
    createBatchQueue,
    splitIntoBatches,
    dispatchBatches,
    collectFailedNodes,
    processHtmlBatch,
    CHEERIO_OPTIONS,
    loadHtml,
    extractFirstHeading,
    resolveAnchorTitle,
    normalizeHref,
    buildHrefIndex,
    callAIWithRetry,
} from "./src/utils.js";

// =================== 2. 核心设置 ===================
const INPUT_FILE_NAME =
    "The Essays of Warren Buffett Lessons for Corporate America, Fourth Edition (Cunningham, Lawrence A. Buffett, Warren E.) (Z-Library).epub";
// "One from Many VISA and the Rise of Chaordic Organization (VISA InternationalHock, Dee) (Z-Library).epub";
// "The Wealth of Nations (Adam Smith) (z-library.sk, 1lib.sk, z-lib.sk).epub";

const CURRENT_PROVIDER = "qwen";

// 测试模式：null 表示翻译全部章节，数字表示只翻译前 N 章
const TEST_MODE_LIMIT = null;

const CONFIG = {
    targetLanguage: "Chinese (Simplified)",
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
        modelName: "gemini-2.5-pro",
        concurrency: 1,
    },
    qwen: {
        apiKey: process.env.QWEN_API_KEY,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: "qwen3-max",
        concurrency: 5,
    },
    mimo: {
        apiKey: process.env.MIMO_API_KEY,
        baseURL: "https://api.xiaomimimo.com/v1",
        modelName: "mimo-v2-flash",
        concurrency: 5,
    },
};

// =================== 3. 翻译风格 ===================
const STYLE_GUIDE = `
TRANSLATION STYLE GUIDE (Target: Chinese Simplified):
1. **Rephrase**: Natural Chinese (Xin Da Ya / 信达雅).
2. **Split Long Sentences**: Break down long English clauses.
3. **Tone**: Professional, insightful.
4. **Vocabulary**: Use appropriate idioms (Chengyu) where natural.
5. **No Translationese**: Avoid passive voice (e.g., limit usage of "被").

HEADING FORMATTING RULES:
1. **Consistency**: Table of Contents must match Main Body.
2. **Preserve Prefix**: Keep numeric/alphabetic numbering prefix (e.g. "1.2 ", "A. ") as-is; only translate the title text after it.
`;

// =================== 13. Agent 规划模块 ===================
const planTranslationOrder = async (chapters, aiProvider, logger) => {
    console.log("🕵️ Agent is analyzing book structure...");

    const simplifiedChapters = chapters.map((ch) => ({
        id: ch.id,
        title: ch.title,
    }));

    const agentPrompt = `
You are a "Translation Strategy Agent".

I have an EPUB book to translate.

GOAL: Filter and reorder the processing list based on these strict rules:

1. **IDENTIFY TOC (Action: Flag)**:
- Find the chapter that serves as the "Table of Contents" or "Contents" page.
- If contents chapter exists, in the output JSON, set "tocId" to its ID, otherwise set "tocId" to null.

2. **FILTER & REMOVE (Strict Exclusion)**:
- From the final "order" list, **COMPLETELY REMOVE** any items identified as: "Table of Contents", "Contents", "Index", "Search Terms", or "Bibliography".
- **Crucial Rule**: Even if you identify a chapter as the TOC for the "tocId" field, you must **NOT** include its ID in the "order" array. The "order" list should contain only translatable content.

3. **MAIN CONTENT FIRST (Priority 1)**:
- Core chapters (e.g., "Chapter 1", "The Rise of VISA", "Part I").
- Translating these first builds the context glossary.

4. **FRONT/BACK MATTER LAST (Priority 2)**:
- "Preface", "Introduction", "Foreword", "Copyright", "Dedication", "About the Author", "Acknowledgments".

REASON: Main content provides the necessary context to translate the introductory and administrative sections accurately later.

INPUT: A JSON list of chapters.
OUTPUT: A JSON object:
{
    "tocId": "id_of_toc_chapter_or_null",
    "order": ["chapter_01", "chapter_02", ...]
}`;

    try {
        const result = await callAIWithRetry(
            aiProvider,
            JSON.stringify(simplifiedChapters),
            agentPrompt,
        );

        console.log(`   📋 TOC: ${result.tocId}, Order: ${result.order.length} chapters`);
        return result;
    } catch (e) {
        logger.write("WARN", `Agent planning failed: ${e.message}, using default order`);
        return {
            tocId: null,
            order: chapters.map((ch) => ch.id),
        };
    }
};

// =================== 14. 翻译主流程 ===================
const translateChapter = async (
    chapter,
    $,
    chapterDoc,
    cache,
    batchQueue,
    aiProvider,
    styleGuide,
    logger,
) => {
    console.log(`  📄 Translating: ${chapter.title}`);

    const cached = cache.load(chapter.id);
    if (cached) {
        const $cached = loadHtml(cached);
        $("body").html($cached("body").html());
    }

    // 标记所有需要翻译的节点
    $("p, li, td, th, h1, h2, h3, h4, h5, h6").each((_, el) => {
        const $el = $(el);
        const id = `t-${Math.random().toString(36).slice(2, 11)}`;
        $el.attr("data-translate-id", id);
    });

    const nodeList = [];
    $("[data-translate-id]").each((_, el) => {
        const $el = $(el);
        nodeList.push({
            id: $el.attr("data-translate-id"),
            content: $el.html(),
        });
    });

    console.log(`    - ${nodeList.length} nodes to translate`);

    const processor = {
        prompt: `You are a professional translator. Translate the following content to ${CONFIG.targetLanguage}. ${styleGuide}

IMPORTANT: Return ONLY the translated XML content. Wrap each translated paragraph in a <node> tag with the original ID:
<node id="ORIGINAL_ID">translated content</node>

Do NOT include any explanations, comments, or markdown formatting.`,
        attrName: "data-translate-id",
    };

    await processHtmlBatch($, nodeList, processor, batchQueue, logger);
    await batchQueue.drainQueue();

    const translatedHtml = $.html();
    cache.save(chapter.id, translatedHtml);

    return translatedHtml;
};

const processEpub = async (inputFile, outputFile) => {
    const logger = createLogger();
    const cache = createProgressCache();
    const aiProvider = createAIProvider(CURRENT_PROVIDER, CONFIG, logger);

    console.log(`📖 Loading EPUB: ${inputFile}`);
    const book = await EPub.create(inputFile);

    const chapters = [];
    for (const chapter of book.flow) {
        if (TEST_MODE_LIMIT && chapters.length >= TEST_MODE_LIMIT) break;

        try {
            const html = await book.getChapter(chapter.id);
            const title = extractFirstHeading(html) ?? chapter.title ?? chapter.id;
            chapters.push({
                id: chapter.id,
                href: chapter.href,
                title,
                content: html,
            });
        } catch (e) {
            logger.write("ERROR", `Failed to load chapter ${chapter.id}: ${e}`);
        }
    }

    console.log(`📑 Found ${chapters.length} chapters`);

    // 使用 Agent 规划翻译顺序
    const { tocId, order } = await planTranslationOrder(
        chapters,
        aiProvider,
        logger,
    );

    // 根据规划顺序翻译
    const chapterMap = new Map(chapters.map((ch) => [ch.id, ch]));
    const orderedChapters = order.map((id) => chapterMap.get(id)).filter(Boolean);

    const { queue, drainQueue } = createBatchQueue(aiProvider, logger);

    for (const chapter of orderedChapters) {
        console.log(`  📄 Translating: ${chapter.title}`);

        let $ = loadHtml(chapter.content);

        // 标记所有需要翻译的节点
        $("p, li, td, th, h1, h2, h3, h4, h5, h6").each((_, el) => {
            const $el = $(el);
            const id = `t-${Math.random().toString(36).slice(2, 11)}`;
            $el.attr("data-translate-id", id);
        });

        const nodeList = [];
        $("[data-translate-id]").each((_, el) => {
            const $el = $(el);
            nodeList.push({
                id: $el.attr("data-translate-id"),
                content: $el.html(),
            });
        });

        console.log(`    - ${nodeList.length} nodes to translate`);

        const processor = {
            prompt: `You are a professional translator. Translate the following content to ${CONFIG.targetLanguage}. ${STYLE_GUIDE}

IMPORTANT: Return ONLY the translated XML content. Wrap each translated paragraph in a <node> tag with the original ID:
<node id="ORIGINAL_ID">translated content</node>

Do NOT include any explanations, comments, or markdown formatting.`,
            attrName: "data-translate-id",
        };

        await processHtmlBatch($, nodeList, processor, queue, logger);
        await drainQueue();

        const translatedHtml = $.html();
        cache.save(chapter.id, translatedHtml);

        // 保存章节到输出文件
        try {
            const zip = new AdmZip(inputFile);
            const entry = zip.getEntry(chapter.href);
            if (entry) {
                entry.setData(Buffer.from(translatedHtml, "utf8"));
                zip.writeZip(outputFile);
            }
        } catch (e) {
            logger.write("ERROR", `Failed to save chapter ${chapter.id}: ${e}`);
        }
    }

    console.log("✅ Translation complete!");
};

// =================== 15. 入口 ===================
const INPUT_FILE = INPUT_FILE_NAME;
const OUTPUT_FILE = INPUT_FILE_NAME.replace(".epub", "_translated.epub");

processEpub(INPUT_FILE, OUTPUT_FILE);
