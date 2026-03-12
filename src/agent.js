import { callAIWithRetry } from "./utils.js";

export const planTranslationOrder = async (chapters, aiProvider, logger) => {
    console.log("\n🕵️ Step 1: Agent is analyzing book structure...");

    const simplifiedChapters = chapters.map((ch) => ({
        id: ch.id,
        title: ch.title,
    }));

    const agentPrompt = `
You are a "Translation Strategy Agent".

I have an EPUB book to translate.

GOAL: Filter and reorder the processing list based on these strict rules:

1. **IDENTIFY TOC (Action: Flag)**:
- Find the chapter that serves as the "Table of Contents" or "Contents" page. 
- If contents chapter exists, in the output JSON, set "tocId" to its ID, otherwise set "tocId" to null.

2. **FILTER & REMOVE (Strict Exclusion)**: 
- From the final "order" list, **COMPLETELY REMOVE** any items identified as: "Table of Contents", "Contents", "Index", "Search Terms", or "Bibliography".
- **Crucial Rule**: Even if you identify a chapter as the TOC for the "tocId" field, you must **NOT** include its ID in the "order" array. The "order" list should contain only translatable content.

3. **MAIN CONTENT FIRST (Priority 1)**: 
- Core chapters (e.g., "Chapter 1", "The Rise of VISA", "Part I").
- Translating these first builds the context glossary.

4. **FRONT/BACK MATTER LAST (Priority 2)**: 
- "Preface", "Introduction", "Foreword", "Copyright", "Dedication", "About the Author", "Acknowledgments".

REASON: Main content provides the necessary context to translate the introductory and administrative sections accurately later.

INPUT: A JSON list of chapters.
OUTPUT: A JSON object:
{
    "tocId": "id_of_toc_chapter_or_null",
    "order": ["chapter_01", "chapter_02", ...]
}`;

    try {
        const result = await callAIWithRetry(
            aiProvider,
            JSON.stringify(simplifiedChapters),
            agentPrompt,
        );

        const chapterMap = new Map(chapters.map((c) => [c.id, c]));
        const ordered = result.order
            .filter((id) => chapterMap.has(id))
            .map((id) => {
                const ch = chapterMap.get(id);
                if (id === result.tocId) ch.isTOC = true;
                chapterMap.delete(id);
                return ch;
            });

        return {
            sorted: [...ordered, ...chapterMap.values()],
            tocId: result.tocId,
        };
    } catch (e) {
        logger.write(
            "ERROR",
            `Agent Plan Failed after retries: ${e.stack || e.message}`,
        );
        console.warn("⚠️ Plan order step failed, using default order.");
        return { sorted: chapters, tocId: null };
    }
};
