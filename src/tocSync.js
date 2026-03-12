import {
    loadHtml,
    normalizeHref,
    buildHrefIndex,
    resolveAnchorTitle,
} from "./utils.js";

// =================== 共用工具 ===================
const findBySrc = (hrefIndex, src) => {
    const normalized = normalizeHref(src);
    if (hrefIndex.has(normalized)) return hrefIndex.get(normalized);
    for (const [key, val] of hrefIndex.entries()) {
        const keyEndsWithNormalized =
            key === normalized || key.endsWith("/" + normalized);
        const normalizedEndsWithKey =
            normalized === key || normalized.endsWith("/" + key);
        if (keyEndsWithNormalized || normalizedEndsWithKey) return val;
    }
    return null;
};

// =================== HTML TOC 同步 ===================
export const synchronizeTocHtml = async (chapterMap, tocId) => {
    if (!tocId || !chapterMap.has(tocId)) {
        console.log("\n⏭️ Step 6: No TOC Found, skipping synchronizing.");
        return;
    }
    console.log("\n🔗 Step 6: Synchronizing HTML TOC (Smart Anchor)...");
    try {
        const tocData = chapterMap.get(tocId);
        const hrefIndex = buildHrefIndex(chapterMap);
        const $toc = loadHtml(tocData.html);
        $toc("a[href]").each((_, el) => {
            const $a = $toc(el);
            const rawHref = $a.attr("href");
            if (!rawHref) return;
            const [rawFile, anchor] = rawHref.split("#");
            const target = findBySrc(hrefIndex, rawFile);
            if (!target || target.id === tocId) return;
            const $doc = loadHtml(target.html);
            const title = resolveAnchorTitle($doc, anchor);
            if (title) $a.text(title);
        });
        tocData.html = $toc.xml();
        console.log("  - ✅ HTML TOC synchronized.");
    } catch (e) {
        console.error(`HTML TOC Sync Failed: ${e.message}`);
    }
};

// =================== NCX 同步 ===================
export const synchronizeNcx = async (chapterMap, zipEntries) => {
    console.log("\n🔗 Step 7: Synchronizing NCX Metadata (Smart Anchor)...");
    try {
        const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
        if (!ncxEntry) return { ncxEntry: null, ncxContent: "" };
        const ncxContent = ncxEntry.getData().toString("utf8");
        const $ncx = loadHtml(ncxContent);
        const hrefIndex = buildHrefIndex(chapterMap);
        $ncx("navPoint").each((_, el) => {
            const $navPoint = $ncx(el);
            const src = $navPoint.find("content").attr("src");
            if (!src) return;
            const [rawFile, anchor] = src.split("#");
            const target = findBySrc(hrefIndex, rawFile);
            if (!target) return;
            const $doc = loadHtml(target.html);
            const title = resolveAnchorTitle($doc, anchor);
            if (title) $navPoint.find("navLabel > text").first().text(title);
        });
        console.log("  - ✅ NCX metadata synchronized.");
        return { ncxEntry, ncxContent: $ncx.xml() };
    } catch (e) {
        console.error(`NCX Sync Failed: ${e.message}`);
        return { ncxEntry: null, ncxContent: "" };
    }
};
