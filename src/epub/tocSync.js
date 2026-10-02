import { loadHtml, resolveAnchorTitle } from "../utils.js";
import {
    buildLinkContext,
    resolveLinkTarget,
    buildHrefFromSource,
    resolveAnchorHeading,
} from "./linkRewriter.js";

const resolveTitle = (chapter, anchor) => {
    if (!chapter?.html) return null;
    const $doc = loadHtml(chapter.html);
    return resolveAnchorHeading($doc, anchor) || resolveAnchorTitle($doc, anchor);
};

const findTocScope = ($toc) => {
    const explicitSelectors = [
        'nav[epub\\:type~="toc"]',
        '[epub\\:type="toc"]',
        'nav[role="doc-toc"]',
        '[role="doc-toc"]',
    ];
    for (const selector of explicitSelectors) {
        const $scope = $toc(selector).first();
        if ($scope.length > 0) return { $scope, mode: "explicit" };
    }

    // EPUB2 兼容：没有 nav 时，选择内部链接最密集的容器作为传统目录
    let best = null;
    $toc("ol, ul, div, section, table").each((_, el) => {
        const $el = $toc(el);
        const links = $el.find("a[href]").length;
        if (links < 3) return;
        if (!best || links > best.links) {
            best = { el, links };
        }
    });
    if (best) return { $scope: $toc(best.el), mode: "density" };
    return { $scope: $toc("body"), mode: "fallback-body" };
};

// =================== HTML TOC 同步 ===================
export const synchronizeTocHtml = async (
    chapterMap,
    tocId,
    context = buildLinkContext(chapterMap),
) => {
    if (!tocId || !chapterMap.has(tocId)) {
        console.log("\n⏭️ Step 6: No TOC Found, skipping synchronizing.");
        return { ok: true, skipped: true };
    }
    console.log("\n🔗 Step 6: Synchronizing HTML TOC (Smart Anchor)...");
    try {
        const tocData = chapterMap.get(tocId);
        const $toc = loadHtml(tocData.html);
        const { $scope, mode } = findTocScope($toc);
        const stats = {
            mode,
            matched: 0,
            changed: 0,
            unresolved: 0,
            errors: [],
        };

        $scope.find("a[href]").each((_, el) => {
            const $a = $toc(el);
            const rawHref = $a.attr("href");
            if (!rawHref) return;
            stats.matched++;
            const target = resolveLinkTarget(context, {
                sourceEntry: tocData.entryName,
                sourceOriginalEntry: tocData.originalEntryName,
                href: rawHref,
            });
            if (!target || target.chapterId === tocId || target.resource) {
                if (!target) stats.unresolved++;
                return;
            }
            const title = resolveTitle(
                chapterMap.get(target.chapterId),
                target.anchor,
            );
            if (title && $a.text() !== title) {
                $a.text(title);
                stats.changed++;
            }
        });

        tocData.html = $toc.xml();
        console.log(
            `  - ✅ HTML TOC synchronized (${stats.mode}, matched=${stats.matched}, changed=${stats.changed}, unresolved=${stats.unresolved}).`,
        );
        return { ok: true, stats };
    } catch (e) {
        console.error(`HTML TOC Sync Failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
};

// =================== NCX 同步 ===================
export const synchronizeNcx = async (
    chapterMap,
    zipEntries,
    context = buildLinkContext(chapterMap, zipEntries),
) => {
    console.log("\n🔗 Step 7: Synchronizing NCX Metadata (Smart Anchor)...");
    try {
        const ncxEntry = zipEntries.find((e) => e.entryName.endsWith(".ncx"));
        if (!ncxEntry) {
            return { ncxEntry: null, ncxContent: "", ok: true, reason: "no-ncx" };
        }
        const ncxContent = ncxEntry.getData().toString("utf8");
        const $ncx = loadHtml(ncxContent);
        $ncx("navPoint").each((_, el) => {
            const $navPoint = $ncx(el);
            const $content = $navPoint.children("content").length
                ? $navPoint.children("content")
                : $navPoint.find("content").first();
            const src = $content.attr("src");
            if (!src) return;
            const target = resolveLinkTarget(context, {
                sourceEntry: ncxEntry.entryName,
                href: src,
            });
            if (!target) return;
            if (target.resource) return; // 资源条目保持原样
            const newSrc = buildHrefFromSource(
                ncxEntry.entryName,
                target.targetEntry,
                target.anchor,
            );
            if (newSrc !== src) $content.attr("src", newSrc);
            const title = resolveTitle(
                chapterMap.get(target.chapterId),
                target.anchor,
            );
            if (title) {
                $navPoint.find("navLabel > text").first().text(title);
            }
        });
        console.log("  - ✅ NCX metadata synchronized.");
        return { ncxEntry, ncxContent: $ncx.xml(), ok: true };
    } catch (e) {
        console.error(`NCX Sync Failed: ${e.message}`);
        return {
            ncxEntry: null,
            ncxContent: "",
            ok: false,
            error: e.message,
        };
    }
};
