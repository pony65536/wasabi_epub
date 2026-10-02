import { normalizeText } from "./content-classifier.js";

/**
 * 前文上下文轻量回溯检索器 (Lightweight Context Retriever)
 *
 * 作用：
 * 1. 在内存中维护已翻译各章节的关键段落快速倒排索引
 * 2. 支持双语查询：用源语术语查译文段落（通过 glossary 展开译名）
 * 3. indexChapter 对同一章节幂等，缓存恢复时重建索引
 */

export class ContextRetriever {
    constructor() {
        this.documents = []; // { chapterId, paragraphIndex, text }
        this.termPairs = []; // [sourceTerm, targetTerm]
    }

    /**
     * 注册术语对照，用于把源语查询词展开为译名
     */
    setGlossary(glossary = {}) {
        this.termPairs = Object.entries(glossary || {})
            .filter(([source, target]) => source && target)
            .map(([source, target]) => [String(source), String(target)]);
    }

    /**
     * 录入已翻译完成的章节文本建立索引（同章节重复调用会先清空旧索引）
     */
    indexChapter(chapterId, textContent) {
        this.documents = this.documents.filter(
            (doc) => doc.chapterId !== chapterId,
        );
        if (!textContent) return;
        const paragraphs = String(textContent)
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
     * 检索与给定线索关键词最相关的 1~2 句前文。
     * 源语词会展开为已注册的译名，反之亦然。
     */
    queryContext(queryKeywords, maxResults = 2) {
        if (!queryKeywords || !Array.isArray(queryKeywords) || queryKeywords.length === 0) {
            return [];
        }

        const expanded = new Set();
        for (const raw of queryKeywords) {
            const key = String(raw || "").trim().toLowerCase();
            if (key.length < 2) continue;
            expanded.add(key);
            for (const [source, target] of this.termPairs) {
                const sourceKey = source.toLowerCase();
                const targetKey = target.toLowerCase();
                if (key === sourceKey) expanded.add(targetKey);
                else if (key === targetKey) expanded.add(sourceKey);
            }
        }
        if (expanded.size === 0) return [];

        const cleanTokens = [...expanded].filter((token) => token.length >= 2);
        if (cleanTokens.length === 0) return [];

        const scored = [];
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
