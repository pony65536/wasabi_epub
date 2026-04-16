import Queue from "better-queue";
import * as cheerio from "cheerio";
import { cleanAIResponse } from "../utils.js";

const previewText = (text, maxLength = 300) => {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
};

// =================== 批处理队列工厂 ===================
export const createBatchQueue = (aiProvider, logger) => {
    const queue = new Queue(
        async (task, cb) => {
            const { batch, $parent, processor } = task;
            const resolvedPrompt =
                typeof processor.prompt === "function"
                    ? processor.prompt(batch)
                    : processor.prompt;
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
                            resolvedPrompt,
                            false,
                        ),
                    );

                    const $response = cheerio.load(
                        `<root>${rawResponse}</root>`,
                        { xmlMode: true, decodeEntities: false },
                    );
                    const updates = [];
                    const missingNodeIds = [];

                    for (const node of batch) {
                        const $node = $response(`node[id="${node.id}"]`);

                        if ($node.length === 0) {
                            missingNodeIds.push(node.id);
                            continue;
                        }

                        const processedContent = $node.html()?.trim();
                        if (!processedContent) {
                            missingNodeIds.push(node.id);
                            continue;
                        }

                        try {
                            cheerio.load(processedContent, { xmlMode: true });
                            updates.push({ nodeId: node.id, processedContent });
                        } catch (xmlError) {
                            const invalidHtmlError = new Error(
                                `Node ${node.id} invalid HTML: ${xmlError.message}`,
                            );
                            invalidHtmlError.responsePreview =
                                previewText(rawResponse);
                            throw invalidHtmlError;
                        }
                    }

                    if (missingNodeIds.length > 0) {
                        const missingError = new Error(
                            `Batch response incomplete. Missing or empty nodes: ${missingNodeIds.join(", ")}`,
                        );
                        missingError.responsePreview = previewText(rawResponse);
                        throw missingError;
                    }

                    for (const update of updates) {
                        const $target = $parent(
                            `[${processor.attrName}="${update.nodeId}"]`,
                        );
                        if ($target.length === 0) {
                            const targetMissingError = new Error(
                                `Node ${update.nodeId} could not be written back to the document.`,
                            );
                            targetMissingError.responsePreview =
                                previewText(rawResponse);
                            throw targetMissingError;
                        }
                        $target
                            .html(update.processedContent)
                            .removeAttr(processor.attrName);
                    }

                    success = true;
                    cb(null);
                } catch (e) {
                    logger.write(
                        "ERROR",
                        `Batch Queue Attempt ${attempts} Failed: ${e.stack || e.message}${e.responsePreview ? `\nResponse Preview: ${e.responsePreview}` : ""}`,
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
            const isIdle = () => queue._running === 0 && queue.length === 0;
            if (isIdle()) return resolve();
            queue.once("drain", resolve);
        });

    return { queue, drainQueue };
};

// =================== 通用批处理逻辑 ===================
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
                    .on("finish", () => resolve({ ok: true, batch }))
                    .on("failed", (err) => {
                        logger.write(
                            "ERROR",
                            `Batch Task Failed: ${err?.message}`,
                        );
                        resolve({ ok: false, batch, error: err });
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

export const processHtmlBatch = async (
    $,
    nodeList,
    processor,
    batchQueue,
    logger,
) => {
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
