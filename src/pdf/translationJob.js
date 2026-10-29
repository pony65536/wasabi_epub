import fs from "fs";
import path from "path";

import { generateInitialGlossary } from "../content/glossary.js";
import { collectReferencedIds } from "../epub/chapterMap.js";
import {
    createJobContext,
    finishJob,
    printJobBanner,
} from "../pipeline/jobContext.js";
import { moveFileIfNeeded } from "../support/files.js";
import {
    createSelectionSlug,
    getLanguageFileCode,
} from "../support/naming.js";
import { translateDocument } from "../pipeline/translateDocument.js";
import {
    extractPdfToJson,
    fillPdfFromJson,
    validatePdfOutput,
} from "./pdfBridge.js";
import { applyTranslatedHtmlToPdfJson, pdfJsonToHtml } from "./pdfHtml.js";
import {
    PDF_BLOCKS_SCHEMA_VERSION,
    logPdfDoclingSummary,
    repairPdfMergedTranslationRuns,
} from "./repair.js";

export const runPdfTranslationJob = async ({
    projectRoot,
    inputPath,
    pageSelector = null,
    selectedPages = null,
    debugMode = false,
    runtimeConfig,
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
            ? `.cache_${fileInfo.name}_page-${selectionSlug}_pdf`
            : `.cache_${fileInfo.name}_pdf`,
    );
    const debugHtmlPath = debugMode
        ? path.resolve(
              outputDir,
              pageSelector
                  ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.html`
                  : `${fileInfo.name}_${targetLanguageSlug}.html`,
          )
        : null;
    const ctx = createJobContext({
        projectRoot,
        inputPath,
        runtimeConfig,
        debugMode,
        cacheDir,
    });
    const { logger, aiProvider, batchQueue, cache } = ctx;
    const extractedJsonPath = path.resolve(cacheDir, "pdf_blocks.json");
    const translatedJsonPath = path.resolve(cacheDir, "pdf_blocks_translated.json");
    const debugSummaryPath = path.resolve(cacheDir, "pdf_blocks_debug.json");

    printJobBanner(ctx, {
        inputIcon: "📕",
        inputName: path.basename(inputPath),
        outputName: path.basename(outputPdfPath),
        htmlName: debugHtmlPath ? path.basename(debugHtmlPath) : null,
        pageSelector,
    });

    let completed = false;

    try {
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
                ctx.glossaryProvider,
                logger,
                runtimeConfig,
            );
            cache.saveGlossary(glossary);
        }

        await translateDocument({
            chapters,
            chapterMap,
            glossary,
            cache,
            cacheMode: "document",
            cacheKey: "document",
            cachedMessage: "PDF HTML",
            runtimeConfig,
            aiProvider,
            batchQueue,
            logger,
            debugMode,
            referencedIds,
            definedClasses,
            mode: "pdf",
        });

        const translatedHtml = chapterMap.get("document").html;
        const outputHtmlPath = debugHtmlPath;
        if (debugMode) {
            console.log(`\n💾 Step 4: Saving translated HTML snapshot...`);
            fs.writeFileSync(outputHtmlPath, translatedHtml, "utf8");
        }

        const translatedPdfJson = applyTranslatedHtmlToPdfJson(pdfJson, translatedHtml);
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
        await fillPdfFromJson(inputPath, translatedJsonPath, outputPdfPath, logger);

        console.log("\n🔎 Step 6: Validating rendered PDF...");
        const validationReport = await validatePdfOutput(
            inputPath,
            translatedJsonPath,
            outputPdfPath,
            validationJsonPath,
            logger,
        );
        console.log(
            `   Validation: status=${validationReport.status} issues=${validationReport.issues?.length || 0}`,
        );

        const finalInputPath = path.resolve(ctx.inputDir, path.basename(inputPath));
        moveFileIfNeeded(inputPath, finalInputPath);

        if (validationReport.status === "ok") {
            console.log(`\n✅ All done! Output: ${path.basename(outputPdfPath)}`);
        } else {
            console.log(
                `\n⚠️ Render finished with review required. Validation: ${path.basename(validationJsonPath)}`,
            );
        }
        completed = true;
        return {
            outputPath: outputPdfPath,
            htmlOutputPath: outputHtmlPath,
            cacheDir,
            logFile: logger.logFile,
            validationPath: validationJsonPath,
            validationStatus: validationReport.status,
        };
    } catch (error) {
        logger.write(
            "ERROR",
            `PDF Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const keepArtifacts = finishJob(ctx, {
            completed,
            retainOnFailure: true,
        });
        if (keepArtifacts && !completed) {
            logger.write(
                "WARN",
                `PDF rendering failed; cache retained for debugging: ${cacheDir}`,
            );
        }
    }
};
