import path from "path";
import { loadHtml, normalizeHref } from "../utils.js";
import { normalizeText } from "../content/content-classifier.js";

export const EPUB_LINK_REWRITER_VERSION = 1;

const toPosix = (value) => String(value || "").replace(/\\/g, "/");

const isExternalHref = (href) =>
    /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/**
 * 构建全书链接解析上下文：
 * - hrefIndex:   章节文件路径 -> 章节
 * - manifestIndex: OPF manifest href -> 章节
 * - anchorIndex:  `文件路径#anchorId` -> { chapterId, anchor }（键带路径，避免跨文件重复 id）
 * - originParts:  被拆分的原文件路径 -> 分片章节 id 序列
 */
export const buildLinkContext = (chapterMap, zipEntries = []) => {
    const hrefIndex = new Map();
    const manifestIndex = new Map();
    const anchorIndex = new Map();
    const anchorById = new Map();
    const originParts = new Map();
    const resourceIndex = new Set();

    for (const entry of zipEntries) {
        const name =
            typeof entry === "string" ? entry : entry?.entryName;
        if (!name) continue;
        resourceIndex.add(normalizeHref(toPosix(name)));
    }

    for (const chapter of chapterMap.values()) {
        if (!chapter?.entryName) continue;
        const entryKey = normalizeHref(toPosix(chapter.entryName));
        hrefIndex.set(entryKey, chapter);
        if (chapter.href) {
            manifestIndex.set(normalizeHref(chapter.href), chapter);
        }
        if (chapter.originalEntryName) {
            const originKey = normalizeHref(toPosix(chapter.originalEntryName));
            if (!originParts.has(originKey)) originParts.set(originKey, []);
            originParts.get(originKey).push(chapter.id);
        }
        if (chapter.html) {
            const $ = loadHtml(chapter.html);
            $("[id]").each((_, el) => {
                const id = $(el).attr("id");
                if (!id) return;
                anchorIndex.set(`${entryKey}#${id}`, {
                    chapterId: chapter.id,
                    anchor: id,
                });
                if (!anchorById.has(id)) anchorById.set(id, []);
                anchorById.get(id).push(chapter.id);
            });
        }
    }

    return {
        chapterMap,
        hrefIndex,
        manifestIndex,
        anchorIndex,
        anchorById,
        originParts,
        resourceIndex,
    };
};

/**
 * 将任意 href 解析为目标章节 + 锚点。
 */
export const resolveLinkTarget = (
    context,
    { sourceEntry, sourceOriginalEntry, href },
) => {
    const raw = String(href || "").trim();
    if (!raw) return null;
    if (isExternalHref(raw)) return null;

    const hashIndex = raw.indexOf("#");
    const rawFile = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const anchor = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";

    const findPartWithAnchor = (partIds) => {
        if (!anchor) return null;
        for (const partId of partIds || []) {
            const part = context.chapterMap.get(partId);
            if (!part?.entryName) continue;
            const key = `${normalizeHref(toPosix(part.entryName))}#${anchor}`;
            if (context.anchorIndex.has(key)) return part;
        }
        return null;
    };

    if (!rawFile) {
        const ownKey = normalizeHref(toPosix(sourceEntry || ""));
        const own = context.hrefIndex.get(ownKey);
        if (own) {
            if (!anchor) {
                return { chapterId: own.id, targetEntry: own.entryName, anchor };
            }
            if (context.anchorIndex.has(`${ownKey}#${anchor}`)) {
                return { chapterId: own.id, targetEntry: own.entryName, anchor };
            }
            const originKey = normalizeHref(
                toPosix(sourceOriginalEntry || sourceEntry || ""),
            );
            const part = findPartWithAnchor(context.originParts.get(originKey));
            if (part) {
                return {
                    chapterId: part.id,
                    targetEntry: part.entryName,
                    anchor,
                };
            }
        }
        return null;
    }

    const sourceDir = path.posix.dirname(toPosix(sourceEntry || ""));
    const resolved = rawFile.startsWith("/")
        ? rawFile.replace(/^\/+/, "")
        : path.posix.normalize(path.posix.join(sourceDir, rawFile));
    const resolvedKey = normalizeHref(resolved);
    const rawKey = normalizeHref(rawFile);

    if (anchor) {
        const hit = context.anchorIndex.get(`${resolvedKey}#${anchor}`);
        if (hit) {
            const chapter = context.chapterMap.get(hit.chapterId);
            if (chapter) {
                return {
                    chapterId: chapter.id,
                    targetEntry: chapter.entryName,
                    anchor,
                };
            }
        }
    }

    const exact =
        context.hrefIndex.get(resolvedKey) ||
        context.manifestIndex.get(rawKey);
    if (exact) {
        return { chapterId: exact.id, targetEntry: exact.entryName, anchor };
    }

    // 全局唯一锚点兜底：处理跨文件迁移的锚点（如 Calibre 把锚点留在上一文件末尾）
    const findUniqueAnchorChapter = () => {
        if (!anchor || !context.anchorById) return null;
        const candidates = context.anchorById.get(anchor);
        if (!candidates || candidates.length !== 1) return null;
        return context.chapterMap.get(candidates[0]) || null;
    };

    const partIds =
        context.originParts.get(resolvedKey) ||
        context.originParts.get(rawKey);
    if (partIds && partIds.length > 0) {
        const withAnchor = findPartWithAnchor(partIds);
        if (withAnchor) {
            return {
                chapterId: withAnchor.id,
                targetEntry: withAnchor.entryName,
                anchor,
            };
        }
        const migrated = findUniqueAnchorChapter();
        if (migrated) {
            return {
                chapterId: migrated.id,
                targetEntry: migrated.entryName,
                anchor,
            };
        }
        const first = context.chapterMap.get(partIds[0]);
        if (first) {
            return {
                chapterId: first.id,
                targetEntry: first.entryName,
                anchor,
            };
        }
    }

    const migrated = findUniqueAnchorChapter();
    if (migrated) {
        return {
            chapterId: migrated.id,
            targetEntry: migrated.entryName,
            anchor,
        };
    }

    // 资源链接（图片/附件等 ZIP 条目）：合法但无需重写
    if (
        context.resourceIndex &&
        (context.resourceIndex.has(resolvedKey) ||
            context.resourceIndex.has(rawKey))
    ) {
        return { resource: true, targetEntry: resolved, anchor: "" };
    }

    for (const [key, chapter] of context.hrefIndex.entries()) {
        if (key.endsWith("/" + resolvedKey) || resolvedKey.endsWith("/" + key)) {
            return {
                chapterId: chapter.id,
                targetEntry: chapter.entryName,
                anchor,
            };
        }
    }

    return null;
};

/**
 * 计算目标文件相对源文件所在目录的 href。
 */
export const buildHrefFromSource = (sourceEntry, targetEntry, anchor) => {
    const source = toPosix(sourceEntry || "");
    const target = toPosix(targetEntry || "");
    let relative = path.posix.relative(path.posix.dirname(source), target);
    if (!relative) relative = path.posix.basename(target);
    return anchor ? `${relative}#${anchor}` : relative;
};

/**
 * 解析锚点对应的标题文本（优先取锚点后第一个非空兄弟节点）。
 */
export const resolveAnchorHeading = ($doc, anchor) => {
    if (!anchor) return null;
    const $el = $doc(`#${anchor}`);
    if (!$el.length) return null;

    let $next = $el.next();
    while ($next.length && !normalizeText($next.text())) {
        $next = $next.next();
    }
    if ($next.length) {
        const text = normalizeText($next.text());
        if (text && text.length <= 160) return text;
    }

    const selfText = normalizeText($el.text());
    if (selfText && selfText.length <= 160) return selfText;

    const $closest = $el.closest("h1, h2, h3, h4, h5, h6, p, li");
    const closestText = $closest.length ? normalizeText($closest.text()) : "";
    if (closestText && closestText.length <= 160) return closestText;

    return null;
};

/**
 * 重写全书中受拆分影响的内部链接（正文交叉引用、Index、HTML TOC 等）。
 * 只改写 href 属性，不改动链接文本。
 */
export const rewriteInternalLinks = (
    chapterMap,
    context = buildLinkContext(chapterMap),
) => {
    let scanned = 0;
    let rewritten = 0;
    let unresolved = 0;

    for (const chapter of chapterMap.values()) {
        if (!chapter?.html || !chapter.entryName) continue;
        const $ = loadHtml(chapter.html);
        let changed = false;

        $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            scanned++;
            const target = resolveLinkTarget(context, {
                sourceEntry: chapter.entryName,
                sourceOriginalEntry: chapter.originalEntryName,
                href,
            });
            if (!target) {
                if (!isExternalHref(href)) unresolved++;
                return;
            }
            if (target.resource) return; // 资源链接保持原样
            const newHref = buildHrefFromSource(
                chapter.entryName,
                target.targetEntry,
                target.anchor,
            );
            if (newHref !== href) {
                $(el).attr("href", newHref);
                changed = true;
                rewritten++;
            }
        });

        if (changed) chapter.html = $.xml();
    }

    return { scanned, rewritten, unresolved };
};

/**
 * 保存前验收：校验全书内部链接（含锚点）是否都能解析到真实目标。
 */
export const validateInternalLinks = (
    chapterMap,
    context = buildLinkContext(chapterMap),
) => {
    let total = 0;
    let dangling = 0;
    const samples = [];

    for (const chapter of chapterMap.values()) {
        if (!chapter?.html || !chapter.entryName) continue;
        const $ = loadHtml(chapter.html);
        $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href || isExternalHref(href)) return;
            total++;
            const target = resolveLinkTarget(context, {
                sourceEntry: chapter.entryName,
                sourceOriginalEntry: chapter.originalEntryName,
                href,
            });
            if (!target) {
                dangling++;
                if (samples.length < 5) {
                    samples.push(`${chapter.entryName} -> ${href} (unresolved)`);
                }
                return;
            }
            if (target.resource) return; // ZIP 资源链接合法
            if (target.anchor) {
                const targetChapter = context.chapterMap.get(target.chapterId);
                const key = `${normalizeHref(toPosix(targetChapter?.entryName))}#${target.anchor}`;
                if (!targetChapter || !context.anchorIndex.has(key)) {
                    dangling++;
                    if (samples.length < 5) {
                        samples.push(
                            `${chapter.entryName} -> ${href} (missing anchor)`,
                        );
                    }
                }
            }
        });
    }

    return { total, dangling, samples };
};

/**
 * 保存前验收：校验 NCX 目录的文件与锚点是否全部可解析。
 */
export const validateNcxLinks = (
    ncxContent,
    ncxEntryName,
    context,
) => {
    let total = 0;
    let dangling = 0;
    const samples = [];
    if (!ncxContent) return { total, dangling, samples };

    const $ncx = loadHtml(ncxContent);
    $ncx("navPoint").each((_, el) => {
        const src =
            $ncx(el).children("content").attr("src") ||
            $ncx(el).find("content").first().attr("src");
        if (!src) return;
        total++;
        const target = resolveLinkTarget(context, {
            sourceEntry: ncxEntryName,
            href: src,
        });
        if (!target) {
            dangling++;
            if (samples.length < 5) {
                samples.push(`NCX -> ${src} (unresolved)`);
            }
            return;
        }
        if (target.resource) return;
        if (target.anchor) {
            const targetChapter = context.chapterMap.get(target.chapterId);
            const key = `${normalizeHref(toPosix(targetChapter?.entryName))}#${target.anchor}`;
            if (!targetChapter || !context.anchorIndex.has(key)) {
                dangling++;
                if (samples.length < 5) {
                    samples.push(`NCX -> ${src} (missing anchor)`);
                }
            }
        }
    });

    return { total, dangling, samples };
};
