import "dotenv/config";
import { EPub } from "epub2";
import AdmZip from "adm-zip";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import { Mutex } from "async-mutex";
import Queue from "better-queue";

// =================== 0. ESM 环境兼容设置 ===================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =================== 1. 核心设置 ===================
const INPUT_FILE_NAME =
    "One from Many VISA and the Rise of Chaordic Organization (VISA InternationalHock, Dee) (Z-Library).epub";
const CURRENT_PROVIDER = "qwen";

const TEST_MODE_LIMIT = null; // Set to null to process the entire book

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

// =================== 2. 翻译风格 ===================

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

// =================== 3. 运行时一致性管理 ===================
const RUNTIME_GLOSSARY = {};
const glossaryMutex = new Mutex();

const getGlossaryPrompt = () => {
    const terms = Object.entries(RUNTIME_GLOSSARY);
    if (terms.length === 0) return "";
    const glossaryList = terms
        .slice(-200)
        .map(([en, zh]) => `    - "${en}" -> "${zh}"`)
        .join("\n");
    return `
    IMPORTANT: CONSISTENCY GLOSSARY (Strictly Adhere):
${glossaryList}
    `;
};

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
    try {
        if (CURRENT_PROVIDER === "gemini") {
            const result = await geminiModel.generateContent(
                `${systemInstruction}\n\nUser Input:\n${userContent}`,
            );
            return (await result.response).text().trim();
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
            return completion.choices[0].message.content.trim();
        }
    } catch (e) {
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
            console.warn(`Agent plan attempt ${attempts} failed. Retrying...`);
            if (attempts >= 3) {
                console.error(
                    "Agent failed after max retries, using default order.",
                );
                return { sorted: chapters, tocId: null };
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
};

// =================== 6. 任务队列初始化 ===================

const batchQueue = new Queue(
    async (task, cb) => {
        const { batch, chapterTitle, $parent } = task;
        const MAX_ATTEMPTS = 3;
        let attempts = 0;
        let success = false;

        while (!success && attempts < MAX_ATTEMPTS) {
            try {
                attempts++;
                const currentGlossaryPrompt = await glossaryMutex.runExclusive(
                    () => getGlossaryPrompt(),
                );
                const batchInput = batch
                    .map((n) => `<node id="${n.id}">${n.content}</node>`)
                    .join("\n");

                const prompt = `
TASK: Translate the content of each <node> into ${CONFIG.targetLanguage}.
CONTEXT: Book Chapter "${chapterTitle}".

${STYLE_GUIDE}
${currentGlossaryPrompt}

🛑 RULES:
1. Return each node as: <node id="node_x">translated text</node>
2. Keep inline tags (<a>, <strong>, etc.) intact.
3. If new terms are found, return them in: <glossary>{"English": "TargetLanguage"}</glossary>
            `;

                const rawResponse = await callAI(batchInput, prompt, false);
                const matchedResults = new Map();
                let nodesFoundCount = 0;

                for (const node of batch) {
                    const nodeRegex = new RegExp(
                        `<node id="${node.id}">([\\s\\S]*?)<\/node>`,
                        "i",
                    );
                    const match = rawResponse.match(nodeRegex);
                    if (match && match[1]) {
                        matchedResults.set(node.id, match[1].trim());
                        nodesFoundCount++;
                    }
                }

                if (nodesFoundCount < batch.length * 0.8) {
                    throw new Error(
                        `AI response corrupted. Found ${nodesFoundCount}/${batch.length} nodes.`,
                    );
                }

                for (const node of batch) {
                    const translatedText = matchedResults.get(node.id);
                    if (translatedText) {
                        $parent(`[data-t-id="${node.id}"]`)
                            .html(translatedText)
                            .removeAttr("data-t-id");
                    }
                }

                const glossaryMatch = rawResponse.match(
                    /<glossary>([\s\S]*?)<\/glossary>/i,
                );
                if (glossaryMatch) {
                    try {
                        const jsonStr = glossaryMatch[1]
                            .replace(/```json|```/g, "")
                            .trim();
                        const newTerms = JSON.parse(jsonStr);
                        if (Object.keys(newTerms).length > 0) {
                            await glossaryMutex.runExclusive(() => {
                                Object.assign(RUNTIME_GLOSSARY, newTerms);
                            });
                        }
                    } catch (e) {}
                }

                success = true;
                cb(null);
            } catch (e) {
                if (attempts >= MAX_ATTEMPTS) {
                    cb(e);
                } else {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        }
    },
    {
        concurrent: CONFIG[CURRENT_PROVIDER].concurrency,
        maxRetries: 0,
    },
);

// =================== 7. 翻译 HTML 内容 ===================

const translateHtmlContent = async (htmlContent, chapterTitle) => {
    const $ = cheerio.load(htmlContent, {
        xmlMode: true,
        decodeEntities: false,
    });

    const nodesToTranslate = [];
    $("p, li, h1, h2, h3, h4, h5, h6, caption, title").each((i, el) => {
        const $el = $(el);
        const originalHtml = $el.html().trim();
        if (originalHtml && originalHtml.length > 0) {
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
                    .push({ batch, chapterTitle, $parent: $ })
                    .on("finish", () => resolve())
                    .on("failed", () => resolve());
            });
        });
        await Promise.all(promises);
    };

    await processInBatches(nodesToTranslate);

    const failedNodes = [];
    $("[data-t-id]").each((_, el) => {
        failedNodes.push({
            id: $(el).attr("data-t-id"),
            content: $(el).html(),
        });
    });

    if (failedNodes.length > 0) {
        await processInBatches(failedNodes);
    }

    $("[data-t-id]").removeAttr("data-t-id");
    return $.html();
};

// =================== 8. 步骤封装函数 ===================

async function analyzeStructure(epub, zipEntries) {
    console.log("📖 Step 1: Analyzing Book Structure...");
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

    const { sorted, tocId } = await planTranslationOrder(rawChapters);
    return { chapterMap, sortedChapters: sorted, tocId };
}

async function performTranslation(sortedChapters, chapterMap) {
    console.log("\n✍️ Step 2: Translating Book Content...");
    const chaptersToProcess = sortedChapters.slice(
        0,
        TEST_MODE_LIMIT || sortedChapters.length,
    );

    for (let i = 0; i < chaptersToProcess.length; i++) {
        const ch = chaptersToProcess[i];
        if (ch.isTOC) {
            console.log(
                `🚀 [${i + 1}/${chaptersToProcess.length}] Skipping TOC for direct translation: "${ch.title}"`,
            );
            continue;
        }
        console.log(
            `🚀 [${i + 1}/${chaptersToProcess.length}] Processing Chapter: "${ch.title}"`,
        );
        const translatedHtml = await translateHtmlContent(ch.html, ch.title);
        if (chapterMap.has(ch.id)) {
            chapterMap.get(ch.id).html = translatedHtml;
        }
    }
}

// 拆分后的函数 1: 统一并标准化 HTML 中的标题格式
async function standardizeHeadingFormats(chapterMap) {
    console.log("\n🧐 Step 3: Standardizing Heading Formats in HTML...");
    const headingSelectors = "h1, h2, h3, h4, h5, h6";
    const uniqueHeadings = new Set();

    for (const data of chapterMap.values()) {
        const $temp = cheerio.load(data.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        $temp(headingSelectors).each((_, el) => {
            const txt = $temp(el).text().trim();
            if (txt) uniqueHeadings.add(txt);
        });
    }

    let corrections = {};
    if (uniqueHeadings.size > 0) {
        const prompt = `
You are a professional copy editor. Standardize chapter headings.
RULES: "Chapter X" -> "第X章" (Arabic numerals).
Example Input: ["第一章 开始", "第2章 中间", "Conclusion", "第3章<br/><br/>结束"]
Example Output: { "第一章 开始": "第1章 开始", "第2章 中间": "第2章 中间", "Conclusion": "Conclusion", "第3章<br/><br/>结束": "第3章 结束"}
        `;
        let attempts = 0;
        while (attempts < 3) {
            try {
                const responseText = await callAI(
                    JSON.stringify(Array.from(uniqueHeadings)),
                    prompt,
                    true,
                );
                corrections = JSON.parse(
                    responseText.replace(/```json|```/g, "").trim(),
                );
                break; // Success
            } catch (e) {
                attempts++;
                console.warn(
                    `Standardization attempt ${attempts} failed. Retrying...`,
                );
                if (attempts >= 3) {
                    console.error(
                        "Standardization AI failed after max retries, skipping formatting.",
                    );
                } else {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        }
    }

    for (const data of chapterMap.values()) {
        const $html = cheerio.load(data.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        let changed = false;
        $html(headingSelectors).each((_, el) => {
            const original = $html(el).text().trim();
            const corrected = corrections[original] || original;
            if (original !== corrected) {
                $html(el).text(corrected);
                changed = true;
            }
        });
        if (changed) data.html = $html.html();
    }
}

// 拆分后的函数 2: 同步 NCX 目录文件
async function synchronizeNcx(chapterMap, zipEntries) {
    console.log("\n🔗 Step 5: Synchronizing NCX Metadata...");
    const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
    if (!ncxEntry) return { ncxEntry: null, ncxContent: "" };

    const ncxContent = ncxEntry.getData().toString("utf8");
    const $ncx = cheerio.load(ncxContent, {
        xmlMode: true,
        decodeEntities: false,
    });
    const headingSelectors = "h1, h2, h3, h4, h5, h6";

    for (const [id, data] of chapterMap) {
        const $html = cheerio.load(data.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        const firstTitle = $html(headingSelectors).first().text().trim();

        if (firstTitle) {
            let $nav = $ncx(`navPoint[id="${id}"]`);
            if ($nav.length === 0) {
                const fn = path.basename(data.href);
                $nav = $ncx(`navPoint`).filter((_, el) =>
                    $ncx(el).find("content").attr("src")?.includes(fn),
                );
            }
            if ($nav.length > 0)
                $nav.find("navLabel > text").first().text(firstTitle);
        }
    }
    return { ncxEntry, ncxContent: $ncx.xml() };
}

async function synchronizeTocHtml(chapterMap, tocId) {
    if (!tocId || !chapterMap.has(tocId)) return;
    console.log("\n🔗 Step 4: Synchronizing HTML TOC via Hrefs...");

    const tocData = chapterMap.get(tocId);
    const $toc = cheerio.load(tocData.html, {
        xmlMode: true,
        decodeEntities: false,
    });
    const allChapters = Array.from(chapterMap.values());

    $toc("a[href]").each((_, el) => {
        const $a = $toc(el);
        const href = $a.attr("href");
        const targetChapter = allChapters.find((ch) =>
            href.includes(path.basename(ch.href)),
        );

        if (targetChapter && targetChapter.id !== tocId) {
            const $temp = cheerio.load(targetChapter.html);
            const translatedTitle = $temp("h1, h2, h3").first().text().trim();
            if (translatedTitle) {
                $a.text(translatedTitle);
            }
        }
    });
    tocData.html = $toc.html();
}

async function saveEpub(zip, chapterMap, ncxEntry, ncxContent) {
    console.log(`\n💾 Step 6: Finalizing and Saving...`);
    for (const [id, data] of chapterMap.entries()) {
        zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
    }
    if (ncxEntry)
        zip.updateFile(ncxEntry.entryName, Buffer.from(ncxContent, "utf8"));

    zip.writeZip(outputPath);
    console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
}

// =================== 9. 主流程 ===================
const main = async () => {
    initClient();
    console.log(`\n========================================`);
    console.log(`📖 Input: ${path.basename(inputPath)}`);
    console.log(`========================================\n`);

    const zip = new AdmZip(inputPath);
    const epub = await EPub.createAsync(inputPath);
    const zipEntries = zip.getEntries();

    const { chapterMap, sortedChapters, tocId } = await analyzeStructure(
        epub,
        zipEntries,
    ); // 1. 翻译全文内容

    await performTranslation(sortedChapters, chapterMap); // 2. 标准化标题格式 (第X章)

    await standardizeHeadingFormats(chapterMap); // 3. 同步 HTML 内的目录链接

    await synchronizeTocHtml(chapterMap, tocId); // 4. 同步 NCX 元数据

    const { ncxEntry, ncxContent } = await synchronizeNcx(
        chapterMap,
        zipEntries,
    ); // 5. 保存

    await saveEpub(zip, chapterMap, ncxEntry, ncxContent);
};

main().catch(console.error);
