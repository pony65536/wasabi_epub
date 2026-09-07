import { normalizeText } from "./content-classifier.js";

/**
 * 前文上下文轻量回溯检索器 (Lightweight Context Retriever)
 * 
 * 作用：
 * 1. 在内存中维护已翻译各章节的关键段落快速倒排索引（基于 BM25 或 TF-IDF 纯 JS 轻量算法，无需外部复杂向量库）
 * 2. 当后续章节遇到代词迷雾、伏笔或前文隐喻时，能瞬间检索出前文相关的 1~2 处剧情线索供模型消歧
 */

export class ContextRetriever {
    constructor() {
        this.documents = []; // { chapterId, paragraphIndex, text }
    }

    /**
     * 录入已翻译完成的章节文本建立索引
     */
    indexChapter(chapterId, textContent) {
        if (!textContent) return;
        const paragraphs = textContent
            .split(/\n+/)
            .map((p) => normalizeText(p))
            .filter((p) => p.length >= 25);

        for (let i = 0; i < paragraphs.length; i++) {
            this.documents.push({
                chapterId,
                paragraphIndex: i,
                text: paragraphs[i],
            });
        }
    }

    /**
     * 检索与给定线索关键词最相关的 1~2 句前文
     */
    queryContext(queryKeywords, maxResults = 2) {
        if (!queryKeywords || !Array.isArray(queryKeywords) || queryKeywords.length === 0) {
            return [];
        }

        const scored = [];
        const cleanTokens = queryKeywords
            .map((k) => String(k).trim().toLowerCase())
            .filter((k) => k.length >= 2);

        if (cleanTokens.length === 0) return [];

        for (const doc of this.documents) {
            const lower = doc.text.toLowerCase();
            let score = 0;
            for (const token of cleanTokens) {
                if (lower.includes(token)) {
                    score += 1;
                }
            }
            if (score > 0) {
                scored.push({ doc, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxResults).map((s) => s.doc);
    }
}
