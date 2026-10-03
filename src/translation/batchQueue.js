import Queue from "better-queue";
import * as cheerio from "cheerio";
import { cleanAIResponse } from "../utils.js";
import {
    encodeInlineTags,
    decodeInlineTagsDetailed,
} from "../content/inlineSlots.js";
import { shouldTriggerCritic, reviewAndCorrectNode } from "../content/critic.js";
import { validateProtectedStructure } from "./structureGuard.js";
import { classifyProviderError } from "./aiProvider.js";
import { computeTextDigest } from "../support/taskIdentity.js";

const previewText = (text, maxLength = 300) => {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
};

const TRANSLATION_NOTE_PATTERNS = [
    /^[（(]?\s*(?:注|NOTE)\s*[:：]/i,
    /\bnode[_\s-]?\d+\b/i,
    /\bsid\b/i,
    /(?:按规则|严格保留|不合并|不调整|原文此处编号有误)/,
];

const normalizeNodeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const extractTextFromFragment = (html) =>
    normalizeNodeText(cheerio.load(`<root>${String(html ?? "")}</root>`, { xmlMode: true }).text());

const shouldUseSingleNodePlainTextFallback = (batch, rawResponse) => {
    if (!Array.isArray(batch) || batch.length !== 1) return false;
    const normalized = String(rawResponse ?? "").trim();
    if (!normalized) return false;
    if (/<node\b/i.test(normalized)) return false;
    return true;
};

const isTranslationMetaNote = (value) => {
    const normalized = normalizeNodeText(value);
    if (!normalized) return false;
    const matchCount = TRANSLATION_NOTE_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
    if (matchCount >= 2) return true;
    if (matchCount >= 1 && normalized.length <= 120 && ["（", "(", "["].includes(normalized.slice(0, 1))) {
        return true;
    }
    return false;
};

// =================== 批处理队列工厂 ===================
export const createBatchQueue = (aiProvider, logger) => {
    const queue = new Queue(
        async (task, cb) => {
            const { batch, $parent, processor, onTaskSuccess, onTaskFailure } = task;
            const resolvedPrompt =
                batch.length === 1 && processor.singleNodePrompt
                    ? typeof processor.singleNodePrompt === "function"
                        ? processor.singleNodePrompt(batch[0])
                        : processor.singleNodePrompt
                    : typeof processor.prompt === "function"
                      ? processor.prompt(batch)
                      : processor.prompt;
            const MAX_ATTEMPTS = 3;
            let attempts = 0;
            let success = false;

            while (!success && attempts < MAX_ATTEMPTS) {
                try {
                    attempts++;

                    // 对每个节点的行内排版标签进行占位符安全编码（不再做有损标签合并）
                    const nodeSlotMetadata = new Map();
                    const encodeNode = (content) => {
                        const encoded = encodeInlineTags(content);
                        if (encoded.incomplete) {
                            const incompleteError = new Error(
                                "Inline tag encoding incomplete; aborting batch before sending.",
                            );
                            incompleteError.responsePreview = previewText(content);
                            throw incompleteError;
                        }
                        return encoded;
                    };
                    const batchInput =
                        batch.length === 1 && processor.singleNodePrompt
                            ? (() => {
                                  const encoded = encodeNode(batch[0].content);
                                  nodeSlotMetadata.set(batch[0].id, encoded);
                                  return encoded.encodedText;
                              })()
                            : batch
                                  .map((n) => {
                                      const encoded = encodeNode(n.content);
                                      nodeSlotMetadata.set(n.id, encoded);
                                      return `<node id="${n.id}">${encoded.encodedText}</node>`;
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
                    const singleNodePlainTextFallback =
                        shouldUseSingleNodePlainTextFallback(batch, rawResponse)
                            ? String(rawResponse ?? "").trim()
                            : null;

                    // 统一校验出口：slot 完整性 + 受保护结构（id/href/class/嵌套）
                    const restoreAndValidate = (node, translatedFragment) => {
                        const slotInfo = nodeSlotMetadata.get(node.id);
                        if (!slotInfo) {
                            const guard = validateProtectedStructure(
                                node.content,
                                translatedFragment,
                            );
                            if (!guard.ok) {
                                const structureError = new Error(
                                    `Node ${node.id} protected structure changed: ${JSON.stringify({
                                        missing: guard.missingAttributes,
                                        unexpected: guard.unexpectedAttributes,
                                        missingNesting: guard.missingNesting,
                                        unexpectedNesting: guard.unexpectedNesting,
                                    })}`,
                                );
                                structureError.responsePreview =
                                    previewText(translatedFragment);
                                throw structureError;
                            }
                            return translatedFragment;
                        }

                        const decoded = decodeInlineTagsDetailed(
                            translatedFragment,
                            slotInfo.slotMap,
                            slotInfo.slotTag,
                        );
                        if (
                            decoded.missingSlots.length > 0 ||
                            decoded.unknownSlots.length > 0 ||
                            decoded.duplicateSlots.length > 0 ||
                            decoded.residualSlots > 0
                        ) {
                            const slotError = new Error(
                                `Node ${node.id} slot integrity failed: missing=${decoded.missingSlots.join(",")} unknown=${decoded.unknownSlots.join(",")} duplicate=${decoded.duplicateSlots.join(",")} residual=${decoded.residualSlots}`,
                            );
                            slotError.responsePreview =
                                previewText(translatedFragment);
                            throw slotError;
                        }

                        const guard = validateProtectedStructure(
                            node.content,
                            decoded.html,
                        );
                        if (!guard.ok) {
                            const structureError = new Error(
                                `Node ${node.id} protected structure changed: ${JSON.stringify({
                                    missing: guard.missingAttributes,
                                    unexpected: guard.unexpectedAttributes,
                                    missingNesting: guard.missingNesting,
                                    unexpectedNesting: guard.unexpectedNesting,
                                })}`,
                            );
                            structureError.responsePreview =
                                previewText(translatedFragment);
                            throw structureError;
                        }
                        return decoded.html;
                    };

                    for (const node of batch) {
                        const $node = $response(`node[id="${node.id}"]`);

                        if ($node.length === 0) {
                            if (
                                singleNodePlainTextFallback !== null &&
                                batch.length === 1
                            ) {
                                const translatedPlainText = extractTextFromFragment(
                                    singleNodePlainTextFallback,
                                );
                                const sourcePlainText = extractTextFromFragment(
                                    node.content,
                                );
                                if (
                                    isTranslationMetaNote(translatedPlainText) &&
                                    !isTranslationMetaNote(sourcePlainText)
                                ) {
                                const metaNoteError = new Error(
                                    `Node ${node.id} returned a translator meta note instead of translated content.`,
                                );
                                metaNoteError.responsePreview =
                                    previewText(rawResponse);
                                throw metaNoteError;
                            }
                                const restoredContent = restoreAndValidate(
                                    node,
                                    singleNodePlainTextFallback,
                                );
                                updates.push({
                                    nodeId: node.id,
                                    processedContent: restoredContent,
                                });
                                continue;
                        }
                        missingNodeIds.push(node.id);
                        continue;
                    }

                    const processedContent = $node.html()?.trim();
                    if (!processedContent) {
                        missingNodeIds.push(node.id);
                        continue;
                    }

                    const translatedPlainText = extractTextFromFragment(processedContent);
                    const sourcePlainText = extractTextFromFragment(node.content);
                    if (
                        isTranslationMetaNote(translatedPlainText) &&
                        !isTranslationMetaNote(sourcePlainText)
                    ) {
                        const metaNoteError = new Error(
                            `Node ${node.id} returned a translator meta note instead of translated content.`,
                        );
                        metaNoteError.responsePreview = previewText(rawResponse);
                        throw metaNoteError;
                    }

                    // 门控反思审查：若命中审校条件（如含有译者注 <ws-note> 或长度比例严重失衡），触发 Critic Agent 修正
                    let finalContent = processedContent;
                    if (shouldTriggerCritic(node.content, processedContent)) {
                        finalContent = await reviewAndCorrectNode(
                            node.content,
                            processedContent,
                            processor.criticProvider || aiProvider,
                            logger,
                            processor.targetLanguage,
                        );
                    }

                    // 统一校验出口：slot 完整性 + 受保护结构（批量、单节点回退、Critic 共用）
                    const restoredContent = restoreAndValidate(
                        node,
                        finalContent,
                    );

                    try {
                        cheerio.load(restoredContent, { xmlMode: true });
                        updates.push({ nodeId: node.id, processedContent: restoredContent });
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

                    const writtenNodeIds = [];
                    const alreadyWrittenNodeIds = [];
                    const failedNodes = [];
                    for (const update of updates) {
                        const record = processor.planState?.get(update.nodeId);
                        if (record?.state === "written") {
                            alreadyWrittenNodeIds.push(update.nodeId);
                            $parent(
                                `[${processor.attrName}="${update.nodeId}"]`,
                            ).removeAttr(processor.attrName);
                            continue;
                        }
                        const $target = $parent(
                            `[${processor.attrName}="${update.nodeId}"]`,
                        );
                        if ($target.length === 0) {
                            failedNodes.push({
                                id: update.nodeId,
                                code: "TARGET_MISSING",
                                retryable: false,
                            });
                            continue;
                        }
                        if ($target.length > 1) {
                            failedNodes.push({
                                id: update.nodeId,
                                code: "TARGET_AMBIGUOUS",
                                retryable: false,
                            });
                            continue;
                        }
                        if (
                            record?.element &&
                            $target.get(0) !== record.element
                        ) {
                            failedNodes.push({
                                id: update.nodeId,
                                code: "TARGET_CHANGED",
                                retryable: false,
                            });
                            continue;
                        }
                        $target
                            .html(update.processedContent)
                            .removeAttr(processor.attrName);
                        if (record) {
                            record.state = "written";
                            record.outputDigest = computeTextDigest(
                                update.processedContent,
                            );
                        }
                        writtenNodeIds.push(update.nodeId);
                    }

                    success = true;
                    try {
                        onTaskSuccess?.(batch);
                    } catch {}
                    cb(null, {
                        writtenNodeIds,
                        alreadyWrittenNodeIds,
                        failedNodes,
                    });
                } catch (e) {
                    const classification = classifyProviderError(e);
                    logger.write(
                        "ERROR",
                        `Batch Queue Attempt ${attempts} Failed [${classification.category}]: ${e.stack || e.message}${e.responsePreview ? `\nResponse Preview: ${e.responsePreview}` : ""}`,
                    );
                    // 认证/模型不存在等永久错误快速失败，不做无谓重试
                    if (!classification.retryable) {
                        try {
                            onTaskFailure?.(batch, e);
                        } catch {}
                        cb(e);
                        return;
                    }
                    if (attempts >= MAX_ATTEMPTS) {
                        try {
                            onTaskFailure?.(batch, e);
                        } catch {}
                        cb(e);
                    }
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
const SUBTITLE_BATCH_SIZE_LIMIT = 6000;
const SUBTITLE_BATCH_NODE_LIMIT = 24;

export const splitIntoBatches = (nodeList, options = {}) => {
    const {
        sizeLimit = BATCH_SIZE_LIMIT,
        nodeLimit = Number.POSITIVE_INFINITY,
    } = options;
    const batches = [];
    let currentBatch = [];
    let currentLength = 0;
    for (const node of nodeList) {
        if (
            currentBatch.length > 0 &&
            (currentLength + node.content.length > sizeLimit ||
                currentBatch.length >= nodeLimit)
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

export const getBatchingOptions = (translationMode) => {
    if (translationMode === "subtitle") {
        return {
            sizeLimit: SUBTITLE_BATCH_SIZE_LIMIT,
            nodeLimit: SUBTITLE_BATCH_NODE_LIMIT,
        };
    }
    return {
        sizeLimit: BATCH_SIZE_LIMIT,
        nodeLimit: Number.POSITIVE_INFINITY,
    };
};

export const dispatchBatches = (
    batches,
    $,
    processor,
    batchQueue,
    logger,
    options = {},
) =>
    batches.map(
        (batch) =>
            new Promise((resolve) => {
                batchQueue.queue
                    .push({
                        batch,
                        $parent: $,
                        processor,
                        onTaskSuccess: options.onTaskSuccess,
                        onTaskFailure: options.onTaskFailure,
                    })
                    .on("finish", (result) =>
                        resolve({ ok: true, batch, result: result || null }),
                    )
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
