import * as cheerio from "cheerio";
import { loadHtml } from "../utils.js";
import { normalizeText } from "../content/content-classifier.js";

/**
 * 内存级 EPUB 体检与自愈重构模块 (In-Memory EPUB Doctor & Restructurer)
 *
 * 核心目标：
 * 1. 体检探针 (Diagnostic Probe):
 *    - 扫描内存中的 chapterMap，检查是否存在单文件 > 80KB 且缺乏 h1-h6 语义标题的假章节。
 * 2. 章节智能解构 (Semantic Splitter):
 *    - 扫描候选段落，识别章节断点（支持带有 "Chapter X"、"第X章"、"数字. 标题" 或独特样式的伪标题）。
 *    - 在内存中把单个超大文件无损物理拆分为标准的多个章节（如 ch01_split_1.xhtml），补全合法的 <h1> 标签。
 * 3. 结构重组 (In-Place Map Reconstruction):
 *    - 原地更新 chapterMap，使后续的 Director Agent、并发翻译和缓存系统直接基于精细化的标准章节运行。
 */

const LARGE_CHAPTER_THRESHOLD = 80 * 1024; // 80KB 以上视为需要体检的超大章节

/**
 * 检查当前 chapterMap 是否存在非标或超大假章节
 */
export const diagnoseChapterMap = (chapterMap) => {
    let largeFileCount = 0;
    let headingTagCount = 0;

    for (const chapter of chapterMap.values()) {
        if (!chapter || !chapter.html || chapter.isTOC) continue;
        const len = Buffer.byteLength(chapter.html, "utf8");
        if (len >= LARGE_CHAPTER_THRESHOLD) {
            largeFileCount++;
        }
        const $ = loadHtml(chapter.html);
        headingTagCount += $("h1, h2, h3").length;
    }

    // 若存在多个超大文件，且整本书的语义标题数远低于文件体积应有的数量，触发重构
    const needsSplitting = largeFileCount >= 1 && headingTagCount <= largeFileCount * 2;

    return {
        needsSplitting,
        largeFileCount,
        headingTagCount,
    };
};

/**
 * 判断某个文本是否极大概率是章节主标题 (Chapter Heading Candidate)
 */
export const isChapterHeadingCandidate = (text) => {
    const trimmed = String(text || "").trim();
    if (trimmed.length < 2 || trimmed.length > 80) return false;

    // 经典英文/中文章节模式
    const patterns = [
        /^(?:chapter|part|section|book)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)/i,
        /^(?:第\s*[0-9一二三四五六七八九十百千万]+\s*[章节部篇回卷])/i,
        /^[0-9]+[\.、\s]+[A-Za-z\u4e00-\u9fa5]/,
        /^(?:introduction|foreword|preface|prologue|epilogue|conclusion|acknowledgments?|afterword|appendix)$/i,
    ];

    return patterns.some((p) => p.test(trimmed));
};

/**
 * 将单个超大 HTML 章节拆分为多个标准小章节
 */
export const splitLargeChapter = (chapter, splitIndexStart = 1) => {
    const $ = loadHtml(chapter.html);
    const body = $("body");
    const children = (body.length ? body : $.root()).children().toArray();

    const sections = [];
    let currentNodes = [];
    let currentTitle = chapter.title || "Section 1";
    let subIndex = splitIndexStart;

    for (const child of children) {
        const $child = $(child);
        const text = normalizeText($child.text());

        // 判定是否达到新章节断点
        if (isChapterHeadingCandidate(text)) {
            if (currentNodes.length > 0) {
                // 保存上一节
                sections.push({
                    subId: `${chapter.id}_part_${subIndex}`,
                    title: currentTitle,
                    nodes: currentNodes,
                });
                subIndex++;
            }
            currentTitle = text;
            currentNodes = [$child];
        } else {
            currentNodes.push($child);
        }
    }

    // 推进最后一节
    if (currentNodes.length > 0) {
        sections.push({
            subId: `${chapter.id}_part_${subIndex}`,
            title: currentTitle,
            nodes: currentNodes,
        });
    }

    if (sections.length <= 1) {
        return null; // 未发现明确断点，保持原状
    }

    // 组装新章节 HTML 并在首个伪标题上规范化 <h1>
    const headHtml = $("head").html() || "<title>Chapter</title>";
    const newChapters = [];

    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const $newDoc = cheerio.load(
            `<html xmlns="http://www.w3.org/1999/xhtml"><head>${headHtml}</head><body></body></html>`,
            { xmlMode: true, decodeEntities: false },
        );
        const $newBody = $newDoc("body");

        for (let nIdx = 0; nIdx < sec.nodes.length; nIdx++) {
            const $n = sec.nodes[nIdx];
            // 若首个段落是伪标题，升级为标准 <h1>
            if (nIdx === 0 && isChapterHeadingCandidate(normalizeText($n.text()))) {
                $newBody.append(`<h1>${$n.html()}</h1>\n`);
            } else {
                $newBody.append($.html($n) + "\n");
            }
        }

        const ext = chapter.entryName ? chapter.entryName.slice(chapter.entryName.lastIndexOf(".")) : ".xhtml";
        const basePath = chapter.entryName ? chapter.entryName.slice(0, chapter.entryName.lastIndexOf(".")) : chapter.id;

        newChapters.push({
            id: sec.subId,
            href: `${basePath}_p${i + 1}${ext}`,
            entryName: `${basePath}_p${i + 1}${ext}`,
            title: sec.title,
            html: $newDoc.xml(),
            isGeneratedSplit: true,
            originalChapterId: chapter.id,
        });
    }

    return newChapters;
};

/**
 * 对整书的 chapterMap 进行内存就地体检与重构
 */
export const repairChapterMapInPlace = (chapterMap, logger) => {
    const diagnosis = diagnoseChapterMap(chapterMap);
    if (!diagnosis.needsSplitting) {
        return { repaired: false, originalCount: chapterMap.size, newCount: chapterMap.size };
    }

    console.log(
        `\n🩺 EPUB Doctor: Detected non-standard ebook structure (${diagnosis.largeFileCount} oversized file(s), sparse semantic headings).`,
    );
    console.log("   Auto-repairing and restructing chapters in-memory...");

    const reconstructedMap = new Map();
    let splitCounter = 0;

    for (const [id, chapter] of chapterMap.entries()) {
        const len = Buffer.byteLength(chapter.html || "", "utf8");
        if (len >= LARGE_CHAPTER_THRESHOLD && !chapter.isTOC) {
            const splits = splitLargeChapter(chapter, 1);
            if (splits && splits.length > 1) {
                splitCounter += splits.length;
                console.log(
                    `   ✂️ Restructured "${chapter.title || id}" (${Math.round(len / 1024)}KB) -> ${splits.length} standardized chapters.`,
                );
                for (const newCh of splits) {
                    reconstructedMap.set(newCh.id, newCh);
                }
                continue;
            }
        }
        reconstructedMap.set(id, chapter);
    }

    // 原地更新 chapterMap
    chapterMap.clear();
    for (const [k, v] of reconstructedMap.entries()) {
        chapterMap.set(k, v);
    }

    logger?.write?.(
        "INFO",
        `EPUB In-Memory Repair complete: split into ${chapterMap.size} chapters (added ${splitCounter} split chapters).`,
    );
    console.log(`   ✅ In-memory repair completed. Total chapters now: ${chapterMap.size}.\n`);

    return {
        repaired: true,
        originalCount: diagnosis.largeFileCount,
        newCount: chapterMap.size,
    };
};
