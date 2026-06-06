import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import {
    getSubtitleLanguageCode,
    inferLanguageFromText,
    languageMatches,
    normalizeLanguageName,
} from "./language.js";

const SUPPORTED_TEXT_SUBTITLE_CODECS = new Set([
    "subrip",
    "srt",
    "ass",
    "ssa",
    "mov_text",
    "webvtt",
    "text",
]);

const EXTERNAL_SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt"]);

const runProcess = (command, args, logger) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            reject(error);
        });
        child.on("close", (code) => {
            if (stdout.trim()) {
                logger?.write("INFO", `Process stdout (${command}):\n${stdout}`);
            }
            if (stderr.trim()) {
                logger?.write("WARN", `Process stderr (${command}):\n${stderr}`);
            }

            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            reject(
                new Error(
                    `${command} exited with code ${code}.${stderr ? `\n${stderr}` : ""}`,
                ),
            );
        });
    });

const getStreamLanguage = (stream) => {
    if (stream?.resolvedLanguage) return stream.resolvedLanguage;
    const candidates = [
        stream?.tags?.language,
        stream?.tags?.LANGUAGE,
        stream?.tags?.title,
    ];
    for (const candidate of candidates) {
        const resolved = normalizeLanguageName(candidate, null);
        if (resolved) return resolved;
    }
    return null;
};

const getFileNameLanguage = (filePath) => {
    const name = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const tokens = name.split(/[.\-_()[\]\s]+/).filter(Boolean);
    for (let index = tokens.length - 1; index >= 0; index--) {
        const resolved = normalizeLanguageName(tokens[index], null);
        if (resolved) return resolved;
    }
    return null;
};

export const probeSubtitleStreams = async (inputPath, logger) => {
    const { stdout } = await runProcess(
        "ffprobe",
        [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-select_streams",
            "s",
            inputPath,
        ],
        logger,
    );
    const payload = JSON.parse(stdout || "{}");
    return Array.isArray(payload.streams) ? payload.streams : [];
};

export const detectExternalSubtitleFiles = (inputPath) => {
    const dir = path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    if (!fs.existsSync(dir)) return [];

    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => {
            const ext = path.extname(name).toLowerCase();
            if (!EXTERNAL_SUBTITLE_EXTENSIONS.has(ext)) return false;
            const stem = path.basename(name, ext).toLowerCase();
            return stem === baseName.toLowerCase() || stem.startsWith(`${baseName.toLowerCase()}.`) || stem.startsWith(`${baseName.toLowerCase()}_`) || stem.startsWith(`${baseName.toLowerCase()}-`);
        })
        .sort((a, b) => a.localeCompare(b))
        .map((name, index) => {
            const fullPath = path.join(dir, name);
            return {
                kind: "external",
                index,
                path: fullPath,
                codec_name: path.extname(name).slice(1).toLowerCase(),
                resolvedLanguage: getFileNameLanguage(fullPath),
                tags: {
                    title: path.basename(name),
                },
            };
        });
};

export const selectSubtitleStream = ({
    streams,
    preferredLanguage,
    fallbackLanguage = "English",
}) => {
    if (!Array.isArray(streams) || streams.length === 0) {
        throw new Error("No subtitle streams found in the input video.");
    }

    const decorated = streams.map((stream) => ({
        ...stream,
        resolvedLanguage: getStreamLanguage(stream),
    }));

    const tryPick = (languageName) =>
        decorated
            .filter((stream) =>
                languageMatches(stream.resolvedLanguage, languageName),
            )
            .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))[0] ||
        null;

    const explicitMatch = preferredLanguage ? tryPick(preferredLanguage) : null;
    if (explicitMatch) return explicitMatch;

    if (!preferredLanguage) {
        const fallbackMatch = fallbackLanguage ? tryPick(fallbackLanguage) : null;
        if (fallbackMatch) return fallbackMatch;
    }

    const defaultStream =
        decorated.find((stream) => Number(stream?.disposition?.default || 0) === 1) ||
        null;
    if (defaultStream) return defaultStream;

    return decorated.sort((a, b) => Number(a.index || 0) - Number(b.index || 0))[0];
};

export const assertSubtitleCodecSupported = (stream) => {
    if (stream?.kind === "external") {
        const ext = path.extname(stream.path || "").slice(1).toLowerCase();
        if (EXTERNAL_SUBTITLE_EXTENSIONS.has(`.${ext}`)) return;
        throw new Error(
            `Unsupported external subtitle format "${ext || "unknown"}".`,
        );
    }
    const codecName = String(stream?.codec_name || "").toLowerCase();
    if (SUPPORTED_TEXT_SUBTITLE_CODECS.has(codecName)) return;
    throw new Error(
        `Unsupported subtitle codec "${codecName || "unknown"}". Only text-based subtitle tracks are supported right now.`,
    );
};

export const extractSubtitleStreamToSrt = async (
    inputPath,
    streamIndex,
    outputSrtPath,
    logger,
) => {
    fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
    await runProcess(
        "ffmpeg",
        [
            "-y",
            "-i",
            inputPath,
            "-map",
            `0:${streamIndex}`,
            outputSrtPath,
        ],
        logger,
    );
    return outputSrtPath;
};

export const convertExternalSubtitleToSrt = async (
    subtitlePath,
    outputSrtPath,
    logger,
) => {
    fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
    await runProcess(
        "ffmpeg",
        ["-y", "-i", subtitlePath, outputSrtPath],
        logger,
    );
    return outputSrtPath;
};

export const muxTranslatedSubtitleIntoVideo = async ({
    inputPath,
    translatedSrtPath,
    outputPath,
    targetLanguage,
    existingSubtitleCount,
    externalSubtitleFiles = [],
    logger,
}) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const preservedExternalInputs = Array.isArray(externalSubtitleFiles)
        ? externalSubtitleFiles
        : [];
    const newSubtitleIndex =
        Math.max(Number(existingSubtitleCount || 0), 0) +
        preservedExternalInputs.length;
    const args = ["-y", "-i", inputPath];

    for (const subtitleFile of preservedExternalInputs) {
        args.push("-i", subtitleFile.path);
    }
    args.push("-i", translatedSrtPath, "-map", "0");

    for (let index = 0; index < preservedExternalInputs.length; index++) {
        args.push("-map", `${index + 1}:0`);
    }
    args.push("-map", `${preservedExternalInputs.length + 1}:0`, "-c", "copy");

    for (let index = 0; index < Number(existingSubtitleCount || 0); index++) {
        args.push(`-disposition:s:${index}`, "0");
    }
    for (let index = 0; index < preservedExternalInputs.length; index++) {
        const subtitleIndex = Number(existingSubtitleCount || 0) + index;
        const subtitleFile = preservedExternalInputs[index];
        args.push(
            `-c:s:${subtitleIndex}`,
            "srt",
            `-metadata:s:s:${subtitleIndex}`,
            `language=${getSubtitleLanguageCode(subtitleFile.resolvedLanguage || "English")}`,
            `-metadata:s:s:${subtitleIndex}`,
            `title=${subtitleFile.tags?.title || path.basename(subtitleFile.path)}`,
            `-disposition:s:${subtitleIndex}`,
            "0",
        );
    }

    args.push(
        `-c:s:${newSubtitleIndex}`,
        "srt",
        `-metadata:s:s:${newSubtitleIndex}`,
        `language=${getSubtitleLanguageCode(targetLanguage)}`,
        `-metadata:s:s:${newSubtitleIndex}`,
        `title=${targetLanguage} (Translated)`,
        `-disposition:s:${newSubtitleIndex}`,
        "default",
        outputPath,
    );

    await runProcess("ffmpeg", args, logger);
    return outputPath;
};

export const inferSubtitleLanguageFromFile = (srtContent) =>
    inferLanguageFromText(
        String(srtContent || "")
            .replace(/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*/g, " ")
            .replace(/\b\d+\b/g, " "),
    );
