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

const logDir = path.resolve(__dirname, "log");
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const writeLog = (type, content) => {
    const timestamp = new Date().toLocaleString();
    const logFile = path.join(
        logDir,
        `translation_${new Date().toISOString().split("T")[0]}.log`,
    );
    const entry = `\n[${timestamp}] [${type}]\n${content}\n${"=".repeat(50)}\n`;
    fs.appendFileSync(logFile, entry, "utf8");
};

// =================== 2. 核心设置 ===================

const INPUT_FILE_NAME =
    "The Essays of Warren Buffett Lessons for Corporate America, Fourth Edition (Cunningham, Lawrence A. Buffett, Warren E.) (Z-Library).epub";

const CURRENT_PROVIDER = "mimo";
const TEST_MODE_LIMIT = 1;

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
`;

// =================== 4. AI 初始化与调用 ===================

const fileInfo = path.parse(INPUT_FILE_NAME);
const activeModelName = CONFIG[CURRENT_PROVIDER].modelName.replace(
    /[\/\\]/g,
    "-",
);

const inputPath = path.resolve(__dirname, INPUT_FILE_NAME);
const outputPath = path.resolve(
    __dirname,
    `${fileInfo.name}_${activeModelName}.epub`,
);

let geminiModel, qwenClient, mimoClient;

const initClient = () => {
    if (CURRENT_PROVIDER === "gemini") {
        const genAI = new GoogleGenerativeAI(CONFIG.gemini.apiKey);
        geminiModel = genAI.getGenerativeModel({
            model: CONFIG.gemini.modelName,
        });
    } else {
        const client = new OpenAI({
            apiKey: CONFIG[CURRENT_PROVIDER].apiKey,
            baseURL: CONFIG[CURRENT_PROVIDER].baseURL,
        });
        if (CURRENT_PROVIDER === "qwen") qwenClient = client;
        else mimoClient = client;
    }
};

const callAI = async (
    userContent,
    systemInstruction,
    forceJsonMode = false,
) => {
    if (!userContent?.trim()) return "";
    writeLog(
        "REQUEST",
        `SYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
    );

    try {
        let responseText = "";

        if (CURRENT_PROVIDER === "gemini") {
            const result = await geminiModel.generateContent(
                `${systemInstruction}\n\nUser Input:\n${userContent}`,
            );
            responseText = (await result.response).text().trim();
        } else {
            const client =
                CURRENT_PROVIDER === "qwen" ? qwenClient : mimoClient;
            const options = {
                model: CONFIG[CURRENT_PROVIDER].modelName,
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent },
                ],
                ...(forceJsonMode && {
                    response_format: { type: "json_object" },
                }),
            };
            const completion = await client.chat.completions.create(options);
            responseText = completion.choices[0].message.content.trim();
        }

        writeLog("RESPONSE", responseText);
        return responseText;
    } catch (e) {
        writeLog("ERROR", `callAI Failed: ${e.stack || e.message}`);
        throw e;
    }
};

const extractHeading = (htmlContent) => {
    const $ = cheerio.load(htmlContent, {
        xmlMode: true,
        decodeEntities: false,
    });
    let heading = $("h1, h2").first();
    if (heading.length > 0) return heading.text().replace(/\s+/g, " ").trim();
    const titleTag = $("title").text();
    return titleTag ? titleTag.trim() : null;
};

// =================== 5. Agent 规划模块 ===================

const planTranslationOrder = async (chapters) => {
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
OUTPUT: A JSON object containing a single array "order" with the "id"s sorted in the best processing order, excluding the forbidden categories.

OUTPUT: A JSON object:
{
    "tocId": "id_of_toc_chapter_or_null",
    "order": ["chapter_01", "chapter_02", ...]
}`;

    let attempts = 0;

    while (attempts < 3) {
        try {
            const responseText = await callAI(
                JSON.stringify(simplifiedChapters),
                agentPrompt,
                true,
            );

            const result = JSON.parse(
                responseText.replace(/```json|```/g, "").trim(),
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
            attempts++;
            writeLog(
                "ERROR",
                `Agent Plan Attempt ${attempts} Failed: ${e.stack || e.message}`,
            );
            if (attempts >= 3) return { sorted: chapters, tocId: null };
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
};

// =================== 6. 术语表生成模块 ===================

const cleanText = (htmlContent) => {
    const $ = cheerio.load(htmlContent);
    const text = $.text();
    return text.replace(/\s+/g, " ").trim();
};

const getContext = (text, term, window = 40) => {
    try {
        const index = text.toLowerCase().indexOf(term.toLowerCase());
        if (index === -1) return "";
        const start = Math.max(0, index - window);
        const end = Math.min(text.length, index + term.length + window);
        return `...${text.slice(start, end).replace(/\s+/g, " ").trim()}...`;
    } catch (e) {
        return "";
    }
};

const getMostCommonNGrams = (words, n, topK) => {
    const ngrams = NGrams.ngrams(words, n).map((g) => g.join(" "));
    const counts = ngrams.reduce((acc, val) => {
        acc[val] = (acc[val] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK);
};

const generateInitialGlossary = async (chapterMap) => {
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
        const biGrams = getMostCommonNGrams(words, 2, 25);
        const triGrams = getMostCommonNGrams(words, 3, 25);
        const formatList = (list) =>
            list.map(([term, count]) => ({
                term: term,
                context: getContext(fullText, term),
                count: count,
            }));
        const payload = JSON.stringify({
            bigrams: formatList(biGrams),
            trigrams: formatList(triGrams),
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
        const systemInstruction =
            "You are a helpful assistant that outputs only JSON.";
        const llmReply = await callAI(userPrompt, systemInstruction, true);

        const parsedResponse = JSON.parse(
            llmReply.replace(/```json|```/g, "").trim(),
        );
        const newTerms = parsedResponse.glossary || [];

        if (Array.isArray(newTerms) && newTerms.length > 0) {
            for (const item of newTerms) {
                if (item.term && item.suggested) {
                    glossary[item.term] = item.suggested;
                }
            }
            console.log(
                `    - ✅ Glossary generated with ${newTerms.length} terms.`,
            );
            writeLog("GLOSSARY", JSON.stringify(newTerms, null, 2));
        } else {
            console.log("    - ⚠️ No terms were suggested by the AI.");
        }
    } catch (error) {
        console.error("    - ❌ Failed to generate glossary:", error.message);
        writeLog(
            "ERROR",
            `Glossary Generation Failed: ${error.stack || error.message}`,
        );
    }
    console.log("    - Glossary generation step completed.\n");
    return glossary;
};

// =================== 7. 任务队列初始化 ===================

const batchQueue = new Queue(
    async (task, cb) => {
        const { batch, chapterTitle, $parent, glossary } = task;
        const MAX_ATTEMPTS = 3;

        let attempts = 0;
        let success = false;

        const glossaryMarkdown =
            glossary && Object.keys(glossary).length > 0
                ? `\nGLOSSARY (Strictly follow these translations):\n${Object.entries(
                      glossary,
                  )
                      .map(([en, zh]) => `- ${en}: ${zh}`)
                      .join("\n")}\n`
                : "";

        while (!success && attempts < MAX_ATTEMPTS) {
            try {
                attempts++;

                const batchInput = batch
                    .map((n) => {
                        let content = n.content;

                        const mergeRegex =
                            /([A-Za-z])<(small|span|strong|em)[^>]*>([\s\S]*?)<\/\2>/gi;

                        let preProcessedContent = content.replace(
                            mergeRegex,
                            (match, p1, p2, p3) => {
                                if (!p3.includes("<")) {
                                    return p1 + p3;
                                }
                                return match;
                            },
                        );

                        return `<node id="${n.id}">${preProcessedContent}</node>`;
                    })
                    .join("\n");

                const prompt = `
TASK: Translate the content of each <node> into ${CONFIG.targetLanguage}.

CONTEXT: Book Chapter "${chapterTitle}".
Use glossary information when translating.
${glossaryMarkdown}
${STYLE_GUIDE}

🛑 RULES:
1. Return each node as: <node id="node_x">translated text</node>
2. Keep inline tags (<a>, <strong>, </node> etc.) intact.
                `;

                const rawResponse = await callAI(batchInput, prompt, false);

                for (const node of batch) {
                    const nodeRegex = new RegExp(
                        `<node id="${node.id}">([\\s\\S]*?)<\/node>`,
                        "i",
                    );
                    const match = rawResponse.match(nodeRegex);
                    if (match && match[1]) {
                        const translatedContent = match[1].trim();

                        try {
                            cheerio.load(translatedContent, { xmlMode: true });
                            $parent(`[data-t-id="${node.id}"]`)
                                .html(translatedContent)
                                .removeAttr("data-t-id");
                        } catch (xmlError) {
                            writeLog(
                                "ERROR",
                                `Node ${node.id} XHTML Validation Failed: ${xmlError.message}`,
                            );
                        }
                    }
                }

                success = true;
                cb(null);
            } catch (e) {
                writeLog(
                    "ERROR",
                    `Batch Queue Attempt ${attempts} Failed: ${e.stack || e.message}`,
                );
                if (attempts >= MAX_ATTEMPTS) cb(e);
                else await new Promise((r) => setTimeout(r, 2000));
            }
        }
    },
    { concurrent: CONFIG[CURRENT_PROVIDER].concurrency, maxRetries: 0 },
);

// =================== 8. 翻译 HTML 内容 ===================
const translateHtmlContent = async (htmlContent, chapterTitle, glossary) => {
    const $ = cheerio.load(htmlContent, {
        xmlMode: true,
        decodeEntities: false,
    });
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

    if (nodesToTranslate.length === 0) return $.html();
    const BATCH_SIZE_LIMIT = 5000;

    const processInBatches = async (nodeList) => {
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

        const promises = batches.map((batch) => {
            return new Promise((resolve) => {
                batchQueue
                    .push({ batch, chapterTitle, $parent: $, glossary })
                    .on("finish", () => resolve())
                    .on("failed", (err) => {
                        writeLog("ERROR", `Batch Task Failed: ${err?.message}`);
                        resolve();
                    });
            });
        });
        await Promise.all(promises);
    };

    await processInBatches(nodesToTranslate);

    let retryRound = 1;
    const MAX_RETRY_ROUNDS = 3;

    while (retryRound <= MAX_RETRY_ROUNDS) {
        const failedNodes = [];
        $("[data-t-id]").each((_, el) => {
            failedNodes.push({
                id: $(el).attr("data-t-id"),
                content: $(el).html(),
            });
        });

        if (failedNodes.length === 0) break;

        console.log(
            `    - ⚠️ Retrying ${failedNodes.length} invalid XHTML nodes (Round ${retryRound}/${MAX_RETRY_ROUNDS})...`,
        );

        writeLog(
            "RETRY_INFO",
            `Round ${retryRound} - Retrying nodes:\n${failedNodes.map((n) => `ID: ${n.id} | Content: ${n.content.substring(0, 100)}...`).join("\n")}`,
        );

        await processInBatches(failedNodes);
        retryRound++;
    }

    $("[data-t-id]").removeAttr("data-t-id");
    return $.html();
};

// =================== 9. 核心步骤函数 ===================

const performTranslation = async (sortedChapters, chapterMap, glossary) => {
    console.log("\n✍️ Step 4: Translating Book Content...");
    const chaptersToProcess = sortedChapters.slice(
        0,
        TEST_MODE_LIMIT || sortedChapters.length,
    );
    for (let i = 0; i < chaptersToProcess.length; i++) {
        const ch = chaptersToProcess[i];
        if (ch.isTOC) continue;
        console.log(
            `🚀 [${i + 1}/${chaptersToProcess.length}] Processing Chapter: "${ch.title}"`,
        );
        try {
            const translatedHtml = await translateHtmlContent(
                ch.html,
                ch.title,
                glossary,
            );
            if (chapterMap.has(ch.id))
                chapterMap.get(ch.id).html = translatedHtml;
        } catch (e) {
            writeLog(
                "ERROR",
                `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
            );
        }
    }
};

const standardizeHeadingFormats = async (chapterMap) => {
    console.log("\n🧐 Step 5: Standardizing Heading Formats...");

    const headingSelectors = "h1, h2, h3, h4, h5, h6";
    const uniqueHeadings = new Set();

    // 1. Extract original HTML fragments
    for (const { html } of chapterMap.values()) {
        const $temp = cheerio.load(html, {
            xmlMode: true,
            decodeEntities: false,
        });
        $temp(headingSelectors).each((_, el) => {
            const htmlContent = $temp(el).html()?.trim();
            if (htmlContent) uniqueHeadings.add(htmlContent);
        });
    }

    if (uniqueHeadings.size === 0) {
        console.log("ℹ️ No headings found to process.");
        return;
    }

    let corrections = {};
    const prompt = `Role: XHTML Copy Editor. Task: STANDARDIZE HEADING FORMATS ONLY.

STRICT CONSTRAINTS:

    NO translation, paraphrasing, or rewriting. Original text must be preserved character-for-character.

    Only modify: Structural markers (numbering/prefixes) and Hierarchy consistency.

    Whitespace Normalization:

        REMOVE: Leading/trailing spaces, \t, \n, \r, and repeated spaces.

        KEEP: Single spaces between English words or meaningful title spacing.

    XHTML: Use self-closing tags (e.g.,

    ).

TASK RULES:

    Unify style for same-level headings (e.g., consistency in "Chapter X" vs "Chapter X").

    Do NOT introduce new language styles or translate (e.g., keep English as English).
Example:
Input:
["old_title_1", "old_title_2", "old_title_3"]

Output:
{
  "old_title_1": "new_title_1",
  "old_title_2": "new_title_2",
  "old_title_3": "new_title_3"
}
`;

    for (let attempts = 1; attempts <= 3; attempts++) {
        try {
            const responseText = await callAI(
                JSON.stringify([...uniqueHeadings]),
                prompt,
                true,
            );

            const cleanJson = JSON.parse(
                responseText.replace(/```json|```/g, "").trim(),
            );

            corrections = Object.entries(cleanJson).reduce(
                (acc, [key, value]) => {
                    acc[key] = validateAndFixXHTML(value);
                    return acc;
                },
                {},
            );

            break;
        } catch (error) {
            writeLog("ERROR", `Attempt ${attempts} failed: ${error.message}`);
            if (attempts === 3) {
                console.log(
                    "❌ Failed to get AI corrections after 3 attempts.",
                );
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    // 2. Apply corrections and log results
    let totalUpdatedHeadings = 0;
    let modifiedChapters = 0;

    for (const [chapterId, data] of chapterMap.entries()) {
        const $html = cheerio.load(data.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        let isChanged = false;
        let chapterChanges = [];

        $html(headingSelectors).each((_, el) => {
            const $el = $html(el);
            const originalHtml = $el.html()?.trim();
            const correctedHtml = corrections[originalHtml];

            if (correctedHtml && originalHtml !== correctedHtml) {
                $el.empty().append(correctedHtml);
                isChanged = true;
                totalUpdatedHeadings++;
                chapterChanges.push(
                    `  [${el.tagName.toUpperCase()}] "${originalHtml}" -> "${correctedHtml}"`,
                );
            }
        });

        if (isChanged) {
            data.html = $html.xml();
            modifiedChapters++;
            console.log(`✅ Chapter [${chapterId}] updated:`);
            chapterChanges.forEach((log) => console.log(log));
        }
    }

    console.log(
        `\n✨ Standardization Complete: Updated ${totalUpdatedHeadings} headings across ${modifiedChapters} chapters.`,
    );
};

const validateAndFixXHTML = (htmlFragment) => {
    if (!htmlFragment) return "";

    const preFixed = htmlFragment
        .replace(/<br>(?!\s*<\/br>)/gi, "<br/>")
        .replace(/<hr>(?!\s*<\/hr>)/gi, "<hr/>")
        .replace(/<img>(?!\s*<\/img>)/gi, "<img/>");

    try {
        const $ = cheerio.load(preFixed, {
            xmlMode: true,
            decodeEntities: false,
        });
        // Use $.xml() to get valid XHTML; trim to avoid extra newlines
        return $.xml().trim();
    } catch (e) {
        console.error("XHTML Fix Failed:", e);
        return htmlFragment.replace(/<[^>]*>/g, "");
    }
};

const getTitleById = ($doc, id) => {
    if (!id) return null;
    const $el = $doc(`#${id}`);
    if ($el.length === 0) return null;

    // 1. 获取当前标签文字
    let text = $el.text().trim();

    // 2. 如果当前标签没字（如 <a id="ch1"></a>），找其内部或紧随其后的标题
    if (!text) {
        const heading = $el.find("h1, h2, h3, h4, h5, h6").first();
        text =
            heading.length > 0
                ? heading.text().trim()
                : $el.nextAll("h1, h2, h3, h4").first().text().trim();
    }

    // 3. 如果还是没字，尝试找包含该 ID 的父级标题（如 <h1><span id="x"></span></h1>）
    if (!text) {
        text = $el.closest("h1, h2, h3, h4, h5, h6").text().trim();
    }

    return text;
};

export const synchronizeTocHtml = async (chapterMap, tocId) => {
    if (!tocId || !chapterMap.has(tocId)) return;

    console.log("\n🔗 Step 6: Synchronizing HTML TOC (Smart Anchor)...");

    try {
        const tocData = chapterMap.get(tocId);
        const $toc = cheerio.load(tocData.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        const allChapters = [...chapterMap.values()];

        $toc("a[href]").each((_, el) => {
            const $a = $toc(el);
            const rawHref = $a.attr("href");
            if (!rawHref) return;

            const [fileName, anchor] = rawHref.split("#");
            const targetChapter = allChapters.find(
                (ch) => path.basename(ch.href) === fileName,
            );

            if (targetChapter && targetChapter.id !== tocId) {
                const $targetDoc = cheerio.load(targetChapter.html);

                // 优先根据锚点同步，失败则回退至首个标题
                const title =
                    getTitleById($targetDoc, anchor) ||
                    $targetDoc("h1, h2, h3").first().text().trim();

                if (title) $a.text(title);
            }
        });

        tocData.html = $toc.html();
    } catch (e) {
        console.error(`HTML TOC Sync Failed: ${e.message}`);
    }
};

export const synchronizeNcx = async (chapterMap, zipEntries) => {
    console.log("\n🔗 Step 7: Synchronizing NCX Metadata (Smart Anchor)...");

    try {
        const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
        if (!ncxEntry) return { ncxEntry: null, ncxContent: "" };

        const ncxContent = ncxEntry.getData().toString("utf8");
        const $ncx = cheerio.load(ncxContent, {
            xmlMode: true,
            decodeEntities: false,
        });
        const allChapters = [...chapterMap.values()];

        $ncx("navPoint").each((_, el) => {
            const $navPoint = $ncx(el);
            const src = $navPoint.find("content").attr("src");
            if (!src) return;

            const [fileName, anchor] = src.split("#");
            const targetData = allChapters.find(
                (ch) => path.basename(ch.href) === fileName,
            );

            if (targetData) {
                const $targetDoc = cheerio.load(targetData.html);

                const title =
                    getTitleById($targetDoc, anchor) ||
                    $targetDoc("h1, h2, h3, h4").first().text().trim();

                if (title) {
                    $navPoint.find("navLabel > text").first().text(title);
                }
            }
        });

        return { ncxEntry, ncxContent: $ncx.xml() };
    } catch (e) {
        console.error(`NCX Sync Failed: ${e.message}`);
        return { ncxEntry: null, ncxContent: "" };
    }
};

const saveEpub = async (zip, chapterMap, ncxEntry, ncxContent) => {
    console.log(`\n💾 Step 8: Finalizing and Saving...`);
    try {
        for (const [id, data] of chapterMap.entries()) {
            zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
        }
        if (ncxEntry && ncxContent)
            zip.updateFile(ncxEntry.entryName, Buffer.from(ncxContent, "utf8"));
        zip.writeZip(outputPath);
        console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
    } catch (e) {
        writeLog("ERROR", `Save EPUB Failed: ${e.stack || e.message}`);
        throw e;
    }
};

// =================== 10. 主流程 ===================
const main = async () => {
    initClient();
    console.log(`\n========================================`);
    console.log(`📖 Input: ${path.basename(inputPath)}`);
    console.log(`========================================\n`);
    try {
        // Step 1: 读取 EPUB 内容
        console.log("📖 Step 1: Reading EPUB Content...");
        const zip = new AdmZip(inputPath);
        const epub = await EPub.createAsync(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = new Map();
        const rawChapters = epub.flow.map((chapter) => {
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
                title: chapter.title || extractHeading(html) || "Untitled",
            };
            if (data.entryName) chapterMap.set(data.id, data);
            return data;
        });

        // Step 2: 制定翻译计划
        console.log("📖 Step 2: Planning Translation Order...");
        const { sorted: sortedChapters, tocId } =
            await planTranslationOrder(rawChapters);

        // Step 3: 生成术语表
        // const glossary = await generateInitialGlossary(chapterMap);

        // Step 4: 执行翻译
        await performTranslation(sortedChapters, chapterMap, glossary);

        // Step 5: 标题标准化
        await standardizeHeadingFormats(chapterMap);

        // Step 6: 同步 HTML 目录
        await synchronizeTocHtml(chapterMap, tocId);

        // Step 7: 同步 NCX 元数据
        const { ncxEntry, ncxContent } = await synchronizeNcx(
            chapterMap,
            zipEntries,
        );

        // Step 8: 保存文件
        await saveEpub(zip, chapterMap, ncxEntry, ncxContent);
    } catch (e) {
        writeLog("ERROR", `Main Process Fatal Error: ${e.stack || e.message}`);
        console.error("Fatal error occurred. Check logs for details.");
    }
};

main();
