import { TRANSLATION_PIPELINE_VERSION } from "../support/taskIdentity.js";

export const countCachedChapters = (cache, chapters) => {
    const statusMap = cache.loadChapterStatus();
    return chapters.reduce((count, chapter) => {
        const cached = cache.load(chapter.id);
        if (!cached) return count;
        const verifiedComplete =
            statusMap[chapter.id]?.status === "complete" &&
            statusMap[chapter.id]?.protocolVersion ===
                TRANSLATION_PIPELINE_VERSION &&
            !statusMap[chapter.id]?.requiresSourceRebuild &&
            !/data-t-id\s*=/.test(cached);
        return count + (verifiedComplete ? 1 : 0);
    }, 0);
};

export const ensureCacheIdentity = (cache, signature, details, logger) => {
    const existing = cache.loadTaskMeta();
    const hasArtifacts =
        cache.count() > 0 ||
        Boolean(cache.loadPlan()) ||
        Boolean(cache.loadGlossary()) ||
        Object.keys(cache.loadChapterStatus()).length > 0;

    if (!existing?.signature && hasArtifacts) {
        // 已有缓存但缺少任务签名：进入显式迁移，不直接赋予新身份
        logger.write(
            "WARN",
            "Unverified cache without task signature; clearing to avoid stale reuse.",
        );
        console.log(
            "\n♻️ Unverified cache without task identity; clearing it.",
        );
        cache.clear();
    } else if (existing?.signature && existing.signature !== signature) {
        logger.write(
            "WARN",
            `Cache task identity mismatch (${existing.signature} -> ${signature}); clearing stale cache.`,
        );
        console.log(
            "\n♻️ Cache belongs to a different translation task; clearing it.",
        );
        cache.clear();
    }
    cache.saveTaskMeta({
        signature,
        ...details,
        updatedAt: new Date().toISOString(),
    });
};
