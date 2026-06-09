import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import {
    CURRENT_PROVIDER,
    FALLBACK_PROVIDER,
    FALLBACK_ON_CONTENT_POLICY,
    JAPANESE_GLOSSARY_MODEL,
    JAPANESE_GLOSSARY_PROVIDER,
    RUSSIAN_GLOSSARY_MODEL,
    RUSSIAN_GLOSSARY_PROVIDER,
} from "./config.js";
import { createLogger } from "./support/logger.js";
import { createAIProvider } from "./translation/aiProvider.js";
import { createProgressCache } from "./support/cache.js";
import { selectChaptersBySpec } from "./support/chapterSelection.js";
import { callAIWithRetry, extractFirstHeading, loadHtml } from "./utils.js";
import { createBatchQueue } from "./translation/batchQueue.js";
import { planTranslationOrder } from "./agent.js";
import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "./content/headings.js";
import { generateInitialGlossary } from "./content/glossary.js";
import {
    collectVisibleTextNodes,
    detectEpubBookStructuralMode,
    performTranslation,
} from "./translation/translator.js";
import { synchronizeTocHtml, synchronizeNcx } from "./epub/tocSync.js";
import { saveEpub } from "./epub/epubSaver.js";
import {
    extractPdfToJson,
    fillPdfFromJson,
} from "./pdf/pdfBridge.js";
import { applyTranslatedHtmlToPdfJson, pdfJsonToHtml } from "./pdf/pdfHtml.js";
import { applyTranslatedHtmlToSubtitleJson, buildSubtitleJson, parseSrt, serializeSrt, subtitleJsonToHtml } from "./subtitle/srt.js";
import { convertExternalSubtitleToSrt, detectExternalSubtitleFiles, extractSubtitleStreamToSrt, inferSubtitleLanguageFromFile, muxTranslatedSubtitleIntoVideo, probeSubtitleStreams, selectSubtitleStream, assertSubtitleCodecSupported } from "./subtitle/video.js";

const sanitizeFileToken = (value) =>
    value.replace(/['"]/g, "").replace(/[<>:"/\\|?*\s]+/g, "_");

const createSelectionSlug = (selection) => {
    if (!selection) return "";
    const sanitized = sanitizeFileToken(selection).replace(/_+/g, "_").trim();
    return sanitized.slice(0, 60) || "selected";
};

const getLanguageFileCode = (languageName) => {
    const fileCodes = {
        English: "en",
        Spanish: "es",
        French: "fr",
        Russian: "ru",
        "Chinese (Simplified)": "zh",
        Korean: "ko",
        Japanese: "ja",
    };
    return (
        fileCodes[languageName] ||
        sanitizeFileToken(languageName.toLowerCase()).replace(/_+/g, "_")
    );
};

const countCachedChapters = (cache, chapters) =>
    chapters.reduce(
        (count, chapter) => count + (cache.load(chapter.id) ? 1 : 0),
        0,
    );

const PDF_BLOCKS_SCHEMA_VERSION = 2;
const PDF_REPAIR_MAX_RUN = 4;
const PDF_TRANSLATION_NOTE_PATTERNS = [
    /^[（(]?\s*(?:注|NOTE)\s*[:：]/i,
    /\bnode[_\s-]?\d+\b/i,
    /\bsid\b/i,
    /(?:按规则|严格保留|不合并|不调整|原文此处编号有误)/,
];
const PDF_TRANSLATION_SHORTHAND_PATTERNS = [
    /^(?:同上|同前|如上|上同|见上|见前)(?:[。．.!！?？]*)$/,
    /^(?:ibid\.?|same as above|see above|same as prior)(?:[.?!]*)$/i,
];

const normalizePdfRepairText = (value) =>
    String(value ?? "").replace(/\s+/g, " ").trim();

const compactPdfRepairText = (value) =>
    normalizePdfRepairText(value).replace(/\s+/g, "");

const isPdfTranslationMetaNote = (value) => {
    const normalized = normalizePdfRepairText(value);
    if (!normalized) return false;
    const matchCount = PDF_TRANSLATION_NOTE_PATTERNS.filter((pattern) =>
        pattern.test(normalized),
    ).length;
    if (matchCount >= 2) return true;
    if (
        matchCount >= 1 &&
        normalized.length <= 120 &&
        ["（", "(", "["].includes(normalized.slice(0, 1))
    ) {
        return true;
    }
    return false;
};

const isPdfTranslationShorthand = (value) => {
    const normalized = normalizePdfRepairText(value);
    if (!normalized) return false;
    return PDF_TRANSLATION_SHORTHAND_PATTERNS.some((pattern) =>
        pattern.test(normalized),
    );
};

const pdfBlockHorizontalOverlapRatio = (a, b) => {
    const aBox = a?.bbox || [0, 0, 0, 0];
    const bBox = b?.bbox || [0, 0, 0, 0];
    const overlap = Math.max(
        0,
        Math.min(Number(aBox[2] || 0), Number(bBox[2] || 0)) -
            Math.max(Number(aBox[0] || 0), Number(bBox[0] || 0)),
    );
    const minWidth = Math.max(
        1,
        Math.min(
            Number(aBox[2] || 0) - Number(aBox[0] || 0),
            Number(bBox[2] || 0) - Number(bBox[0] || 0),
        ),
    );
    return overlap / minWidth;
};

const sourceLooksLikeContinuation = (text) => {
    const normalized = normalizePdfRepairText(text);
    if (!normalized) return false;
    if (/[.!?。！？”"]$/.test(normalized)) return false;
    if (/[,;:，；：-]$/.test(normalized)) return true;
    if (/\b(?:such as|for example|including|like|if|if i|and some, such as)$/i.test(normalized)) {
        return true;
    }
    return true;
};

const blockStartsWithOpeningQuote = (text) =>
    /^[“"‘']/.test(normalizePdfRepairText(text));

const blocksFormRepairableRun = (previousBlock, block) => {
    if (!previousBlock || !block) return false;
    if (Number(previousBlock.page || 0) !== Number(block.page || 0)) return false;
    if (previousBlock.preserveOriginal || block.preserveOriginal) return false;
    if (String(previousBlock.role || "") !== "paragraph" || String(block.role || "") !== "paragraph") {
        return false;
    }
    const prevSize = Number(previousBlock.fontSize || 0);
    const size = Number(block.fontSize || 0);
    if (Math.abs(prevSize - size) > Math.max(2.5, prevSize * 0.18)) return false;
    const prevBox = previousBlock.bbox || [0, 0, 0, 0];
    const box = block.bbox || [0, 0, 0, 0];
    const yGap = Number(box[1] || 0) - Number(prevBox[3] || 0);
    if (yGap < -8 || yGap > 90) return false;
    if (pdfBlockHorizontalOverlapRatio(previousBlock, block) < 0.28) return false;
    return sourceLooksLikeContinuation(previousBlock.text || "");
};

const runLooksSuspiciousForRepair = (blocks) => {
    if (!Array.isArray(blocks) || blocks.length < 2) return false;
    const ratios = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const sourceText = normalizePdfRepairText(block.text || "");
        const translatedText = normalizePdfRepairText(block.translatedText || "");
        if (!sourceText || !translatedText) return true;
        if (isPdfTranslationMetaNote(translatedText) || isPdfTranslationShorthand(translatedText)) {
            return true;
        }
        if (
            index > 0 &&
            blockStartsWithOpeningQuote(translatedText) &&
            !blockStartsWithOpeningQuote(sourceText)
        ) {
            return true;
        }
        const sourceLen = Math.max(compactPdfRepairText(sourceText).length, 1);
        const translatedLen = Math.max(compactPdfRepairText(translatedText).length, 1);
        ratios.push(translatedLen / sourceLen);
        if (translatedLen <= 8 && sourceLen >= 24) return true;
    }
    return Math.max(...ratios) / Math.max(Math.min(...ratios), 0.01) > 2.2;
};

const buildPdfRepairPrompt = (targetLanguage) => `
You repair mis-split PDF block translations.

Task:
Redistribute translated text back into the original block boundaries.

Rules:
1. Return valid JSON only.
2. Output exact ids in the same order.
3. Use the source blocks to decide boundaries.
4. Keep all meaning from the current translated text, but move text back to the correct block.
5. You may lightly retranslate only when needed to restore the correct block boundary.
6. Do not merge blocks.
7. Do not leave a block empty.
8. Do not add notes, comments, warnings, or explanations.
9. Do not use shorthand such as "同上", "如上", "见上", "same as above", or "ibid." unless the source block itself says so.
10. The output language must be fluent ${targetLanguage}.

Return this schema:
{"blocks":[{"id":"...","translatedText":"..."}]}
`.trim();

const validatePdfRepairResult = (run, repairedBlocks) => {
    if (!Array.isArray(repairedBlocks) || repairedBlocks.length !== run.length) {
        return false;
    }
    const combinedOriginal = compactPdfRepairText(
        run.map((block) => block.translatedText || "").join(" "),
    );
    const combinedRepaired = compactPdfRepairText(
        repairedBlocks.map((block) => block.translatedText || "").join(" "),
    );
    if (!combinedRepaired) return false;
    if (
        combinedOriginal &&
        (combinedRepaired.length < combinedOriginal.length * 0.65 ||
            combinedRepaired.length > combinedOriginal.length * 1.45)
    ) {
        return false;
    }

    for (let index = 0; index < repairedBlocks.length; index++) {
        const repaired = repairedBlocks[index];
        const source = run[index];
        if (!repaired || repaired.id !== source.id) return false;
        const translatedText = normalizePdfRepairText(repaired.translatedText || "");
        if (!translatedText) return false;
        if (
            isPdfTranslationMetaNote(translatedText) ||
            isPdfTranslationShorthand(translatedText)
        ) {
            return false;
        }
        if (
            index > 0 &&
            blockStartsWithOpeningQuote(translatedText) &&
            !blockStartsWithOpeningQuote(source.text || "")
        ) {
            return false;
        }
    }
    return true;
};

const repairPdfMergedTranslationRuns = async (
    pdfJson,
    aiProvider,
    logger,
    targetLanguage,
) => {
    const blocks = Array.isArray(pdfJson?.blocks) ? pdfJson.blocks : [];
    if (blocks.length < 2) return 0;

    let repairedRunCount = 0;
    for (let index = 0; index < blocks.length - 1; index++) {
        const run = [blocks[index]];
        let cursor = index;
        while (
            cursor + 1 < blocks.length &&
            run.length < PDF_REPAIR_MAX_RUN &&
            blocksFormRepairableRun(blocks[cursor], blocks[cursor + 1])
        ) {
            run.push(blocks[cursor + 1]);
            cursor += 1;
        }
        if (run.length < 2 || !runLooksSuspiciousForRepair(run)) {
            continue;
        }

        const payload = {
            blocks: run.map((block) => ({
                id: block.id,
                source: normalizePdfRepairText(block.text || ""),
                translatedText: normalizePdfRepairText(block.translatedText || ""),
            })),
            mergedTranslation: normalizePdfRepairText(
                run.map((block) => block.translatedText || "").join(" "),
            ),
        };

        try {
            const repaired = await callAIWithRetry(
                aiProvider,
                JSON.stringify(payload, null, 2),
                buildPdfRepairPrompt(targetLanguage),
                2,
            );
            const repairedBlocks = repaired?.blocks;
            if (!validatePdfRepairResult(run, repairedBlocks)) {
                logger.write(
                    "WARN",
                    `PDF repair validation failed for run: ${run.map((block) => block.id).join(", ")}`,
                );
                continue;
            }
            for (let runIndex = 0; runIndex < run.length; runIndex++) {
                run[runIndex].translatedText = normalizePdfRepairText(
                    repairedBlocks[runIndex].translatedText,
                );
            }
            logger.write(
                "INFO",
                `PDF repair applied for run: ${run.map((block) => block.id).join(", ")}`,
            );
            repairedRunCount += 1;
            index = cursor;
        } catch (error) {
            logger.write(
                "WARN",
                `PDF repair failed for run ${run.map((block) => block.id).join(", ")}: ${error.stack || error.message}`,
            );
        }
    }

    return repairedRunCount;
};

const logPdfDoclingSummary = (pdfJson) => {
    const summary = pdfJson?.doclingSummary;
    if (!summary) return;

    if (summary.enabled) {
        const labelCounts = summary.labelCounts || {};
        const labelPreview = Object.entries(labelCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 6)
            .map(([label, count]) => `${label}=${count}`)
            .join(", ");
        console.log(
            `   Docling: status=${summary.status} items=${summary.items ?? 0} matchedBlocks=${summary.matchedBlocks ?? 0} elapsedMs=${summary.elapsedMs ?? 0}${labelPreview ? ` labels=[${labelPreview}]` : ""}`,
        );
    } else {
        console.log(
            `   Docling: status=${summary.status || "disabled"}${summary.error ? ` error=${summary.error}` : ""}`,
        );
    }
};

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const moveFileIfNeeded = (sourcePath, targetPath) => {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedSource === resolvedTarget) return;
    ensureDir(path.dirname(resolvedTarget));
    if (fs.existsSync(resolvedTarget)) {
        fs.unlinkSync(resolvedTarget);
    }
    fs.renameSync(resolvedSource, resolvedTarget);
};

const collectReferencedIds = (chapterMap) => {
    const referencedIds = new Set();
    for (const chapter of chapterMap.values()) {
        const $ = loadHtml(chapter.html);
        $("a[href]").each((_, el) => {
            const hash = $(el).attr("href")?.split("#")[1];
            if (hash) referencedIds.add(hash);
        });
    }
    return referencedIds;
};

const collectDefinedClasses = (zipEntries) => {
    const definedClasses = new Set();
    const cssEntries = zipEntries.filter((entry) =>
        entry.entryName.endsWith(".css"),
    );
    for (const entry of cssEntries) {
        const css = entry.getData().toString("utf8");
        const matches = css.matchAll(/\.([a-zA-Z][\w-]*)/g);
        for (const match of matches) definedClasses.add(match[1]);
    }
    return definedClasses;
};

const hasUsableProviderConfig = (providerName, config) => {
    const providerConfig = config?.[providerName];
    if (!providerConfig) return false;
    return Boolean(providerConfig.apiKey);
};

const createGlossaryProvider = (logger, runtimeConfig) => {
    const primaryProvider = createAIProvider(
        CURRENT_PROVIDER,
        runtimeConfig,
        logger,
        FALLBACK_PROVIDER,
        FALLBACK_ON_CONTENT_POLICY,
    );

    let glossaryProviderName = null;
    let glossaryModelName = null;

    if (runtimeConfig.sourceLanguage === "Russian") {
        glossaryProviderName = RUSSIAN_GLOSSARY_PROVIDER;
        glossaryModelName = RUSSIAN_GLOSSARY_MODEL;
    } else if (runtimeConfig.sourceLanguage === "Japanese") {
        glossaryProviderName = JAPANESE_GLOSSARY_PROVIDER;
        glossaryModelName = JAPANESE_GLOSSARY_MODEL;
    }

    if (!glossaryProviderName || !glossaryModelName) {
        return primaryProvider;
    }

    const glossaryConfig = {
        ...runtimeConfig,
        [glossaryProviderName]: {
            ...runtimeConfig[glossaryProviderName],
            modelName: glossaryModelName,
        },
    };

    if (!hasUsableProviderConfig(glossaryProviderName, glossaryConfig)) {
        return primaryProvider;
    }

    return createAIProvider(glossaryProviderName, glossaryConfig, logger);
};

const createChapterMap = (zipEntries) => {
    const chapterMap = new Map();
    const opfEntry = zipEntries.find((entry) => entry.entryName.endsWith(".opf"));
    if (!opfEntry) {
        throw new Error("OPF file not found in EPUB.");
    }

    const opfBasePath = opfEntry.entryName.replace(/[^/]+$/, "");
    const $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
        xmlMode: true,
    });

    $opf("[media-type='application/xhtml+xml']").each((_, el) => {
        const item = {
            id: $opf(el).attr("id"),
            href: $opf(el).attr("href"),
            mediaType: $opf(el).attr("media-type"),
        };
        if (item.mediaType !== "application/xhtml+xml") return;

        const fullHref = opfBasePath + item.href;
        const zipEntry = zipEntries.find(
            (entry) => decodeURIComponent(entry.entryName) === fullHref,
        );
        const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
        const chapter = {
            ...item,
            html,
            entryName: zipEntry?.entryName,
            title: extractFirstHeading(html) || item.id || "Untitled",
        };

        if (chapter.entryName) {
            chapterMap.set(chapter.id, chapter);
        }
    });

    return chapterMap;
};

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

const saveHtmlDocument = async (outputPath, html, logger) => {
    console.log(`\n💾 Step 5: Finalizing and Saving...`);
    try {
        fs.writeFileSync(outputPath, html, "utf8");
        console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
    } catch (error) {
        logger.write("ERROR", `Save HTML Failed: ${error.stack || error.message}`);
        throw error;
    }
};

const VIDEO_INPUT_EXTENSIONS = new Set([".mkv", ".mp4", ".mov", ".m4v", ".webm"]);

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

    let shouldKeepArtifacts = debugMode;

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
            plan = cachedPlan;
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
        return { outputPath, cacheDir, logFile: logger.logFile };
    } catch (error) {
        shouldKeepArtifacts = debugMode;
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        if (!shouldKeepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
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

    let shouldKeepArtifacts = debugMode;

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
        return { outputPath, cacheDir, logFile: logger.logFile };
    } catch (error) {
        shouldKeepArtifacts = debugMode;
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        if (!shouldKeepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};

export const runPdfTranslationJob = async ({
    projectRoot,
    inputPath,
    pageSelector = null,
    selectedPages = null,
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
    const selectionSlug = createSelectionSlug(pageSelector);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPdfPath = path.resolve(
        outputDir,
        pageSelector
            ? `${fileInfo.name}_page-${selectionSlug}_${targetLanguageSlug}.pdf`
            : `${fileInfo.name}_${targetLanguageSlug}.pdf`,
    );
    const cacheDir = path.resolve(
        projectRoot,
        pageSelector
            ? `.cache_${fileInfo.name}_page-${selectionSlug}_pdf`
            : `.cache_${fileInfo.name}_pdf`,
    );
    const cache = createProgressCache(cacheDir);
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
    if (runtimeConfig[CURRENT_PROVIDER]?.concurrency) {
        console.log(
            `⚙️ Concurrency: ${runtimeConfig[CURRENT_PROVIDER].concurrency}`,
        );
    }
    if (pageSelector) {
        console.log(`📄 Pages: ${pageSelector}`);
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    console.log(`========================================\n`);

    let shouldKeepArtifacts = debugMode;

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
                glossaryProvider,
                logger,
                runtimeConfig,
            );
            cache.saveGlossary(glossary);
        }

        const cachedHtml = cache.load("document");
        if (cachedHtml) {
            console.log(`\n📑 Found cached translated PDF HTML, reusing it.`);
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
                "pdf",
                debugMode,
            );
            await batchQueue.drainQueue();
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

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        moveFileIfNeeded(inputPath, finalInputPath);

        console.log(`\n✅ All done! Output: ${path.basename(outputPdfPath)}`);
        return {
            outputPath: outputPdfPath,
            htmlOutputPath: outputHtmlPath,
            cacheDir,
            logFile: logger.logFile,
        };
    } catch (error) {
        shouldKeepArtifacts = debugMode;
        logger.write(
            "ERROR",
            `PDF Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        if (!shouldKeepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};

export const runSubtitleTranslationJob = async ({
    projectRoot,
    inputPath,
    debugMode = false,
    runtimeConfig,
    sourceLanguageExplicit = false,
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
    const batchQueue = createBatchQueue(aiProvider, logger);

    const fileInfo = path.parse(inputPath);
    const inputExt = fileInfo.ext.toLowerCase();
    const isVideoInput = VIDEO_INPUT_EXTENSIONS.has(inputExt);
    const targetLanguageSlug = getLanguageFileCode(runtimeConfig.targetLanguage);
    const outputPath = path.resolve(
        outputDir,
        isVideoInput
            ? `${fileInfo.name}_${targetLanguageSlug}.mkv`
            : `${fileInfo.name}_${targetLanguageSlug}.srt`,
    );
    const cacheDir = path.resolve(projectRoot, `.cache_${fileInfo.name}_subtitle`);
    const cache = createProgressCache(cacheDir);
    const extractedSrtBasePath = path.resolve(cacheDir, "source_subtitle");
    const sourceJsonPath = path.resolve(cacheDir, "subtitle_cues.json");
    const translatedJsonPath = path.resolve(
        cacheDir,
        "subtitle_cues_translated.json",
    );
    const translatedSrtPath = isVideoInput
        ? path.resolve(cacheDir, "translated_subtitle.srt")
        : outputPath;
    const streamProbePath = path.resolve(cacheDir, "subtitle_streams.json");

    console.log(`\n========================================`);
    console.log(
        `${isVideoInput ? "🎬" : "🎞️"} Input:  ${path.basename(inputPath)}`,
    );
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

    let shouldKeepArtifacts = debugMode;

    try {
        let sourceSrtPath = inputPath;
        let subtitleTrack = null;
        let subtitleStreamCount = 0;
        let preservedExternalSubtitleFiles = [];

        if (isVideoInput) {
            console.log("\n🎞️ Step 1: Probing subtitle tracks...");
            const embeddedStreams = await probeSubtitleStreams(inputPath, logger);
            const externalSubtitleFiles = detectExternalSubtitleFiles(inputPath);
            const streams = [...embeddedStreams, ...externalSubtitleFiles];
            subtitleStreamCount = embeddedStreams.length;
            preservedExternalSubtitleFiles = externalSubtitleFiles;
            if (debugMode) {
                fs.writeFileSync(streamProbePath, JSON.stringify(streams, null, 2), "utf8");
            }
            const selectedStream = selectSubtitleStream({
                streams,
                preferredLanguage: sourceLanguageExplicit
                    ? runtimeConfig.sourceLanguage
                    : null,
                fallbackLanguage: "English",
            });
            assertSubtitleCodecSupported(selectedStream);
            subtitleTrack = {
                kind: selectedStream.kind || "embedded",
                streamIndex:
                    selectedStream.kind === "external"
                        ? null
                        : Number(selectedStream.index || 0),
                codecName: selectedStream.codec_name || null,
                language:
                    selectedStream.resolvedLanguage ||
                    selectedStream.tags?.language ||
                    null,
                title: selectedStream.tags?.title || null,
                path: selectedStream.path || null,
            };
            console.log(
                subtitleTrack.kind === "external"
                    ? `   Selected external subtitle: ${path.basename(subtitleTrack.path)}${subtitleTrack.language ? ` (${subtitleTrack.language})` : ""}`
                    : `   Selected subtitle stream #${subtitleTrack.streamIndex} (${subtitleTrack.codecName}${subtitleTrack.language ? `, ${subtitleTrack.language}` : ""})`,
            );
            const extractedSrtPath =
                subtitleTrack.kind === "external"
                    ? `${extractedSrtBasePath}_external.srt`
                    : `${extractedSrtBasePath}_${subtitleTrack.streamIndex}.srt`;

            if (fs.existsSync(extractedSrtPath)) {
                console.log(
                    `   Using cached subtitle extraction: ${path.basename(extractedSrtPath)}`,
                );
            } else {
                console.log("\n📤 Step 2: Extracting subtitle track to SRT...");
                if (subtitleTrack.kind === "external") {
                    await convertExternalSubtitleToSrt(
                        subtitleTrack.path,
                        extractedSrtPath,
                        logger,
                    );
                } else {
                    await extractSubtitleStreamToSrt(
                        inputPath,
                        subtitleTrack.streamIndex,
                        extractedSrtPath,
                        logger,
                    );
                }
            }
            sourceSrtPath = extractedSrtPath;
        }

        const srtContent = fs.readFileSync(sourceSrtPath, "utf8");
        if (!sourceLanguageExplicit) {
            runtimeConfig.sourceLanguage =
                subtitleTrack?.language ||
                inferSubtitleLanguageFromFile(srtContent) ||
                runtimeConfig.sourceLanguage;
        }
        const glossaryProvider = createGlossaryProvider(logger, runtimeConfig);

        console.log("\n🧩 Step 3: Parsing subtitle cues to JSON...");
        const subtitleJson = buildSubtitleJson({
            sourceFile: path.basename(inputPath),
            sourceType: isVideoInput ? "video" : "srt",
            sourceLanguage: runtimeConfig.sourceLanguage,
            targetLanguage: runtimeConfig.targetLanguage,
            cues: parseSrt(srtContent),
            subtitleTrack,
        });
        fs.writeFileSync(sourceJsonPath, JSON.stringify(subtitleJson, null, 2), "utf8");

        const html = subtitleJsonToHtml(subtitleJson);
        const chapterMap = new Map([
            [
                "document",
                {
                    id: "document",
                    href: `${fileInfo.name}.html`,
                    html,
                    entryName: `${fileInfo.name}.html`,
                    title: subtitleJson.sourceFile || fileInfo.name || "Subtitle Document",
                },
            ],
        ]);
        const chapters = [...chapterMap.values()];
        const referencedIds = new Set();
        const definedClasses = new Set();

        let glossary = {};
        const cachedGlossary = cache.loadGlossary();
        if (cachedGlossary && Object.keys(cachedGlossary).length > 0) {
            console.log("\n📊 Step 4: Loading glossary from cache...");
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

        const cachedHtml = cache.load("document");
        if (cachedHtml) {
            console.log(`\n📑 Found cached translated subtitle HTML, reusing it.`);
            chapterMap.get("document").html = cachedHtml;
        } else {
            console.log("\n✍️ Step 5: Translating subtitle content...");
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
                "subtitle",
                debugMode,
            );
            await batchQueue.drainQueue();
        }

        console.log("\n🧱 Step 6: Writing translated subtitle artifacts...");
        const translatedSubtitleJson = applyTranslatedHtmlToSubtitleJson(
            subtitleJson,
            chapterMap.get("document").html,
        );
        fs.writeFileSync(
            translatedJsonPath,
            JSON.stringify(translatedSubtitleJson, null, 2),
            "utf8",
        );
        const translatedSrtContent = serializeSrt(translatedSubtitleJson);
        parseSrt(translatedSrtContent);
        fs.writeFileSync(translatedSrtPath, translatedSrtContent, "utf8");

        if (isVideoInput) {
            console.log("\n📥 Step 7: Muxing translated subtitle into output video...");
            await muxTranslatedSubtitleIntoVideo({
                inputPath,
                translatedSrtPath,
                outputPath,
                targetLanguage: runtimeConfig.targetLanguage,
                existingSubtitleCount: subtitleStreamCount,
                externalSubtitleFiles: preservedExternalSubtitleFiles,
                logger,
            });
        }

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        moveFileIfNeeded(inputPath, finalInputPath);

        console.log(`\n✅ All done! Output: ${path.basename(outputPath)}`);
        return {
            outputPath,
            cacheDir,
            logFile: logger.logFile,
            translatedJsonPath,
            translatedSrtPath,
        };
    } catch (error) {
        shouldKeepArtifacts = true;
        logger.write(
            "ERROR",
            `Subtitle Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        if (!shouldKeepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};
