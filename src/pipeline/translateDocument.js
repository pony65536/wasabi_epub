import { performTranslation } from "../translation/translator.js";

export const translateDocument = async ({
    chapters,
    chapterMap,
    glossary,
    cache,
    cacheMode,
    cacheKey = "document",
    runtimeConfig,
    aiProvider,
    batchQueue,
    logger,
    debugMode,
    referencedIds,
    definedClasses,
    mode,
    translationOptions,
    cachedMessage = null,
    translationMessage = null,
    postTranslate = null,
}) => {
    if (cacheMode === "document") {
        const cachedHtml = cache.load(cacheKey);
        if (cachedHtml) {
            console.log(
                `\n📑 Found cached translated ${cachedMessage || "document"}, reusing it.`,
            );
            chapterMap.get(cacheKey).html = cachedHtml;
            if (postTranslate) {
                await postTranslate();
            }
            return { fromCache: true, summary: null };
        }
    }

    if (translationMessage) {
        console.log(translationMessage);
    }

    const summary = await performTranslation(
        chapters,
        chapterMap,
        glossary,
        runtimeConfig,
        aiProvider,
        batchQueue,
        logger,
        cache,
        referencedIds,
        definedClasses,
        mode,
        debugMode,
        translationOptions,
    );

    await batchQueue.drainQueue();

    if (postTranslate) {
        await postTranslate();
    }

    return { fromCache: false, summary };
};
