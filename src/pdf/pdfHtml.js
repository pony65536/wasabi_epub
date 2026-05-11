import { loadHtml } from "../utils.js";

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const INLINE_FORMULA_PATTERNS = [
    /[A-Za-z][A-Za-z0-9_]*\([^()\n]*\)/g,
    /\b[A-Za-z][A-Za-z0-9_]*\s*=\s*(?:\([^()\n]{1,48}\)|[A-Za-z0-9_√]+(?:\s*[+\-*/]\s*[A-Za-z0-9_√()]+)+|[A-Za-z0-9_./^-]{1,24})/g,
    /\b(?:\w+\s*[·*/+-]\s*)+\w+\b/g,
    /\b[a-zA-Z]\d+(?:\s*,\s*\.\.\.\s*,\s*[a-zA-Z]\d+)+\b/g,
    /\b[a-zA-Z]+_[a-zA-Z0-9]+\b/g,
    /\b[a-zA-Z]\s*[A-Z](?:\s*[+\-*/]\s*[a-zA-Z0-9]+)+\b/g,
    /\b(?:d|W|Q|K|V|x|y|z|h|f|g|n|m)_[a-zA-Z0-9]+\b/g,
    /\b[A-Za-z][A-Za-z0-9_]*\^[A-Za-z0-9]+\b/g,
    /\b[A-Za-z][A-Za-z0-9_]*\s*∈\s*[^，。；：,.]{1,80}/g,
    /√\s*[A-Za-z][A-Za-z0-9_]*/g,
];

const INLINE_FORMULA_PLACEHOLDER_REGEX = /@@WASABI_INLINE_FORMULA_\d+@@/g;
const LATEX_DELIMITED_MATH_REGEX =
    /\\\[((?:.|\n)*?)\\\]|\\\(((?:.|\n)*?)\\\)|\$\$([\s\S]*?)\$\$|(^|[^\\])\$([^$\n]+?)\$(?=$|[^\\$])/g;

const protectInlineFormula = (text) => {
    const placeholders = {};
    let protectedText = String(text ?? "");
    let counter = 0;

    for (const pattern of INLINE_FORMULA_PATTERNS) {
        protectedText = protectedText.replace(pattern, (match) => {
            const normalized = String(match ?? "").trim();
            if (!normalized || normalized.length < 3) return match;
            if (normalized.includes("@@WASABI_INLINE_FORMULA_")) return match;
            const key = `@@WASABI_INLINE_FORMULA_${counter}@@`;
            counter += 1;
            placeholders[key] = normalized;
            return key;
        });
    }

    let protectedHtml = escapeHtml(protectedText);
    for (const [key, value] of Object.entries(placeholders)) {
        const escapedKey = escapeHtml(key);
        const escapedValue = escapeHtml(value);
        protectedHtml = protectedHtml.split(escapedKey).join(
            `<span data-wasabi-inline-formula="${escapedKey}" translate="no">${escapedValue}</span>`,
        );
    }

    return { protectedHtml, placeholders };
};

const buildLineBasedFormulaMarkup = (block) => {
    const lines = Array.isArray(block?.layoutLines) ? block.layoutLines : [];
    if (lines.length === 0) return null;

    const placeholders = {};
    let counter = 0;
    const lineFragments = [];

    for (const line of lines) {
        const items = Array.isArray(line?.items) ? line.items : [];
        if (items.length === 0) continue;
        let lineHtml = "";
        for (const item of items) {
            const itemText = String(item?.text ?? "");
            if (!itemText) continue;
            if (item?.type === "formula") {
                const key = `@@WASABI_INLINE_FORMULA_${counter}@@`;
                counter += 1;
                placeholders[key] = {
                    text: itemText,
                    bbox: Array.isArray(item?.bbox) ? item.bbox : null,
                    lineBBox: Array.isArray(line?.bbox) ? line.bbox : null,
                };
                lineHtml += `<span data-wasabi-inline-formula="${escapeHtml(key)}" translate="no">${escapeHtml(itemText)}</span>`;
                continue;
            }
            lineHtml += escapeHtml(itemText);
        }
        if (lineHtml) lineFragments.push(lineHtml);
    }

    if (Object.keys(placeholders).length === 0) return null;
    return {
        protectedHtml: lineFragments.join(" "),
        placeholders,
    };
};

const restoreInlineFormula = (text, placeholders = {}) => {
    let restored = String(text ?? "");
    for (const [key, value] of Object.entries(placeholders)) {
        restored = restored.split(key).join(value);
    }
    return restored;
};

const stripLatexMathDelimiters = (text) =>
    String(text ?? "")
        .replace(/\\\[((?:.|\n)*?)\\\]/g, "$1")
        .replace(/\\\(((?:.|\n)*?)\\\)/g, "$1")
        .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
        .replace(/(^|[^\\])\$([^$\n]+?)\$(?=$|[^\\$])/g, "$1$2");

const orderedPlaceholderKeys = (placeholders = {}) =>
    Object.keys(placeholders).sort((a, b) => {
        const aNum = Number((a.match(/\d+/) || ["0"])[0]);
        const bNum = Number((b.match(/\d+/) || ["0"])[0]);
        return aNum - bNum;
    });

const restoreLatexDelimitedSegmentsToPlaceholders = (text, placeholders = {}) => {
    const source = String(text ?? "");
    const orderedKeys = orderedPlaceholderKeys(placeholders);
    if (orderedKeys.length === 0) return source;

    const usedKeys = new Set(source.match(INLINE_FORMULA_PLACEHOLDER_REGEX) || []);
    const remainingKeys = orderedKeys.filter((key) => !usedKeys.has(key));
    if (remainingKeys.length === 0) return source;

    LATEX_DELIMITED_MATH_REGEX.lastIndex = 0;
    return source.replace(
        LATEX_DELIMITED_MATH_REGEX,
        (match, bracketBody, parenBody, displayBody, dollarPrefix, dollarBody) => {
            const nextKey = remainingKeys.shift();
            if (!nextKey) {
                return stripLatexMathDelimiters(match);
            }
            if (typeof dollarBody === "string") {
                return `${dollarPrefix || ""}${nextKey}`;
            }
            return nextKey;
        },
    );
};

const extractTranslatedText = ($, node, placeholders) => {
    if (node.type === "text") {
        return node.data || "";
    }
    if (node.type !== "tag") {
        return "";
    }

    const formulaKey = $(node).attr("data-wasabi-inline-formula");
    if (formulaKey && placeholders[formulaKey]) {
        return formulaKey;
    }

    return $(node)
        .contents()
        .toArray()
        .map((child) => extractTranslatedText($, child, placeholders))
        .join("");
};

export const pdfJsonToHtml = (pdfJson) => {
    const title = pdfJson?.title || pdfJson?.sourceFile || "PDF Document";
    const blocks = Array.isArray(pdfJson?.blocks) ? pdfJson.blocks : [];
    const body = blocks
        .filter((block) => !block.preserveOriginal)
        .map((block) => {
            const tag = block.role === "heading" ? "h2" : "p";
            const lineBased = buildLineBasedFormulaMarkup(block);
            const { protectedHtml, placeholders } =
                lineBased || protectInlineFormula(block.text);
            block.inlineFormulaPlaceholders = placeholders;
            return `<${tag} data-pdf-block-id="${escapeHtml(block.id)}" data-page="${escapeHtml(block.page)}">${protectedHtml}</${tag}>`;
        })
        .join("\n");

    return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeHtml(title)}</title></head>
<body>
${body}
</body>
</html>`;
};

export const applyTranslatedHtmlToPdfJson = (pdfJson, translatedHtml) => {
    const $ = loadHtml(translatedHtml);
    const blocksById = new Map();
    for (const block of pdfJson.blocks || []) {
        blocksById.set(String(block.id), block);
    }

    $("[data-pdf-block-id]").each((_, el) => {
        const id = $(el).attr("data-pdf-block-id");
        const block = blocksById.get(String(id));
        if (!block) return;
        const translatedText = stripLatexMathDelimiters(
            restoreLatexDelimitedSegmentsToPlaceholders(
                extractTranslatedText(
                    $,
                    el,
                    block.inlineFormulaPlaceholders || {},
                ),
                block.inlineFormulaPlaceholders || {},
            ),
        ).replace(/\s+/g, " ").trim();
        if (translatedText && INLINE_FORMULA_PLACEHOLDER_REGEX.test(translatedText)) {
            INLINE_FORMULA_PLACEHOLDER_REGEX.lastIndex = 0;
        }
        if (translatedText) block.translatedText = translatedText;
    });

    return pdfJson;
};
