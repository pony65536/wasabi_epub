import AdmZip from "adm-zip";
import path from "path";

import {
    CURRENT_PROVIDER,
    FALLBACK_PROVIDER,
    FALLBACK_ON_CONTENT_POLICY,
} from "../config.js";
import { planTranslationOrder } from "../agent.js";
import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { shouldRetainArtifacts } from "../pipeline/artifactPolicy.js";
import { createProgressCache } from "../support/cache.js";
import { selectChaptersBySpec } from "../support/chapterSelection.js";
import { ensureDir, moveFileIfNeeded } from "../support/files.js";
import { createLogger } from "../support/logger.js";
import {
    createSelectionSlug,
    getLanguageFileCode,
} from "../support/naming.js";
import { createAIProvider } from "../translation/aiProvider.js";
import { createBatchQueue } from "../translation/batchQueue.js";
import { createGlossaryProvider } from "../translation/glossaryProvider.js";
import {
    detectEpubBookStructuralMode,
    performTranslation,
} from "../translation/translator.js";
import {
    collectDefinedClasses,
    collectReferencedIds,
    createChapterMap,
    sanitizeCachedPlan,
} from "./chapterMap.js";
import { saveEpub } from "./epubSaver.js";
import { synchronizeNcx, synchronizeTocHtml } from "./tocSync.js";

const countCachedChapters = (cache, chapters) =>
    chapters.reduce(
        (count, chapter) => count + (cache.load(chapter.id) ? 1 : 0),
        0,
    );

export const runTranslationJob = async ({
    projectRoot,
    inputPath,
    chapterSelector = null,
    debugMode = false,
    runtimeConfig,
}) => {
    const logDir = path.resolve(projectRoot, "log");
    const inputDir = path.resolve(projectRoot, "input");
    const outputDir = path.resolve(projectRoot, "output");
    ensureDir(logDir);
    ensureDir(inputDir);
    ensureDir(outputDir);

    const logger = createLogger(logDir);
    const aiProvider = createAIProvider(
        CURRENT_PROVIDER,
        runtimeConfig,
        logger,
        FALLBACK_PROVIDER,
        FALLBACK_ON_CONTENT_POLICY,
    );
    const glossaryProvider = createGlossaryProvider(logger, runtimeConfig);
    const batchQueue = createBatchQueue(aiProvider, logger);

    const fileInfo = path.parse(inputPath);
    const selectionSlug = createSelectionSlug(chapterSelector);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputStem = chapterSelector
        ? `${fileInfo.name}_chap-${selectionSlug}_${targetLanguageSlug}`
        : `${fileInfo.name}_${targetLanguageSlug}`;
    const outputPath = path.resolve(outputDir, `${outputStem}.epub`);
    const cacheDir = path.resolve(
        projectRoot,
        chapterSelector
            ? `.cache_${fileInfo.name}_chap-${selectionSlug}`
            : `.cache_${fileInfo.name}`,
    );
    const cache = createProgressCache(cacheDir);

    console.log(`\n========================================`);
    console.log(`📖 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPath)}`);
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`🐞 Debug: ${debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${runtimeConfig.sourceLanguage}`);
    console.log(`🌐 Target: ${runtimeConfig.targetLanguage}`);
    if (runtimeConfig[CURRENT_PROVIDER]?.concurrency) {
        console.log(
            `⚙️ Concurrency: ${runtimeConfig[CURRENT_PROVIDER].concurrency}`,
        );
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    if (chapterSelector) {
        console.log(`🎯 Chapters: ${chapterSelector}`);
    }
    console.log(`========================================\n`);

    let completed = false;

    try {
        const zip = new AdmZip(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = createChapterMap(zipEntries);
        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = collectDefinedClasses(zipEntries);

        let plan = { sorted: [], tocId: null };
        let headingFormatRules = [];
        let glossary = {};
        let ncxEntry = null;
        let ncxContent = null;

        const cachedPlan = cache.loadPlan();
        const cachedGlossary = cache.loadGlossary();
        const cachedHeadingRules = cache.loadHeadingRules();

        if (cachedPlan) {
            console.log("\n🕵️ Step 1: Loading translation plan from cache...");
            plan = sanitizeCachedPlan(cachedPlan, chapterMap, logger) || cachedPlan;
            cache.savePlan(plan);
            if (plan.tocId) {
                const tocChapter = chapterMap.get(plan.tocId);
                if (tocChapter) tocChapter.isTOC = true;
            }
        } else {
            plan = await planTranslationOrder(
                [...chapterMap.values()],
                aiProvider,
                logger,
            );
            cache.savePlan(plan);
        }

        const selectedChapters = chapterSelector
            ? selectChaptersBySpec(plan.sorted, chapterSelector)
            : plan.sorted;
        const selectedChapterMap = new Map(
            selectedChapters.map((chapter) => [
                chapter.id,
                chapterMap.get(chapter.id),
            ]),
        );
        const epubStructuralMode = detectEpubBookStructuralMode(
            selectedChapters,
            referencedIds,
            definedClasses,
        );
        const selectedCachedChapterCount = countCachedChapters(
            cache,
            selectedChapters,
        );
        const totalSelectedChapters = selectedChapters.length;

        if (chapterSelector) {
            console.log(
                `\n🎯 Selected ${totalSelectedChapters} chapter(s) from --chap.`,
            );
        }

        if (cachedHeadingRules && cachedHeadingRules.length > 0) {
            console.log(
                "\n🔍 Step 2: Loading heading format rules from cache...",
            );
            headingFormatRules = cachedHeadingRules;
        } else {
            headingFormatRules = await analyzeHeadingFormats(
                selectedChapterMap,
                aiProvider,
                logger,
                runtimeConfig,
            );
            cache.saveHeadingRules(headingFormatRules);
        }

        if (cachedGlossary && Object.keys(cachedGlossary).length > 0) {
            console.log("\n📊 Step 3: Loading glossary from cache...");
            glossary = cachedGlossary;
        } else {
            glossary = await generateInitialGlossary(
                selectedChapterMap,
                glossaryProvider,
                logger,
                runtimeConfig,
            );
            cache.saveGlossary(glossary);
        }

        if (selectedCachedChapterCount > 0) {
            console.log(
                `\n📑 Found ${selectedCachedChapterCount}/${totalSelectedChapters} selected chapter(s) already translated.`,
            );
        }

        if (epubStructuralMode.enabled) {
            const summary = epubStructuralMode.summary || {};
            console.log(
                `\n🧱 EPUB structural mode enabled: analyzable=${summary.analyzableChapterCount ?? 0}, fallbackChapters=${summary.fallbackChapterCount ?? 0}, strongStructural=${summary.strongStructuralChapterCount ?? 0}`,
            );
        }

        await performTranslation(
            selectedChapters,
            chapterMap,
            glossary,
            runtimeConfig,
            aiProvider,
            batchQueue,
            logger,
            cache,
            referencedIds,
            definedClasses,
            "epub",
            debugMode,
            epubStructuralMode,
        );

        await batchQueue.drainQueue();

        await standardizeHeadingsByRules(
            selectedChapterMap,
            headingFormatRules,
            aiProvider,
            batchQueue,
            logger,
        );

        await synchronizeTocHtml(chapterMap, plan.tocId);
        ({ ncxEntry, ncxContent } = await synchronizeNcx(chapterMap, zipEntries));

        await saveEpub(
            zip,
            chapterMap,
            ncxEntry ?? null,
            ncxContent ?? null,
            outputPath,
            logger,
        );

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        moveFileIfNeeded(inputPath, finalInputPath);

        console.log(`\n✅ All done! Output: ${path.basename(outputPath)}`);
        completed = true;
        return { outputPath, cacheDir, logFile: logger.logFile };
    } catch (error) {
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const keepArtifacts = shouldRetainArtifacts({
            completed,
            debugMode,
            retainOnFailure: false,
        });
        if (!keepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};
