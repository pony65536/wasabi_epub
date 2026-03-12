import Queue from "better-queue";
import * as cheerio from "cheerio";
import { CONFIG } from "./config.js";
import { loadHtml, cleanAIResponse, callAIWithRetry } from "./utils.js";
import { splitIntoBatches } from "./batchQueue.js";

export const HEADING_SELECTORS = "h1, h2, h3, h4, h5, h6";

// =================== 标题格式分析 ===================
export const analyzeHeadingFormats = async (chapterMap, aiProvider, logger) => {
    console.log("\n🔍 Step 2: Analyzing heading format examples...");

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

// =================== 标题标准化 ===================
export const standardizeHeadingsByRules = async (
    chapterMap,
    headingExamples,
    aiProvider,
    batchQueue,
    logger,
) => {
    if (!headingExamples || headingExamples.length === 0) {
        console.log(
            "\n⏭️ Step 5: No format rules available, skipping standardization.",
        );
        return;
    }

    console.log(
        "\n🧹 Step 5: Post-translation heading standardization (AI)...",
    );

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
2. Keep inline tags (<node/>, </a>, <strong>, <em>, <sup>, <span> etc.) intact.
3. Do NOT translate or rephrase any text content.
4. Only adjust numbering prefixes, punctuation markers, or whitespace to match the format rule for that heading's level.
5. Trim edges; collapse internal spaces to a single space; remove all newlines or tabs.`,
    };

    let globalNodeIndex = 0;
    const chapterDomMap = new Map();
    const allNodes = [];

    for (const [chapterId, data] of chapterMap.entries()) {
        const $ = loadHtml(data.html);
        chapterDomMap.set(chapterId, $);

        $(HEADING_SELECTORS).each((_, el) => {
            const $el = $(el);
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
                        { xmlMode: true, decodeEntities: false },
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

    const pushBatch = (batch) =>
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
        });

    await Promise.all(batches.map(pushBatch));
    await drainWriteBackQueue();

    // 重试残留节点
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
        await Promise.all(splitIntoBatches(failedNodes).map(pushBatch));
        await drainWriteBackQueue();
    }

    // 清理残留属性并写回
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
