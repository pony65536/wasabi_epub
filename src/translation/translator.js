import { buildStyleGuide } from "../config.js";
import fs from "fs";
import { loadHtml } from "../utils.js";
import {
    splitIntoBatches,
    getBatchingOptions,
    dispatchBatches,
    collectFailedNodes,
} from "./batchQueue.js";
import path from "path";
import { fileURLToPath } from "url";
import {
    buildClassificationLog,
    classifyNode,
    classifyTextNode,
    normalizeText,
} from "../content/content-classifier.js";
import { formatBookBibleForPrompt } from "../content/director.js";
import {
    extractAndFormatNotes,
    appendFootnotesSection,
    findMaxFootnoteIndex,
} from "../content/footnotes.js";
import { extractChapterMemory } from "../content/memory.js";
import { computeCoverageAudit } from "./coverage.js";
import {
    computeTextDigest,
    TRANSLATION_PIPELINE_VERSION,
} from "../support/taskIdentity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EPUB_TRANSLATION_PROMPT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, "../../prompts/epub_translation_prompt.txt"),
    "utf8",
);
const HTML_TRANSLATION_PROMPT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, "../../prompts/html_translation_prompt.txt"),
    "utf8",
);
const PDF_TRANSLATION_PROMPT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, "../../prompts/pdf_translation_prompt.txt"),
    "utf8",
);
const SUBTITLE_TRANSLATION_PROMPT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, "../../prompts/subtitle_translation_prompt.txt"),
    "utf8",
);

function findContentRoot($) {
    const selectors = [
        "main",
        "article",
        "#content",
        "#main",
        ".content",
        ".post-content",
        ".entry-content",
        ".article-body",
        ".markdown-body",
        ".mw-parser-output",
    ];

    let best = null;
    let bestScore = 0;

    for (const sel of selectors) {
        const candidates = $(sel).toArray();

        for (const el of candidates) {
            const $el = $(el);
            const text = $el.text().replace(/\s+/g, " ").trim();
            const textLen = text.length;

            const linkText = $el.find("a").text().replace(/\s+/g, " ").trim();
            const linkDensity = textLen > 0 ? linkText.length / textLen : 1;

            const pCount = $el.find("p").length;
            const liCount = $el.find("li").length;

            const score =
                textLen * 1.0 + (pCount + liCount) * 50 - linkDensity * 500;

            if (score > bestScore) {
                best = $el;
                bestScore = score;
            }
        }
    }

    if (best) return best;

    let fallback = null;
    let fallbackScore = 0;

    $("body > *").each((_, el) => {
        const $el = $(el);
        const textLen = $el.text().trim().length;
        if (textLen > fallbackScore) {
            fallback = $el;
            fallbackScore = textLen;
        }
    });

    return fallback || $("body");
}

const HARD_BLOCKED_TAGS = new Set([
    "script",
    "style",
    "svg",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "g",
    "defs",
    "symbol",
    "use",
    "meta",
    "link",
    "noscript",
    "template",
    "iframe",
    "canvas",
    "form",
    "input",
    "textarea",
    "select",
    "option",
    "button",
]);

const BLOCKED_ANCESTOR_TAGS = new Set([
    "nav",
    "header",
    "footer",
    "aside",
    "menu",
    "dialog",
]);

const BLOCKED_ANCESTOR_KEYWORDS = [
    "nav",
    "navigation",
    "navbar",
    "menu",
    "header",
    "footer",
    "sidebar",
    "toolbar",
    "dropdown",
    "popup",
    "modal",
    "dialog",
    "notification",
    "notifications",
    "user-card",
    "profile",
    "avatar",
    "search",
    "donate",
    "theme-switcher",
    "login",
    "signup",
    "register",
    "auth",
    "comment",
    "comments",
];

const STRUCTURAL_ROOT_TAGS = new Set(["html", "head", "body"]);
const SIMPLE_CONTAINER_TAGS = new Set(["span", "a", "div"]);
const INLINE_FORMATTING_TAGS = new Set([
    "span",
    "a",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "small",
    "sup",
    "sub",
    "cite",
    "q",
    "abbr",
]);
const BLOCKED_DESCENDANT_TAGS = new Set([
    "script",
    "style",
    "svg",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "form",
    "iframe",
    "canvas",
    "template",
]);

const isElementNode = (node) => node && node.type === "tag";

const getTagName = (node) => String(node?.name || "").toLowerCase();

const getNodeText = ($, node) => normalizeText($(node).text());

const getDirectText = ($, node) =>
    normalizeText(
        $(node)
            .contents()
            .filter((_, child) => child.type === "text")
            .text(),
    );

const getDirectElementChildren = ($, node) =>
    $(node)
        .contents()
        .filter((_, child) => isElementNode(child))
        .toArray();

const getDescendantElementCount = ($, node) =>
    $(node)
        .find("*")
        .filter((_, child) => isElementNode(child))
        .length;

const hasShadowRootAttribute = (node) =>
    Boolean(
        node?.attribs &&
            Object.keys(node.attribs).some((attr) =>
                attr.toLowerCase().includes("shadowroot"),
            ),
    );

const isBlockedRegionNode = (node) => {
    if (!isElementNode(node)) return false;
    const tagName = getTagName(node);
    if (BLOCKED_ANCESTOR_TAGS.has(tagName)) return true;

    const attribs = node.attribs || {};
    const signature = `${String(attribs.id || "").toLowerCase()} ${String(
        attribs.class || "",
    ).toLowerCase()}`;
    return BLOCKED_ANCESTOR_KEYWORDS.some((keyword) =>
        signature.includes(keyword),
    );
};

const isMostlySymbols = (text) => {
    const compact = String(text ?? "").replace(/\s+/g, "");
    if (!compact) return true;
    if (/^\d+(?:[.,:/-]\d+)*$/.test(compact)) return true;
    const meaningful = compact.match(/[\p{L}\p{N}]/gu) || [];
    if (meaningful.length === 0) return true;
    const symbols = compact.match(/[^\p{L}\p{N}]/gu) || [];
    return symbols.length / Math.max(compact.length, 1) >= 0.6;
};

const isInteractiveSubtree = ($, node) => {
    const tagName = getTagName(node);
    if (BLOCKED_DESCENDANT_TAGS.has(tagName)) return true;
    return (
        $(node)
            .find(
                "button, input, textarea, select, option, form, iframe, canvas, svg, template",
            )
            .length > 0
    );
};

const isSimpleTextContainer = ($, node) => {
    const tagName = getTagName(node);
    if (!SIMPLE_CONTAINER_TAGS.has(tagName)) return true;

    const directChildren = getDirectElementChildren($, node);
    if (directChildren.length > 8) return false;

    return !directChildren.some((child) => {
        const childTag = getTagName(child);
        return (
            BLOCKED_DESCENDANT_TAGS.has(childTag) ||
            BLOCKED_ANCESTOR_TAGS.has(childTag) ||
            [
                "div",
                "section",
                "article",
                "main",
                "aside",
                "nav",
                "header",
                "footer",
                "menu",
                "dialog",
                "table",
                "form",
                "ul",
                "ol",
                "li",
                "figure",
                "figcaption",
                "blockquote",
            ].includes(childTag)
        );
    });
};

const CORE_TEXT_TAGS = new Set([
    "p",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "td",
    "th",
    "caption",
]);

const VISIBLE_TEXT_EXCLUDED_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "svg",
    "meta",
    "link",
    "template",
    "iframe",
    "canvas",
]);

const previewMarkup = (html, maxLength = 160) => {
    const normalized = String(html ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
};

const countPreviousSameTagSiblings = (node) => {
    const tagName = getTagName(node);
    if (!tagName || !node?.parent?.children) return 1;

    let index = 0;
    for (const sibling of node.parent.children) {
        if (!isElementNode(sibling)) continue;
        if (getTagName(sibling) !== tagName) continue;
        index++;
        if (sibling === node) return index;
    }

    return Math.max(index, 1);
};

const buildDomPath = ($, el) => {
    try {
        const parts = [];
        let current = el;

        while (current && isElementNode(current)) {
            const tagName = getTagName(current);
            if (!tagName) {
                parts.unshift("unknown");
                break;
            }

            const siblingIndex = countPreviousSameTagSiblings(current);
            parts.unshift(`${tagName}:nth-of-type(${siblingIndex})`);
            current = current.parent;
        }

        return parts.length > 0 ? parts.join(" > ") : "unknown";
    } catch (error) {
        return `unavailable:${getTagName(el) || "unknown"}`;
    }
};

const logClassification = (logger, payload, debugMode = false) => {
    logger.write("INFO", `Content Filter: ${JSON.stringify(payload)}`);
    if (debugMode) {
        console.log(`    - 🧹 Filtered: ${JSON.stringify(payload)}`);
    }
};

const enrichClassificationLog = ($, el, chapterTitle, logEntry, htmlContent) => ({
    ...logEntry,
    chapterTitle,
    tagName: el?.name || "unknown",
    domPath: buildDomPath($, el),
    htmlPreview: previewMarkup(htmlContent),
});

// EPUB 路径仍保留原有的冗余 span 解包逻辑，HTML 路径不走这一步。
const unwrapUselessSpans = ($, referencedIds, definedClasses) => {
    $("span").each((_, el) => {
        const { id, class: cls, style, lang } = el.attribs;
        if (lang) return;
        if (style) return;
        if (id && referencedIds.has(id)) return;
        if (cls) {
            const classes = cls.split(/\s+/);
            if (classes.some((c) => c && definedClasses.has(c))) return;
        }
        $(el).replaceWith($(el).contents());
    });
};

const buildExclusionLog = ($, el, reason) => ({
    status: "excluded",
    reason,
    tagName: el?.name || "unknown",
    domPath: buildDomPath($, el),
    htmlPreview: (() => {
        try {
            return previewMarkup($.html(el));
        } catch {
            return "";
        }
    })(),
});

const logNodeExclusion = (logger, payload, debugMode = false) => {
    logger.write("INFO", `Content Filter: ${JSON.stringify(payload)}`);
    if (debugMode) {
        console.log(`    - 🚫 Excluded: ${JSON.stringify(payload)}`);
    }
};

export const isBlacklistedTag = (node) =>
    HARD_BLOCKED_TAGS.has(getTagName(node)) || hasShadowRootAttribute(node);

export const isCustomElement = (node) => getTagName(node).includes("-");

export const hasBlockedAncestor = ($, node) => {
    let current = node?.parent;
    while (current && isElementNode(current)) {
        if (isBlockedRegionNode(current) || hasShadowRootAttribute(current)) {
            return true;
        }
        current = current.parent;
    }
    return false;
};

export const isTextDominantNode = ($, node) => {
    const text = getNodeText($, node);
    if (text.length < 3) return false;
    if (isMostlySymbols(text)) return false;

    const directTextLength = getDirectText($, node).length;
    const directElementChildren = getDirectElementChildren($, node);
    const directElementChildCount = directElementChildren.length;
    const descendantElementCount = getDescendantElementCount($, node);
    const hasOnlyInlineFormattingChildren =
        directElementChildCount > 0 &&
        directElementChildren.every((child) =>
            INLINE_FORMATTING_TAGS.has(getTagName(child)),
        );

    if (directTextLength === 0 && !hasOnlyInlineFormattingChildren) return false;
    if (
        directElementChildCount > 0 &&
        directTextLength < 2 &&
        !hasOnlyInlineFormattingChildren
    ) {
        return false;
    }

    const structuralCost =
        directElementChildCount * 4 + Math.min(descendantElementCount, 8) * 2;
    return text.length >= Math.max(3, structuralCost);
};

export const isEligibleTranslatableNode = ($, node) => {
    if (!isElementNode(node)) return false;
    const tagName = getTagName(node);

    if (CORE_TEXT_TAGS.has(tagName)) {
        const text = getNodeText($, node);
        if (text.length >= 2 && !isMostlySymbols(text)) {
            return true;
        }
    }

    if (STRUCTURAL_ROOT_TAGS.has(tagName)) return false;
    if (isBlacklistedTag(node)) return false;
    if (isCustomElement(node)) return false;
    if (hasBlockedAncestor($, node)) return false;
    if (isInteractiveSubtree($, node)) return false;
    if (!isSimpleTextContainer($, node)) return false;
    return isTextDominantNode($, node);
};

export const collectTranslatableNodes = (
    $,
    root,
    logger,
    debugMode = false,
) => {
    const collected = [];

    const logExcludedSubtree = (node, reason) => {
        if (!isElementNode(node)) return;
        logNodeExclusion(logger, buildExclusionLog($, node, reason), debugMode);
        for (const child of node.children || []) {
            logExcludedSubtree(child, reason);
        }
    };

    const visitChildren = (parent) => {
        for (const child of parent.children || []) {
            if (!isElementNode(child)) continue;

            const tagName = getTagName(child);
            if (isBlacklistedTag(child)) {
                logExcludedSubtree(child, "excluded: blacklisted_tag");
                continue;
            }
            if (isCustomElement(child)) {
                logExcludedSubtree(child, "excluded: custom_element");
                continue;
            }
            if (hasBlockedAncestor($, child)) {
                logExcludedSubtree(child, "excluded: blocked_ancestor");
                continue;
            }
            if (STRUCTURAL_ROOT_TAGS.has(tagName)) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: not_text_dominant"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }
            if (isInteractiveSubtree($, child)) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: interactive_node"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }
            if (!isSimpleTextContainer($, child)) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: not_text_dominant"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }
            const text = getNodeText($, child);
            if (text.length < 3) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: too_short"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }
            if (isMostlySymbols(text)) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: mostly_symbols"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }
            if (!isTextDominantNode($, child)) {
                logNodeExclusion(
                    logger,
                    buildExclusionLog($, child, "excluded: not_text_dominant"),
                    debugMode,
                );
                visitChildren(child);
                continue;
            }

            const content = $(child).html()?.trim();
            if (!content) continue;

            const nodeId = `node_${collected.length}`;
            collected.push({
                id: nodeId,
                content,
                node: child,
            });
        }
    };

    visitChildren(root[0] || root);
    return collected;
};

export const collectVisibleTextNodes = (
    $,
    root,
    logger,
    debugMode = false,
) => {
    const collected = [];
    const rootNode = root?.[0] || root;
    let visitOrder = 0;

    const logExcludedNode = (node, reason) => {
        if (!isElementNode(node)) return;
        logNodeExclusion(
            logger,
            {
                status: "excluded",
                reason,
                tagName: node?.name || "unknown",
                domPath: buildDomPath($, node),
                htmlPreview: (() => {
                    try {
                        return previewMarkup($.html(node));
                    } catch {
                        return "";
                    }
                })(),
            },
            debugMode,
        );
    };

    const visit = (node) => {
        if (!isElementNode(node)) {
            return { textLen: 0, selectedLen: 0 };
        }

        const tagName = getTagName(node);
        const isRootNode = tagName === "html" || tagName === "body";
        const currentOrder = visitOrder++;
        if (VISIBLE_TEXT_EXCLUDED_TAGS.has(tagName)) {
            logExcludedNode(node, "excluded: blacklisted_tag");
            return { textLen: 0, selectedLen: 0 };
        }

        let maxChildSelectedLen = 0;
        for (const child of node.children || []) {
            if (!isElementNode(child)) continue;
            const childStats = visit(child);
            maxChildSelectedLen = Math.max(
                maxChildSelectedLen,
                childStats.selectedLen,
            );
        }

        if (isRootNode) {
            return { textLen: 0, selectedLen: maxChildSelectedLen };
        }

        const text = getNodeText($, node);
        const textLen = text.length;

        if (textLen < 1) {
            return { textLen: 0, selectedLen: maxChildSelectedLen };
        }

        if (isMostlySymbols(text)) {
            logExcludedNode(node, "excluded: mostly_symbols");
            return { textLen, selectedLen: maxChildSelectedLen };
        }

        const childDominates =
            maxChildSelectedLen > 0 && maxChildSelectedLen >= textLen * 0.7;
        if (childDominates) {
            logExcludedNode(node, "excluded: duplicate_parent");
            return { textLen, selectedLen: maxChildSelectedLen };
        }

        const content = $(node).html()?.trim();
        if (!content) {
            return { textLen, selectedLen: maxChildSelectedLen };
        }

        const nodeId = `node_${collected.length}`;
        collected.push({
            id: nodeId,
            content,
            node,
            order: currentOrder,
        });

        return { textLen, selectedLen: Math.max(textLen, maxChildSelectedLen) };
    };

    if (rootNode && isElementNode(rootNode)) {
        visit(rootNode, false);
    }

    if (
        collected.length === 0 &&
        rootNode &&
        isElementNode(rootNode) &&
        getTagName(rootNode) === "body"
    ) {
        const bodyText = getNodeText($, rootNode);
        if (bodyText.length >= 1 && !isMostlySymbols(bodyText)) {
            collected.push({
                id: "node_0",
                content: $(rootNode).html()?.trim() || bodyText,
                node: rootNode,
                order: 0,
            });
        }
    }

    return collected
        .sort((a, b) => a.order - b.order)
        .map(({ order, ...rest }) => rest);
};

const shouldBypassClassification = (classification, translationMode) => {
    const action = classification?.action;
    if (translationMode === "subtitle") {
        if (classification?.reason === "empty") return true;
        return action === "SKIP" || action === "PLACEHOLDER";
    }
    return action === "DROP" || action === "SKIP" || action === "PLACEHOLDER";
};

const buildSubtitleSingleNodePrompt = (sourceLanguage, targetLanguage) => `
Translate this single subtitle cue from ${sourceLanguage} into fluent, natural, easy-to-read ${targetLanguage}.

Rules:
1. Translate only this exact cue.
2. Return only the translated cue text, with no XML wrapper, no Markdown, and no explanation.
3. Do not copy neighboring dialogue.
4. Preserve line breaks only if they remain useful in the target language.
5. Do not add comments, notes, or labels unless they already exist in the source.
`.trim();

const createTerminalProgressRenderer = () => {
    const isDynamic =
        Boolean(process.stdout?.isTTY) &&
        typeof process.stdout.clearLine === "function" &&
        typeof process.stdout.cursorTo === "function";
    let active = false;
    let lastLine = "";

    const clearActiveLine = () => {
        if (!isDynamic || !active) return;
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        active = false;
    };

    return {
        render(line) {
            if (!isDynamic) {
                console.log(line);
                return;
            }
            const nextLine = String(line ?? "");
            if (nextLine === lastLine) return;
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(nextLine);
            active = true;
            lastLine = nextLine;
        },
        println(line) {
            if (!isDynamic) {
                console.log(line);
                return;
            }
            clearActiveLine();
            process.stdout.write(`${line}\n`);
            lastLine = "";
        },
        finish(finalLine = null) {
            if (!isDynamic) {
                if (finalLine) console.log(finalLine);
                return;
            }
            clearActiveLine();
            if (finalLine) {
                process.stdout.write(`${finalLine}\n`);
            }
            lastLine = "";
        },
    };
};

const getTranslationPromptTemplate = (translationMode) => {
    if (translationMode === "html") {
        return HTML_TRANSLATION_PROMPT_TEMPLATE;
    }
    if (translationMode === "pdf") {
        return PDF_TRANSLATION_PROMPT_TEMPLATE;
    }
    if (translationMode === "subtitle") {
        return SUBTITLE_TRANSLATION_PROMPT_TEMPLATE;
    }
    return EPUB_TRANSLATION_PROMPT_TEMPLATE;
};

const estimateNodeTextLength = (html) => {
    const $fragment = loadHtml(`<root>${String(html ?? "")}</root>`);
    return normalizeText($fragment("root").text()).length;
};

const shouldUseEpubStructuralFallback = ($, explicitNodes) => {
    const body = $("body");
    const bodyTextLength = normalizeText((body.length ? body : $.root()).text()).length;
    if (bodyTextLength < 80) return false;

    const explicitTextLength = explicitNodes.reduce(
        (sum, node) => sum + estimateNodeTextLength(node.content),
        0,
    );

    if (explicitNodes.length === 0) return true;
    if (explicitTextLength === 0) return true;
    if (explicitNodes.length <= 2 && explicitTextLength < bodyTextLength * 0.35) {
        return true;
    }
    return explicitTextLength < bodyTextLength * 0.25;
};

const STRUCTURAL_EXEMPT_TITLE_PATTERNS = [
    /toc/i,
    /table\s+of\s+contents/i,
    /contents?/i,
    /copyright/i,
    /title\s*page/i,
    /cover/i,
    /dedication/i,
    /acknowledg/i,
    /preface/i,
    /foreword/i,
    /index/i,
    /bibliograph/i,
    /about\s+the\s+author/i,
    /reviews?/i,
];

const buildEpubStructuralMetrics = (htmlContent, referencedIds, definedClasses) => {
    const $ = loadHtml(htmlContent);
    unwrapUselessSpans($, referencedIds, definedClasses);
    const body = $("body").length ? $("body") : $.root();
    const bodyTextLength = normalizeText(body.text()).length;

    const explicitNodes = [];
    $("p, li, h1, h2, h3, h4, h5, h6, caption, title").each((i, el) => {
        const $el = $(el);
        const originalHtml = $el.html()?.trim();
        if (!originalHtml) return;
        const classification = classifyNode({
            tagName: el.name,
            text: $el.text(),
            html: originalHtml,
        });
        if (shouldBypassClassification(classification, "epub")) return;
        explicitNodes.push({
            id: `node_${i}`,
            content: originalHtml,
            node: el,
        });
    });

    const explicitTextLength = explicitNodes.reduce(
        (sum, node) => sum + estimateNodeTextLength(node.content),
        0,
    );
    const structuralNodes = collectTranslatableNodes(
        $,
        body,
        { write: () => {} },
        false,
    );
    const structuralTextLength = structuralNodes.reduce(
        (sum, node) => sum + estimateNodeTextLength(node.content),
        0,
    );

    return {
        bodyTextLength,
        explicitNodeCount: explicitNodes.length,
        explicitTextLength,
        structuralNodeCount: structuralNodes.length,
        structuralTextLength,
        shouldFallback: shouldUseEpubStructuralFallback($, explicitNodes),
    };
};

const shouldExemptChapterFromStructuralMode = (chapterTitle, metrics) => {
    const title = String(chapterTitle || "").trim();
    if (title && STRUCTURAL_EXEMPT_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
        return true;
    }
    if (!metrics) return false;
    if (metrics.bodyTextLength < 500) return true;
    if (metrics.structuralNodeCount <= 1 && metrics.bodyTextLength < 1200) return true;
    return false;
};

export const detectEpubBookStructuralMode = (
    chapters,
    referencedIds = new Set(),
    definedClasses = new Set(),
) => {
    const analyzable = [];

    for (const chapter of chapters || []) {
        if (!chapter?.html || chapter?.isTOC) continue;
        const metrics = buildEpubStructuralMetrics(
            chapter.html,
            referencedIds,
            definedClasses,
        );
        if (metrics.bodyTextLength < 80) continue;
        analyzable.push({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            ...metrics,
        });
    }

    if (analyzable.length === 0) {
        return {
            enabled: false,
            reason: "no_analyzable_chapters",
            chapterModes: {},
            summary: null,
        };
    }

    const strongStructuralChapters = analyzable.filter((chapter) => {
        if (chapter.explicitNodeCount > 2) return false;
        if (chapter.structuralNodeCount < 3) return false;
        return chapter.structuralTextLength >= chapter.bodyTextLength * 0.45;
    });
    const fallbackChapters = analyzable.filter((chapter) => chapter.shouldFallback);
    const enabled =
        fallbackChapters.length >= Math.max(3, Math.ceil(analyzable.length * 0.45)) ||
        strongStructuralChapters.length >= Math.max(2, Math.ceil(analyzable.length * 0.35));

    const chapterModes = {};
    if (enabled) {
        for (const chapter of analyzable) {
            chapterModes[chapter.chapterId] = {
                preferStructuralNodes:
                    chapter.shouldFallback &&
                    !shouldExemptChapterFromStructuralMode(
                        chapter.chapterTitle,
                        chapter,
                    ),
            };
        }
    }

    return {
        enabled,
        reason: enabled ? "book_level_structural_pattern" : "insufficient_structural_signal",
        chapterModes,
        summary: {
            analyzableChapterCount: analyzable.length,
            fallbackChapterCount: fallbackChapters.length,
            strongStructuralChapterCount: strongStructuralChapters.length,
        },
    };
};

/**
 * 把章节内所有 batch 塞进全局队列，返回一个 Promise。
 * Promise resolve 时该章节已完全翻译完毕（含重试轮次）。
 */
const enqueueChapterTranslation = (
    htmlContent,
    chapterTitle,
    glossary,
    translationConfig,
    batchQueue,
    logger,
    referencedIds,
    definedClasses,
    translationMode = "epub",
    debugMode = false,
    chapterTranslationOptions = {},
) => {
    const $ = loadHtml(htmlContent);
    let subtitleProgress = null;
    const subtitleProgressRenderer =
        translationMode === "subtitle" ? createTerminalProgressRenderer() : null;
    const subtitleStatusLine = (line) => {
        if (subtitleProgressRenderer) {
            subtitleProgressRenderer.println(line);
            return;
        }
        console.log(line);
    };

    const resumeFailedOnly = Boolean(
        chapterTranslationOptions?.resumeFailedOnly,
    );
    let skippedNodeCount = 0;

    // 覆盖率审计：按文本节点位置/身份核对，避免子串匹配掩盖漏翻
    const AUDIT_ATTR = "data-wasabi-audit";
    const markAudit = (node, kind) => {
        if (!node) return;
        try {
            $(node).attr(AUDIT_ATTR, kind);
        } catch {
            // 标记失败不影响翻译
        }
    };
    const walkTextNodes = (visitor) => {
        const rootNode = $("body")[0] || $.root()[0];
        if (!rootNode) return;
        const visit = (node) => {
            if (!node) return;
            if (node.type === "text") {
                visitor(node);
                return;
            }
            for (const child of node.children || []) visit(child);
        };
        visit(rootNode);
    };
    const collectTextNodeGaps = () => {
        const gaps = [];
        walkTextNodes((textNode) => {
            const text = normalizeText(textNode.data || "");
            const letterCount = (text.match(/\p{L}/gu) || []).length;
            if (letterCount < 4) return;
            const parent = textNode.parent;
            const tag = String(
                parent?.tagName || parent?.name || "",
            ).toLowerCase();
            if (VISIBLE_TEXT_EXCLUDED_TAGS.has(tag)) return;
            if ($(parent).closest(`[${AUDIT_ATTR}]`).length > 0) return;
            gaps.push({
                id: null,
                reason: "not_selected",
                sample: text.replace(/\s+/g, " ").slice(0, 80),
                letterCount,
            });
        });
        return gaps;
    };
    const isSampleCovered = (sample) => {
        let covered = false;
        walkTextNodes((textNode) => {
            if (covered) return;
            const text = normalizeText(textNode.data || "");
            if (
                text.includes(sample) &&
                $(textNode.parent).closest(`[${AUDIT_ATTR}]`).length > 0
            ) {
                covered = true;
            }
        });
        return covered;
    };
    const mergePreviousCoverageGaps = (coverage) => {
        const previousGaps =
            chapterTranslationOptions?.previousCoverageGaps || [];
        if (previousGaps.length === 0) return coverage;
        const docText = normalizeText(
            ($("body").length ? $("body") : $.root()).text(),
        );
        for (const prev of previousGaps) {
            const sample = normalizeText(prev?.sample || "");
            if (!sample || !docText.includes(sample)) continue;
            if (
                coverage.gaps.some(
                    (gap) => normalizeText(gap.sample || "") === sample,
                )
            ) {
                continue;
            }
            if (isSampleCovered(sample)) continue;
            coverage.gaps.push({ ...prev, carriedOver: true });
        }
        return coverage;
    };

    const collectNodesToTranslate = () => {
        const collected = [];
        const preservedUnits = [];

        if (translationMode !== "html") {
            unwrapUselessSpans($, referencedIds, definedClasses);
        }

        $("table").each((i, el) => {
            const $el = $(el);
            const cellTexts = $el
                .find("th, td")
                .map((_, cell) => $(cell).text())
                .get();
            const classification = classifyNode({
                tagName: el.name,
                text: $el.text(),
                html: $el.html(),
                cellTexts,
            });

            if (classification.action !== "PLACEHOLDER") return;

            const logEntry = buildClassificationLog(
                `table_${i}`,
                classification,
                $el.text(),
            );
            skippedNodeCount++;
            logClassification(
                logger,
                enrichClassificationLog($, el, chapterTitle, logEntry, $.html($el)),
                debugMode,
            );
        });

        if (translationMode === "html") {
            const visibleNodes = collectVisibleTextNodes(
                $,
                $("body").length ? $("body") : $.root(),
                logger,
                debugMode,
            );
            for (const node of visibleNodes) {
                $(node.node).attr("data-t-id", node.id);
                markAudit(node.node, "selected");
            }
            return { collected: visibleNodes, preservedUnits: [] };
        }

        const explicitNodes = [];
        const SELECTABLE_SELECTOR =
            "p, li, h1, h2, h3, h4, h5, h6, caption, title";
        const candidateElements = $(SELECTABLE_SELECTOR).toArray();
        const candidateSet = new Set(candidateElements);
        const unitByElement = new Map();
        const preservedByElement = new Map();
        const decision = new Map();

        const allCandidateDescendants = (el) => {
            const result = [];
            const walk = (node) => {
                for (const child of node.children || []) {
                    if (candidateSet.has(child)) result.push(child);
                    walk(child);
                }
            };
            walk(el);
            return result;
        };

        const nearestCandidateDescendants = (el) => {
            const result = [];
            const walk = (node) => {
                for (const child of node.children || []) {
                    if (candidateSet.has(child)) {
                        result.push(child);
                        continue;
                    }
                    walk(child);
                }
            };
            walk(el);
            return result;
        };

        // 容器剩余可见文本 = 容器文本去掉「后代计划已接管」的子树，
        // 行内包装（strong/em/a/span）里的文字仍算剩余。
        const collectUnhandledText = (el, handledSet) => {
            let text = "";
            const walk = (node) => {
                if (node.type === "text") {
                    text += node.data || "";
                    return;
                }
                if (node !== el && handledSet.has(node)) return;
                for (const child of node.children || []) walk(child);
            };
            walk(el);
            return normalizeText(text);
        };

        const cancelDescendants = (el) => {
            for (const descendant of allCandidateDescendants(el)) {
                unitByElement.delete(descendant);
                preservedByElement.delete(descendant);
                decision.set(descendant, "covered");
            }
        };

        const decide = (el) => {
            if (decision.has(el)) return decision.get(el);
            const $el = $(el);
            const originalHtml = $el.html()?.trim();
            if (!originalHtml) {
                decision.set(el, "defer");
                return "defer";
            }

            const descendants = nearestCandidateDescendants(el);
            for (const descendant of descendants) decide(descendant);
            const handled = new Set(
                descendants.filter((descendant) => {
                    const state = decision.get(descendant);
                    return state === "translate" || state === "preserve";
                }),
            );

            if (descendants.length > 0) {
                const remaining = collectUnhandledText(el, handled);
                const remainingClass = remaining
                    ? classifyTextNode(remaining)
                    : null;
                const remainingTranslatable =
                    remainingClass &&
                    !shouldBypassClassification(
                        remainingClass,
                        translationMode,
                    );
                if (remainingTranslatable) {
                    // 容器接管：撤销后代子计划，避免父子重叠任务
                    cancelDescendants(el);
                    decision.set(el, "translate");
                    unitByElement.set(el, {
                        element: el,
                        content: originalHtml,
                    });
                    return "translate";
                }
                if (remaining && remainingClass) {
                    // 剩余文本按既有分类明确保留，后代计划继续接管其余内容
                    preservedByElement.set(el, {
                        element: el,
                        text: remaining,
                        reason: remainingClass.reason,
                    });
                }
                decision.set(el, "defer");
                return "defer";
            }

            const classification = classifyNode({
                tagName: el.name,
                text: $el.text(),
                html: originalHtml,
            });
            if (shouldBypassClassification(classification, translationMode)) {
                decision.set(el, "preserve");
                preservedByElement.set(el, {
                    element: el,
                    text: $el.text(),
                    reason: classification.reason,
                });
                return "preserve";
            }
            decision.set(el, "translate");
            unitByElement.set(el, { element: el, content: originalHtml });
            return "translate";
        };

        for (const el of candidateElements) decide(el);

        // 计划校验：目标唯一、无祖先/后代重叠、仍连接在当前 DOM
        const validatePlan = (units) => {
            const elements = new Set();
            for (const unit of units) {
                if (elements.has(unit.element)) {
                    return { ok: false, reason: "duplicate_target" };
                }
                elements.add(unit.element);
            }
            for (const unit of units) {
                let parent = unit.element.parent;
                while (parent) {
                    if (elements.has(parent)) {
                        return { ok: false, reason: "overlapping_targets" };
                    }
                    parent = parent.parent;
                }
            }
            const rootNode = $("body")[0] || $.root()[0];
            for (const unit of units) {
                let node = unit.element;
                let connected = false;
                while (node) {
                    if (node === rootNode) {
                        connected = true;
                        break;
                    }
                    node = node.parent;
                }
                if (!connected) {
                    return { ok: false, reason: "detached_target" };
                }
            }
            return { ok: true };
        };

        const planUnits = [...unitByElement.values()];
        const explicitPlanCheck = validatePlan(planUnits);
        let planInvalid = explicitPlanCheck.ok ? null : explicitPlanCheck.reason;

        if (explicitPlanCheck.ok) {
            let counter = 0;
            for (const unit of planUnits) {
                const nodeId = `node_${counter++}`;
                unit.id = nodeId;
                $(unit.element).attr("data-t-id", nodeId);
                markAudit(unit.element, "selected");
                explicitNodes.push({
                    id: nodeId,
                    content: unit.content,
                    node: unit.element,
                });
            }
            for (const item of preservedByElement.values()) {
                const nodeId = `node_${counter++}`;
                preservedUnits.push({
                    id: nodeId,
                    text: item.text,
                    reason: item.reason,
                });
                markAudit(item.element, "preserved");
            }
        } else {
            logger.write(
                "WARN",
                `Explicit node plan rejected (${explicitPlanCheck.reason}); falling back or rebuilding.`,
            );
        }

        const shouldFallback =
            translationMode === "epub" &&
            (
                chapterTranslationOptions?.preferStructuralNodes ||
                shouldUseEpubStructuralFallback($, explicitNodes)
            );

        if (shouldFallback) {
            const root = $("body").length ? $("body") : $.root();
            const structuralNodes = collectTranslatableNodes(
                $,
                root,
                logger,
                debugMode,
            );
            const structuralCheck = validatePlan(
                structuralNodes.map((node) => ({ element: node.node })),
            );

            if (structuralNodes.length > 0 && structuralCheck.ok) {
                logger.write(
                    "INFO",
                    `Content Filter: ${JSON.stringify({
                        status: "fallback",
                        mode: chapterTranslationOptions?.preferStructuralNodes
                            ? "epub_book_structural_mode"
                            : "epub_structural_nodes",
                        explicitNodeCount: explicitNodes.length,
                        structuralNodeCount: structuralNodes.length,
                    })}`,
                );

                for (const node of structuralNodes) {
                    $(node.node).attr("data-t-id", node.id);
                    markAudit(node.node, "selected");
                    collected.push({
                        id: node.id,
                        content: node.content,
                        node: node.node,
                    });
                }
                // 结构回退覆盖全文，显式路径的保留项不再计为漏选
                preservedUnits.length = 0;
                planInvalid = null;
            } else if (structuralNodes.length > 0) {
                logger.write(
                    "WARN",
                    `Structural node plan rejected (${structuralCheck.reason}).`,
                );
            }
        }

        if (collected.length === 0) {
            for (const node of explicitNodes) {
                $(node.node).attr("data-t-id", node.id);
                markAudit(node.node, "selected");
                collected.push({
                    id: node.id,
                    content: node.content,
                    node: node.node,
                });
            }
        }

        return { collected, preservedUnits, planInvalid };
    };

    const collectResult = resumeFailedOnly
        ? {
              collected: collectFailedNodes($, "data-t-id").map((node) => {
                  const $el = $(`[data-t-id="${node.id}"]`);
                  markAudit($el.get(0), "selected");
                  return {
                      id: node.id,
                      content: node.content,
                      node: $el.get(0),
                  };
              }),
              preservedUnits: [],
          }
        : collectNodesToTranslate();
    const nodesToTranslate = collectResult.collected;
    const preservedUnits = collectResult.preservedUnits;

    // 章节级计划状态：written 只能由真实写回产生，DOM 标记仅用于定位/续翻
    const planState = new Map();
    for (const unit of nodesToTranslate) {
        planState.set(unit.id, {
            id: unit.id,
            element: unit.node,
            state: "pending",
            sourceDigest: computeTextDigest(unit.content || ""),
            outputDigest: null,
            failureCode: null,
            retryable: null,
        });
    }

    if (nodesToTranslate.length === 0) {
        if (resumeFailedOnly) {
            // 续翻请求但没有任何失败标记：缓存不可信，不能当作已完成。
            // 正常流程不会走到这里（调用方只在存在标记时才请求续翻），此处为兜底。
            return Promise.resolve({
                html: $.xml(),
                status: "failed",
                failedNodeIds: [],
                totalNodes: 0,
                translatedNodes: 0,
                error: "resume requested but cache has no failure markers",
            });
        }
        // 零节点也必须走覆盖率审计：可见文本未被处理时不得 complete
        const previousPlan = chapterTranslationOptions?.previousPlan || null;
        const coverage = mergePreviousCoverageGaps(
            computeCoverageAudit({
                selectedUnits: [],
                preservedUnits,
                failedNodeIds: [],
                textNodeGaps: collectTextNodeGaps(),
            }),
        );
        if (collectResult.planInvalid) {
            coverage.gaps.push({
                id: null,
                reason: "plan_invalid",
                sample: collectResult.planInvalid,
                letterCount: 0,
            });
        }
        const zeroStatus = coverage.gaps.length > 0 ? "failed" : "complete";
        const rawHtml = $.xml();
        const cleanHtml = stripAuditMarkers(rawHtml);
        return Promise.resolve({
            html: cleanHtml,
            cacheHtml: zeroStatus === "complete" ? cleanHtml : rawHtml,
            status: zeroStatus,
            failedNodeIds: [],
            failedNodes: [],
            nodes: [],
            writtenNodes: previousPlan?.writtenNodes ?? 0,
            requiresSourceRebuild: Boolean(collectResult.planInvalid),
            protocolVersion: TRANSLATION_PIPELINE_VERSION,
            totalNodes: previousPlan?.totalNodes ?? 0,
            translatedNodes: previousPlan?.writtenNodes ?? 0,
            coverage,
        });
    }

    if (translationMode === "subtitle") {
        subtitleProgress = {
            totalNodes: nodesToTranslate.length,
            completedNodes: 0,
            completedBatches: 0,
            failedBatches: 0,
            nextReportAt: 0,
        };
        subtitleProgressRenderer.render(
            `    - 🎞️ Subtitle progress: 0/${subtitleProgress.totalNodes} cues (0%)`,
        );
    }

    const makeProcessor = () => ({
        attrName: "data-t-id",
        targetLanguage: translationConfig.targetLanguage,
        criticProvider: chapterTranslationOptions?.criticProvider,
        planState,
        prompt: (batchNodes) => {
            const batchText = batchNodes
                .map((n) => n.content)
                .join(" ")
                .toLowerCase();
            const relevantEntries = Object.entries(glossary).filter(([term]) =>
                batchText.includes(term.toLowerCase()),
            );
            const glossaryMarkdown =
                relevantEntries.length > 0
                    ? `\nGLOSSARY (Prefer these, but adapt if context requires):\n${relevantEntries
                          .map(([en, zh]) => `- ${en}: ${zh}`)
                          .join("\n")}\n`
                    : "";
            const promptTemplate = getTranslationPromptTemplate(
                translationMode,
            );
            const liveBookBible =
                chapterTranslationOptions?.livingMemoryStore?.getSnapshot?.() ||
                chapterTranslationOptions?.bookBible;
            const bookBibleMarkdown = liveBookBible
                ? formatBookBibleForPrompt(liveBookBible)
                : "";

            let priorContextMarkdown = "";
            const retriever = chapterTranslationOptions?.contextRetriever;
            if (retriever && relevantEntries.length > 0) {
                const hits = retriever.queryContext(
                    relevantEntries.map(([term]) => term),
                    2,
                );
                if (hits.length > 0) {
                    priorContextMarkdown = `\nPRIOR CONTEXT (from earlier chapters; keep terminology and pronouns consistent):\n${hits
                        .map((hit) => `- [${hit.chapterId}] ${hit.text}`)
                        .join("\n")}\n`;
                }
            }

            const basePrompt = promptTemplate
                .replace(
                    "{{TARGET_LANGUAGE}}",
                    translationConfig.targetLanguage,
                )
                .replace(
                    "{{SOURCE_LANGUAGE}}",
                    translationConfig.sourceLanguage,
                )
                .replace("{{CHAPTER_TITLE}}", chapterTitle)
                .replace("{{BOOK_BIBLE_BLOCK}}", bookBibleMarkdown)
                .replace("{{GLOSSARY_BLOCK}}", glossaryMarkdown)
                .replace(
                    "{{STYLE_GUIDE}}",
                    buildStyleGuide(translationConfig.targetLanguage),
                )
                .replace("{{PRIOR_CONTEXT_BLOCK}}", priorContextMarkdown)
                .trim();
            return priorContextMarkdown && !promptTemplate.includes("{{PRIOR_CONTEXT_BLOCK}}")
                ? `${basePrompt}\n${priorContextMarkdown}`
                : basePrompt;
        },
        singleNodePrompt:
            translationMode === "subtitle"
                ? () =>
                      buildSubtitleSingleNodePrompt(
                          translationConfig.sourceLanguage,
                          translationConfig.targetLanguage,
                      )
                : null,
    });

    // 非重试结构失败（目标缺失/歧义/身份变化）不参与后续重试
    const structuralFailures = new Map();
    const recordOutcomes = (outcomes) => {
        for (const outcome of outcomes) {
            for (const failure of outcome.result?.failedNodes || []) {
                if (!failure.retryable) {
                    structuralFailures.set(failure.id, failure.code);
                }
            }
        }
    };

    const dispatchRound = async (nodes, processor, options = {}) => {
        const batchingOptions = getBatchingOptions(translationMode);
        const batches =
            translationMode === "pdf"
                ? nodes.map((node) => [node])
                : splitIntoBatches(nodes, {
                      ...batchingOptions,
                      ...(options.nodeLimit
                          ? { nodeLimit: options.nodeLimit }
                          : {}),
                  });
        const dispatchOptions =
            translationMode === "subtitle"
                ? {
                      onTaskSuccess: (batch) => {
                          if (!subtitleProgress) return;
                          subtitleProgress.completedBatches += 1;
                          subtitleProgress.completedNodes += batch.length;
                          const percent = Math.min(
                              100,
                              Math.floor(
                                  (subtitleProgress.completedNodes /
                                      Math.max(subtitleProgress.totalNodes, 1)) *
                                      100,
                              ),
                          );
                          if (
                              percent >= subtitleProgress.nextReportAt ||
                              subtitleProgress.completedNodes >=
                                  subtitleProgress.totalNodes
                          ) {
                              subtitleProgressRenderer.render(
                                  `    - ⏱️ Subtitle progress: ${subtitleProgress.completedNodes}/${subtitleProgress.totalNodes} cues (${percent}%), batches=${subtitleProgress.completedBatches}, failedBatches=${subtitleProgress.failedBatches}`,
                              );
                              subtitleProgress.nextReportAt += 10;
                          }
                      },
                      onTaskFailure: () => {
                          if (!subtitleProgress) return;
                          subtitleProgress.failedBatches += 1;
                      },
                  }
                : {};
        const outcomes = await Promise.all(
            dispatchBatches(
                batches,
                $,
                processor,
                batchQueue,
                logger,
                dispatchOptions,
            ),
        );
        recordOutcomes(outcomes);
        return outcomes;
    };

    const dispatchSplitRetryRounds = async (
        failedNodes,
        processor,
        roundLabel,
        maxRounds,
    ) => {
        let currentNodes = failedNodes.filter(
            (node) => !structuralFailures.has(node.id),
        );
        for (let round = 1; round <= maxRounds; round++) {
            if (currentNodes.length === 0) return;
            const nextNodeLimit = Math.max(
                2,
                Math.ceil(currentNodes.length / Math.pow(2, round)),
            );
            subtitleStatusLine(
                `    - ↘️ [${roundLabel}] Retrying ${currentNodes.length} failed node(s) in smaller subtitle batches (Round ${round}/${maxRounds}, nodeLimit=${nextNodeLimit})...`,
            );
            recordOutcomes(
                await Promise.all(
                    dispatchBatches(
                        splitIntoBatches(currentNodes, {
                            ...getBatchingOptions(translationMode),
                            nodeLimit: nextNodeLimit,
                        }),
                        $,
                        processor,
                        batchQueue,
                        logger,
                    ),
                ),
            );
            currentNodes = collectFailedNodes($, processor.attrName).filter(
                (node) => !structuralFailures.has(node.id),
            );
        }
    };

    const fallbackToSingleNodes = async (roundLabel, processor) => {
        const failedNodes = collectFailedNodes($, processor.attrName).filter(
            (node) => !structuralFailures.has(node.id),
        );
        if (failedNodes.length === 0) return;

        subtitleStatusLine(
            `    - ↘️ [${roundLabel}] Falling back to single-node retries for ${failedNodes.length} node(s)...`,
        );

        const singleNodeBatches = failedNodes.map((node) => [node]);
        recordOutcomes(
            await Promise.all(
                dispatchBatches(
                    singleNodeBatches,
                    $,
                    processor,
                    batchQueue,
                    logger,
                ),
            ),
        );

        const unresolvedNodes = collectFailedNodes(
            $,
            processor.attrName,
        ).filter((node) => !structuralFailures.has(node.id));
        if (unresolvedNodes.length === 0) return;

        const unresolvedIds = unresolvedNodes.map((node) => node.id);
        logger.write(
            "WARN",
            `Chapter "${roundLabel}" has ${unresolvedIds.length} unresolved node(s) after single-node fallback: ${unresolvedIds.join(", ")}`,
        );
        subtitleStatusLine(
            `    - ⚠️ [${roundLabel}] ${unresolvedIds.length} node(s) could not be translated and were left as source text.`,
        );
        // 保留 data-t-id 失败标记：章节状态标记为 partial，续跑时只补这些节点。
    };

    // 把首轮所有 batch 入队，返回一个 Promise chain：
    // 首轮完成 → 检查失败节点 → 最多 3 轮重试 → resolve 最终 HTML
    const runRound = async (nodes, roundLabel) => {
        const processor = makeProcessor();
        await dispatchRound(nodes, processor);

        const MAX_RETRY_ROUNDS = translationMode === "subtitle" ? 2 : 3;
        for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
            const failedNodes = collectFailedNodes(
                $,
                processor.attrName,
            ).filter((node) => !structuralFailures.has(node.id));
            if (failedNodes.length === 0) break;
            // 截断/格式类失败：重试时逐步缩小批次，降低再次截断概率
            const nodeLimit = Math.max(
                2,
                Math.ceil(failedNodes.length / Math.pow(2, round)),
            );
            subtitleStatusLine(
                `    - ⚠️ [${roundLabel}] Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS}, nodeLimit=${nodeLimit})...`,
            );
            await dispatchRound(failedNodes, processor, { nodeLimit });
        }

        if (translationMode === "subtitle") {
            const failedNodes = collectFailedNodes($, processor.attrName);
            await dispatchSplitRetryRounds(failedNodes, processor, roundLabel, 2);
        }

        await fallbackToSingleNodes(roundLabel, processor);
    };

    // 返回整个异步链，但 enqueue 动作是立即发生的（不等 await）
    return runRound(nodesToTranslate, chapterTitle).then(() => {
        subtitleProgressRenderer?.finish(
            subtitleProgress
                ? `    - ✅ Subtitle progress: ${subtitleProgress.completedNodes}/${subtitleProgress.totalNodes} cues (100%), batches=${subtitleProgress.completedBatches}, failedBatches=${subtitleProgress.failedBatches}`
                : null,
        );
        if (debugMode && skippedNodeCount > 0) {
            console.log(
                `    - ⏭️ Skipped translation for ${skippedNodeCount} classified node(s); original content preserved.`,
            );
        }

        // EPUB 模式下：提取并格式化译者注，挂载 EPUB 3 脚注区
        const finalizeHtml = () => {
            if (translationMode !== "epub") return $.xml();
            const chapterNotes = [];
            const stableChapterId =
                chapterTranslationOptions?.chapterId || chapterTitle;
            // 续跑时已有脚注角标，从最大编号继续，避免重复 id
            const startIndex = findMaxFootnoteIndex($.xml());
            $("p, li, h1, h2, h3, h4, h5, h6, caption").each((_, el) => {
                const inner = $(el).html();
                if (inner && inner.includes("<ws-note")) {
                    $(el).html(
                        extractAndFormatNotes(
                            inner,
                            chapterNotes,
                            stableChapterId,
                            { startIndex },
                        ),
                    );
                }
            });
            if (chapterNotes.length > 0) {
                console.log(`    - 📑 [${chapterTitle}] Embedded ${chapterNotes.length} cultural footnote(s) (<aside epub:type="footnote">).`);
                return appendFootnotesSection($.xml(), chapterNotes);
            }
            return $.xml();
        };

        const previousPlan = chapterTranslationOptions?.previousPlan || null;
        const pendingFailed = collectFailedNodes($, "data-t-id").filter(
            (node) => !structuralFailures.has(node.id),
        );
        const structuralFailed = [...structuralFailures.entries()].map(
            ([id, code]) => ({ id, code, retryable: false }),
        );
        const newlyWritten = [...planState.values()].filter(
            (record) => record.state === "written",
        ).length;
        const totalNodes =
            previousPlan?.totalNodes ?? planState.size;
        const translatedNodes =
            (previousPlan?.writtenNodes ?? 0) + newlyWritten;
        const failedNodeIds = [
            ...pendingFailed.map((node) => node.id),
            ...structuralFailed.map((item) => item.id),
        ];
        const requiresSourceRebuild =
            structuralFailures.size > 0 || Boolean(collectResult.planInvalid);
        const coverage = mergePreviousCoverageGaps(
            computeCoverageAudit({
                selectedUnits: nodesToTranslate,
                preservedUnits,
                failedNodeIds,
                textNodeGaps: collectTextNodeGaps(),
            }),
        );
        if (collectResult.planInvalid) {
            coverage.gaps.push({
                id: null,
                reason: "plan_invalid",
                sample: collectResult.planInvalid,
                letterCount: 0,
            });
        }
        const hasCoverageGaps = coverage.gaps.length > 0;
        const allPlannedWritten = [...planState.values()].every(
            (record) => record.state === "written",
        );
        const status =
            pendingFailed.length === 0 &&
            structuralFailed.length === 0 &&
            !hasCoverageGaps &&
            !collectResult.planInvalid &&
            allPlannedWritten
                ? "complete"
                : translatedNodes === 0
                  ? "failed"
                  : "partial";
        if (status === "complete") {
            $("[data-t-id]").removeAttr("data-t-id");
        }
        // 缓存 partial 章节时保留审计标记，续跑才能恢复「已译/已保留」状态；
        // 输出与 complete 缓存使用剥离后的干净 HTML。
        const finalizedHtml = finalizeHtml();
        const cleanHtml = stripAuditMarkers(finalizedHtml);

        return {
            html: cleanHtml,
            cacheHtml: status === "complete" ? cleanHtml : finalizedHtml,
            status,
            failedNodeIds,
            failedNodes: [
                ...pendingFailed.map((node) => ({
                    id: node.id,
                    code: "UNRESOLVED",
                    retryable: true,
                })),
                ...structuralFailed,
            ],
            nodes: [...planState.values()].map((record) => ({
                id: record.id,
                state: record.state,
                sourceDigest: record.sourceDigest,
                outputDigest: record.outputDigest,
                failureCode: structuralFailures.get(record.id) || null,
            })),
            writtenNodes: translatedNodes,
            requiresSourceRebuild,
            protocolVersion: TRANSLATION_PIPELINE_VERSION,
            totalNodes,
            translatedNodes,
            coverage,
        };
    });
};

const stripAuditMarkers = (html) => {
    const $ = loadHtml(html);
    $("[data-wasabi-audit]").removeAttr("data-wasabi-audit");
    return $.xml();
};

const stripTranslationMarkers = (html) => {
    const $ = loadHtml(html);
    $("[data-t-id]").removeAttr("data-t-id");
    $("[data-wasabi-audit]").removeAttr("data-wasabi-audit");
    return $.xml();
};

const hasTranslationMarkers = (html) =>
    typeof html === "string" && /data-t-id\s*=/.test(html);

const hasOverlappingTranslationMarkers = (html) => {
    if (!hasTranslationMarkers(html)) return false;
    const $ = loadHtml(html);
    let overlapping = false;
    $("[data-t-id]").each((_, el) => {
        if ($(el).parents("[data-t-id]").length > 0) {
            overlapping = true;
        }
    });
    return overlapping;
};

// 兼容旧调用（headings.js 等地方可能直接调用）
export const translateHtmlContent = async (
    htmlContent,
    chapterTitle,
    glossary,
    translationConfig,
    aiProvider,
    batchQueue,
    logger,
    referencedIds = new Set(),
    definedClasses = new Set(),
    translationMode = "epub",
    debugMode = false,
    chapterTranslationOptions = {},
) => {
    return enqueueChapterTranslation(
        htmlContent,
        chapterTitle,
        glossary,
        translationConfig,
        batchQueue,
        logger,
        referencedIds,
        definedClasses,
        translationMode,
        debugMode,
        chapterTranslationOptions,
    );
};

// =================== 全书翻译调度 ===================
export const performTranslation = async (
    sortedChapters,
    chapterMap,
    glossary,
    translationConfig,
    aiProvider,
    batchQueue,
    logger,
    cache,
    referencedIds = new Set(),
    definedClasses = new Set(),
    translationMode = "epub",
    debugMode = false,
    bookTranslationOptions = {},
) => {
    console.log(
        translationMode === "subtitle"
            ? "\n✍️ Step 4: Translating Subtitle Content..."
            : "\n✍️ Step 4: Translating Book Content...",
    );
    let skipped = 0;
    const total = sortedChapters.length;
    const chapterStatus = cache.loadChapterStatus();
    // 注册术语对照，供双语前文检索使用
    bookTranslationOptions?.contextRetriever?.setGlossary?.(glossary);

    // 只有「状态为 complete 且 HTML 无失败标记」的缓存才允许跳过；
    // partial / failed / 状态缺失 / 状态与 HTML 不一致 一律进入续翻。
    const pending = [];
    const results = new Map();
    for (let i = 0; i < total; i++) {
        const ch = sortedChapters[i];
        if (ch.isTOC) continue;

        const cached = cache.load(ch.id);
        if (cached) {
            const cachedStatus = chapterStatus[ch.id]?.status;
            const cachedDigest = chapterStatus[ch.id]?.htmlDigest;
            const digestOk =
                !cachedDigest || cachedDigest === computeTextDigest(cached);
            const protocolStale =
                Boolean(cachedStatus) &&
                chapterStatus[ch.id]?.protocolVersion !==
                    TRANSLATION_PIPELINE_VERSION;
            const requiresRebuild = Boolean(
                chapterStatus[ch.id]?.requiresSourceRebuild,
            );
            const overlappingMarkers =
                cachedStatus !== "complete" &&
                hasOverlappingTranslationMarkers(cached);
            if (
                cachedStatus === "complete" &&
                !hasTranslationMarkers(cached) &&
                digestOk &&
                !protocolStale &&
                !requiresRebuild
            ) {
                chapterMap.get(ch.id).html = cached;
                skipped++;
                // 缓存成功章节也进入结果聚合，续跑状态/counts 才准确
                results.set(ch.id, {
                    id: ch.id,
                    title: ch.title,
                    status: "complete",
                    failedNodeIds: [],
                    coverage: chapterStatus[ch.id]?.coverage ?? null,
                    cached: true,
                });
                // 缓存恢复的章节也进入前文检索索引，保证续跑与新跑上下文一致
                const retriever = bookTranslationOptions?.contextRetriever;
                if (retriever?.indexChapter) {
                    try {
                        retriever.indexChapter(ch.id, loadHtml(cached).text());
                    } catch {
                        // 索引失败不影响翻译流程
                    }
                }
                console.log(
                    `⏭️  [${i + 1}/${total}] Skipped (verified cached): "${ch.title}"`,
                );
                continue;
            }
            if (protocolStale || requiresRebuild || overlappingMarkers) {
                console.log(
                    `♻️ [${i + 1}/${total}] Cache needs rebuild (${protocolStale ? "protocol" : requiresRebuild ? "structural failure" : "overlapping markers"}); retranslating source: "${ch.title}"`,
                );
                pending.push({
                    ch,
                    index: i,
                    resumeFailedOnly: false,
                    sourceHtml: ch.html,
                });
                continue;
            }
            if (!digestOk) {
                console.log(
                    `♻️ [${i + 1}/${total}] Cache digest mismatch for "${ch.title}"; retranslating source.`,
                );
                pending.push({
                    ch,
                    index: i,
                    resumeFailedOnly: false,
                    sourceHtml: ch.html,
                });
                continue;
            }
            if (hasTranslationMarkers(cached)) {
                console.log(
                    `🔁 [${i + 1}/${total}] Resuming ${cachedStatus || "unverified"} cache: "${ch.title}" (${chapterStatus[ch.id]?.failedNodeIds?.length ?? "?"} failed node(s))`,
                );
                pending.push({
                    ch,
                    index: i,
                    resumeHtml: cached,
                    resumeFailedOnly: true,
                    sourceHtml: ch.html,
                });
                continue;
            }
            // 状态非 complete（或缺失）但 HTML 没有任何失败标记：缓存不可信，
            // 不能零请求判定完成，改为重翻原始章节。
            console.log(
                `♻️ [${i + 1}/${total}] Discarding unverifiable cache (status=${cachedStatus || "missing"}, no failure markers); retranslating source: "${ch.title}"`,
            );
            pending.push({
                ch,
                index: i,
                resumeFailedOnly: false,
                sourceHtml: ch.html,
            });
            continue;
        }

        pending.push({
            ch,
            index: i,
            resumeFailedOnly: false,
            sourceHtml: ch.html,
        });
    }

    const memoryTasks = [];
    const CHAPTER_WINDOW_SIZE = 4;
    // 章节窗口调度：窗口内批次并发，窗口之间串行并提交记忆快照
    const runChapter = async ({
        ch,
        index,
        resumeHtml,
        resumeFailedOnly,
        sourceHtml,
    }) => {
            const translationPromise = enqueueChapterTranslation(
                resumeHtml ?? ch.html,
                ch.title,
                glossary,
                translationConfig,
                batchQueue,
                logger,
                referencedIds,
                definedClasses,
                translationMode,
                debugMode,
                {
                    ...(bookTranslationOptions?.chapterModes?.[ch.id] || {}),
                    bookBible: bookTranslationOptions?.bookBible,
                    livingMemoryStore: bookTranslationOptions?.livingMemoryStore,
                    contextRetriever: bookTranslationOptions?.contextRetriever,
                    chapterId: ch.id,
                    previousCoverageGaps:
                        chapterStatus[ch.id]?.coverage?.gaps || [],
                    previousPlan: chapterStatus[ch.id]
                        ? {
                              totalNodes:
                                  chapterStatus[ch.id].totalNodes ?? 0,
                              writtenNodes:
                                  chapterStatus[ch.id].writtenNodes ?? 0,
                              nodes: chapterStatus[ch.id].nodes || [],
                          }
                        : null,
                    resumeFailedOnly,
                },
            );

            // 每章独立 then：完成后立即写 cache，不等其他章节
            return translationPromise
                .then((result) => {
                    const status =
                        result?.status === "failed"
                            ? "failed"
                            : result?.status === "partial"
                              ? "partial"
                              : "complete";
                    const failedNodeIds = result?.failedNodeIds || [];
                    // 摘要必须与缓存保存的内容完全一致，否则续跑会误判缓存损坏
                    const cacheHtml = result.cacheHtml ?? result.html;
                    chapterStatus[ch.id] = {
                        status,
                        failedNodeIds,
                        totalNodes: result?.totalNodes ?? 0,
                        translatedNodes: result?.translatedNodes ?? 0,
                        writtenNodes: result?.writtenNodes ?? 0,
                        nodes: result?.nodes || [],
                        failedNodes: result?.failedNodes || [],
                        requiresSourceRebuild: Boolean(
                            result?.requiresSourceRebuild,
                        ),
                        protocolVersion:
                            result?.protocolVersion ??
                            TRANSLATION_PIPELINE_VERSION,
                        coverage: result?.coverage ?? null,
                        htmlDigest: computeTextDigest(cacheHtml),
                        updatedAt: new Date().toISOString(),
                    };
                    // 每章完成即落盘状态，进程中断后仍可续跑
                    cache.saveChapterStatus(chapterStatus);
                    results.set(ch.id, {
                        id: ch.id,
                        title: ch.title,
                        status,
                        failedNodeIds,
                        coverage: result?.coverage ?? null,
                    });

                    if (chapterMap.has(ch.id)) {
                        chapterMap.get(ch.id).html =
                            status === "complete"
                                ? result.html
                                : stripTranslationMarkers(result.html);
                        // 缓存保留 data-t-id 失败标记与审计标记，供下次续跑恢复状态
                        cache.save(ch.id, cacheHtml);

                        if (status === "complete") {
                            console.log(
                                `✅ [${index + 1}/${total}] Done: "${ch.title}"`,
                            );

                            // 已译章节进入前文检索索引
                            const retriever =
                                bookTranslationOptions?.contextRetriever;
                            if (retriever?.indexChapter) {
                                try {
                                    retriever.indexChapter(
                                        ch.id,
                                        loadHtml(result.html).text(),
                                    );
                                } catch {
                                    // 索引失败不影响翻译流程
                                }
                            }

                            // 增量记忆提取：收集 Promise，翻译结束后统一等待
                            if (bookTranslationOptions?.livingMemoryStore) {
                                memoryTasks.push(
                                    extractChapterMemory(
                                        result.html,
                                        bookTranslationOptions.livingMemoryStore,
                                        bookTranslationOptions?.memoryProvider ||
                                            aiProvider,
                                        logger,
                                        translationConfig,
                                        ch.title,
                                        {
                                            sourceText: (() => {
                                                try {
                                                    return loadHtml(
                                                        sourceHtml || "",
                                                    ).text();
                                                } catch {
                                                    return "";
                                                }
                                            })(),
                                            chapterId: ch.id,
                                        },
                                    ),
                                );
                            }
                        } else if (status === "partial") {
                            const coverageGaps =
                                result?.coverage?.gaps?.length ?? 0;
                            console.log(
                                `⚠️ [${index + 1}/${total}] Partial: "${ch.title}" (${failedNodeIds.length} node(s) failed${coverageGaps > 0 ? `, ${coverageGaps} coverage gap(s)` : ""}, cache kept for resume)`,
                            );
                        } else {
                            console.log(
                                `❌ [${index + 1}/${total}] Failed: "${ch.title}" (all ${failedNodeIds.length} node(s) failed, cache kept for resume)`,
                            );
                        }
                    }
                })
                .catch((e) => {
                    chapterStatus[ch.id] = {
                        status: "failed",
                        failedNodeIds: [],
                        error: String(e?.message || e),
                        updatedAt: new Date().toISOString(),
                    };
                    cache.saveChapterStatus(chapterStatus);
                    results.set(ch.id, {
                        id: ch.id,
                        title: ch.title,
                        status: "failed",
                        failedNodeIds: [],
                    });
                    logger.write(
                        "ERROR",
                        `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
                    );
                    console.log(`❌ [${index + 1}/${total}] Failed: "${ch.title}"`);
                });
    };

    for (let start = 0; start < pending.length; start += CHAPTER_WINDOW_SIZE) {
        const windowItems = pending.slice(start, start + CHAPTER_WINDOW_SIZE);
        await Promise.all(windowItems.map((item) => runChapter(item)));
        // 每个窗口结束提交记忆快照，降低完成顺序不确定性
        if (memoryTasks.length > 0) {
            await Promise.all(memoryTasks.splice(0));
        }
        cache.saveChapterStatus(chapterStatus);
    }
    cache.saveChapterStatus(chapterStatus);

    // 等待增量记忆提取收敛，避免后处理/缓存清理与提取任务竞争
    if (memoryTasks.length > 0) {
        await Promise.all(memoryTasks);
    }

    if (skipped > 0) {
        console.log(`  ℹ️  ${skipped} chapter(s) restored from cache.`);
    }

    const chapters = [...results.values()];
    const { status, failedChapters, partialChapters } =
        aggregateTranslationResults(chapters);

    return {
        status,
        failedChapters,
        partialChapters,
        chapters,
        total: chapters.length,
        skipped,
        translated: chapters.filter((chapter) => chapter.status === "complete" && !chapter.cached).length,
        failed: failedChapters.length,
        failedIds: failedChapters.map((chapter) => chapter.id),
    };
};

/**
 * 统一状态聚合：所有入口（单阶段、分阶段合并）共用同一个 reducer。
 * - 有失败但仍有成功/部分成功 → partial
 * - 全部失败 → failed
 * - 其余 → complete
 */
export const aggregateTranslationResults = (chapters) => {
    const list = Array.isArray(chapters) ? chapters : [];
    const failedChapters = list.filter((item) => item.status === "failed");
    const partialChapters = list.filter((item) => item.status === "partial");
    const successfulCount = list.filter(
        (item) => item.status === "complete" || item.status === "partial",
    ).length;
    const status =
        failedChapters.length > 0 && successfulCount === 0
            ? "failed"
            : failedChapters.length > 0 || partialChapters.length > 0
              ? "partial"
              : "complete";
    return { status, failedChapters, partialChapters };
};

/**
 * 合并分阶段翻译结果（正文阶段 + 前言阶段）。
 */
export const mergeTranslationReports = (reports) => {
    const list = (reports || []).filter(Boolean);
    const chapters = list.flatMap((report) => report.chapters || []);
    const { status, failedChapters, partialChapters } =
        aggregateTranslationResults(chapters);
    return { status, failedChapters, partialChapters, chapters };
};
