import * as cheerio from "cheerio";
import { extractFirstHeading, loadHtml } from "../utils.js";

export const collectReferencedIds = (chapterMap) => {
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

export const collectDefinedClasses = (zipEntries) => {
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

export const createChapterMap = (zipEntries) => {
    const chapterMap = new Map();
    const opfEntry = zipEntries.find((entry) => entry.entryName.endsWith(".opf"));
    if (!opfEntry) {
        throw new Error("OPF file not found in EPUB.");
    }

    const opfBasePath = opfEntry.entryName.replace(/[^/]+$/, "");
    const $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
        xmlMode: true,
    });

    const manifestChapters = new Map();
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
            manifestChapters.set(chapter.id, chapter);
        }
    });

    // 阅读顺序以 OPF spine 为准（manifest 顺序可能不同），spine 未覆盖的条目追加在后
    const spineIds = [];
    $opf("spine itemref").each((_, el) => {
        const idref = $opf(el).attr("idref");
        if (idref) spineIds.push(idref);
    });

    const remaining = new Map(manifestChapters);
    for (const idref of spineIds) {
        const chapter = remaining.get(idref);
        if (!chapter) continue;
        chapterMap.set(chapter.id, chapter);
        remaining.delete(idref);
    }
    for (const chapter of remaining.values()) {
        chapterMap.set(chapter.id, chapter);
    }

    return chapterMap;
};

export const sanitizeCachedPlan = (plan, chapterMap, logger) => {
    if (!plan || !Array.isArray(plan.sorted)) return null;

    let droppedCount = 0;
    const seenIds = new Set();
    const sorted = plan.sorted.filter((chapter) => {
        const id = chapter?.id;
        if (!id || !chapterMap.has(id) || seenIds.has(id)) {
            droppedCount += 1;
            return false;
        }
        seenIds.add(id);
        return true;
    });

    if (droppedCount > 0) {
        logger.write(
            "WARN",
            `Dropped ${droppedCount} invalid cached chapters from translation plan.`,
        );
    }

    return {
        ...plan,
        sorted,
    };
};
