import crypto from "crypto";
import path from "path";
import * as cheerio from "cheerio";
import { loadHtml, normalizeHref } from "../utils.js";
import { normalizeText } from "../content/content-classifier.js";

/**
 * 内存级 EPUB 体检与自愈重构模块 (In-Memory EPUB Doctor & Restructurer)
 *
 * 核心目标：
 * 1. 体检探针 (Diagnostic Probe):
 *    - 扫描内存中的 chapterMap，检查是否存在单文件 > 80KB 且缺乏 h1-h6 语义标题的假章节。
 * 2. 章节智能解构 (Semantic Splitter):
 *    - 优先使用 NCX 锚点提示 (anchor -> navLabel) 定位真实章节边界；
 *    - 无 NCX 时回退到强标题模式 (CHAPTER N / PART N / 第N章)。
 *    - 锚点节点随标题迁入新分片；续片继承上一章上下文。
 * 3. 结构重组 (In-Place Map Reconstruction):
 *    - 原地更新 chapterMap，并返回修复报告与指纹，供链接重写、输出清理和缓存校验使用。
 */

export const EPUB_DOCTOR_VERSION = 2;
const LARGE_CHAPTER_THRESHOLD = 80 * 1024;
const MIN_PART_TEXT_LENGTH = 1500;

const STRONG_BOUNDARY_PATTERN =
    /^(?:chapter|part)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const FRONT_BACK_BOUNDARY_PATTERN =
    /^(?:about the author|preamble|preface|foreword|prologue|epilogue|conclusion|acknowledgments?|afterword|appendix|eula)\b/i;
const NEVER_BOUNDARY_PATTERN =
    /^(?:notes?|exercises?|references?|bibliograph(?:y|ies)|further reading)\b/i;
const PART_TITLE_PATTERN = /^part\s+/i;
const SECTION_NUMBER_PATTERN = /^(\d+)\.\d+/;
const GENERIC_ID_TITLE_PATTERN = /^id[_-]?\d+$/i;

const toPosix = (value) => String(value || "").replace(/\\/g, "/");

/**
 * 从 NCX 提取「原文件路径 -> (anchorId -> navLabel)」提示表。
 * NCX 目录项的锚点通常指向标题前的 <span id="filepos…"/>。
 */
export const buildBoundaryHints = (zipEntries) => {
    const hints = new Map();
    const ncxEntry = (zipEntries || []).find((entry) =>
        entry.entryName.endsWith(".ncx"),
    );
    if (!ncxEntry) return hints;

    try {
        const $ncx = cheerio.load(ncxEntry.getData().toString("utf8"), {
            xmlMode: true,
            decodeEntities: false,
        });
        const ncxBase = toPosix(ncxEntry.entryName).replace(/[^/]+$/, "");
        $ncx("navPoint").each((_, el) => {
            const $np = $ncx(el);
            const label = $np
                .children("navLabel")
                .children("text")
                .first()
                .text()
                .trim();
            const src =
                $np.children("content").attr("src") ||
                $np.find("content").first().attr("src");
            if (!label || !src) return;
            const [rawFile, anchor] = src.split("#");
            if (!anchor) return;
            const resolved = path.posix.normalize(
                path.posix.join(ncxBase, rawFile || ""),
            );
            const key = normalizeHref(resolved);
            if (!hints.has(key)) hints.set(key, new Map());
            hints.get(key).set(anchor, label);
        });
    } catch {
        return new Map();
    }

    return hints;
};

const classifyBoundaryLabel = (label, { hasHint }) => {
    const trimmed = String(label || "").trim();
    if (!trimmed) return "none";
    if (NEVER_BOUNDARY_PATTERN.test(trimmed)) return "none";
    if (STRONG_BOUNDARY_PATTERN.test(trimmed)) return "strong";
    if (hasHint && FRONT_BACK_BOUNDARY_PATTERN.test(trimmed)) return "strong";
    return "none";
};

const isStrongHeadingText = (text) =>
    classifyBoundaryLabel(text, { hasHint: false }) === "strong";

const FALLBACK_HEADING_TAGS = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "div",
]);
const FALLBACK_MAX_HEADING_LENGTH = 90;

/**
 * 无 NCX 提示时的回退判定：只认短标题型节点，排除列表页与以 "Chapter N" 开头的正文段。
 */
const isFallbackStrongNode = ($node, text) => {
    const tag = String($node.get(0)?.tagName || "").toLowerCase();
    if (!FALLBACK_HEADING_TAGS.has(tag)) return false;
    if (text.length > FALLBACK_MAX_HEADING_LENGTH) return false;
    if (/\b(?:table|figure)\s+\d/i.test(text)) return false;
    return isStrongHeadingText(text);
};

const firstVisibleText = (html) => {
    if (!html) return "";
    const $ = loadHtml(html);
    const root = $("body").length ? $("body") : $.root();
    for (const node of root.children().toArray()) {
        const text = normalizeText($(node).text());
        if (text) return text;
    }
    return "";
};

/**
 * 判断某个文本是否极大概率是章节主标题 (Chapter Heading Candidate)
 */
export const isChapterHeadingCandidate = (text) =>
    isStrongHeadingText(normalizeText(text));

/**
 * Index 文件整体保护：首个可见文本为 Index 且包含大量链接/列表时不拆分。
 */
export const isIndexChapter = (chapter) => {
    if (!chapter?.html) return false;
    const $ = loadHtml(chapter.html);
    const root = $("body").length ? $("body") : $.root();
    let firstText = "";
    for (const node of root.children().toArray()) {
        const text = normalizeText($(node).text());
        if (text) {
            firstText = text;
            break;
        }
    }
    if (!/^index$/i.test(firstText)) return false;
    const linkCount = $("a[href]").length;
    const listCount = $("ul, ol").length;
    return linkCount >= 10 || listCount >= 3;
};

const visibleTextLength = (nodes, $) =>
    normalizeText(nodes.map((node) => $(node).text()).join(" "))
        .length;

const inferContinuationTitle = (firstText, chapter, inheritedTitle) => {
    const sectionMatch = firstText.match(SECTION_NUMBER_PATTERN);
    if (sectionMatch) return `Chapter ${sectionMatch[1]}（续）`;
    if (inheritedTitle) return `${inheritedTitle}（续）`;
    const original = String(chapter.title || "").trim();
    if (
        original &&
        !GENERIC_ID_TITLE_PATTERN.test(original) &&
        original !== chapter.id
    ) {
        return original;
    }
    return "Front Matter";
};

/**
 * 检查当前 chapterMap 是否存在非标或超大假章节
 */
export const diagnoseChapterMap = (chapterMap) => {
    let largeFileCount = 0;
    let headingTagCount = 0;

    for (const chapter of chapterMap.values()) {
        if (!chapter || !chapter.html || chapter.isTOC) continue;
        if (isIndexChapter(chapter)) continue;
        const len = Buffer.byteLength(chapter.html, "utf8");
        if (len >= LARGE_CHAPTER_THRESHOLD) {
            largeFileCount++;
        }
        const $ = loadHtml(chapter.html);
        headingTagCount += $("h1, h2, h3").length;
    }

    const needsSplitting =
        largeFileCount >= 1 && headingTagCount <= largeFileCount * 2;

    return {
        needsSplitting,
        largeFileCount,
        headingTagCount,
    };
};

/**
 * 将单个超大 HTML 章节拆分为多个标准小章节
 */
export const splitLargeChapter = (
    chapter,
    splitIndexStart = 1,
    options = {},
) => {
    const $ = loadHtml(chapter.html);
    const body = $("body");
    const root = body.length ? body : $.root();
    // 使用 contents() 以保留 body 直接文本节点；children() 会漏掉它们
    const children = root.contents().toArray();
    const hints = options.hints instanceof Map ? options.hints : null;
    const htmlAttrs = {
        xmlns: "http://www.w3.org/1999/xhtml",
        ...($("html").attr() || {}),
    };
    const bodyAttrs = body.attr() || {};

    const sections = [];
    let currentNodes = [];
    let currentTitle = chapter.title || "Section 1";
    let currentBoundary = null;
    let pendingPrefix = [];
    let pendingHint = null;
    const trailing = [];

    const flushSection = () => {
        if (currentNodes.length === 0 && pendingPrefix.length === 0) return;
        if (pendingPrefix.length > 0) {
            currentNodes.push(...pendingPrefix);
            pendingPrefix = [];
        }
        sections.push({
            title: currentTitle,
            nodes: currentNodes,
            boundary: currentBoundary,
        });
        currentNodes = [];
        currentBoundary = null;
    };

    for (const child of children) {
        const $child = $(child);
        const id = $child.attr("id");
        const text = normalizeText($child.text());
        const hint = hints && id ? hints.get(id) : null;

        if (hint) pendingHint = { label: hint, anchorId: id };

        if (!text) {
            pendingPrefix.push(child);
            continue;
        }

        if (pendingHint) {
            const kind = classifyBoundaryLabel(pendingHint.label, {
                hasHint: true,
            });
            if (kind === "strong") {
                const prefix = pendingPrefix;
                pendingPrefix = [];
                flushSection();
                currentTitle = pendingHint.label;
                currentBoundary = { ...pendingHint, kind };
                currentNodes = [...prefix, child];
                pendingHint = null;
                continue;
            }
            pendingHint = null;
        } else {
            const kind = isFallbackStrongNode($child, text)
                ? "strong"
                : "none";
            if (kind === "strong") {
                const moved = [];
                while (currentNodes.length > 0) {
                    const last = currentNodes[currentNodes.length - 1];
                    if (normalizeText($(last).text())) break;
                    moved.unshift(currentNodes.pop());
                }
                const prefix = pendingPrefix;
                pendingPrefix = [];
                flushSection();
                currentTitle = text;
                currentBoundary = { label: text, anchorId: null, kind };
                currentNodes = [...moved, ...prefix, child];
                continue;
            }
        }

        currentNodes.push(...pendingPrefix, child);
        pendingPrefix = [];
    }

    // 文件末尾的提示锚点：标题可能落在下一个文件开头（Calibre 常见切法），
    // 交给 repair 迁移到下一章，而不是留在本文件末尾。
    if (pendingHint && pendingPrefix.length > 0) {
        trailing.push({
            anchorId: pendingHint.anchorId,
            label: pendingHint.label,
            html: pendingPrefix.map((node) => $.html(node)).join("\n"),
        });
        pendingPrefix = [];
    }
    flushSection();

    if (sections.length === 0) return null;

    // 续片标题继承（仅第一个无边界分片）
    if (!sections[0].boundary) {
        const firstTextNode = sections[0].nodes.find((node) =>
            normalizeText($(node).text()),
        );
        const firstText = firstTextNode ? normalizeText($(firstTextNode).text()) : "";
        sections[0].title = inferContinuationTitle(
            firstText,
            chapter,
            options.inheritedTitle || null,
        );
    }

    // 碎片合并：仅合并「无边界且正文过短」的分片，合法短页与真实章节保留
    const merged = [];
    for (const section of sections) {
        const textLength = visibleTextLength(section.nodes, $);
        const canMerge =
            !section.boundary && textLength < MIN_PART_TEXT_LENGTH;
        if (canMerge && merged.length > 0) {
            merged[merged.length - 1].nodes.push(...section.nodes);
            continue;
        }
        merged.push(section);
    }

    if (merged.length <= 1) return null;
    // 组装新章节 HTML，标题节点升级为 <h1> 且保留原属性
    const headHtml = $("head").html() || "<title>Chapter</title>";
    const newChapters = [];

    const serializeAttrs = (attrs) =>
        Object.entries(attrs || {})
            .map(
                ([key, value]) =>
                    ` ${key}="${String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
            )
            .join("");

    for (let i = 0; i < merged.length; i++) {
        const sec = merged[i];
        // body 的视觉/语言属性（class/style/lang/dir 等）保留到各分片；
        // 原 id 只保留在 body 起点所在分片，避免重复标识。
        const partBodyAttrs = { ...bodyAttrs };
        if (i > 0) delete partBodyAttrs.id;
        const $newDoc = cheerio.load(
            `<html${serializeAttrs(htmlAttrs)}><head>${headHtml}</head><body${serializeAttrs(partBodyAttrs)}></body></html>`,
            { xmlMode: true, decodeEntities: false },
        );
        const $newBody = $newDoc("body");

        for (const node of sec.nodes) {
            const $node = $(node);
            const nodeText = normalizeText($node.text());
            const nodeTag = String($node.get(0)?.tagName || "").toLowerCase();
            const isHeadingNode =
                sec.boundary &&
                nodeText &&
                FALLBACK_HEADING_TAGS.has(nodeTag) &&
                isStrongHeadingText(nodeText);
            if (isHeadingNode) {
                const $h1 = $newDoc("<h1></h1>");
                $h1.attr($node.attr() || {});
                $h1.html($node.html() || "");
                $newBody.append($h1);
                $newBody.append("\n");
            } else {
                $newBody.append($.html(node) + "\n");
            }
        }

        const ext = chapter.entryName
            ? chapter.entryName.slice(chapter.entryName.lastIndexOf("."))
            : ".xhtml";
        const basePath = chapter.entryName
            ? chapter.entryName.slice(0, chapter.entryName.lastIndexOf("."))
            : chapter.id;

        newChapters.push({
            id: `${chapter.id}_part_${splitIndexStart + i}`,
            href: `${basePath}_p${splitIndexStart + i}${ext}`,
            entryName: `${basePath}_p${splitIndexStart + i}${ext}`,
            title: sec.title,
            html: $newDoc.xml(),
            isGeneratedSplit: true,
            originalChapterId: chapter.id,
            originalEntryName: chapter.entryName,
            originalId: chapter.originalId || chapter.id,
            boundaryAnchorIds: sec.boundary?.anchorId
                ? [sec.boundary.anchorId]
                : [],
        });
    }

    return { parts: newChapters, trailing };
};

const computeSourceDigest = (chapterMap) => {
    const hash = crypto.createHash("sha1");
    for (const [id, chapter] of chapterMap.entries()) {
        hash.update(
            `${id}|${chapter.entryName || ""}|${crypto
                .createHash("sha1")
                .update(chapter.html || "")
                .digest("hex")}\n`,
        );
    }
    return hash.digest("hex");
};

const computeBoundaryDigest = (replaced) => {
    const hash = crypto.createHash("sha1");
    for (const item of replaced) {
        hash.update(
            `${item.id}=>${item.partIds.join(",")}|${item.partTitles.join("~")}\n`,
        );
    }
    return hash.digest("hex");
};

/**
 * 对整书的 chapterMap 进行内存就地体检与重构
 */
export const repairChapterMapInPlace = (chapterMap, logger, options = {}) => {
    const hints =
        options.hints instanceof Map
            ? options.hints
            : buildBoundaryHints(options.zipEntries);
    const sourceDigest = computeSourceDigest(chapterMap);
    const diagnosis = diagnoseChapterMap(chapterMap);

    if (!diagnosis.needsSplitting) {
        return {
            repaired: false,
            originalCount: chapterMap.size,
            newCount: chapterMap.size,
            replaced: [],
            sourceDigest,
            fingerprint: crypto
                .createHash("sha1")
                .update(`${EPUB_DOCTOR_VERSION}|${sourceDigest}|none`)
                .digest("hex"),
        };
    }

    console.log(
        `\n🩺 EPUB Doctor: Detected non-standard ebook structure (${diagnosis.largeFileCount} oversized file(s), sparse semantic headings).`,
    );
    console.log("   Auto-repairing and restructing chapters in-memory...");

    const reconstructedMap = new Map();
    const replaced = [];
    let splitCounter = 0;
    let lastStrongTitle = null;
    let carriedTrailing = [];

    const prependTrailingAnchors = (chapter) => {
        if (carriedTrailing.length === 0 || !chapter?.html) return;
        const $ = loadHtml(chapter.html);
        const root = $("body").length ? $("body") : $.root();
        let firstText = "";
        for (const node of root.children().toArray()) {
            const text = normalizeText($(node).text());
            if (text) {
                firstText = text;
                break;
            }
        }
        const matches = carriedTrailing.some((item) =>
            firstText
                .toLowerCase()
                .startsWith(item.label.toLowerCase().slice(0, 12)),
        );
        if (matches) {
            const fragment = carriedTrailing
                .map((item) => item.html)
                .join("\n");
            root.prepend(`${fragment}\n`);
            chapter.html = $.xml();
            carriedTrailing = [];
        }
    };

    for (const [id, chapter] of chapterMap.entries()) {
        prependTrailingAnchors(chapter);
        const len = Buffer.byteLength(chapter.html || "", "utf8");
        if (
            len >= LARGE_CHAPTER_THRESHOLD &&
            !chapter.isTOC &&
            !isIndexChapter(chapter)
        ) {
            const chapterHints = hints.get(
                normalizeHref(toPosix(chapter.entryName)),
            );
            const splitResult = splitLargeChapter(chapter, 1, {
                hints: chapterHints,
                inheritedTitle: lastStrongTitle,
            });
            const splits = splitResult?.parts || null;
            if (splits && splits.length > 1) {
                splitCounter += splits.length;
                console.log(
                    `   ✂️ Restructured "${chapter.title || id}" (${Math.round(len / 1024)}KB) -> ${splits.length} standardized chapters.`,
                );
                for (const newCh of splits) {
                    reconstructedMap.set(newCh.id, newCh);
                }
                replaced.push({
                    id,
                    entryName: chapter.entryName,
                    partIds: splits.map((part) => part.id),
                    partTitles: splits.map((part) => part.title),
                });
                const strongParts = splits.filter(
                    (part) =>
                        part.boundaryAnchorIds.length > 0 ||
                        isStrongHeadingText(part.title),
                );
                if (strongParts.length > 0) {
                    lastStrongTitle = strongParts[strongParts.length - 1].title;
                }
                if (splitResult.trailing?.length) {
                    carriedTrailing = splitResult.trailing;
                }
                continue;
            }
        }

        reconstructedMap.set(id, chapter);
        if (
            GENERIC_ID_TITLE_PATTERN.test(String(chapter.title || "")) ||
            chapter.title === id
        ) {
            const firstText = firstVisibleText(chapter.html);
            if (firstText && firstText.length <= 80) {
                chapter.title = firstText;
            }
        }
        if (isStrongHeadingText(chapter.title)) {
            lastStrongTitle = chapter.title;
        }
    }

    chapterMap.clear();
    for (const [key, value] of reconstructedMap.entries()) {
        chapterMap.set(key, value);
    }

    if (replaced.length === 0) {
        logger?.write?.(
            "INFO",
            "EPUB Doctor: oversized files detected but no safe chapter boundaries found; keeping original structure.",
        );
        console.log(
            "   ⏭️ No safe chapter boundaries found; keeping original structure.\n",
        );
        return {
            repaired: false,
            originalCount: chapterMap.size,
            newCount: chapterMap.size,
            replaced: [],
            sourceDigest,
            fingerprint: crypto
                .createHash("sha1")
                .update(`${EPUB_DOCTOR_VERSION}|${sourceDigest}|none`)
                .digest("hex"),
        };
    }

    const fingerprint = crypto
        .createHash("sha1")
        .update(
            `${EPUB_DOCTOR_VERSION}|${sourceDigest}|${computeBoundaryDigest(replaced)}`,
        )
        .digest("hex");

    logger?.write?.(
        "INFO",
        `EPUB In-Memory Repair complete: split into ${chapterMap.size} chapters (added ${splitCounter} split chapters). Fingerprint: ${fingerprint}`,
    );
    console.log(
        `   ✅ In-memory repair completed. Total chapters now: ${chapterMap.size}.\n`,
    );

    return {
        repaired: true,
        originalCount: diagnosis.largeFileCount,
        newCount: chapterMap.size,
        replaced,
        sourceDigest,
        fingerprint,
    };
};
