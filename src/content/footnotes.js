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
 * 3. 完美兼容微信读书、Apple Books、Kindle 的原生点击弹窗交互。
 */

/**
 * 将段落译文中的 <ws-note term="...">...</ws-note> 标签提取出来，
 * 在正文中替换为角标引用，并收集进章节注释列表。
 * 
 * @param {string} htmlContent - 单个节点的译文 HTML
 * @param {Array<{ index: number, refId: string, noteId: string, term: string, note: string }>} notesCollection - 章节级别的注释累加数组
 * @param {string} chapterId - 章节唯一标识
 * @returns {string} 替换角标后的正文 HTML
 */
export const extractAndFormatNotes = (htmlContent, notesCollection = [], chapterId = "ch") => {
    if (!htmlContent || typeof htmlContent !== "string" || !htmlContent.includes("<ws-note")) {
        return htmlContent || "";
    }

    const noteRegex = /<ws-note(?:\s+term=["']([^"']*)["'])?>([\s\S]*?)<\/ws-note>/gi;

    return htmlContent.replace(noteRegex, (match, rawTerm, rawNote) => {
        const noteText = (rawNote || "").trim();
        const term = (rawTerm || "").trim();
        if (!noteText) return "";

        const noteIndex = notesCollection.length + 1;
        const cleanChapterSlug = String(chapterId).replace(/[^a-zA-Z0-9_-]/g, "_");
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
 * 在章节 HTML 的 </body> 闭合前，挂载本章所有生成的脚注区域
 * 
 * @param {string} chapterHtml - 完整章节 HTML
 * @param {Array<{ index: number, refId: string, noteId: string, term: string, note: string }>} notes - 本章收集的所有注释
 * @returns {string} 挂载脚注后的完整 HTML
 */
export const appendFootnotesSection = (chapterHtml, notes = []) => {
    if (!notes || notes.length === 0 || !chapterHtml) {
        return chapterHtml;
    }

    const noteItems = notes
        .map((n) => {
            const termPrefix = n.term ? `<strong>${n.term}：</strong>` : "";
            return `  <aside id="${n.noteId}" epub:type="footnote" class="footnote-body">
    <p><a href="#${n.refId}">[注${n.index}]</a> ${termPrefix}${n.note}</p>
  </aside>`;
        })
        .join("\n");

    const footnotesContainer = `
<section epub:type="footnotes" class="footnotes-section">
  <hr class="footnote-divider"/>
${noteItems}
</section>
`;

    if (chapterHtml.includes("</body>")) {
        return chapterHtml.replace("</body>", `${footnotesContainer}\n</body>`);
    }

    return `${chapterHtml}\n${footnotesContainer}`;
};
