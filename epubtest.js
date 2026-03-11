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

// =================== 2. 核心设置 ===================
const INPUT_FILE_NAME =
    // "The Essays of Warren Buffett Lessons for Corporate America, Fourth Edition (Cunningham, Lawrence A. Buffett, Warren E.) (Z-Library).epub";
    // "One from Many VISA and the Rise of Chaordic Organization (VISA InternationalHock, Dee) (Z-Library).epub";
    "The Wealth of Nations (Adam Smith) (z-library.sk, 1lib.sk, z-lib.sk).epub";

const CURRENT_PROVIDER = "qwen";

// 测试模式：null 表示翻译全部章节，数字表示只翻译前 N 章
const TEST_MODE_LIMIT = 2;

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

// =================== 4. 日志模块 ===================
const createLogger = (logDir) => {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFile = path.join(logDir, `translation_${runId}.log`);

    const write = (type, content) => {
        const timestamp = new Date().toLocaleString();
        const entry = `\n[${timestamp}] [${type}]\n${content}\n${"=".repeat(50)}\n`;
        fs.appendFileSync(logFile, entry, "utf8");
    };

    console.log(`📝 Log file: ${path.basename(logFile)}`);
    return { write, logFile };
};

// =================== 5. AI Provider 工厂 ===================
const createAIProvider = (providerName, config, logger) => {
    const providerConfig = config[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);

    let _callRaw;

    if (providerName === "gemini") {
        const genAI = new GoogleGenerativeAI(providerConfig.apiKey);
        const model = genAI.getGenerativeModel({
            model: providerConfig.modelName,
        });
        _callRaw = async (systemInstruction, userContent) => {
            const result = await model.generateContent(
                `${systemInstruction}\n\nUser Input:\n${userContent}`,
            );
            return (await result.response).text().trim();
        };
    } else {
        const client = new OpenAI({
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseURL,
        });
        _callRaw = async (systemInstruction, userContent, forceJson) => {
            const options = {
                model: providerConfig.modelName,
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent },
                ],
                ...(forceJson && { response_format: { type: "json_object" } }),
            };
            const completion = await client.chat.completions.create(options);
            return completion.choices[0].message.content.trim();
        };
    }

    const callAI = async (
        userContent,
        systemInstruction,
        forceJsonMode = false,
    ) => {
        if (!userContent?.trim()) return "";
        logger.write(
            "REQUEST",
            `SYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
        );
        try {
            const responseText = await _callRaw(
                systemInstruction,
                userContent,
                forceJsonMode,
            );
            logger.write("RESPONSE", responseText);
            return responseText;
        } catch (e) {
            logger.write("ERROR", `callAI Failed: ${e.stack || e.message}`);
            throw e;
        }
    };

    return {
        callAI,
        concurrency: providerConfig.concurrency,
        modelName: providerConfig.modelName,
    };
};

// =================== 6. 断点续传缓存模块 ===================
const createProgressCache = (cacheDir) => {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const _cacheFile = (chapterId) =>
        path.join(cacheDir, `${chapterId.replace(/[/\\:*?"<>|]/g, "_")}.html`);

    const load = (chapterId) => {
        const file = _cacheFile(chapterId);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, "utf8");
        }
        return null;
    };

    const save = (chapterId, html) => {
        fs.writeFileSync(_cacheFile(chapterId), html, "utf8");
    };

    const clear = () => {
        for (const f of fs.readdirSync(cacheDir)) {
            fs.unlinkSync(path.join(cacheDir, f));
        }
        console.log("🗑️  Cache cleared.");
    };

    const count = () =>
        fs.readdirSync(cacheDir).filter((f) => f.endsWith(".html")).length;

    return { load, save, clear };
};

// =================== 7. AI 响应清洗工具 ===================
/**
 * 【修复问题4】清洗 AI 返回内容中的 Markdown 代码块包裹。
 * AI 有时会将结果包在 ```xml 或 ``` 中，导致后续 cheerio 解析失败。
 */
const cleanAIResponse = (raw) => {
    return raw
        .replace(/```[\w]*\n?/g, "") // 去掉 ```xml、```html 等开头
        .replace(/```/g, "") // 去掉尾部 ```
        .trim();
};

// =================== 8. 批处理队列工厂 ===================
const createBatchQueue = (aiProvider, logger) => {
    const queue = new Queue(
        async (task, cb) => {
            const { batch, $parent, processor } = task;
            const MAX_ATTEMPTS = 3;
            let attempts = 0;
            let success = false;

            while (!success && attempts < MAX_ATTEMPTS) {
                try {
                    attempts++;

                    const mergeRegex =
                        /([A-Za-z])<(small|span|strong|em)[^>]*>([\s\S]*?)<\/\2>/gi;

                    const batchInput = batch
                        .map((n) => {
                            const preProcessedContent = n.content.replace(
                                mergeRegex,
                                (match, p1, p2, p3) =>
                                    !p3.includes("<") ? p1 + p3 : match,
                            );
                            return `<node id="${n.id}">${preProcessedContent}</node>`;
                        })
                        .join("\n");

                    // 【修复问题4】清洗 AI 响应，去除可能的 Markdown 包裹
                    const rawResponse = cleanAIResponse(
                        await aiProvider.callAI(
                            batchInput,
                            processor.prompt,
                            false,
                        ),
                    );

                    // 【修复问题4】用 cheerio 解析整个响应，替代逐节点正则匹配。
                    // 优点：
                    //   1. 不受 AI 输出的空格、换行、属性顺序影响
                    //   2. 天然支持嵌套 HTML，不会因 </node> 提前截断
                    //   3. node.id 含特殊字符时也不会使正则崩溃
                    const $response = cheerio.load(
                        `<root>${rawResponse}</root>`,
                        { xmlMode: true, decodeEntities: false },
                    );

                    for (const node of batch) {
                        // cheerio 按属性值精确选择，无需转义
                        const $node = $response(`node[id="${node.id}"]`);

                        if ($node.length === 0) {
                            // 节点在响应中缺失：保留 data-* 属性，交给外层重试逻辑
                            logger.write(
                                "WARN",
                                `Node ${node.id} missing from AI response, will retry.`,
                            );
                            continue;
                        }

                        const processedContent = $node.html()?.trim();
                        if (!processedContent) continue;

                        try {
                            // 验证内容是合法 XML 片段，失败则不写回（保留属性供重试）
                            cheerio.load(processedContent, { xmlMode: true });
                            $parent(`[${processor.attrName}="${node.id}"]`)
                                .html(processedContent)
                                .removeAttr(processor.attrName);
                        } catch (xmlError) {
                            logger.write(
                                "ERROR",
                                `Node ${node.id} invalid HTML: ${xmlError.message}`,
                            );
                            // 故意不 removeAttr，让外层重试逻辑捕获该节点
                        }
                    }

                    success = true;
                    cb(null);
                } catch (e) {
                    logger.write(
                        "ERROR",
                        `Batch Queue Attempt ${attempts} Failed: ${e.stack || e.message}`,
                    );
                    if (attempts >= MAX_ATTEMPTS) cb(e);
                    else await new Promise((r) => setTimeout(r, 2000));
                }
            }
        },
        { concurrent: aiProvider.concurrency, maxRetries: 0 },
    );

    const drainQueue = () =>
        new Promise((resolve) => {
            const isIdle = () =>
                queue._running === 0 && queue._queue.length === 0;
            if (isIdle()) return resolve();
            queue.once("drain", resolve);
        });

    return { queue, drainQueue };
};

// =================== 9. 通用批处理逻辑 ===================
const BATCH_SIZE_LIMIT = 5000;

const splitIntoBatches = (nodeList) => {
    const batches = [];
    let currentBatch = [];
    let currentLength = 0;
    for (const node of nodeList) {
        if (
            currentLength + node.content.length > BATCH_SIZE_LIMIT &&
            currentBatch.length > 0
        ) {
            batches.push(currentBatch);
            currentBatch = [];
            currentLength = 0;
        }
        currentBatch.push(node);
        currentLength += node.content.length;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
};

const dispatchBatches = (batches, $, processor, batchQueue, logger) =>
    batches.map(
        (batch) =>
            new Promise((resolve) => {
                batchQueue.queue
                    .push({ batch, $parent: $, processor })
                    .on("finish", () => resolve())
                    .on("failed", (err) => {
                        logger.write(
                            "ERROR",
                            `Batch Task Failed: ${err?.message}`,
                        );
                        resolve();
                    });
            }),
    );

const collectFailedNodes = ($, attrName) => {
    const failed = [];
    $(`[${attrName}]`).each((_, el) => {
        failed.push({ id: $(el).attr(attrName), content: $(el).html() });
    });
    return failed;
};

const processHtmlBatch = async ($, nodeList, processor, batchQueue, logger) => {
    if (nodeList.length === 0) return;

    const batches = splitIntoBatches(nodeList);
    await Promise.all(
        dispatchBatches(batches, $, processor, batchQueue, logger),
    );

    const MAX_RETRY_ROUNDS = 3;
    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        const failedNodes = collectFailedNodes($, processor.attrName);
        if (failedNodes.length === 0) break;

        console.log(
            `    - ⚠️ Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS})...`,
        );

        const retryBatches = splitIntoBatches(failedNodes);
        await Promise.all(
            dispatchBatches(retryBatches, $, processor, batchQueue, logger),
        );
    }
};

// =================== 10. Cheerio 辅助工具 ===================
const CHEERIO_OPTIONS = { xmlMode: true, decodeEntities: false };

const loadHtml = (html) => cheerio.load(html, CHEERIO_OPTIONS);

const extractFirstHeading = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    const heading = $("h1, h2").first();
    if (heading.length > 0) return heading.text().replace(/\s+/g, " ").trim();
    const titleTag = $("title").text();
    return titleTag ? titleTag.trim() : null;
};

// const resolveAnchorTitle = ($doc, anchor) => {
//     if (anchor) {
//         const $el = $doc(`#${anchor}`);
//         if ($el.length > 0) {
//             let text = $el.text().trim();
//             if (!text) {
//                 const heading = $el.find("h1, h2, h3, h4, h5, h6").first();
//                 text =
//                     heading.length > 0
//                         ? heading.text().trim()
//                         : $el.nextAll("h1, h2, h3, h4").first().text().trim();
//             }
//             if (!text)
//                 text = $el.closest("h1, h2, h3, h4, h5, h6").text().trim();
//             if (text) return text;
//         }
//     }
//     return $doc("h1, h2, h3").first().text().trim() || null;
// };
const resolveAnchorTitle = ($doc, anchor) => {
    const cleanText = ($el) => {
        if (!$el || !$el.length) return "";
        const $clone = $el.clone();
        $clone.find("sup, a[href]").remove();
        return $clone.text().trim().replace(/\s+/g, " ");
    };

    if (anchor) {
        const $el = $doc(`#${anchor}`);
        if ($el.length > 0) {
            let text = cleanText($el);
            if (!text) {
                const heading = $el.find("h1, h2, h3, h4, h5, h6").first();
                text =
                    heading.length > 0
                        ? cleanText(heading)
                        : cleanText($el.nextAll("h1, h2, h3, h4").first());
            }
            if (!text) text = cleanText($el.closest("h1, h2, h3, h4, h5, h6"));
            if (text) return text;
        }
    }
    return cleanText($doc("h1, h2, h3").first()) || null;
};

// =================== 11. href 规范化索引 ===================
const normalizeHref = (href) =>
    decodeURIComponent(href || "")
        .split("#")[0]
        .replace(/^\.\//, "")
        .replace(/\\/g, "/")
        .toLowerCase()
        .trim();

const buildHrefIndex = (chapterMap) => {
    const index = new Map();
    for (const data of chapterMap.values()) {
        if (!data.href) continue;
        index.set(normalizeHref(data.href), data);
    }
    return index;
};

// =================== 12. 带重试的 JSON AI 调用工具 ===================
const callAIWithRetry = async (
    aiProvider,
    userContent,
    systemPrompt,
    maxAttempts = 3,
) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const raw = await aiProvider.callAI(
                userContent,
                systemPrompt,
                true,
            );
            return JSON.parse(raw.replace(/```json|```/g, "").trim());
        } catch (e) {
            if (attempt >= maxAttempts) throw e;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
};

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

        const chapterMap = new Map(chapters.map((c) => [c.id, c]));
        const ordered = result.order
            .filter((id) => chapterMap.has(id))
            .map((id) => {
                const ch = chapterMap.get(id);
                if (id === result.tocId) ch.isTOC = true;
                chapterMap.delete(id);
                return ch;
            });

        return {
            sorted: [...ordered, ...chapterMap.values()],
            tocId: result.tocId,
        };
    } catch (e) {
        logger.write(
            "ERROR",
            `Agent Plan Failed after retries: ${e.stack || e.message}`,
        );
        console.warn("⚠️ Plan order step failed, using default order.");
        return { sorted: chapters, tocId: null };
    }
};

// =================== 14. 标题格式分析与标准化模块 ===================
const HEADING_SELECTORS = "h1, h2, h3, h4, h5, h6";

const analyzeHeadingFormats = async (chapterMap, aiProvider, logger) => {
    console.log("\n🔍 Step 2: Analyzing heading format examples...");

    // 收集全书所有标题，去重
    const allHeadings = new Map(); // text -> level
    for (const data of chapterMap.values()) {
        const $ = loadHtml(data.html);
        $(HEADING_SELECTORS).each((_, el) => {
            const level = el.tagName;
            const text = $(el).text().trim();
            if (text && !allHeadings.has(text)) {
                allHeadings.set(text, level);
            }
        });
    }

    if (allHeadings.size === 0) {
        console.log("  - No headings found, skipping.");
        return [];
    }

    const samples = [...allHeadings.entries()].map(([text, level]) => ({
        level,
        text,
    }));
    console.log(
        `  - Collected ${samples.length} unique headings, sending to AI...`,
    );

    const systemPrompt = `You are an expert book translator (English → ${CONFIG.targetLanguage}).
Task: Review ALL the heading samples below. For headings that have a special prefix format requiring conversion, provide the translated version as a format example. For plain titles with no special prefix, do NOT include them in the output.

A heading qualifies as a format example if it contains:
- Chapter/Part keywords with Roman numerals (e.g. "Chapter I", "Part II")
- Letter prefixes (e.g. "A.", "B.")
- Numeric prefixes (e.g. "1.", "1.1")
- Any other structural prefix that requires consistent formatting across the book

A heading should be EXCLUDED if it is:
- A plain title with no prefix or structural keyword (e.g. "Introduction", "Conclusion", "About the Author")

**Return at most 2 examples per prefix type. If more exist, pick the most representative ones.**

Output json example: { "examples": [ { "original": "Chapter I Mr. Market", "translated": "第一章 市场先生" }, { "original": "A. The Superinvestors", "translated": "A. 超级投资者" } ] }

Translation rules for included headings: ...`;

    try {
        const result = await callAIWithRetry(
            aiProvider,
            JSON.stringify(samples),
            systemPrompt,
        );

        const examples = result.examples || [];
        console.log(
            `  - ✅ Got ${examples.length} heading format examples (plain titles excluded).`,
        );
        logger.write("HEADING_EXAMPLES", JSON.stringify(examples, null, 2));
        return examples;
    } catch (e) {
        logger.write(
            "ERROR",
            `Heading format analysis failed: ${e.stack || e.message}`,
        );
        console.warn(
            "  - ⚠️ Could not get heading examples, standardization will be skipped.",
        );
        return [];
    }
};

const standardizeHeadingsByRules = async (
    chapterMap,
    headingExamples, // ← 改为接收 analyzeHeadingFormats 的返回值
    aiProvider,
    batchQueue,
    logger,
) => {
    if (!headingExamples || headingExamples.length === 0) {
        console.log(
            "\n⏭️  Step 6: No format rules available, skipping standardization.",
        );
        return;
    }

    console.log(
        "\n🧹 Step 6: Post-translation heading standardization (AI)...",
    );

    // 直接用原文→译文对照例子，不需要描述规则
    const rulesDescription = headingExamples
        .map((e) => `- "${e.original}" → "${e.translated}"`)
        .join("\n");

    const standardizeProcessor = {
        attrName: "data-std-id",
        prompt: `Role: XHTML Copy Editor.
Task: Standardize heading formats according to the format rules below.

FORMAT RULES (apply strictly per heading level):
${rulesDescription}

🛑 RULES:
1. Return each node as: <node id="std_x">standardized heading content</node>
2. Keep inline tags (<a>, <strong>, <em>, <sup>, <span> etc.) intact.
3. Do NOT translate or rephrase any text content.
4. Only adjust numbering prefixes, punctuation markers, or whitespace to match the format rule for that heading's level.
5. Trim edges; collapse internal spaces to a single space; remove all newlines or tabs.`,
    };

    // 全书统一编号
    let globalNodeIndex = 0;
    // 记录每个章节对应的 $ 实例，供后续写回
    const chapterDomMap = new Map();
    // 全书所有节点列表
    const allNodes = [];

    // 第一遍：遍历所有章节，收集节点并打上全局编号
    for (const [chapterId, data] of chapterMap.entries()) {
        const $ = loadHtml(data.html);
        chapterDomMap.set(chapterId, $);

        $(HEADING_SELECTORS).each((_, el) => {
            const $el = $(el);
            const level = el.tagName;

            const content = $el.html()?.trim();
            if (!content) return;

            const nodeId = `std_${globalNodeIndex++}`;
            $el.attr("data-std-id", nodeId);
            allNodes.push({ id: nodeId, content });
        });
    }

    if (allNodes.length === 0) {
        console.log("  - No headings found, skipping.");
        return;
    }

    console.log(
        `  - Found ${allNodes.length} headings across all chapters, processing...`,
    );

    // 第二遍：用全书节点列表统一跑批处理
    // processHtmlBatch 需要一个 $ 来做节点回写，这里构造一个虚拟容器
    // 但由于节点分散在各章节的 $ 实例中，需要自定义回写逻辑
    // 所以直接复用 splitIntoBatches + dispatchBatches，回写时按 chapterDomMap 查找
    const batches = splitIntoBatches(allNodes);

    const writeBackQueue = new Queue(
        async (task, cb) => {
            const { batch } = task;
            const MAX_ATTEMPTS = 3;
            let attempts = 0;

            while (attempts < MAX_ATTEMPTS) {
                try {
                    attempts++;
                    const batchInput = batch
                        .map((n) => `<node id="${n.id}">${n.content}</node>`)
                        .join("\n");

                    const rawResponse = cleanAIResponse(
                        await aiProvider.callAI(
                            batchInput,
                            standardizeProcessor.prompt,
                            false,
                        ),
                    );

                    const $response = cheerio.load(
                        `<root>${rawResponse}</root>`,
                        {
                            xmlMode: true,
                            decodeEntities: false,
                        },
                    );

                    for (const node of batch) {
                        const $node = $response(`node[id="${node.id}"]`);
                        if ($node.length === 0) {
                            logger.write(
                                "WARN",
                                `Node ${node.id} missing from AI response.`,
                            );
                            continue;
                        }
                        const processedContent = $node.html()?.trim();
                        if (!processedContent) continue;

                        // 在各章节的 $ 实例中查找并回写
                        for (const $ of chapterDomMap.values()) {
                            const $target = $(`[data-std-id="${node.id}"]`);
                            if ($target.length > 0) {
                                $target
                                    .html(processedContent)
                                    .removeAttr("data-std-id");
                                break;
                            }
                        }
                    }

                    cb(null);
                    return;
                } catch (e) {
                    logger.write(
                        "ERROR",
                        `Standardize Batch Attempt ${attempts} Failed: ${e.stack || e.message}`,
                    );
                    if (attempts >= MAX_ATTEMPTS) {
                        cb(e);
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        },
        { concurrent: aiProvider.concurrency, maxRetries: 0 },
    );

    const drainWriteBackQueue = () =>
        new Promise((resolve) => {
            const isIdle = () =>
                writeBackQueue._running === 0 &&
                writeBackQueue._queue.length === 0;
            if (isIdle()) return resolve();
            writeBackQueue.once("drain", resolve);
        });

    await Promise.all(
        batches.map(
            (batch) =>
                new Promise((resolve) => {
                    writeBackQueue
                        .push({ batch })
                        .on("finish", resolve)
                        .on("failed", (err) => {
                            logger.write(
                                "ERROR",
                                `Standardize Batch Failed: ${err?.message}`,
                            );
                            resolve();
                        });
                }),
        ),
    );

    await drainWriteBackQueue();

    // 重试未回写成功的节点（data-std-id 仍残留）
    const MAX_RETRY_ROUNDS = 3;
    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        const failedNodes = [];
        for (const $ of chapterDomMap.values()) {
            $("[data-std-id]").each((_, el) => {
                failedNodes.push({
                    id: $(el).attr("data-std-id"),
                    content: $(el).html(),
                });
            });
        }
        if (failedNodes.length === 0) break;

        console.log(
            `    - ⚠️ Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS})...`,
        );
        const retryBatches = splitIntoBatches(failedNodes);
        await Promise.all(
            retryBatches.map(
                (batch) =>
                    new Promise((resolve) => {
                        writeBackQueue
                            .push({ batch })
                            .on("finish", resolve)
                            .on("failed", (err) => {
                                logger.write(
                                    "ERROR",
                                    `Retry Batch Failed: ${err?.message}`,
                                );
                                resolve();
                            });
                    }),
            ),
        );
        await drainWriteBackQueue();
    }

    // 清理所有残留的 data-std-id，并将各章节 $ 结果写回 chapterMap
    let remaining = 0;
    for (const [chapterId, $] of chapterDomMap.entries()) {
        const leftover = $("[data-std-id]").length;
        if (leftover > 0) {
            remaining += leftover;
            logger.write(
                "WARN",
                `${leftover} heading(s) in chapter "${chapterId}" could not be standardized.`,
            );
            $("[data-std-id]").removeAttr("data-std-id");
        }
        chapterMap.get(chapterId).html = $.xml();
    }

    if (remaining > 0) {
        console.log(
            `  - ⚠️ ${remaining} heading(s) could not be standardized and were left as-is.`,
        );
    }
    console.log(
        `  - ✅ Standardized ${globalNodeIndex - remaining} / ${globalNodeIndex} headings.`,
    );
};

// =================== 15. 术语表生成模块 ===================
const cleanText = (htmlContent) => {
    const $ = cheerio.load(htmlContent);
    return $.text().replace(/\s+/g, " ").trim();
};

const getContext = (text, term, window = 40) => {
    try {
        const index = text.toLowerCase().indexOf(term.toLowerCase());
        if (index === -1) return "";
        const start = Math.max(0, index - window);
        const end = Math.min(text.length, index + term.length + window);
        return `...${text.slice(start, end).replace(/\s+/g, " ").trim()}...`;
    } catch {
        return "";
    }
};

const getMostCommonNGrams = (words, n, topK) => {
    const counts = NGrams.ngrams(words, n)
        .map((g) => g.join(" "))
        .reduce((acc, val) => {
            acc[val] = (acc[val] || 0) + 1;
            return acc;
        }, {});
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK);
};

const generateInitialGlossary = async (chapterMap, aiProvider, logger) => {
    console.log("\n📊 Step 3: Generating Initial Glossary...");
    let glossary = {};
    try {
        console.log("    - Reading and cleaning book content...");
        let fullText = "";
        for (const chapter of chapterMap.values()) {
            fullText += cleanText(chapter.html) + " ";
        }

        console.log("    - Tokenizing and calculating N-Grams...");
        const tokenizer = new WordTokenizer();
        const words = tokenizer
            .tokenize(fullText.toLowerCase())
            .filter(
                (w) =>
                    w.length > 1 &&
                    !/^(the|and|a|of|to|in|is|it|that|with|as|for|was)$/.test(
                        w,
                    ),
            );

        const formatList = (list) =>
            list.map(([term, count]) => ({
                term,
                context: getContext(fullText, term),
                count,
            }));

        const payload = JSON.stringify({
            bigrams: formatList(getMostCommonNGrams(words, 2, 25)),
            trigrams: formatList(getMostCommonNGrams(words, 3, 25)),
        });

        console.log("    - Sending candidate terms to AI for selection...");
        const userPrompt = `我想翻译一本电子书，现在使用 n-gram 算法初步筛选了候选词列表。
请你挑选其中容易导致翻译上下文翻译不一致的词组，尤其挑选日常生活中不常见的用法，但是高频出现在书中的部分，并以 JSON 格式输出。
输出格式如下，且不要包含任何多余说明文字，只返回纯 JSON 列表：
{
  "glossary": [
    {
        "term": "术语名称",
        "suggested": "建议翻译",
        "reason": "入选理由",
        "category": "类别"
    }
  ]
}
下面是我整理的候选项：\n${payload}`;

        const parsedResponse = await callAIWithRetry(
            aiProvider,
            userPrompt,
            "You are a helpful assistant that outputs only JSON.",
        );
        const newTerms = parsedResponse.glossary || [];

        if (Array.isArray(newTerms) && newTerms.length > 0) {
            for (const item of newTerms) {
                if (item.term && item.suggested)
                    glossary[item.term] = item.suggested;
            }
            console.log(
                `    - ✅ Glossary generated with ${newTerms.length} terms.`,
            );
            logger.write("GLOSSARY", JSON.stringify(newTerms, null, 2));
        } else {
            console.log("    - ⚠️ No terms were suggested by the AI.");
        }
    } catch (error) {
        console.error("    - ❌ Failed to generate glossary:", error.message);
        logger.write(
            "ERROR",
            `Glossary Generation Failed: ${error.stack || error.message}`,
        );
    }

    console.log("    - Glossary generation step completed.\n");
    return glossary;
};

// =================== 16. 翻译模块 ===================
const translateHtmlContent = async (
    htmlContent,
    chapterTitle,
    glossary,
    headingFormatRules,
    aiProvider,
    batchQueue,
    logger,
) => {
    const $ = loadHtml(htmlContent);
    const nodesToTranslate = [];

    $("p, li, h1, h2, h3, h4, h5, h6, caption, title").each((i, el) => {
        const $el = $(el);
        const originalHtml = $el.html().trim();
        if (originalHtml) {
            const nodeId = `node_${i}`;
            $el.attr("data-t-id", nodeId);
            nodesToTranslate.push({ id: nodeId, content: originalHtml });
        }
    });

    const glossaryMarkdown =
        glossary && Object.keys(glossary).length > 0
            ? `\nGLOSSARY (Strictly follow these translations):\n${Object.entries(
                  glossary,
              )
                  .map(([en, zh]) => `- ${en}: ${zh}`)
                  .join("\n")}\n`
            : "";

    const translationProcessor = {
        attrName: "data-t-id",
        prompt: `
TASK: Translate the content of each <node> into ${CONFIG.targetLanguage}.

CONTEXT: Book Chapter "${chapterTitle}".
Use glossary information when translating.
${glossaryMarkdown}
${STYLE_GUIDE}

🛑 RULES:
1. Return each node as: <node id="node_x">translated text</node>
2. Keep inline tags (<a>, <strong>, </node> etc.) intact.
        `,
    };

    await processHtmlBatch(
        $,
        nodesToTranslate,
        translationProcessor,
        batchQueue,
        logger,
    );
    $("[data-t-id]").removeAttr("data-t-id");
    return $.xml();
};

const performTranslation = async (
    sortedChapters,
    chapterMap,
    glossary,
    headingFormatRules,
    aiProvider,
    batchQueue,
    logger,
    cache,
) => {
    console.log("\n✍️ Step 4: Translating Book Content...");
    const chaptersToProcess = TEST_MODE_LIMIT
        ? sortedChapters.slice(0, TEST_MODE_LIMIT)
        : sortedChapters;

    let skipped = 0;
    for (let i = 0; i < chaptersToProcess.length; i++) {
        const ch = chaptersToProcess[i];
        if (ch.isTOC) continue;

        const cached = cache.load(ch.id);
        if (cached) {
            chapterMap.get(ch.id).html = cached;
            skipped++;
            console.log(
                `⏭️  [${i + 1}/${chaptersToProcess.length}] Skipped (cached): "${ch.title}"`,
            );
            continue;
        }

        console.log(
            `🚀 [${i + 1}/${chaptersToProcess.length}] Processing Chapter: "${ch.title}"`,
        );
        try {
            const translatedHtml = await translateHtmlContent(
                ch.html,
                ch.title,
                glossary,
                headingFormatRules,
                aiProvider,
                batchQueue,
                logger,
            );
            if (chapterMap.has(ch.id)) {
                chapterMap.get(ch.id).html = translatedHtml;
                cache.save(ch.id, translatedHtml);
            }
        } catch (e) {
            logger.write(
                "ERROR",
                `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
            );
        }
    }

    if (skipped > 0) {
        console.log(`  ℹ️  ${skipped} chapter(s) restored from cache.`);
    }

    cache.clear();
    console.log("  🗑️  Cache cleared after successful translation.");
};

// =================== 17. 目录同步模块 ===================
const findBySrc = (hrefIndex, src) => {
    const normalized = normalizeHref(src);
    if (hrefIndex.has(normalized)) return hrefIndex.get(normalized);
    for (const [key, val] of hrefIndex.entries()) {
        const keyEndsWithNormalized =
            key === normalized || key.endsWith("/" + normalized);
        const normalizedEndsWithKey =
            normalized === key || normalized.endsWith("/" + key);
        if (keyEndsWithNormalized || normalizedEndsWithKey) return val;
    }
    return null;
};

const synchronizeTocHtml = async (chapterMap, tocId) => {
    if (!tocId || !chapterMap.has(tocId)) return;
    console.log("\n🔗 Step 7: Synchronizing HTML TOC (Smart Anchor)...");
    try {
        const tocData = chapterMap.get(tocId);
        const hrefIndex = buildHrefIndex(chapterMap);
        const $toc = loadHtml(tocData.html);
        $toc("a[href]").each((_, el) => {
            const $a = $toc(el);
            const rawHref = $a.attr("href");
            if (!rawHref) return;
            const [rawFile, anchor] = rawHref.split("#");
            const target = findBySrc(hrefIndex, rawFile);
            if (!target || target.id === tocId) return;
            const $doc = loadHtml(target.html);
            const title = resolveAnchorTitle($doc, anchor);
            if (title) $a.text(title);
        });
        tocData.html = $toc.xml();
        console.log("  - ✅ HTML TOC synchronized.");
    } catch (e) {
        console.error(`HTML TOC Sync Failed: ${e.message}`);
    }
};

const synchronizeNcx = async (chapterMap, zipEntries) => {
    console.log("\n🔗 Step 8: Synchronizing NCX Metadata (Smart Anchor)...");
    try {
        const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
        if (!ncxEntry) return { ncxEntry: null, ncxContent: "" };
        const ncxContent = ncxEntry.getData().toString("utf8");
        const $ncx = loadHtml(ncxContent);
        const hrefIndex = buildHrefIndex(chapterMap);
        $ncx("navPoint").each((_, el) => {
            const $navPoint = $ncx(el);
            const src = $navPoint.find("content").attr("src");
            if (!src) return;
            const [rawFile, anchor] = src.split("#");
            const target = findBySrc(hrefIndex, rawFile);
            if (!target) return;
            const $doc = loadHtml(target.html);
            const title = resolveAnchorTitle($doc, anchor);
            if (title) $navPoint.find("navLabel > text").first().text(title);
        });
        console.log("  - ✅ NCX metadata synchronized.");
        return { ncxEntry, ncxContent: $ncx.xml() };
    } catch (e) {
        console.error(`NCX Sync Failed: ${e.message}`);
        return { ncxEntry: null, ncxContent: "" };
    }
};

// =================== 18. 文件保存模块 ===================
const saveEpub = async (
    zip,
    chapterMap,
    ncxEntry,
    ncxContent,
    outputPath,
    logger,
) => {
    console.log(`\n💾 Step 9: Finalizing and Saving...`);
    try {
        for (const data of chapterMap.values()) {
            zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
        }
        if (ncxEntry && ncxContent) {
            zip.updateFile(ncxEntry.entryName, Buffer.from(ncxContent, "utf8"));
        }
        zip.writeZip(outputPath);
        console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
    } catch (e) {
        logger.write("ERROR", `Save EPUB Failed: ${e.stack || e.message}`);
        throw e;
    }
};

// =================== 19. 主函数 ===================
const main = async () => {
    const logger = createLogger(path.resolve(__dirname, "log"));
    const aiProvider = createAIProvider(CURRENT_PROVIDER, CONFIG, logger);
    const batchQueue = createBatchQueue(aiProvider, logger);

    const fileInfo = path.parse(INPUT_FILE_NAME);
    const activeModelName = aiProvider.modelName.replace(/[\/\\]/g, "-");
    const inputPath = path.resolve(__dirname, INPUT_FILE_NAME);
    const outputPath = path.resolve(
        __dirname,
        `${fileInfo.name}_${activeModelName}.epub`,
    );

    const cacheDir = path.resolve(__dirname, `.cache_${fileInfo.name}`);
    const cache = createProgressCache(cacheDir);

    console.log(`\n========================================`);
    console.log(`📖 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPath)}`);
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`========================================\n`);

    try {
        const zip = new AdmZip(inputPath);
        const epub = await EPub.createAsync(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = new Map();

        epub.flow.forEach((chapter) => {
            const zipEntry = zipEntries.find((e) =>
                decodeURIComponent(e.entryName).endsWith(
                    decodeURIComponent(chapter.href),
                ),
            );
            const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
            const data = {
                ...chapter,
                html,
                entryName: zipEntry?.entryName,
                title: chapter.title || extractFirstHeading(html) || "Untitled",
            };
            if (data.entryName) chapterMap.set(data.id, data);
        });

        // Step 1: 规划顺序
        const plan = await planTranslationOrder(
            [...chapterMap.values()],
            aiProvider,
            logger,
        );

        // Step 2: 翻译前分析标题格式
        const headingFormatRules = await analyzeHeadingFormats(
            chapterMap,
            aiProvider,
            logger,
        );

        // Step 3: 生成术语表
        const glossary = await generateInitialGlossary(
            chapterMap,
            aiProvider,
            logger,
        );

        // Step 4: 翻译
        await performTranslation(
            plan.sorted,
            chapterMap,
            glossary,
            headingFormatRules,
            aiProvider,
            batchQueue,
            logger,
            cache,
        );

        // 等待队列完全排干
        await batchQueue.drainQueue();

        // Step 5 标题标准化
        await standardizeHeadingsByRules(
            chapterMap,
            headingFormatRules,
            aiProvider,
            batchQueue,
            logger,
        );

        // Step 6: 同步 HTML 目录
        await synchronizeTocHtml(chapterMap, plan.tocId);

        // Step 7: 同步 NCX
        const { ncxEntry, ncxContent } = await synchronizeNcx(
            chapterMap,
            zipEntries,
        );

        // Step 8: 保存文件
        await saveEpub(
            zip,
            chapterMap,
            ncxEntry ?? null,
            ncxContent ?? null,
            outputPath,
            logger,
        );

        console.log(
            `\n✅ All done! Cache preserved at: ${path.basename(cacheDir)}`,
        );
        console.log(
            `   (Delete the cache folder to force a full re-translation next time)`,
        );
    } catch (e) {
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${e.stack || e.message}`,
        );
        console.error(
            "Fatal error occurred. Check logs for details.",
            e.message,
        );
        process.exit(1);
    }
};

main();
