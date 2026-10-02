import { isIndexChapter } from "../epub/epubDoctor.js";
import { normalizeText } from "./content-classifier.js";
import { loadHtml } from "../utils.js";

/**
 * 章节角色契约：阅读顺序中的每个章节先归类，规划器/选择器/调度器共用。
 * - toc: 目录页（标记 isTOC，不参与翻译）
 * - index: 索引页（默认排除翻译）
 * - bibliography: 参考文献（默认排除翻译）
 * - front: 前置/后置材料（最后翻译）
 * - content: 正文（优先翻译）
 */

const TOC_TITLE_PATTERN =
    /^(?:table of contents|contents in brief|contents|目录|目次)(?=\b|[\s:：]|$)/i;
const INDEX_TITLE_PATTERN = /^(?:index|索引)(?=\b|[\s:：]|$)/i;
const BIBLIOGRAPHY_TITLE_PATTERN =
    /^(?:bibliograph(?:y|ies)|references|works cited|further reading|参考文献)(?=\b|[\s:：]|$)/i;
const FRONT_TITLE_PATTERN =
    /^(?:cover|title page|copyright|dedication|epigraph|preamble|preface|foreword|introduction|prologue|about the author|acknowledgments?|afterword|epilogue|appendix)(?=\b|[\s:：]|$)/i;

export const EXCLUDED_ROLES = new Set(["index", "bibliography"]);

export const classifyChapterRole = (chapter) => {
    const title = normalizeText(chapter?.title || "");
    if (TOC_TITLE_PATTERN.test(title)) return "toc";
    if (INDEX_TITLE_PATTERN.test(title)) return "index";
    if (BIBLIOGRAPHY_TITLE_PATTERN.test(title)) return "bibliography";
    if (FRONT_TITLE_PATTERN.test(title)) return "front";
    if (chapter?.html && isIndexChapter(chapter)) return "index";
    return "content";
};

const internalLinkCount = (html) => {
    if (!html) return 0;
    try {
        const $ = loadHtml(html);
        let count = 0;
        $("a[href]").each((_, el) => {
            const href = $(el).attr("href") || "";
            if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
                return;
            }
            count++;
        });
        return count;
    } catch {
        return 0;
    }
};

/**
 * 目录页识别：标题命中，或链接密度显著偏高（大量内部跳转 + 文本较短）。
 */
export const detectTocChapterId = (chapters) => {
    const titleMatch = chapters.find((chapter) =>
        TOC_TITLE_PATTERN.test(normalizeText(chapter?.title || "")),
    );
    if (titleMatch) return titleMatch.id;

    let best = null;
    for (const chapter of chapters) {
        if (!chapter?.html) continue;
        const links = internalLinkCount(chapter.html);
        if (links < 5) continue;
        const textLength = normalizeText(
            loadHtml(chapter.html).text(),
        ).length;
        const density = links / Math.max(textLength, 1);
        if (density >= 0.005 && (!best || links > best.links)) {
            best = { id: chapter.id, links };
        }
    }
    return best?.id || null;
};
