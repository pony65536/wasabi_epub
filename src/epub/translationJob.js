import AdmZip from "adm-zip";
import path from "path";
import { buildJobResult } from "../support/jobRuntime.js";
import { buildTaskSignature, computePromptDigest } from "../support/taskIdentity.js";
import { selectChaptersBySpec } from "../support/chapterSelection.js";
import { moveFileIfNeeded } from "../support/archive.js";
import { planTranslationOrder } from "../agent.js";
import { runDirectorAgent } from "../content/director.js";
import { LivingMemoryStore } from "../content/memory.js";
import { repairChapterMapInPlace } from "./epubDoctor.js";
import { buildLinkContext, rewriteInternalLinks, validateInternalLinks, validateNcxLinks } from "./linkRewriter.js";
import { analyzeHeadingFormats, standardizeHeadingsByRules } from "../content/headings.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { EXCLUDED_ROLES, classifyChapterRole } from "../content/chapterRoles.js";
import { ContextRetriever } from "../content/retriever.js";
import { detectEpubBookStructuralMode, mergeTranslationReports } from "../translation/translator.js";
import { synchronizeTocHtml, synchronizeNcx } from "./tocSync.js";
import { saveEpub } from "./epubSaver.js";
import { createSelectionSlug, getLanguageFileCode } from "../support/naming.js";
import { collectReferencedIds, collectDefinedClasses, createChapterMap, sanitizeCachedPlan } from "./chapterMap.js";
import { countCachedChapters, ensureCacheIdentity } from "../pipeline/jobSupport.js";
import { createJobContext, finishJob, formatRoutingSummary } from "../pipeline/jobContext.js";
import { translateChapters } from "../pipeline/translateDocument.js";

export const runTranslationJob = async ({
    projectRoot,
    inputPath,
    chapterSelector = null,
    debugMode = false,
    runtimeConfig,
    modelName = null,
    createAdapter,
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
            ? `.cache_${fileInfo.name}_${targetLanguageSlug}_chap-${selectionSlug}`
            : `.cache_${fileInfo.name}_${targetLanguageSlug}`,
    );
    const ctx = createJobContext({ projectRoot, inputPath, runtimeConfig, debugMode, cacheDir, modelName, createAdapter });
    const { logger, gateway, aiProvider, batchQueue, cache, inputDir } = ctx;
    const glossaryProvider = ctx.getGlossaryProvider();

    console.log(`\n========================================`);
    console.log(`📖 Input:  ${path.basename(inputPath)}`);
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
    if (chapterSelector) {
        console.log(`🎯 Chapters: ${chapterSelector}`);
    }
    console.log(`========================================\n`);

    let completed = false;
    let shouldKeepArtifacts = debugMode;
    let translationStatus = "complete";

    try {
        const zip = new AdmZip(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = createChapterMap(zipEntries);

        // 🩺 内存级就地体检与重构：针对非标/超大单文件假章节进行智能切分
        const repairReport = repairChapterMapInPlace(chapterMap, logger, {
            zipEntries,
        });
        const repairFingerprint = repairReport.fingerprint;
        const epubTaskSignature = buildTaskSignature({
            kind: "epub",
            sourceDigest: repairReport.sourceDigest,
            sourceLanguage: runtimeConfig.sourceLanguage,
            targetLanguage: runtimeConfig.targetLanguage,
            extras: {
                repairFingerprint,
                promptDigest: computePromptDigest(
                    projectRoot,
                    "epub_translation_prompt.txt",
                ),
                chapterSelector: chapterSelector || null,
                modelRoutingFingerprint: gateway.routing.fingerprint,
            },
        });
        ensureCacheIdentity(
            cache,
            epubTaskSignature,
            { kind: "epub", repairFingerprint },
            logger,
        );
        cache.saveRepairFingerprint(repairFingerprint);

        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = collectDefinedClasses(zipEntries);

        let plan = { sorted: [], tocId: null };
        let headingFormatRules = [];
        let glossary = {};
        let bookBible = null;
        let ncxEntry = null;
        let ncxContent = null;

        const cachedBookBible = cache.loadBookBible();
        const cachedPlan = cache.loadPlan();
        const cachedGlossary = cache.loadGlossary();
        const cachedHeadingRules = cache.loadHeadingRules();

        // 先规划（确定角色/阅读顺序），再抽样运行 Director，只喂正文
        if (cachedPlan) {
            console.log("\n🕵️ Step 1: Loading translation plan from cache...");
            plan = sanitizeCachedPlan(cachedPlan, chapterMap, logger) || cachedPlan;
            cache.savePlan({ ...plan, repairFingerprint });
            if (plan.tocId) {
                const tocChapter = chapterMap.get(plan.tocId);
                if (tocChapter) tocChapter.isTOC = true;
            }
        } else {
            plan = await planTranslationOrder(
                [...chapterMap.values()],
                gateway.forStage("planner"),
                logger,
            );
            cache.savePlan({ ...plan, repairFingerprint });
        }

        if (cachedBookBible) {
            console.log("\n🎬 Step 0: Loading Book Bible from cache...");
            bookBible = cachedBookBible;
        } else {
            const roleOfChapter = (chapter) =>
                plan.roles?.[chapter.id] || classifyChapterRole(chapter);
            const directorChapters = plan.sorted.filter(
                (chapter) =>
                    !chapter.isTOC &&
                    !EXCLUDED_ROLES.has(roleOfChapter(chapter)) &&
                    roleOfChapter(chapter) !== "front",
            );
            bookBible = await runDirectorAgent(
                directorChapters.length > 0
                    ? directorChapters
                    : [...chapterMap.values()],
                gateway.forStage("director"),
                logger,
                runtimeConfig,
            );
            if (bookBible) {
                cache.saveBookBible(bookBible);
            }
        }

        const livingMemoryStore = new LivingMemoryStore(bookBible, cache);

        const roleOf = (chapter) =>
            plan.roles?.[chapter.id] || classifyChapterRole(chapter);

        // 阅读顺序（spine）中的可翻译章节，作为 --chap 编号基准，与 AI 重排无关
        const readingOrderChapters = [...chapterMap.values()].filter(
            (chapter) =>
                !chapter.isTOC && !EXCLUDED_ROLES.has(roleOf(chapter)),
        );
        const selectedChapters = chapterSelector
            ? (() => {
                  const selected = selectChaptersBySpec(
                      readingOrderChapters,
                      chapterSelector,
                  );
                  const selectedIds = new Set(
                      selected.map((chapter) => chapter.id),
                  );
                  return plan.sorted.filter((chapter) =>
                      selectedIds.has(chapter.id),
                  );
              })()
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
                gateway.forStage("headings"),
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
            // 将 Director Agent 提取的特定世界观/术语合并入 glossary
            if (bookBible?.worldviewAndGlossary) {
                glossary = {
                    ...bookBible.worldviewAndGlossary,
                    ...glossary,
                };
            }
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

        const contextRetriever = new ContextRetriever();
        const translationOptions = {
            ...epubStructuralMode,
            bookBible,
            livingMemoryStore,
            contextRetriever,
            criticProvider: gateway.forStage("critic"),
            memoryProvider: gateway.forStage("memory"),
        };

        // 阶段化调度：正文优先（积累记忆与术语），前置材料最后
        const contentChapters = selectedChapters.filter(
            (chapter) => roleOf(chapter) !== "front",
        );
        const frontChapters = selectedChapters.filter(
            (chapter) => roleOf(chapter) === "front",
        );

        const phaseReports = [];
        if (contentChapters.length > 0) {
            phaseReports.push(
                await translateChapters(
                    contentChapters,
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
                    translationOptions,
                ),
            );
        }

        // 将正文阶段沉淀的动态术语并入 glossary，供前言阶段使用
        if (frontChapters.length > 0) {
            const snapshot = livingMemoryStore?.getSnapshot?.();
            const dynamicGlossary = snapshot?.worldviewAndGlossary || {};
            if (Object.keys(dynamicGlossary).length > 0) {
                glossary = { ...dynamicGlossary, ...glossary };
                cache.saveGlossary(glossary);
                console.log(
                    `  🧠 Merged ${Object.keys(dynamicGlossary).length} memory term(s) into glossary for front-matter phase.`,
                );
            }
            phaseReports.push(
                await translateChapters(
                    frontChapters,
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
                    translationOptions,
                ),
            );
        }

        const translationReport = mergeTranslationReports(phaseReports);
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
            selectedChapterMap,
            headingFormatRules,
            gateway.forStage("headings"),
            batchQueue,
            logger,
        );

        const linkContext = buildLinkContext(chapterMap, zipEntries);
        const linkStats = rewriteInternalLinks(chapterMap, linkContext);
        console.log(
            `\n🔗 Step 5.5: Rewrote ${linkStats.rewritten}/${linkStats.scanned} internal link(s)${linkStats.unresolved > 0 ? ` (${linkStats.unresolved} unresolved)` : ""}.`,
        );

        const tocResult = await synchronizeTocHtml(
            chapterMap,
            plan.tocId,
            linkContext,
        );
        if (!tocResult.ok) {
            throw new Error(
                `HTML TOC synchronization failed: ${tocResult.error}. Cache retained; output not written.`,
            );
        }
        const ncxResult = await synchronizeNcx(
            chapterMap,
            zipEntries,
            linkContext,
        );
        ncxEntry = ncxResult.ncxEntry;
        ncxContent = ncxResult.ncxContent;
        if (!ncxResult.ok) {
            throw new Error(
                `NCX synchronization failed: ${ncxResult.error}. Cache retained; output not written.`,
            );
        }

        // 保存前验收：内部链接（含锚点）必须全部可解析
        const linkValidation = validateInternalLinks(chapterMap, linkContext);
        if (linkStats.unresolved > 0 || linkValidation.dangling > 0) {
            const details = [
                `dangling=${linkValidation.dangling}`,
                `unresolvedAfterRewrite=${linkStats.unresolved}`,
                ...linkValidation.samples,
            ];
            throw new Error(
                `EPUB link validation failed before save: ${details.join("; ")}. Cache retained; output not written.`,
            );
        }
        console.log(
            `\n🔎 Step 5.6: Link validation passed (${linkValidation.total} internal link(s)).`,
        );

        // 保存前验收：NCX 目录的文件与锚点必须全部可解析
        if (ncxEntry && ncxContent) {
            const ncxValidation = validateNcxLinks(
                ncxContent,
                ncxEntry.entryName,
                linkContext,
            );
            if (ncxValidation.dangling > 0) {
                throw new Error(
                    `NCX validation failed before save: ${ncxValidation.dangling}/${ncxValidation.total} entries dangling. ${ncxValidation.samples.join("; ")}. Cache retained; output not written.`,
                );
            }
            console.log(
                `🔎 Step 5.7: NCX validation passed (${ncxValidation.total} entries).`,
            );
        }

        await saveEpub(
            zip,
            chapterMap,
            ncxEntry ?? null,
            ncxContent ?? null,
            outputPath,
            logger,
            repairReport,
        );

        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        const archivedInputPath = moveFileIfNeeded(
            inputPath,
            finalInputPath,
        );

        completed = true;
        shouldKeepArtifacts = shouldKeepArtifacts || translationStatus !== "complete";
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
