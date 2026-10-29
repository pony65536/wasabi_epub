import fs from "fs";
import path from "path";

import {
    CURRENT_PROVIDER,
    FALLBACK_PROVIDER,
    FALLBACK_ON_CONTENT_POLICY,
} from "../config.js";
import { generateInitialGlossary } from "../content/glossary.js";
import { shouldRetainArtifacts } from "../pipeline/artifactPolicy.js";
import { createProgressCache } from "../support/cache.js";
import { ensureDir, moveFileIfNeeded } from "../support/files.js";
import { createLogger } from "../support/logger.js";
import { getLanguageFileCode } from "../support/naming.js";
import { createAIProvider } from "../translation/aiProvider.js";
import { createBatchQueue } from "../translation/batchQueue.js";
import { createGlossaryProvider } from "../translation/glossaryProvider.js";
import { performTranslation } from "../translation/translator.js";
import {
    applyTranslatedHtmlToSubtitleJson,
    buildSubtitleJson,
    parseSrt,
    serializeSrt,
    subtitleJsonToHtml,
} from "./srt.js";
import {
    assertSubtitleCodecSupported,
    convertExternalSubtitleToSrt,
    detectExternalSubtitleFiles,
    extractSubtitleStreamToSrt,
    inferSubtitleLanguageFromFile,
    muxTranslatedSubtitleIntoVideo,
    probeSubtitleStreams,
    selectSubtitleStream,
} from "./video.js";

const VIDEO_INPUT_EXTENSIONS = new Set([".mkv", ".mp4", ".mov", ".m4v", ".webm"]);

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

    let completed = false;

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
        completed = true;
        return {
            outputPath,
            cacheDir,
            logFile: logger.logFile,
            translatedJsonPath,
            translatedSrtPath,
        };
    } catch (error) {
        logger.write(
            "ERROR",
            `Subtitle Process Fatal Error: ${error.stack || error.message}`,
        );
        throw error;
    } finally {
        const keepArtifacts = shouldRetainArtifacts({
            completed,
            debugMode,
            retainOnFailure: true,
        });
        if (!keepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};
