import AdmZip from "adm-zip";
import path from "path";

import { planTranslationOrder } from "../agent.js";
import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import {
    createJobContext,
    finishJob,
    printJobBanner,
} from "../pipeline/jobContext.js";
import { selectChaptersBySpec } from "../support/chapterSelection.js";
import { moveFileIfNeeded } from "../support/files.js";
import {
    createSelectionSlug,
    getLanguageFileCode,
} from "../support/naming.js";
import { translateDocument } from "../pipeline/translateDocument.js";
import { detectEpubBookStructuralMode } from "../translation/translator.js";
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
    const outputDir = path.resolve(projectRoot, "output");
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
    const ctx = createJobContext({
        projectRoot,
        inputPath,
        runtimeConfig,
        debugMode,
        cacheDir,
    });
    const { logger, aiProvider, batchQueue, cache } = ctx;

    printJobBanner(ctx, {
        inputIcon: "📖",
        inputName: path.basename(inputPath),
        outputName: path.basename(outputPath),
        chapterSelector,
    });

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
                ctx.glossaryProvider,
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

        await translateDocument({
            chapters: selectedChapters,
            chapterMap,
            glossary,
            cache,
            cacheMode: "perChapter",
            runtimeConfig,
            aiProvider,
            batchQueue,
            logger,
            debugMode,
            referencedIds,
            definedClasses,
            mode: "epub",
            translationOptions: epubStructuralMode,
            postTranslate: async () => {
                await standardizeHeadingsByRules(
                    selectedChapterMap,
                    headingFormatRules,
                    aiProvider,
                    batchQueue,
                    logger,
                );
            },
        });

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

        const finalInputPath = path.resolve(ctx.inputDir, path.basename(inputPath));
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
        finishJob(ctx, { completed, retainOnFailure: false });
    }
};
