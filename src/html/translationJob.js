import fs from "fs";
import path from "path";

import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { collectReferencedIds } from "../epub/chapterMap.js";
import {
    createJobContext,
    finishJob,
    printJobBanner,
} from "../pipeline/jobContext.js";
import {
    moveFileIfNeeded,
    saveHtmlDocument,
} from "../support/files.js";
import { getLanguageFileCode } from "../support/naming.js";
import { translateDocument } from "../pipeline/translateDocument.js";
import { collectVisibleTextNodes } from "../translation/translator.js";
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
    const outputDir = path.resolve(projectRoot, "output");
    const fileInfo = path.parse(inputPath);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPath = path.resolve(
        outputDir,
        `${fileInfo.name}_${targetLanguageSlug}.html`,
    );
    const cacheDir = path.resolve(projectRoot, `.cache_${fileInfo.name}_html`);
    const ctx = createJobContext({
        projectRoot,
        inputPath,
        runtimeConfig,
        debugMode,
        cacheDir,
    });
    const { logger, aiProvider, batchQueue, cache } = ctx;

    printJobBanner(ctx, {
        inputIcon: "📄",
        inputName: path.basename(inputPath),
        outputName: path.basename(outputPath),
    });

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
            cachedMessage: "HTML",
            runtimeConfig,
            aiProvider,
            batchQueue,
            logger,
            debugMode,
            referencedIds,
            definedClasses,
            mode: "html",
            postTranslate: async () => {
                await standardizeHeadingsByRules(
                    chapterMap,
                    headingFormatRules,
                    aiProvider,
                    batchQueue,
                    logger,
                );
            },
        });

        await saveHtmlDocument(
            outputPath,
            chapterMap.get("document").html,
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
