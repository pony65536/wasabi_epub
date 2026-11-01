import { performTranslation } from "../translation/translator.js";

// Cache validation and node-level recovery apply to every format.
export const translateChapters = async (...args) => {
    const summary = await performTranslation(...args);
    await args[5].drainQueue();
    return summary;
};

export const translateDocument = async ({ chapters, chapterMap, glossary, cache,
    runtimeConfig, aiProvider, batchQueue, logger, debugMode, referencedIds,
    definedClasses, mode, translationOptions, translationMessage = null,
    postTranslate = null }) => {
    if (translationMessage) console.log(translationMessage);
    const summary = await translateChapters(chapters, chapterMap, glossary,
        runtimeConfig, aiProvider, batchQueue, logger, cache, referencedIds,
        definedClasses, mode, debugMode, translationOptions);
    if (postTranslate && summary.status !== "failed") await postTranslate();
    return { fromCache: summary.skipped === summary.total, summary };
};
