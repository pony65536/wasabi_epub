import fs from "fs";
import path from "path";

import {
    CURRENT_PROVIDER,
    FALLBACK_PROVIDER,
    FALLBACK_ON_CONTENT_POLICY,
} from "../config.js";
import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { collectReferencedIds } from "../epub/chapterMap.js";
import { shouldRetainArtifacts } from "../pipeline/artifactPolicy.js";
import { createProgressCache } from "../support/cache.js";
import { createLogger } from "../support/logger.js";
import {
    ensureDir,
    moveFileIfNeeded,
    saveHtmlDocument,
} from "../support/files.js";
import { getLanguageFileCode } from "../support/naming.js";
import { createAIProvider } from "../translation/aiProvider.js";
import { createBatchQueue } from "../translation/batchQueue.js";
import { createGlossaryProvider } from "../translation/glossaryProvider.js";
import {
    collectVisibleTextNodes,
    performTranslation,
} from "../translation/translator.js";
import { extractFirstHeading, loadHtml } from "../utils.js";

const createSingleHtmlChapterMap = (inputPath) => {
    const html = fs.readFileSync(inputPath, "utf8");
    const chapter = {
        id: "document",
        href: path.basename(inputPath),
        html,
        entryName: path.basename(inputPath),
        title: extractFirstHeading(html) || path.parse(inputPath).name || "Untitled",
    };

    return new Map([[chapter.id, chapter]]);
};

const createHtmlGlossarySourceMap = (chapterMap) => {
    const glossarySourceMap = new Map();
    const silentLogger = { write: () => {} };

    for (const chapter of chapterMap.values()) {
        const $ = loadHtml(chapter.html);
        const root = $("body").length ? $("body") : $.root();
        const visibleNodes = collectVisibleTextNodes(
            $,
            root,
            silentLogger,
            false,
        );

        glossarySourceMap.set(chapter.id, {
            ...chapter,
            html: visibleNodes.map((node) => node.content).join(" "),
        });
    }

    return glossarySourceMap;
};

export const runHtmlTranslationJob = async ({
    projectRoot,
    inputPath,
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
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPath = path.resolve(
        outputDir,
        `${fileInfo.name}_${targetLanguageSlug}.html`,
    );
    const cacheDir = path.resolve(projectRoot, `.cache_${fileInfo.name}_html`);
    const cache = createProgressCache(cacheDir);

    console.log(`\n========================================`);
    console.log(`📄 Input:  ${path.basename(inputPath)}`);
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
    console.log(`========================================\n`);

    let completed = false;

    try {
        const chapterMap = createSingleHtmlChapterMap(inputPath);
        const chapters = [...chapterMap.values()];
        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = new Set();

        let headingFormatRules = [];
        let glossary = {};

        const cachedGlossary = cache.loadGlossary();
        const cachedHeadingRules = cache.loadHeadingRules();

        if (cachedHeadingRules && cachedHeadingRules.length > 0) {
            console.log("\n🔍 Step 1: Loading heading format rules from cache...");
            headingFormatRules = cachedHeadingRules;
        } else {
            headingFormatRules = await analyzeHeadingFormats(
                chapterMap,
                aiProvider,
                logger,
                runtimeConfig,
            );
            cache.saveHeadingRules(headingFormatRules);
        }

        if (cachedGlossary && Object.keys(cachedGlossary).length > 0) {
            console.log("\n📊 Step 2: Loading glossary from cache...");
            glossary = cachedGlossary;
        } else {
            const glossarySourceMap = createHtmlGlossarySourceMap(chapterMap);
            glossary = await generateInitialGlossary(
                glossarySourceMap,
                glossaryProvider,
                logger,
                runtimeConfig,
            );
            cache.saveGlossary(glossary);
        }

        const cachedHtml = cache.load("document");
        if (cachedHtml) {
            console.log(`\n📑 Found cached translated HTML, reusing it.`);
            chapterMap.get("document").html = cachedHtml;
        } else {
            await performTranslation(
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
                "html",
                debugMode,
            );
            await batchQueue.drainQueue();
        }

        await standardizeHeadingsByRules(
            chapterMap,
            headingFormatRules,
            aiProvider,
            batchQueue,
            logger,
        );

        await saveHtmlDocument(
            outputPath,
            chapterMap.get("document").html,
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
