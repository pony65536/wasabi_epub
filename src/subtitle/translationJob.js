import fs from "fs";
import path from "path";
import { buildJobResult } from "../support/jobRuntime.js";
import { buildTaskSignature, computeFileDigest, computePromptDigest, computeTextDigest } from "../support/taskIdentity.js";
import { moveFileIfNeeded } from "../support/archive.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { applyTranslatedHtmlToSubtitleJson, buildSubtitleJson, parseSrt, serializeSrt, subtitleJsonToHtml } from "./srt.js";
import { convertExternalSubtitleToSrt, detectExternalSubtitleFiles, extractSubtitleStreamToSrt, inferSubtitleLanguageFromFile, isSubtitleCodecSupported, muxTranslatedSubtitleIntoVideo, probeSubtitleStreams, selectSubtitleStream, assertSubtitleCodecSupported } from "./video.js";
import { getLanguageFileCode } from "../support/naming.js";
import { ensureCacheIdentity } from "../pipeline/jobSupport.js";
import { createJobContext, finishJob, formatRoutingSummary } from "../pipeline/jobContext.js";
import { translateChapters } from "../pipeline/translateDocument.js";

const VIDEO_INPUT_EXTENSIONS = new Set([".mkv", ".mp4", ".mov", ".m4v", ".webm"]);

export const runSubtitleTranslationJob = async ({
    projectRoot,
    inputPath,
    debugMode = false,
    runtimeConfig,
    sourceLanguageExplicit = false,
    modelName = null,
    createAdapter,
}) => {
    const outputDir = path.resolve(projectRoot, "output");

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
    const cacheDir = path.resolve(
        projectRoot,
        `.cache_${fileInfo.name}_subtitle_${targetLanguageSlug}`,
    );
    const ctx = createJobContext({ projectRoot, inputPath, runtimeConfig, debugMode, cacheDir, modelName, createAdapter });
    const { logger, gateway, aiProvider, batchQueue, cache, inputDir } = ctx;
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

    let shouldKeepArtifacts = debugMode;
    let translationStatus = "complete";

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
            const supportedStreams = streams.filter(isSubtitleCodecSupported);
            const selectedStream = selectSubtitleStream({
                streams:
                    supportedStreams.length > 0 ? supportedStreams : streams,
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
            if (!sourceLanguageExplicit && subtitleTrack.language) {
                runtimeConfig.sourceLanguage = subtitleTrack.language;
            }
            ctx.getGlossaryProvider();

            // 任务身份必须在复用提取结果之前校验，避免视频被替换后仍翻译旧字幕
            const externalSubtitleDigest =
                subtitleTrack.kind === "external" && subtitleTrack.path
                    ? computeFileDigest(subtitleTrack.path)
                    : null;
            ensureCacheIdentity(
                cache,
                buildTaskSignature({
                    kind: "subtitle",
                    sourceDigest: computeFileDigest(inputPath),
                    sourceLanguage: runtimeConfig.sourceLanguage,
                    targetLanguage: runtimeConfig.targetLanguage,
                    extras: {
                        inputType: "video",
                        streamKind: subtitleTrack.kind,
                        streamIndex: subtitleTrack.streamIndex,
                        streamLanguage: subtitleTrack.language,
                        externalSubtitleDigest,
                        promptDigest: computePromptDigest(
                            projectRoot,
                            "subtitle_translation_prompt.txt",
                        ),
                        modelRoutingFingerprint: gateway.routing.fingerprint,
                    },
                }),
                { kind: "subtitle", inputType: "video" },
                logger,
            );

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

        const glossaryProvider = ctx.getGlossaryProvider();

        // 非视频（SRT）在此校验任务身份；视频已在复用提取结果前校验
        if (!isVideoInput) {
            ensureCacheIdentity(
                cache,
                buildTaskSignature({
                    kind: "subtitle",
                    sourceDigest: computeTextDigest(srtContent),
                    sourceLanguage: runtimeConfig.sourceLanguage,
                    targetLanguage: runtimeConfig.targetLanguage,
                    extras: {
                        inputType: "srt",
                        promptDigest: computePromptDigest(
                            projectRoot,
                            "subtitle_translation_prompt.txt",
                        ),
                        modelRoutingFingerprint: gateway.routing.fingerprint,
                    },
                }),
                { kind: "subtitle", inputType: "srt" },
                logger,
            );
        }

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

        console.log("\n✍️ Step 5: Translating subtitle content...");
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
            "subtitle",
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
        const archivedInputPath = moveFileIfNeeded(
            inputPath,
            finalInputPath,
        );

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
            reportPath: translatedJsonPath,
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
                translatedJsonPath,
                translatedSrtPath,
                modelRouting: gateway.describe(),
                usage: gateway.usage(),
            },
        });
    } catch (error) {
        shouldKeepArtifacts = true;
        logger.write(
            "ERROR",
            `Subtitle Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const retention = finishJob(ctx, {
            keepArtifacts: shouldKeepArtifacts,
        });
        if (retention === "retained" && !debugMode) {
            logger.write(
                "WARN",
                `Subtitle artifacts retained (status=${translationStatus}): ${cacheDir}`,
            );
        }
    }
};
