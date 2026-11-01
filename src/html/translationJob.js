import path from "path";
import { buildJobResult } from "../support/jobRuntime.js";
import { buildTaskSignature, computeFileDigest, computePromptDigest } from "../support/taskIdentity.js";
import { moveFileIfNeeded } from "../support/archive.js";
import { analyzeHeadingFormats, standardizeHeadingsByRules } from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { getLanguageFileCode } from "../support/naming.js";
import { collectReferencedIds } from "../epub/chapterMap.js";
import { ensureCacheIdentity } from "../pipeline/jobSupport.js";
import { createSingleHtmlChapterMap, createHtmlGlossarySourceMap } from "./chapterMap.js";
import { saveHtmlDocument } from "../support/files.js";
import { createJobContext, finishJob, formatRoutingSummary } from "../pipeline/jobContext.js";
import { translateChapters } from "../pipeline/translateDocument.js";

export const runHtmlTranslationJob = async ({
    projectRoot,
    inputPath,
    debugMode = false,
    runtimeConfig,
    modelName = null,
    createAdapter,
}) => {
    const outputDir = path.resolve(projectRoot, "output");

    const fileInfo = path.parse(inputPath);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPath = path.resolve(
        outputDir,
        `${fileInfo.name}_${targetLanguageSlug}.html`,
    );
    const cacheDir = path.resolve(
        projectRoot,
        `.cache_${fileInfo.name}_html_${targetLanguageSlug}`,
    );
    const ctx = createJobContext({ projectRoot, inputPath, runtimeConfig, debugMode, cacheDir, modelName, createAdapter });
    const { logger, gateway, aiProvider, batchQueue, cache, inputDir } = ctx;
    const glossaryProvider = ctx.getGlossaryProvider();

    console.log(`\n========================================`);
    console.log(`📄 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPath)}`);
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`🐞 Debug: ${debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${runtimeConfig.sourceLanguage}`);
    console.log(`🌐 Target: ${runtimeConfig.targetLanguage}`);
    if (runtimeConfig.concurrencyOverride) {
        console.log(
            `⚙️ Concurrency: ${runtimeConfig.concurrencyOverride}`,
        );
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    console.log(`🧭 Routing: ${formatRoutingSummary(gateway)}`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    console.log(`========================================\n`);

    let completed = false;
    let shouldKeepArtifacts = debugMode;
    let translationStatus = "complete";

    try {
        const chapterMap = createSingleHtmlChapterMap(inputPath);
        const chapters = [...chapterMap.values()];
        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = new Set();

        ensureCacheIdentity(
            cache,
            buildTaskSignature({
                kind: "html",
                sourceDigest: computeFileDigest(inputPath),
                sourceLanguage: runtimeConfig.sourceLanguage,
                targetLanguage: runtimeConfig.targetLanguage,
                extras: {
                    promptDigest: computePromptDigest(
                        projectRoot,
                        "html_translation_prompt.txt",
                    ),
                    modelRoutingFingerprint: gateway.routing.fingerprint,
                },
            }),
            { kind: "html" },
            logger,
        );

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
                gateway.forStage("headings"),
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

        const translationReport = await translateChapters(
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
            {
                criticProvider: gateway.forStage("critic"),
                memoryProvider: gateway.forStage("memory"),
            },
        );
        translationStatus = translationReport.status;
        await batchQueue.drainQueue();

        if (translationStatus === "failed") {
            throw new Error(
                "Translation failed for every pending chapter. Cache retained for resume.",
            );
        }
        if (translationStatus === "partial") {
            console.log(
                `\n⚠️ Partial translation: ${translationReport.partialChapters.length} chapter(s) have unresolved nodes. Cache retained; rerun to resume only failed nodes.`,
            );
        }

        await standardizeHeadingsByRules(
            chapterMap,
            headingFormatRules,
            gateway.forStage("headings"),
            batchQueue,
            logger,
        );

        await saveHtmlDocument(
            outputPath,
            chapterMap.get("document").html,
            logger,
        );

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        const archivedInputPath = moveFileIfNeeded(
            inputPath,
            finalInputPath,
        );

        completed = true;
        shouldKeepArtifacts =
            shouldKeepArtifacts || translationStatus !== "complete";
        if (translationStatus === "complete") {
            console.log(`\n✅ All done! Output: ${path.basename(outputPath)}`);
        } else {
            console.log(
                `\n⚠️ Output written with unresolved nodes: ${path.basename(outputPath)} (cache retained; rerun to resume failed nodes)`,
            );
        }
        return buildJobResult({
            outputPath,
            cacheDir,
            logFile: logger.logFile,
            translationStatus,
            validationStatus:
                translationStatus === "complete" ? "ok" : "partial",
            counts: {
                chapters: translationReport.chapters.length,
                failedChapters: translationReport.failedChapters.length,
                partialChapters: translationReport.partialChapters.length,
            },
            archivedInputPath,
            extra: {
                modelRouting: gateway.describe(),
                usage: gateway.usage(),
            },
        });
    } catch (error) {
        shouldKeepArtifacts = true;
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const retention = finishJob(ctx, {
            keepArtifacts: !completed || shouldKeepArtifacts,
        });
        if (retention === "retained" && !debugMode) {
            logger.write(
                "WARN",
                `Artifacts retained (status=${translationStatus}, completed=${completed}): ${cacheDir}`,
            );
        }
    }
};
