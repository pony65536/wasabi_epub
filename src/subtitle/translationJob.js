import fs from "fs";
import path from "path";

import { generateInitialGlossary } from "../content/glossary.js";
import {
    createJobContext,
    finishJob,
    printJobBanner,
} from "../pipeline/jobContext.js";
import { moveFileIfNeeded } from "../support/files.js";
import { getLanguageFileCode } from "../support/naming.js";
import { translateDocument } from "../pipeline/translateDocument.js";
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
    const cacheDir = path.resolve(projectRoot, `.cache_${fileInfo.name}_subtitle`);
    const ctx = createJobContext({
        projectRoot,
        inputPath,
        runtimeConfig,
        debugMode,
        cacheDir,
        deferGlossaryProvider: true,
    });
    const { logger, aiProvider, batchQueue, cache } = ctx;
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

    printJobBanner(ctx, {
        inputIcon: isVideoInput ? "🎬" : "🎞️",
        inputName: path.basename(inputPath),
        outputName: path.basename(outputPath),
    });

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
        const glossaryProvider = ctx.getGlossaryProvider();

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

        await translateDocument({
            chapters,
            chapterMap,
            glossary,
            cache,
            cacheMode: "document",
            cacheKey: "document",
            cachedMessage: "subtitle HTML",
            translationMessage: "\n✍️ Step 5: Translating subtitle content...",
            runtimeConfig,
            aiProvider,
            batchQueue,
            logger,
            debugMode,
            referencedIds,
            definedClasses,
            mode: "subtitle",
        });

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

        const finalInputPath = path.resolve(ctx.inputDir, path.basename(inputPath));
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
        finishJob(ctx, { completed, retainOnFailure: true });
    }
};
