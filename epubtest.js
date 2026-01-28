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
const CURRENT_PROVIDER = "mimo";

const TEST_MODE_LIMIT = 1; // Set to null to process the entire book

const CONFIG = {
    targetLanguage: "Chinese (Simplified)",
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
        modelName: "gemini-2.5-pro",
        concurrency: 1,
    },
    qwen: {
        apiKey: process.env.DASHSCOPE_API_KEY,
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

    GOAL: Reorder the processing list to follow this logic:
    1. **MAIN CONTENT FIRST**: Chapters like "Chapter 1", "Chapter 2", "The Rise of VISA", etc.
    2. **FRONT/BACK MATTER LAST**: "Preface", "Introduction", "Foreword", "Copyright", "Dedication".

    REASON: Translating the main content first builds the context glossary, which improves the quality of the Preface/Introduction translation later.

    INPUT: A JSON list of chapters.
    OUTPUT: A JSON object containing a single array "order" with the "id"s sorted in the best processing order.

    Example Output Format:
    {
        "order": ["item3", "item4", "item5", "item1", "item2"]
    }
    `;

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
                chapterMap.delete(id);
                return ch;
            });
        return [...ordered, ...chapterMap.values()];
    } catch (e) {
        console.error("Agent failed, using default order.");
        return chapters;
    }
};

// =================== 6. 任务队列初始化 (带内容查看) ===================

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
                    } else {
                        $parent(`[data-t-id="${node.id}"]`).removeAttr(
                            "data-t-id",
                        );
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
                    } catch (e) {
                        // Ignore glossary parse errors
                    }
                }

                success = true;
                cb(null);
            } catch (e) {
                if (attempts >= MAX_ATTEMPTS) {
                    console.error(
                        `\n🚨 BATCH FAILED AFTER ${MAX_ATTEMPTS} ATTEMPTS`,
                    );
                    console.error(`📍 Chapter: "${chapterTitle}"`);
                    console.error(`❌ Error: ${e.message}`);

                    // 打印出失败 Batch 的原文预览
                    const preview = batch
                        .map((n) => n.content)
                        .join(" ")
                        .substring(0, 300);
                    console.log(
                        `📝 SKIPPED CONTENT PREVIEW:\n"${preview}..."\n`,
                    );

                    batch.forEach((n) =>
                        $parent(`[data-t-id="${n.id}"]`).removeAttr(
                            "data-t-id",
                        ),
                    );
                    cb(e);
                } else {
                    console.warn(
                        `      ⚠️ Attempt ${attempts} failed for batch in "${chapterTitle}", retrying...`,
                    );
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

    const BATCH_SIZE_LIMIT = 4000;
    const batches = [];
    let currentBatch = [];
    let currentLength = 0;

    for (const node of nodesToTranslate) {
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

    const batchPromises = batches.map((batch) => {
        return new Promise((resolve) => {
            batchQueue
                .push({ batch, chapterTitle, $parent: $ })
                .on("finish", () => resolve())
                .on("failed", () => resolve());
        });
    });

    await Promise.all(batchPromises);
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

    const sortedChapters = await planTranslationOrder(rawChapters);
    return { chapterMap, sortedChapters };
}

async function performTranslation(sortedChapters, chapterMap) {
    console.log("\n✍️ Step 2: Translating Book Content (Batch Queue Mode)...");
    const chaptersToProcess = sortedChapters.slice(
        0,
        TEST_MODE_LIMIT || sortedChapters.length,
    );

    for (let i = 0; i < chaptersToProcess.length; i++) {
        const ch = chaptersToProcess[i];
        console.log(
            `🚀 [${i + 1}/${chaptersToProcess.length}] Processing Chapter: "${ch.title}"`,
        );
        const translatedHtml = await translateHtmlContent(ch.html, ch.title);
        if (chapterMap.has(ch.id)) {
            chapterMap.get(ch.id).html = translatedHtml;
        }
    }
}

async function synchronizeHeadings(chapterMap, zipEntries) {
    console.log("\n🧐 Step 3: Synchronizing Headings (Strong Binding)...");

    const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
    let ncxContent = "";
    let $ncx = null;

    if (ncxEntry) {
        ncxContent = ncxEntry.getData().toString("utf8");
        $ncx = cheerio.load(ncxContent, {
            xmlMode: true,
            decodeEntities: false,
        });
    }

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
        try {
            const responseText = await callAI(
                JSON.stringify(Array.from(uniqueHeadings)),
                prompt,
                true,
            );
            corrections = JSON.parse(
                responseText.replace(/```json|```/g, "").trim(),
            );
        } catch (e) {
            console.warn("    ⚠️ Heading AI standardization failed.");
        }
    }

    for (const [id, data] of chapterMap) {
        const $html = cheerio.load(data.html, {
            xmlMode: true,
            decodeEntities: false,
        });
        let firstTitle = null;

        $html(headingSelectors).each((i, el) => {
            const original = $html(el).text().trim();
            const corrected = corrections[original] || original;
            if (original !== corrected) $html(el).text(corrected);
            if (i === 0) firstTitle = corrected;
        });

        data.html = $html.html();

        if ($ncx && firstTitle) {
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

    return {
        ncxEntry,
        ncxContent: $ncx ? $ncx.xml() : ncxContent,
    };
}

async function saveEpub(zip, chapterMap, ncxEntry, ncxContent) {
    console.log(`\n💾 Step 4: Finalizing and Saving...`);
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

    const { chapterMap, sortedChapters } = await analyzeStructure(
        epub,
        zipEntries,
    );
    await performTranslation(sortedChapters, chapterMap);
    const { ncxEntry, ncxContent } = await synchronizeHeadings(
        chapterMap,
        zipEntries,
    );
    await saveEpub(zip, chapterMap, ncxEntry, ncxContent);
};

main().catch(console.error);
