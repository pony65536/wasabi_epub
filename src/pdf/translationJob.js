import fs from "fs";
import path from "path";
import { buildJobResult } from "../support/jobRuntime.js";
import { buildTaskSignature, computeFileDigest, computePromptDigest } from "../support/taskIdentity.js";
import { moveFileIfNeeded } from "../support/archive.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { extractPdfToJson, fillPdfFromJson, validatePdfOutput } from "./pdfBridge.js";
import { applyTranslatedHtmlToPdfJson, pdfJsonToHtml } from "./pdfHtml.js";
import { createSelectionSlug, getLanguageFileCode } from "../support/naming.js";
import { collectReferencedIds } from "../epub/chapterMap.js";
import { PDF_BLOCKS_SCHEMA_VERSION, repairPdfMergedTranslationRuns, logPdfDoclingSummary } from "./repair.js";
import { ensureCacheIdentity } from "../pipeline/jobSupport.js";
import { createJobContext, finishJob, formatRoutingSummary } from "../pipeline/jobContext.js";
import { translateChapters } from "../pipeline/translateDocument.js";

export const runPdfTranslationJob = async ({
    projectRoot,
    inputPath,
    pageSelector = null,
    selectedPages = null,
    debugMode = false,
    runtimeConfig,
    modelName = null,
    createAdapter,
}) => {
    const outputDir = path.resolve(projectRoot, "output");

    const fileInfo = path.parse(inputPath);
    const selectionSlug = createSelectionSlug(pageSelector);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPdfPath = path.resolve(
        outputDir,
        pageSelector
            ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.pdf`
            : `${fileInfo.name}_${targetLanguageSlug}.pdf`,
    );
    const validationJsonPath = path.resolve(
        outputDir,
        pageSelector
            ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.validation.json`
            : `${fileInfo.name}_${targetLanguageSlug}.validation.json`,
    );
    const cacheDir = path.resolve(
        projectRoot,
        pageSelector
            ? `.cache_${fileInfo.name}_page-${selectionSlug}_pdf_${targetLanguageSlug}`
            : `.cache_${fileInfo.name}_pdf_${targetLanguageSlug}`,
    );
    const ctx = createJobContext({ projectRoot, inputPath, runtimeConfig, debugMode, cacheDir, modelName, createAdapter });
    const { logger, gateway, aiProvider, batchQueue, cache, inputDir } = ctx;
    const glossaryProvider = ctx.getGlossaryProvider();
    const extractedJsonPath = path.resolve(cacheDir, "pdf_blocks.json");
    const translatedJsonPath = path.resolve(cacheDir, "pdf_blocks_translated.json");
    const debugSummaryPath = path.resolve(cacheDir, "pdf_blocks_debug.json");

    console.log(`\n========================================`);
    console.log(`📕 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPdfPath)}`);
    if (debugMode) {
        const outputHtmlPath = path.resolve(
            outputDir,
            pageSelector
                ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.html`
                : `${fileInfo.name}_${targetLanguageSlug}.html`,
        );
        console.log(`📄 HTML:   ${path.basename(outputHtmlPath)}`);
    }
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`🐞 Debug: ${debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${runtimeConfig.sourceLanguage}`);
    console.log(`🌐 Target: ${runtimeConfig.targetLanguage}`);
    if (runtimeConfig.concurrencyOverride) {
        console.log(
            `⚙️ Concurrency: ${runtimeConfig.concurrencyOverride}`,
        );
    }
    if (pageSelector) {
        console.log(`📄 Pages: ${pageSelector}`);
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    console.log(`🧭 Routing: ${formatRoutingSummary(gateway)}`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    console.log(`========================================\n`);

    let completed = false;
    let translationStatus = "complete";
    let validationStatus = "not_run";

    try {
        ensureCacheIdentity(
            cache,
            buildTaskSignature({
                kind: "pdf",
                sourceDigest: computeFileDigest(inputPath),
                sourceLanguage: runtimeConfig.sourceLanguage,
                targetLanguage: runtimeConfig.targetLanguage,
                extras: {
                    pageSelector: pageSelector || null,
                    promptDigest: computePromptDigest(
                        projectRoot,
                        "pdf_translation_prompt.txt",
                    ),
                    modelRoutingFingerprint: gateway.routing.fingerprint,
                },
            }),
            { kind: "pdf" },
            logger,
        );

        console.log("\n📤 Step 1: Extracting PDF text blocks to JSON...");
        const hasCachedExtraction = fs.existsSync(extractedJsonPath);
        const cachedPdfJson = hasCachedExtraction
            ? JSON.parse(fs.readFileSync(extractedJsonPath, "utf8"))
            : null;
        const canReuseCachedExtraction =
            Boolean(cachedPdfJson) &&
            Number(cachedPdfJson.version || 0) >= PDF_BLOCKS_SCHEMA_VERSION;
        const pdfJson = canReuseCachedExtraction
            ? cachedPdfJson
            : await extractPdfToJson(
                  inputPath,
                  extractedJsonPath,
                  logger,
                  selectedPages,
              );
        if (canReuseCachedExtraction) {
            console.log(
                `   Using cached extraction: ${path.basename(extractedJsonPath)}`,
            );
        } else {
            if (hasCachedExtraction && cachedPdfJson) {
                console.log(
                    `   Cached extraction version ${cachedPdfJson.version || 0} is stale; regenerating.`,
                );
            }
            console.log(
                `   Saved fresh extraction: ${path.basename(extractedJsonPath)}`,
            );
        }
        logPdfDoclingSummary(pdfJson);

        const html = pdfJsonToHtml(pdfJson);
        const chapterMap = new Map([
            [
                "document",
                {
                    id: "document",
                    href: `${fileInfo.name}.html`,
                    html,
                    entryName: `${fileInfo.name}.html`,
                    title: pdfJson.title || fileInfo.name || "PDF Document",
                },
            ],
        ]);
        const chapters = [...chapterMap.values()];
        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = new Set();

        let glossary = {};

        const cachedGlossary = cache.loadGlossary();

        if (cachedGlossary && Object.keys(cachedGlossary).length > 0) {
            console.log("\n📊 Step 2: Loading glossary from cache...");
            glossary = cachedGlossary;
        } else {
            glossary = await generateInitialGlossary(
                chapterMap,
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
            "pdf",
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

        const translatedHtml = chapterMap.get("document").html;
        let outputHtmlPath = null;
        if (debugMode) {
            outputHtmlPath = path.resolve(
                outputDir,
                pageSelector
                    ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.html`
                    : `${fileInfo.name}_${targetLanguageSlug}.html`,
            );
            console.log(`\n💾 Step 4: Saving translated HTML snapshot...`);
            fs.writeFileSync(outputHtmlPath, translatedHtml, "utf8");
        }

        const translatedPdfJson = applyTranslatedHtmlToPdfJson(pdfJson, translatedHtml);
        const pdfMappingReport = translatedPdfJson.translationReport || {};
        console.log(
            `   Mapping: matched=${pdfMappingReport.matchedBlocks ?? 0}, missing=${pdfMappingReport.missingBlockIds?.length ?? 0}, unknown=${pdfMappingReport.unknownBlockIds?.length ?? 0}, duplicate=${pdfMappingReport.duplicateBlockIds?.length ?? 0}, unrecoveredPlaceholders=${pdfMappingReport.unrecoveredPlaceholders?.length ?? 0}`,
        );
        if (
            (pdfMappingReport.missingBlockIds?.length ?? 0) > 0 ||
            (pdfMappingReport.unrecoveredPlaceholders?.length ?? 0) > 0
        ) {
            logger.write(
                "WARN",
                `PDF mapping issues: missing=${JSON.stringify(pdfMappingReport.missingBlockIds || [])}, unrecovered=${JSON.stringify(pdfMappingReport.unrecoveredPlaceholders || [])}`,
            );
        }
        const repairedRuns = await repairPdfMergedTranslationRuns(
            translatedPdfJson,
            aiProvider,
            logger,
            runtimeConfig.targetLanguage,
        );
        if (repairedRuns > 0) {
            console.log(`🩹 Repaired ${repairedRuns} suspicious PDF translation run(s).`);
        }
        fs.writeFileSync(
            translatedJsonPath,
            JSON.stringify(translatedPdfJson, null, 2),
            "utf8",
        );
        if (debugMode) {
            fs.writeFileSync(
                debugSummaryPath,
                JSON.stringify(
                    (translatedPdfJson.blocks || []).map((block) => ({
                        id: block.id,
                        page: block.page,
                        role: block.role,
                        preserveOriginal: Boolean(block.preserveOriginal),
                        preserveReason: block.preserveReason || null,
                        fontSize: block.fontSize,
                        bbox: block.bbox,
                        text: block.text,
                        translatedText: block.translatedText || null,
                        translationMetaNote: block.translationMetaNote || null,
                    })),
                    null,
                    2,
                ),
                "utf8",
            );
            console.log(`🧾 Debug:  ${path.basename(debugSummaryPath)}`);
        }

        console.log("\n📥 Step 5: Filling translated text back into PDF...");
        const pdfFillResultPath = path.resolve(
            cacheDir,
            "pdf_fill_result.json",
        );
        const fillResult = await fillPdfFromJson(
            inputPath,
            translatedJsonPath,
            outputPdfPath,
            logger,
            pdfFillResultPath,
        );
        const actualPdfPath = fillResult.outputPath;
        if (fillResult.usedFallback) {
            console.log(
                `   ⚠️ Target PDF was locked; actual output: ${path.basename(actualPdfPath)}`,
            );
        }

        console.log("\n🔎 Step 6: Validating rendered PDF...");
        const validationReport = await validatePdfOutput(
            inputPath,
            translatedJsonPath,
            actualPdfPath,
            validationJsonPath,
            logger,
        );
        console.log(
            `   Validation: status=${validationReport.status} issues=${validationReport.issues?.length || 0}`,
        );

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        const archivedInputPath = moveFileIfNeeded(
            inputPath,
            finalInputPath,
        );

        completed = true;
        validationStatus = validationReport.status;
        if (translationStatus === "complete" && validationReport.status === "ok") {
            console.log(`\n✅ All done! Output: ${path.basename(actualPdfPath)}`);
        } else if (translationStatus !== "complete") {
            console.log(
                `\n⚠️ Output written with unresolved nodes: ${path.basename(actualPdfPath)} (cache retained; rerun to resume failed nodes)`,
            );
        } else {
            console.log(
                `\n⚠️ Render finished with review required. Validation: ${path.basename(validationJsonPath)}`,
            );
        }
        return buildJobResult({
            outputPath: actualPdfPath,
            cacheDir,
            logFile: logger.logFile,
            reportPath: validationJsonPath,
            validationStatus: validationReport.status,
            translationStatus,
            counts: {
                chapters: translationReport.chapters.length,
                failedChapters: translationReport.failedChapters.length,
                partialChapters: translationReport.partialChapters.length,
            },
            archivedInputPath,
            extra: {
                htmlOutputPath: outputHtmlPath,
                validationPath: validationJsonPath,
                pdfMappingReport,
                modelRouting: gateway.describe(),
                usage: gateway.usage(),
            },
        });
    } catch (error) {
        logger.write(
            "ERROR",
            `PDF Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const retention = finishJob(ctx, {
            keepArtifacts: !(
                completed &&
                translationStatus === "complete" &&
                validationStatus === "ok"
            ),
        });
        if (retention === "retained" && !debugMode) {
            logger.write(
                "WARN",
                `PDF artifacts retained (translation=${translationStatus}, validation=${validationStatus}, completed=${completed}): ${cacheDir}`,
            );
        }
    }
};
