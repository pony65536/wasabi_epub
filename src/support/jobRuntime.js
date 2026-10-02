import path from "path";
import { createLogger } from "./logger.js";
import { createProgressCache } from "./cache.js";

/**
 * 任务运行时共用逻辑：缓存 + 任务锁 + 结果契约 + 材料保留策略。
 * 四种 Job（EPUB/HTML/PDF/字幕）共用，避免各写一份。
 */

export const createJobCache = (cacheDir) => {
    const cache = createProgressCache(cacheDir);
    const taskLock = cache.acquireTaskLock();
    if (!taskLock.acquired) {
        throw new Error(
            `Cache is locked by another run (pid=${taskLock.holder?.pid}). Stop it or remove the stale lock file: ${path.join(cacheDir, "task.lock")}`,
        );
    }
    return cache;
};

export const createJobLogger = (logDir) => createLogger(logDir);

/**
 * 统一清理策略：仅完整成功且非 debug 才删除缓存与日志；其余保留。
 */
export const finalizeJobArtifacts = ({
    cache,
    logger,
    debugMode,
    keepArtifacts,
}) => {
    // 删除缓存会连同锁文件一起清掉；保留缓存时才显式释放锁，避免提前让出
    if (!keepArtifacts && !debugMode) {
        cache.removeDir();
        logger.remove();
        return "removed";
    }
    cache.releaseTaskLock();
    return "retained";
};

export const buildJobResult = ({
    outputPath,
    cacheDir,
    logFile,
    translationStatus,
    validationStatus,
    reportPath = null,
    counts = {},
    archivedInputPath = null,
    extra = {},
}) => ({
    outputPath,
    cacheDir,
    logFile,
    reportPath,
    translationStatus,
    validationStatus,
    counts,
    archivedInputPath,
    ...extra,
});
