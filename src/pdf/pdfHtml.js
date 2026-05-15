import { loadHtml } from "../utils.js";

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const INLINE_FORMULA_PLACEHOLDER_REGEX = /@@WASABI_INLINE_FORMULA_\d+@@/g;
const LATEX_DELIMITED_MATH_REGEX =
    /\\\[((?:.|\n)*?)\\\]|\\\(((?:.|\n)*?)\\\)|\$\$([\s\S]*?)\$\$|(^|[^\\])\$([^$\n]+?)\$(?=$|[^\\$])/g;
const TRANSLATION_NOTE_PATTERNS = [
    /^[（(]?\s*(?:注|NOTE)\s*[:：]/i,
    /\bnode[_\s-]?\d+\b/i,
    /\bsid\b/i,
    /(?:按规则|严格保留|不合并|不调整|原文此处编号有误)/,
];

const fallbackDefaultStyle = (block) => {
    const fontRole =
        String(block?.defaultStyle?.fontRole || "") ||
        (String(block?.role || "") === "heading" ? "heading" : "body");
    const preferredStyle =
        String(block?.preferredTextStyle || "") ||
        (Boolean(block?.hasBoldLike) || fontRole === "heading" ? "bold" : "normal");
    return {
        fontRole,
        familyClass: String(block?.styleFamilyClass || "serif"),
        weight:
            preferredStyle === "bold" || preferredStyle === "bold_italic" || fontRole === "heading"
                ? "bold"
                : "regular",
        italic: preferredStyle === "italic" || preferredStyle === "bold_italic",
        mono: preferredStyle === "monospace" || fontRole === "code",
    };
};

const shouldTagWholeHeadingStyle = (block) =>
    String(block?.role || "") === "heading" &&
    String(fallbackDefaultStyle(block)?.weight || "") === "bold";

const buildStyleMarkerMap = (block) => {
    if (!shouldTagWholeHeadingStyle(block)) {
        return {};
    }
    const defaultStyle = fallbackDefaultStyle(block);
    return {
        S0: {
            kind: "text_style",
            familyClass: String(defaultStyle.familyClass || "serif"),
            weight: String(defaultStyle.weight || "bold"),
            italic: Boolean(defaultStyle.italic),
            mono: Boolean(defaultStyle.mono),
            fontRole: String(defaultStyle.fontRole || "heading"),
        },
    };
};

const buildPdfTranslationSourceText = (block, blocksById) => {
    const blockText = String(block?.text ?? "");
    const dropCap = block?.dropCap;
    if (!dropCap || typeof dropCap !== "object") {
        return blockText;
    }
    const sourceBlockId = String(dropCap.sourceBlockId || "");
    if (!sourceBlockId) {
        return blockText;
    }
    const sourceBlock = blocksById.get(sourceBlockId);
    const leadText = String(sourceBlock?.text ?? "");
    if (!leadText) {
        return blockText;
    }
    if (blockText.startsWith(leadText)) {
        return blockText;
    }
    return `${leadText}${blockText}`;
};

const wrapWithStyleMarkers = (html, styleMarkers) => {
    if (!html || !styleMarkers?.S0) {
        return html;
    }
    return `<span data-wasabi-style-marker="S0">${html}</span>`;
};

const protectInlineFormula = (text) => {
    const placeholders = {};
    const source = String(text ?? "");
    let counter = 0;
    let lastIndex = 0;
    const fragments = [];

    LATEX_DELIMITED_MATH_REGEX.lastIndex = 0;
    let match;
    while ((match = LATEX_DELIMITED_MATH_REGEX.exec(source)) !== null) {
        const fullMatch = match[0];
        const matchIndex = match.index;
        const prefix = typeof match[4] === "string" ? match[4] || "" : "";
        const prefixLength = prefix ? prefix.length : 0;
        const visibleText = stripLatexMathDelimiters(fullMatch).trim();
        if (!visibleText) {
            continue;
        }
        const textStart = matchIndex + prefixLength;
        const leadingText = source.slice(lastIndex, textStart);
        if (leadingText) {
            fragments.push(escapeHtml(leadingText));
        }
        const key = `@@WASABI_INLINE_FORMULA_${counter}@@`;
        counter += 1;
        placeholders[key] = visibleText;
        fragments.push(
            `<span data-wasabi-inline-formula="${escapeHtml(key)}" translate="no">${escapeHtml(visibleText)}</span>`,
        );
        lastIndex = matchIndex + fullMatch.length;
    }

    if (Object.keys(placeholders).length === 0) {
        return { protectedHtml: escapeHtml(source), placeholders };
    }

    const trailing = source.slice(lastIndex);
    if (trailing) {
        fragments.push(escapeHtml(trailing));
    }
    return { protectedHtml: fragments.join(""), placeholders };
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
                    font: String(item?.font ?? ""),
                    flags: Number(item?.flags ?? 0),
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

const isTranslationMetaNote = (value) => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return false;
    const matchCount = TRANSLATION_NOTE_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
    if (matchCount >= 2) return true;
    if (matchCount >= 1 && normalized.length <= 120 && ["（", "(", "["].includes(normalized.slice(0, 1))) {
        return true;
    }
    return false;
};

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

const extractTranslatedTextAndStyles = ($, node, placeholders, styleMarkers, state) => {
    if (node.type === "text") {
        const text = node.data || "";
        if (!text) return;
        const start = state.text.length;
        state.text += text;
        const activeMarker = state.activeStyleMarkers[state.activeStyleMarkers.length - 1];
        if (activeMarker) {
            const existing = state.styleRuns[state.styleRuns.length - 1];
            if (existing && existing.markerId === activeMarker && existing.end === start) {
                existing.end = state.text.length;
            } else {
                state.styleRuns.push({ markerId: activeMarker, start, end: state.text.length });
            }
        }
        return;
    }
    if (node.type !== "tag") {
        return;
    }

    const formulaKey = $(node).attr("data-wasabi-inline-formula");
    if (formulaKey && placeholders[formulaKey]) {
        const start = state.text.length;
        state.text += formulaKey;
        const activeMarker = state.activeStyleMarkers[state.activeStyleMarkers.length - 1];
        if (activeMarker) {
            const existing = state.styleRuns[state.styleRuns.length - 1];
            if (existing && existing.markerId === activeMarker && existing.end === start) {
                existing.end = state.text.length;
            } else {
                state.styleRuns.push({ markerId: activeMarker, start, end: state.text.length });
            }
        }
        return;
    }

    const styleMarker = $(node).attr("data-wasabi-style-marker");
    if (styleMarker && styleMarkers?.[styleMarker]) {
        state.activeStyleMarkers.push(styleMarker);
    }

    $(node)
        .contents()
        .toArray()
        .forEach((child) =>
            extractTranslatedTextAndStyles(
                $,
                child,
                placeholders,
                styleMarkers,
                state,
            ),
        );

    if (styleMarker && styleMarkers?.[styleMarker]) {
        state.activeStyleMarkers.pop();
    }
};

export const pdfJsonToHtml = (pdfJson) => {
    const title = pdfJson?.title || pdfJson?.sourceFile || "PDF Document";
    const blocks = Array.isArray(pdfJson?.blocks) ? pdfJson.blocks : [];
    const blocksById = new Map(blocks.map((block) => [String(block.id), block]));
    const body = blocks
        .filter(
            (block) =>
                !block.preserveOriginal &&
                block.blockType !== "reference_block" &&
                block.doclingLabel !== "reference",
        )
        .map((block) => {
            const tag = block.role === "heading" ? "h2" : "p";
            const sourceText = buildPdfTranslationSourceText(block, blocksById);
            const lineBased = buildLineBasedFormulaMarkup(block);
            const { protectedHtml, placeholders } =
                lineBased || protectInlineFormula(sourceText);
            const styleMarkers = buildStyleMarkerMap(block);
            block.defaultStyle = block.defaultStyle || fallbackDefaultStyle(block);
            block.inlineFormulaPlaceholders = placeholders;
            block.styleMarkers = styleMarkers;
            return `<${tag} data-pdf-block-id="${escapeHtml(block.id)}" data-page="${escapeHtml(block.page)}">${wrapWithStyleMarkers(protectedHtml, styleMarkers)}</${tag}>`;
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
        const extractionState = {
            text: "",
            styleRuns: [],
            activeStyleMarkers: [],
        };
        extractTranslatedTextAndStyles(
            $,
            el,
            block.inlineFormulaPlaceholders || {},
            block.styleMarkers || {},
            extractionState,
        );
        const translatedText = stripLatexMathDelimiters(
            restoreLatexDelimitedSegmentsToPlaceholders(
                extractionState.text,
                block.inlineFormulaPlaceholders || {},
            ),
        ).replace(/\s+/g, " ").trim();
        if (translatedText && INLINE_FORMULA_PLACEHOLDER_REGEX.test(translatedText)) {
            INLINE_FORMULA_PLACEHOLDER_REGEX.lastIndex = 0;
        }
        if (translatedText && isTranslationMetaNote(translatedText)) {
            block.translationMetaNote = translatedText;
            block.preserveOriginal = true;
            block.preserveReason = "translation_meta_note";
        } else if (translatedText) {
            block.translatedText = translatedText;
            if (block.translationMetaNote) delete block.translationMetaNote;
            if (block.preserveReason === "translation_meta_note") {
                delete block.preserveReason;
                delete block.preserveOriginal;
            }
        }
        if (Array.isArray(extractionState.styleRuns) && extractionState.styleRuns.length > 0) {
            block.translatedStyleRuns = extractionState.styleRuns
                .map((run) => {
                    const marker = (block.styleMarkers || {})[run.markerId];
                    if (!marker) return null;
                    return {
                        markerId: run.markerId,
                        start: run.start,
                        end: run.end,
                        ...marker,
                    };
                })
                .filter(Boolean);
        }
    });

    return pdfJson;
};
