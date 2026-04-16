const NOISE_SYMBOL_REGEX = /^[0-9oO#.:,_\-\/\\|()[\]{}*+=~`"' ]+$/;
const CAPTION_REGEX = /^(fig(?:ure)?\.?|table)\s*[A-Za-z0-9.\-:]*$/i;
const BROKEN_OCR_REGEX =
    /^([A-Za-z]\s+[A-Za-z][\-.,:]?|[.\-_:]{3,}[A-Za-z]?|[A-Za-z]?[.\-_:]{3,})$/;
const WORD_REGEX = /[A-Za-z]{3,}/g;
const FORMULA_HINT_REGEX =
    /(?:=|≈|≤|≥|∑|∫|√|×|÷|\b(?:sin|cos|tan|log|ln|max|min)\b)/i;

const countMatches = (text, regex) => (text.match(regex) || []).length;

const previewText = (text, maxLength = 80) => {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
};

export const normalizeText = (text) =>
    String(text ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

export const classifyTextNode = (text) => {
    const normalized = normalizeText(text);
    if (!normalized) {
        return { type: "TEXT_NOISE", action: "DROP", reason: "empty" };
    }

    if (normalized.includes("�")) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "replacement_char",
        };
    }

    if (CAPTION_REGEX.test(normalized)) {
        return { type: "CAPTION", action: "KEEP", reason: "caption_label" };
    }

    const alphaCount = countMatches(normalized, /[A-Za-z]/g);
    const digitCount = countMatches(normalized, /\d/g);
    const symbolCount = countMatches(normalized, /[^A-Za-z0-9\s]/g);
    const wordMatches = normalized.match(WORD_REGEX) || [];
    const hasWords = wordMatches.length > 0;
    const compact = normalized.replace(/\s+/g, "");

    if (
        compact.length <= 3 &&
        alphaCount <= 2 &&
        digitCount <= 2 &&
        !hasWords
    ) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "short_noise",
        };
    }

    if (/^\d+(?:[.,:/-]\d+)*$/.test(normalized)) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "numeric_fragment",
        };
    }

    if (BROKEN_OCR_REGEX.test(normalized)) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "broken_ocr_fragment",
        };
    }

    if (
        !hasWords &&
        compact.length >= 4 &&
        (NOISE_SYMBOL_REGEX.test(normalized) ||
            symbolCount / Math.max(compact.length, 1) >= 0.45)
    ) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "mostly_symbols",
        };
    }

    if (
        FORMULA_HINT_REGEX.test(normalized) &&
        alphaCount + digitCount > 0 &&
        symbolCount >= 2 &&
        wordMatches.length <= 2
    ) {
        return {
            type: "FORMULA",
            action: "PLACEHOLDER",
            reason: "formula_like_text",
        };
    }

    if (
        !hasWords &&
        compact.length <= 6 &&
        alphaCount <= 2 &&
        symbolCount + digitCount >= Math.max(compact.length - 1, 1)
    ) {
        return {
            type: "TEXT_NOISE",
            action: "DROP",
            reason: "isolated_fragment",
        };
    }

    return { type: "TEXT_NORMAL", action: "KEEP", reason: "default_keep" };
};

export const isPseudoTable = (node) => {
    const cellTexts = Array.isArray(node?.cellTexts)
        ? node.cellTexts.map((cell) => normalizeText(cell))
        : [];

    if (cellTexts.length < 12) return false;

    const nonEmptyCells = cellTexts.filter(Boolean);
    if (nonEmptyCells.length === 0) return false;

    const tinyCells =
        nonEmptyCells.filter((cell) => cell.length <= 2).length /
        nonEmptyCells.length;
    const shortCells =
        nonEmptyCells.filter((cell) => cell.length <= 8).length /
        nonEmptyCells.length;
    const pseudoCharsetCells =
        nonEmptyCells.filter((cell) => /^[0oO#.:_\- ]{1,2}$/.test(cell)).length /
        nonEmptyCells.length;
    const wordCells =
        nonEmptyCells.filter((cell) => /[A-Za-z]{3,}/.test(cell)).length /
        nonEmptyCells.length;
    const noiseCells =
        nonEmptyCells.filter((cell) => {
            const result = classifyTextNode(cell);
            return (
                result.type === "TEXT_NOISE" ||
                (result.type !== "TEXT_NORMAL" && result.action !== "KEEP")
            );
        }).length / nonEmptyCells.length;

    const joined = nonEmptyCells.join("");
    const distinctChars = new Set(joined.split("")).size;

    return (
        shortCells >= 0.9 &&
        wordCells <= 0.05 &&
        ((tinyCells >= 0.85 && pseudoCharsetCells >= 0.7) ||
            noiseCells >= 0.75) &&
        distinctChars <= 32
    );
};

export const classifyNode = (node) => {
    const tagName = String(node?.tagName || "").toLowerCase();

    if (tagName === "table") {
        if (isPseudoTable(node)) {
            return {
                type: "TABLE_PSEUDO",
                action: "PLACEHOLDER",
                reason: "image_like_table",
            };
        }
        return { type: "TABLE_REAL", action: "KEEP", reason: "table_keep" };
    }

    if (tagName === "caption" || tagName === "figcaption") {
        const textResult = classifyTextNode(node?.text || "");
        if (textResult.type === "TEXT_NOISE") {
            return {
                type: "CAPTION",
                action: "DROP",
                reason: textResult.reason,
            };
        }
        return { type: "CAPTION", action: "KEEP", reason: "caption_keep" };
    }

    return classifyTextNode(node?.text || "");
};

export const buildPlaceholderMarkup = (classification, tagName = "div") => {
    const labelMap = {
        TABLE_PSEUDO: "[Table omitted: non-text OCR grid]",
        FORMULA: "[Formula omitted]",
    };
    const label = labelMap[classification?.type];
    if (!label) return null;
    return `<${tagName} data-wasabi-placeholder="${classification.type.toLowerCase()}">${label}</${tagName}>`;
};

export const buildClassificationLog = (id, classification, previewSource) => ({
    id,
    type: classification.type,
    action: classification.action,
    reason: classification.reason,
    preview: previewText(previewSource),
});
