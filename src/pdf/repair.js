import { callAIWithRetry } from "../utils.js";

export const PDF_BLOCKS_SCHEMA_VERSION = 2;
const PDF_REPAIR_MAX_RUN = 4;
const PDF_TRANSLATION_NOTE_PATTERNS = [
    /^[（(]?\s*(?:注|NOTE)\s*[:：]/i,
    /\bnode[_\s-]?\d+\b/i,
    /\bsid\b/i,
    /(?:按规则|严格保留|不合并|不调整|原文此处编号有误)/,
];
const PDF_TRANSLATION_SHORTHAND_PATTERNS = [
    /^(?:同上|同前|如上|上同|见上|见前)(?:[。．.!！?？]*)$/,
    /^(?:ibid\.?|same as above|see above|same as prior)(?:[.?!]*)$/i,
];

const normalizePdfRepairText = (value) =>
    String(value ?? "").replace(/\s+/g, " ").trim();

const compactPdfRepairText = (value) =>
    normalizePdfRepairText(value).replace(/\s+/g, "");

const isPdfTranslationMetaNote = (value) => {
    const normalized = normalizePdfRepairText(value);
    if (!normalized) return false;
    const matchCount = PDF_TRANSLATION_NOTE_PATTERNS.filter((pattern) =>
        pattern.test(normalized),
    ).length;
    if (matchCount >= 2) return true;
    if (
        matchCount >= 1 &&
        normalized.length <= 120 &&
        ["（", "(", "["].includes(normalized.slice(0, 1))
    ) {
        return true;
    }
    return false;
};

const isPdfTranslationShorthand = (value) => {
    const normalized = normalizePdfRepairText(value);
    if (!normalized) return false;
    return PDF_TRANSLATION_SHORTHAND_PATTERNS.some((pattern) =>
        pattern.test(normalized),
    );
};

const pdfBlockHorizontalOverlapRatio = (a, b) => {
    const aBox = a?.bbox || [0, 0, 0, 0];
    const bBox = b?.bbox || [0, 0, 0, 0];
    const overlap = Math.max(
        0,
        Math.min(Number(aBox[2] || 0), Number(bBox[2] || 0)) -
            Math.max(Number(aBox[0] || 0), Number(bBox[0] || 0)),
    );
    const minWidth = Math.max(
        1,
        Math.min(
            Number(aBox[2] || 0) - Number(aBox[0] || 0),
            Number(bBox[2] || 0) - Number(bBox[0] || 0),
        ),
    );
    return overlap / minWidth;
};

const sourceLooksLikeContinuation = (text) => {
    const normalized = normalizePdfRepairText(text);
    if (!normalized) return false;
    if (/[.!?。！？”"]$/.test(normalized)) return false;
    if (/[,;:，；：-]$/.test(normalized)) return true;
    if (/\b(?:such as|for example|including|like|if|if i|and some, such as)$/i.test(normalized)) {
        return true;
    }
    return true;
};

const blockStartsWithOpeningQuote = (text) =>
    /^[“"‘']/.test(normalizePdfRepairText(text));

const blocksFormRepairableRun = (previousBlock, block) => {
    if (!previousBlock || !block) return false;
    if (Number(previousBlock.page || 0) !== Number(block.page || 0)) return false;
    if (previousBlock.preserveOriginal || block.preserveOriginal) return false;
    if (String(previousBlock.role || "") !== "paragraph" || String(block.role || "") !== "paragraph") {
        return false;
    }
    const prevSize = Number(previousBlock.fontSize || 0);
    const size = Number(block.fontSize || 0);
    if (Math.abs(prevSize - size) > Math.max(2.5, prevSize * 0.18)) return false;
    const prevBox = previousBlock.bbox || [0, 0, 0, 0];
    const box = block.bbox || [0, 0, 0, 0];
    const yGap = Number(box[1] || 0) - Number(prevBox[3] || 0);
    if (yGap < -8 || yGap > 90) return false;
    if (pdfBlockHorizontalOverlapRatio(previousBlock, block) < 0.28) return false;
    return sourceLooksLikeContinuation(previousBlock.text || "");
};

const runLooksSuspiciousForRepair = (blocks) => {
    if (!Array.isArray(blocks) || blocks.length < 2) return false;
    const ratios = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const sourceText = normalizePdfRepairText(block.text || "");
        const translatedText = normalizePdfRepairText(block.translatedText || "");
        if (!sourceText || !translatedText) return true;
        if (isPdfTranslationMetaNote(translatedText) || isPdfTranslationShorthand(translatedText)) {
            return true;
        }
        if (
            index > 0 &&
            blockStartsWithOpeningQuote(translatedText) &&
            !blockStartsWithOpeningQuote(sourceText)
        ) {
            return true;
        }
        const sourceLen = Math.max(compactPdfRepairText(sourceText).length, 1);
        const translatedLen = Math.max(compactPdfRepairText(translatedText).length, 1);
        ratios.push(translatedLen / sourceLen);
        if (translatedLen <= 8 && sourceLen >= 24) return true;
    }
    return Math.max(...ratios) / Math.max(Math.min(...ratios), 0.01) > 2.2;
};

const buildPdfRepairPrompt = (targetLanguage) => `
You repair mis-split PDF block translations.

Task:
Redistribute translated text back into the original block boundaries.

Rules:
1. Return valid JSON only.
2. Output exact ids in the same order.
3. Use the source blocks to decide boundaries.
4. Keep all meaning from the current translated text, but move text back to the correct block.
5. You may lightly retranslate only when needed to restore the correct block boundary.
6. Do not merge blocks.
7. Do not leave a block empty.
8. Do not add notes, comments, warnings, or explanations.
9. Do not use shorthand such as "同上", "如上", "见上", "same as above", or "ibid." unless the source block itself says so.
10. The output language must be fluent ${targetLanguage}.

Return this schema:
{"blocks":[{"id":"...","translatedText":"..."}]}
`.trim();

const validatePdfRepairResult = (run, repairedBlocks) => {
    if (!Array.isArray(repairedBlocks) || repairedBlocks.length !== run.length) {
        return false;
    }
    const combinedOriginal = compactPdfRepairText(
        run.map((block) => block.translatedText || "").join(" "),
    );
    const combinedRepaired = compactPdfRepairText(
        repairedBlocks.map((block) => block.translatedText || "").join(" "),
    );
    if (!combinedRepaired) return false;
    if (
        combinedOriginal &&
        (combinedRepaired.length < combinedOriginal.length * 0.65 ||
            combinedRepaired.length > combinedOriginal.length * 1.45)
    ) {
        return false;
    }

    for (let index = 0; index < repairedBlocks.length; index++) {
        const repaired = repairedBlocks[index];
        const source = run[index];
        if (!repaired || repaired.id !== source.id) return false;
        const translatedText = normalizePdfRepairText(repaired.translatedText || "");
        if (!translatedText) return false;
        if (
            isPdfTranslationMetaNote(translatedText) ||
            isPdfTranslationShorthand(translatedText)
        ) {
            return false;
        }
        if (
            index > 0 &&
            blockStartsWithOpeningQuote(translatedText) &&
            !blockStartsWithOpeningQuote(source.text || "")
        ) {
            return false;
        }
    }
    return true;
};

export const repairPdfMergedTranslationRuns = async (
    pdfJson,
    aiProvider,
    logger,
    targetLanguage,
) => {
    const blocks = Array.isArray(pdfJson?.blocks) ? pdfJson.blocks : [];
    if (blocks.length < 2) return 0;

    let repairedRunCount = 0;
    for (let index = 0; index < blocks.length - 1; index++) {
        const run = [blocks[index]];
        let cursor = index;
        while (
            cursor + 1 < blocks.length &&
            run.length < PDF_REPAIR_MAX_RUN &&
            blocksFormRepairableRun(blocks[cursor], blocks[cursor + 1])
        ) {
            run.push(blocks[cursor + 1]);
            cursor += 1;
        }
        if (run.length < 2 || !runLooksSuspiciousForRepair(run)) {
            continue;
        }

        const payload = {
            blocks: run.map((block) => ({
                id: block.id,
                source: normalizePdfRepairText(block.text || ""),
                translatedText: normalizePdfRepairText(block.translatedText || ""),
            })),
            mergedTranslation: normalizePdfRepairText(
                run.map((block) => block.translatedText || "").join(" "),
            ),
        };

        try {
            const repaired = await callAIWithRetry(
                aiProvider,
                JSON.stringify(payload, null, 2),
                buildPdfRepairPrompt(targetLanguage),
                2,
            );
            const repairedBlocks = repaired?.blocks;
            if (!validatePdfRepairResult(run, repairedBlocks)) {
                logger.write(
                    "WARN",
                    `PDF repair validation failed for run: ${run.map((block) => block.id).join(", ")}`,
                );
                continue;
            }
            for (let runIndex = 0; runIndex < run.length; runIndex++) {
                run[runIndex].translatedText = normalizePdfRepairText(
                    repairedBlocks[runIndex].translatedText,
                );
            }
            logger.write(
                "INFO",
                `PDF repair applied for run: ${run.map((block) => block.id).join(", ")}`,
            );
            repairedRunCount += 1;
            index = cursor;
        } catch (error) {
            logger.write(
                "WARN",
                `PDF repair failed for run ${run.map((block) => block.id).join(", ")}: ${error.stack || error.message}`,
            );
        }
    }

    return repairedRunCount;
};

export const logPdfDoclingSummary = (pdfJson) => {
    const summary = pdfJson?.doclingSummary;
    if (!summary) return;

    if (summary.enabled) {
        const labelCounts = summary.labelCounts || {};
        const labelPreview = Object.entries(labelCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 6)
            .map(([label, count]) => `${label}=${count}`)
            .join(", ");
        console.log(
            `   Docling: status=${summary.status} items=${summary.items ?? 0} matchedBlocks=${summary.matchedBlocks ?? 0} elapsedMs=${summary.elapsedMs ?? 0}${labelPreview ? ` labels=[${labelPreview}]` : ""}`,
        );
    } else {
        console.log(
            `   Docling: status=${summary.status || "disabled"}${summary.error ? ` error=${summary.error}` : ""}`,
        );
    }
};
