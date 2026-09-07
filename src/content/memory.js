import { callAIWithRetry } from "../utils.js";
import { normalizeText } from "./content-classifier.js";

/**
 * 动态记忆中枢 (Living Memory Store)
 * 
 * 职责：
 * 1. 统一管理全书 Director 生成的初始基座 (Base Memory) 与后续章节沉淀的增量实体 (Incremental Memory)
 * 2. 在每章翻译完成后，异步触发轻量 Extractor Agent，提炼本章新出现的人物、专有名词与统一称谓
 * 3. 自动去重合并，并实时同步到持久化缓存 (.cache/book_bible.json)
 */

export class LivingMemoryStore {
    constructor(initialBookBible = null, cache = null) {
        this.cache = cache;
        this.data = initialBookBible || {
            genre: "General",
            stylisticTone: {},
            characterBible: [],
            worldviewAndGlossary: {},
            syntaxConventions: {},
            dynamicTimeline: [], // 记录各章的关键事件与实体出现历史
        };
    }

    /**
     * 获取供 Prompt 挂载的最新记忆快照 (包含术语字典与角色人称约束)
     */
    getSnapshot() {
        return {
            genre: this.data.genre,
            stylisticTone: this.data.stylisticTone,
            characterBible: [...(this.data.characterBible || [])],
            worldviewAndGlossary: { ...(this.data.worldviewAndGlossary || {}) },
            syntaxConventions: this.data.syntaxConventions,
        };
    }

    /**
     * 合并增量记忆
     */
    mergeIncremental({ characters = [], terms = {}, chapterId = "" }) {
        let changed = false;

        // 1. 合并新角色 / 人称
        if (Array.isArray(characters)) {
            const existingMap = new Map(
                (this.data.characterBible || []).map((c) => [c.name.toLowerCase(), c]),
            );
            for (const char of characters) {
                if (!char || !char.name || !char.targetName) continue;
                const key = char.name.toLowerCase();
                if (!existingMap.has(key)) {
                    this.data.characterBible.push(char);
                    existingMap.set(key, char);
                    changed = true;
                }
            }
        }

        // 2. 合并新术语
        if (terms && typeof terms === "object") {
            this.data.worldviewAndGlossary = this.data.worldviewAndGlossary || {};
            for (const [src, tgt] of Object.entries(terms)) {
                if (src && tgt && !this.data.worldviewAndGlossary[src]) {
                    this.data.worldviewAndGlossary[src] = tgt;
                    changed = true;
                }
            }
        }

        if (chapterId) {
            this.data.dynamicTimeline = this.data.dynamicTimeline || [];
            this.data.dynamicTimeline.push({
                chapterId,
                timestamp: Date.now(),
                newCharactersCount: characters?.length || 0,
                newTermsCount: Object.keys(terms || {}).length,
            });
        }

        // 3. 实时持久化回写缓存
        if (changed && this.cache?.saveBookBible) {
            this.cache.saveBookBible(this.data);
        }

        return changed;
    }
}

const buildExtractorPrompt = (sourceLanguage, targetLanguage) => `
You are the "Entity & Terminology Extractor" for a book translation project.

Task:
Analyze the provided translated chapter excerpt, identify any NEW key characters, recurring proper nouns, specialized terminology, or organizational names that should remain consistent throughout subsequent chapters.

Target Language: ${targetLanguage}
Source Language: ${sourceLanguage}

Rules:
1. Output valid JSON only:
{
  "newCharacters": [
    {
      "name": "Original Name",
      "targetName": "Translated Name in ${targetLanguage}",
      "gender": "male | female | unknown",
      "pronoun": "他 | 她 | 它 | TA",
      "role": "Brief role/title if evident"
    }
  ],
  "newTerms": {
    "Source Term": "Standard translation in ${targetLanguage}"
  }
}
2. Extract only HIGH-VALUE, RECURRING, or SPECIFIC entities (characters, locations, organizations, unique concepts).
3. Do NOT include generic common words (e.g. "morning", "car", "good").
4. If no significant new entities are found, return empty arrays/objects.
`.trim();

/**
 * 异步从章节译文中提炼增量记忆实体
 */
export const extractChapterMemory = async (
    chapterContentText,
    livingMemoryStore,
    aiProvider,
    logger,
    runtimeConfig,
    chapterTitle = "",
) => {
    if (!chapterContentText || chapterContentText.length < 200) return;

    try {
        const sampleText = normalizeText(chapterContentText).slice(0, 4000);
        const prompt = buildExtractorPrompt(
            runtimeConfig.sourceLanguage,
            runtimeConfig.targetLanguage,
        );

        const result = await callAIWithRetry(
            aiProvider,
            sampleText,
            prompt,
            2,
        );

        const characters = Array.isArray(result?.newCharacters) ? result.newCharacters : [];
        const terms = result?.newTerms && typeof result.newTerms === "object" ? result.newTerms : {};

        const hasUpdates = livingMemoryStore.mergeIncremental({
            characters,
            terms,
            chapterId: chapterTitle,
        });

        if (hasUpdates) {
            logger?.write?.(
                "INFO",
                `Living Memory updated from "${chapterTitle}": +${characters.length} characters, +${Object.keys(terms).length} terms.`,
            );
            console.log(
                `    - 🧠 Living Memory updated: +${characters.length} character(s), +${Object.keys(terms).length} new term(s).`,
            );
        }
    } catch (err) {
        logger?.write?.("WARN", `Memory Extractor failed for "${chapterTitle}": ${err.message}`);
    }
};
