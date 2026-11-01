import fs from "fs";
import path from "path";
import { extractFirstHeading, loadHtml } from "../utils.js";
import { collectVisibleTextNodes } from "../translation/translator.js";

export const createSingleHtmlChapterMap = (inputPath) => {
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

export const createHtmlGlossarySourceMap = (chapterMap) => {
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
