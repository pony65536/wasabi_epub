import * as cheerio from "cheerio";

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const decodeHtml = (value) =>
    String(value ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");

const SRT_TIME_RANGE_REGEX =
    /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})(?:\s+(.*))?$/;

const sanitizeCueText = (value, fallback = "") => {
    const normalized = String(value ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\u0000/g, "")
        .replace(/\n{2,}/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
    return normalized || String(fallback ?? "").trim();
};

const splitCueBlocks = (content) =>
    content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

export const parseSrt = (content) => {
    const cues = [];
    const blocks = splitCueBlocks(content);

    for (let index = 0; index < blocks.length; index++) {
        const lines = blocks[index]
            .split("\n")
            .map((line) => line.replace(/\u0000/g, ""));
        if (lines.length < 2) {
            throw new Error(`Invalid SRT cue at block ${index + 1}.`);
        }

        let cueIdentifier = null;
        let timeLineIndex = 0;
        if (!lines[0].includes("-->")) {
            const firstLine = lines[0].trim();
            cueIdentifier = /^\d+$/.test(firstLine) ? null : firstLine || null;
            timeLineIndex = 1;
        }

        const timeLine = lines[timeLineIndex]?.trim();
        const match = timeLine?.match(SRT_TIME_RANGE_REGEX);
        if (!match) {
            throw new Error(`Invalid SRT time range at block ${index + 1}.`);
        }

        const textLines = lines.slice(timeLineIndex + 1);
        cues.push({
            id: `node_${String(index + 1).padStart(5, "0")}`,
            sequence: index + 1,
            cueIdentifier,
            start: match[1],
            end: match[2],
            settings: match[3] || "",
            sourceText: textLines.join("\n").trim(),
            translatedText: "",
        });
    }

    return cues;
};

export const buildSubtitleJson = ({
    sourceFile,
    sourceType,
    sourceLanguage,
    targetLanguage,
    cues,
    subtitleTrack = null,
}) => ({
    version: 1,
    sourceFile,
    sourceType,
    sourceLanguage,
    targetLanguage,
    subtitleTrack,
    cues,
});

export const subtitleJsonToHtml = (subtitleJson) => {
    const title = escapeHtml(subtitleJson?.sourceFile || "Subtitle Document");
    const cueHtml = (subtitleJson?.cues || [])
        .map((cue) => {
            const sourceHtml = escapeHtml(cue.sourceText || "").replace(
                /\n/g,
                "<br/>",
            );
            return `<p data-subtitle-id="${cue.id}">${sourceHtml}</p>`;
        })
        .join("\n");

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<html>",
        "<head>",
        `<title>${title}</title>`,
        "</head>",
        "<body>",
        cueHtml,
        "</body>",
        "</html>",
    ].join("");
};

export const applyTranslatedHtmlToSubtitleJson = (subtitleJson, translatedHtml) => {
    const $ = cheerio.load(translatedHtml, {
        xmlMode: true,
        decodeEntities: false,
    });
    const translatedById = new Map();

    $("[data-subtitle-id]").each((_, el) => {
        const id = $(el).attr("data-subtitle-id");
        if (!id) return;
        const html = $(el).html() || "";
        const normalized = decodeHtml(
            html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+>/g, ""),
        )
            .replace(/\r\n/g, "\n")
            .trim();
        translatedById.set(id, normalized);
    });

    for (const cue of subtitleJson.cues || []) {
        cue.translatedText = translatedById.get(cue.id) || cue.sourceText || "";
    }

    return subtitleJson;
};

export const serializeSrt = (subtitleJson, { preferTranslated = true } = {}) => {
    const cues = Array.isArray(subtitleJson?.cues) ? subtitleJson.cues : [];
    return cues
        .map((cue, index) => {
            const text = sanitizeCueText(
                preferTranslated && cue.translatedText
                    ? cue.translatedText
                    : cue.sourceText || "",
                cue.sourceText || "",
            );
            const lines = [
                String(index + 1),
                `${cue.start} --> ${cue.end}${cue.settings ? ` ${cue.settings}` : ""}`,
                text,
            ];
            if (cue.cueIdentifier && !/^\d+$/.test(String(cue.cueIdentifier).trim())) {
                lines.splice(1, 0, cue.cueIdentifier);
            }
            return lines.join("\n").trimEnd();
        })
        .join("\n\n");
};
