import { buildStyleGuide } from "../config.js";
import fs from "fs";
import { loadHtml } from "../utils.js";
import {
    splitIntoBatches,
    dispatchBatches,
    collectFailedNodes,
} from "./batchQueue.js";
import path from "path";
import { fileURLToPath } from "url";
import {
    buildClassificationLog,
    classifyNode,
    normalizeText,
} from "../content/content-classifier.js";

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
    if (directChildren.length > 3) return false;

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
    const directElementChildren = getDirectElementChildren($, node).length;
    const descendantElementCount = getDescendantElementCount($, node);

    if (directTextLength === 0) return false;
    if (directElementChildren > 0 && directTextLength < 2) return false;

    const structuralCost = directElementChildren * 4 + Math.min(descendantElementCount, 8) * 2;
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

const shouldBypassTranslation = (action) =>
    action === "DROP" || action === "SKIP" || action === "PLACEHOLDER";

const getTranslationPromptTemplate = (translationMode) => {
    if (translationMode === "html") {
        return HTML_TRANSLATION_PROMPT_TEMPLATE;
    }
    return EPUB_TRANSLATION_PROMPT_TEMPLATE;
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
) => {
    const $ = loadHtml(htmlContent);

    if (translationMode !== "html") {
        unwrapUselessSpans($, referencedIds, definedClasses);
    }

    let skippedNodeCount = 0;

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

    const nodesToTranslate =
        translationMode === "html"
            ? collectVisibleTextNodes(
                  $,
                  $("body").length ? $("body") : $.root(),
                  logger,
                  debugMode,
              )
            : [];

    if (translationMode !== "html") {
        $("p, li, h1, h2, h3, h4, h5, h6, caption, title").each((i, el) => {
            const $el = $(el);
            const originalHtml = $el.html()?.trim();
            if (!originalHtml) return;

            const nodeId = `node_${i}`;
            const classification = classifyNode({
                tagName: el.name,
                text: $el.text(),
                html: originalHtml,
            });

            if (shouldBypassTranslation(classification.action)) {
                skippedNodeCount++;
                const logEntry = buildClassificationLog(
                    nodeId,
                    classification,
                    $el.text(),
                );
                logClassification(
                    logger,
                    enrichClassificationLog(
                        $,
                        el,
                        chapterTitle,
                        logEntry,
                        $.html($el),
                    ),
                    debugMode,
                );
                return;
            }

            $el.attr("data-t-id", nodeId);
            nodesToTranslate.push({ id: nodeId, content: originalHtml });
        });
    } else {
        for (const node of nodesToTranslate) {
            $(node.node).attr("data-t-id", node.id);
        }
    }

    if (nodesToTranslate.length === 0) {
        $("[data-t-id]").removeAttr("data-t-id");
        return Promise.resolve($.xml());
    }

    const makeProcessor = () => ({
        attrName: "data-t-id",
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
            return promptTemplate.replace(
                "{{TARGET_LANGUAGE}}",
                translationConfig.targetLanguage,
            )
                .replace("{{CHAPTER_TITLE}}", chapterTitle)
                .replace("{{GLOSSARY_BLOCK}}", glossaryMarkdown)
                .replace(
                    "{{STYLE_GUIDE}}",
                    buildStyleGuide(translationConfig.targetLanguage),
                )
                .trim();
        },
    });

    const dispatchRound = async (nodes, processor) => {
        const batches = splitIntoBatches(nodes);
        return Promise.all(
            dispatchBatches(batches, $, processor, batchQueue, logger),
        );
    };

    const fallbackToSingleNodes = async (roundLabel, processor) => {
        const failedNodes = collectFailedNodes($, processor.attrName);
        if (failedNodes.length === 0) return;

        console.log(
            `    - ↘️ [${roundLabel}] Falling back to single-node retries for ${failedNodes.length} node(s)...`,
        );

        const singleNodeBatches = failedNodes.map((node) => [node]);
        await Promise.all(
            dispatchBatches(
                singleNodeBatches,
                $,
                processor,
                batchQueue,
                logger,
            ),
        );

        const unresolvedNodes = collectFailedNodes($, processor.attrName);
        if (unresolvedNodes.length === 0) return;

        const unresolvedIds = unresolvedNodes.map((node) => node.id);
        logger.write(
            "WARN",
            `Chapter "${roundLabel}" has ${unresolvedIds.length} unresolved node(s) after single-node fallback: ${unresolvedIds.join(", ")}`,
        );
        console.log(
            `    - ⚠️ [${roundLabel}] ${unresolvedIds.length} node(s) could not be translated and were left as source text.`,
        );
        for (const unresolvedNode of unresolvedNodes) {
            $(`[${processor.attrName}="${unresolvedNode.id}"]`).removeAttr(
                processor.attrName,
            );
        }
    };

    // 把首轮所有 batch 入队，返回一个 Promise chain：
    // 首轮完成 → 检查失败节点 → 最多 3 轮重试 → resolve 最终 HTML
    const runRound = async (nodes, roundLabel) => {
        const processor = makeProcessor();
        await dispatchRound(nodes, processor);

        const MAX_RETRY_ROUNDS = 3;
        for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
            const failedNodes = collectFailedNodes($, processor.attrName);
            if (failedNodes.length === 0) break;
            console.log(
                `    - ⚠️ [${roundLabel}] Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS})...`,
            );
            await dispatchRound(failedNodes, processor);
        }

        await fallbackToSingleNodes(roundLabel, processor);
    };

    // 返回整个异步链，但 enqueue 动作是立即发生的（不等 await）
    return runRound(nodesToTranslate, chapterTitle).then(() => {
        $("[data-t-id]").removeAttr("data-t-id");
        if (debugMode && skippedNodeCount > 0) {
            console.log(
                `    - ⏭️ Skipped translation for ${skippedNodeCount} classified node(s); original content preserved.`,
            );
        }
        return $.xml();
    });
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
) => {
    console.log("\n✍️ Step 4: Translating Book Content...");
    let skipped = 0;
    const total = sortedChapters.length;

    // 过滤掉已缓存和 TOC，剩余章节同时入队
    const pending = [];
    for (let i = 0; i < total; i++) {
        const ch = sortedChapters[i];
        if (ch.isTOC) continue;

        const cached = cache.load(ch.id);
        if (cached) {
            chapterMap.get(ch.id).html = cached;
            skipped++;
            console.log(
                `⏭️  [${i + 1}/${total}] Skipped (cached): "${ch.title}"`,
            );
            continue;
        }

        pending.push({ ch, index: i });
    }

    // 所有待翻译章节同时入队，各自拿到自己的完成 Promise
    const chapterPromises = pending.map(({ ch, index }) => {
        const translationPromise = enqueueChapterTranslation(
            ch.html,
            ch.title,
            glossary,
            translationConfig,
            batchQueue,
            logger,
            referencedIds,
            definedClasses,
            translationMode,
            debugMode,
        );

        // 每章独立 then：完成后立即写 cache，不等其他章节
        return translationPromise
            .then((translatedHtml) => {
                if (chapterMap.has(ch.id)) {
                    chapterMap.get(ch.id).html = translatedHtml;
                    cache.save(ch.id, translatedHtml);
                    console.log(
                        `✅ [${index + 1}/${total}] Done: "${ch.title}"`,
                    );
                }
            })
            .catch((e) => {
                logger.write(
                    "ERROR",
                    `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
                );
                console.log(`❌ [${index + 1}/${total}] Failed: "${ch.title}"`);
            });
    });

    await Promise.all(chapterPromises);

    if (skipped > 0) {
        console.log(`  ℹ️  ${skipped} chapter(s) restored from cache.`);
    }
};
