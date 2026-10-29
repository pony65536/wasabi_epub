import path from "path";

import { createProgressCache } from "../support/cache.js";
import { ensureDir } from "../support/files.js";
import { createLogger } from "../support/logger.js";
import { createAIProvider } from "../translation/aiProvider.js";
import { createBatchQueue } from "../translation/batchQueue.js";
import { createGlossaryProvider } from "../translation/glossaryProvider.js";
import { shouldRetainArtifacts } from "./artifactPolicy.js";

export const createJobContext = ({
    projectRoot,
    inputPath,
    runtimeConfig,
    debugMode,
    cacheDir,
    deferGlossaryProvider = false,
}) => {
    const logDir = path.resolve(projectRoot, "log");
    const inputDir = path.resolve(projectRoot, "input");
    const outputDir = path.resolve(projectRoot, "output");
    ensureDir(logDir);
    ensureDir(inputDir);
    ensureDir(outputDir);

    const logger = createLogger(logDir);
    const aiProvider = createAIProvider({
        primaryModel: runtimeConfig.models.primary,
        fallbackModel: runtimeConfig.models.fallback,
        onContentPolicy: Boolean(runtimeConfig.models.fallback),
        logger,
    });
    const batchQueue = createBatchQueue(aiProvider, logger);
    const cache = createProgressCache(cacheDir);

    const buildGlossaryProvider = () =>
        createGlossaryProvider({
            logger,
            runtimeConfig,
            primaryProvider: aiProvider,
        });

    let glossaryProvider = deferGlossaryProvider
        ? null
        : buildGlossaryProvider();

    return {
        projectRoot,
        inputPath,
        runtimeConfig,
        debugMode,
        logDir,
        inputDir,
        outputDir,
        logger,
        aiProvider,
        batchQueue,
        cache,
        cacheDir,
        get glossaryProvider() {
            return glossaryProvider;
        },
        getGlossaryProvider: () => {
            if (!glossaryProvider) {
                glossaryProvider = buildGlossaryProvider();
            }
            return glossaryProvider;
        },
    };
};

export const printJobBanner = (
    ctx,
    {
        inputIcon,
        inputName,
        outputName,
        htmlName = null,
        pageSelector = null,
        chapterSelector = null,
    },
) => {
    const { runtimeConfig, debugMode, aiProvider, cacheDir } = ctx;

    console.log(`\n========================================`);
    console.log(`${inputIcon} Input:  ${inputName}`);
    console.log(`💾 Output: ${outputName}`);
    if (htmlName) {
        console.log(`📄 HTML:   ${htmlName}`);
    }
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`🐞 Debug: ${debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${runtimeConfig.sourceLanguage}`);
    console.log(`🌐 Target: ${runtimeConfig.targetLanguage}`);
    const concurrency =
        runtimeConfig.concurrencyOverride ??
        runtimeConfig.models.primary.concurrency;
    if (concurrency) {
        console.log(`⚙️ Concurrency: ${concurrency}`);
    }
    if (pageSelector) {
        console.log(`📄 Pages: ${pageSelector}`);
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    if (chapterSelector) {
        console.log(`🎯 Chapters: ${chapterSelector}`);
    }
    console.log(`========================================\n`);
};

export const finishJob = (ctx, { completed, retainOnFailure }) => {
    const keepArtifacts = shouldRetainArtifacts({
        completed,
        debugMode: ctx.debugMode,
        retainOnFailure,
    });

    if (!keepArtifacts) {
        ctx.cache.removeDir();
        ctx.logger.remove();
    }

    return keepArtifacts;
};
