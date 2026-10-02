import { callAIWithRetry } from "./utils.js";
import {
    EXCLUDED_ROLES,
    classifyChapterRole,
    detectTocChapterId,
} from "./content/chapterRoles.js";

const buildRoleMap = (chapters) =>
    new Map(chapters.map((chapter) => [chapter.id, classifyChapterRole(chapter)]));

const partitionRemaining = (chapters, seenIds, roles) => {
    const remainingContent = [];
    const remainingFront = [];
    for (const chapter of chapters) {
        if (seenIds.has(chapter.id)) continue;
        const role = roles.get(chapter.id);
        if (role === "toc" || EXCLUDED_ROLES.has(role)) continue;
        if (role === "front") remainingFront.push(chapter);
        else remainingContent.push(chapter);
    }
    return { remainingContent, remainingFront };
};

const finalizePlan = (chapters, ordered, roles, tocId, logger) => {
    const seenIds = new Set(ordered.map((chapter) => chapter.id));
    const { remainingContent, remainingFront } = partitionRemaining(
        chapters,
        seenIds,
        roles,
    );

    if (tocId) {
        const tocChapter = chapters.find((chapter) => chapter.id === tocId);
        if (tocChapter) tocChapter.isTOC = true;
    }

    return {
        sorted: [...ordered, ...remainingContent, ...remainingFront],
        tocId: tocId || null,
        roles: Object.fromEntries(roles),
        excluded: chapters
            .filter((chapter) => {
                const role = roles.get(chapter.id);
                return role === "toc" || EXCLUDED_ROLES.has(role);
            })
            .map((chapter) => chapter.id),
    };
};

export const planTranslationOrder = async (chapters, aiProvider, logger) => {
    console.log("\n🕵️ Step 1: Agent is analyzing book structure...");

    const roles = buildRoleMap(chapters);
    const detectedTocId = detectTocChapterId(chapters);

    const simplifiedChapters = chapters.map((ch) => ({
        id: ch.id,
        title: ch.title,
        role: roles.get(ch.id),
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
- Items marked with role "index", "bibliography" or "toc" in the input are already excluded; never add them to "order".

3. **MAIN CONTENT FIRST (Priority 1)**:
- Core chapters (e.g., "Chapter 1", "The Rise of VISA", "Part I").
- Translating these first builds the context glossary.

4. **FRONT/BACK MATTER LAST (Priority 2)**:
- "Preface", "Introduction", "Foreword", "Copyright", "Dedication", "About the Author", "Acknowledgments" (role "front" in the input).
- Translating main content first provides the context needed for these sections.

INPUT: A JSON list of chapters with their roles.
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
        let droppedCount = 0;
        const seenIds = new Set();
        const ordered = [];
        const orderedIds = Array.isArray(result?.order) ? result.order : [];
        for (const id of orderedIds) {
            if (!chapterMap.has(id) || seenIds.has(id)) {
                droppedCount += 1;
                continue;
            }
            const role = roles.get(id);
            if (role === "toc" || EXCLUDED_ROLES.has(role)) {
                continue;
            }
            seenIds.add(id);
            ordered.push(chapterMap.get(id));
        }

        if (droppedCount > 0) {
            logger.write(
                "WARN",
                `Dropped ${droppedCount} invalid entries from translation plan.`,
            );
        }

        const aiTocId =
            result?.tocId && chapterMap.has(result.tocId)
                ? result.tocId
                : null;
        return finalizePlan(
            chapters,
            ordered,
            roles,
            aiTocId || detectedTocId,
            logger,
        );
    } catch (e) {
        logger.write(
            "ERROR",
            `Agent Plan Failed after retries: ${e.stack || e.message}`,
        );
        console.warn("⚠️ Plan order step failed, using role-based default order.");
        return finalizePlan(chapters, [], roles, detectedTocId, logger);
    }
};
