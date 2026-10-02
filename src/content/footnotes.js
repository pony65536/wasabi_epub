import * as cheerio from "cheerio";
import { loadHtml } from "../utils.js";

/**
 * 出版级译者注与文化注释模块 (Footnotes & Cultural Annotations)
 *
 * 规范：
 * 1. 在正文中使用轻量占位标记: <ws-note term="原文术语">注释内容说明</ws-note>
 * 2. 装配阶段转换为标准的 EPUB 3 脚注规范:
 *    - 正文内: <sup><a id="noteref-X" href="#note-X" epub:type="noteref" class="footnote-ref">[注X]</a></sup>
 *    - 章节末尾挂载:
 *      <aside id="note-X" epub:type="footnote" class="footnote-body">
 *        <p><a href="#noteref-X">[注X]</a> <strong>原文术语：</strong>注释内容</p>
 *      </aside>
 * 3. 幂等：续跑重放缓存 HTML 时复用已有脚注区，按 noteId 去重，不重复编号。
 */

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const decodeHtml = (value) =>
    String(value ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");

export const chapterSlug = (chapterId) =>
    String(chapterId || "ch").replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * 将段落译文中的 <ws-note term="...">...</ws-note> 标签提取出来，
 * 在正文中替换为角标引用，并收集进章节注释列表。
 *
 * @param {string} htmlContent - 单个节点的译文 HTML
 * @param {Array} notesCollection - 章节级别的注释累加数组
 * @param {string} chapterId - 稳定章节标识
 * @param {{ startIndex?: number }} options - startIndex：已有脚注的最大编号（续跑时传入）
 */
export const extractAndFormatNotes = (
    htmlContent,
    notesCollection = [],
    chapterId = "ch",
    options = {},
) => {
    if (!htmlContent || typeof htmlContent !== "string" || !htmlContent.includes("<ws-note")) {
        return htmlContent || "";
    }

    const baseIndex = Number.isInteger(options.startIndex)
        ? options.startIndex
        : 0;
    const noteRegex = /<ws-note(?:\s+term=["']([^"']*)["'])?>([\s\S]*?)<\/ws-note>/gi;

    return htmlContent.replace(noteRegex, (match, rawTerm, rawNote) => {
        const noteText = (rawNote || "").trim();
        const term = decodeHtml((rawTerm || "").trim());
        if (!noteText) return "";

        const noteIndex = baseIndex + notesCollection.length + 1;
        const cleanChapterSlug = chapterSlug(chapterId);
        const refId = `noteref-${cleanChapterSlug}-${noteIndex}`;
        const noteId = `note-${cleanChapterSlug}-${noteIndex}`;

        notesCollection.push({
            index: noteIndex,
            refId,
            noteId,
            term,
            note: noteText,
        });

        return `<sup><a id="${refId}" href="#${noteId}" epub:type="noteref" class="footnote-ref">[注${noteIndex}]</a></sup>`;
    });
};

/**
 * 扫描章节 HTML 中已有的脚注角标，返回最大编号（无则 0）。
 */
export const findMaxFootnoteIndex = (chapterHtml) => {
    if (!chapterHtml) return 0;
    const $ = loadHtml(chapterHtml);
    let maxIndex = 0;
    $('a[id^="noteref-"]').each((_, el) => {
        const id = $(el).attr("id") || "";
        const match = id.match(/-(\d+)$/);
        if (match) maxIndex = Math.max(maxIndex, Number.parseInt(match[1], 10));
    });
    return maxIndex;
};

const renderNoteAside = (note) => {
    const termPrefix = note.term
        ? `<strong>${escapeHtml(note.term)}：</strong>`
        : "";
    return `  <aside id="${note.noteId}" epub:type="footnote" class="footnote-body">
    <p><a href="#${note.refId}">[注${note.index}]</a> ${termPrefix}${note.note}</p>
  </aside>`;
};

/**
 * 在章节 HTML 的 </body> 闭合前挂载脚注区域。
 * 若已存在脚注区，则按 noteId 去重后增量追加，保证幂等。
 */
export const appendFootnotesSection = (chapterHtml, notes = []) => {
    if (!notes || notes.length === 0 || !chapterHtml) {
        return chapterHtml;
    }

    const $ = loadHtml(chapterHtml);
    let $section = $('section[epub\\:type="footnotes"]').first();
    const existingIds = new Set();
    if ($section.length > 0) {
        $section.find("aside[id]").each((_, el) => {
            const id = $(el).attr("id");
            if (id) existingIds.add(id);
        });
    }

    const newNotes = notes.filter((note) => !existingIds.has(note.noteId));
    if (newNotes.length === 0) {
        return chapterHtml;
    }

    if ($section.length === 0) {
        $section = $(
            '<section epub:type="footnotes" class="footnotes-section"><hr class="footnote-divider"/></section>',
        );
        const $body = $("body");
        if ($body.length > 0) {
            $body.append($section);
        } else {
            $.root().append($section);
        }
    }

    for (const note of newNotes) {
        $section.append(renderNoteAside(note));
    }

    return $.xml();
};
