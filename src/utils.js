import * as cheerio from "cheerio";
import Queue from "better-queue";

// =================== 7. AI 响应清洗工具 ===================
/**
 * 清洗 AI 返回内容中的 Markdown 代码块包裹。
 */
export const cleanAIResponse = (raw) => {
    return raw
        .replace(/```[\w]*\n?/g, "")
        .replace(/```/g, "")
        .trim();
};

// =================== 8. 批处理队列工厂 ===================
export const createBatchQueue = (aiProvider, logger) => {
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

                    const rawResponse = cleanAIResponse(
                        await aiProvider.callAI(
                            batchInput,
                            processor.prompt,
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
                                `Node ${node.id} missing from AI response, will retry.`,
                            );
                            continue;
                        }

                        const processedContent = $node.html()?.trim();
                        if (!processedContent) continue;

                        try {
                            cheerio.load(processedContent, { xmlMode: true });
                            $parent(`[${processor.attrName}="${node.id}"]`)
                                .html(processedContent)
                                .removeAttr(processor.attrName);
                        } catch (xmlError) {
                            logger.write(
                                "ERROR",
                                `Node ${node.id} invalid HTML: ${xmlError.message}`,
                            );
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

export const splitIntoBatches = (nodeList) => {
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

export const dispatchBatches = (batches, $, processor, batchQueue, logger) =>
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

export const collectFailedNodes = ($, attrName) => {
    const failed = [];
    $(`[${attrName}]`).each((_, el) => {
        failed.push({ id: $(el).attr(attrName), content: $(el).html() });
    });
    return failed;
};

export const processHtmlBatch = async ($, nodeList, processor, batchQueue, logger) => {
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
export const CHEERIO_OPTIONS = { xmlMode: true, decodeEntities: false };

export const loadHtml = (html) => cheerio.load(html, CHEERIO_OPTIONS);

export const extractFirstHeading = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    const heading = $("h1, h2").first();
    if (heading.length > 0) return heading.text().replace(/\s+/g, " ").trim();
    const titleTag = $("title").text();
    return titleTag ? titleTag.trim() : null;
};

export const resolveAnchorTitle = ($doc, anchor) => {
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
export const normalizeHref = (href) =>
    decodeURIComponent(href || "")
        .split("#")[0]
        .replace(/^\.\//, "")
        .replace(/\\/g, "/")
        .toLowerCase()
        .trim();

export const buildHrefIndex = (chapterMap) => {
    const index = new Map();
    for (const data of chapterMap.values()) {
        if (!data.href) continue;
        index.set(normalizeHref(data.href), data);
    }
    return index;
};

// =================== 12. 带重试的 JSON AI 调用工具 ===================
export const callAIWithRetry = async (
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
