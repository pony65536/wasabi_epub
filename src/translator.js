import { CONFIG, STYLE_GUIDE, TEST_MODE_LIMIT } from "./config.js";
import { loadHtml } from "./utils.js";
import { processHtmlBatch } from "./batchQueue.js";

// =================== 单章节翻译 ===================
const unwrapUselessSpans = ($, referencedIds, definedClasses) => {
    $("span").each((_, el) => {
        const { id, class: cls, style, lang } = el.attribs;
        if (lang) return;
        if (style) return;
        if (id && referencedIds.has(id)) return;
        if (cls) {
            const classes = cls.split(/\s+/);
            if (classes.some((c) => c && definedClasses.has(c))) return;
        }
        $(el).replaceWith($(el).contents());
    });
};

export const translateHtmlContent = async (
    htmlContent,
    chapterTitle,
    glossary,
    aiProvider,
    batchQueue,
    logger,
    referencedIds = new Set(),
    definedClasses = new Set(),
) => {
    const $ = loadHtml(htmlContent);

    unwrapUselessSpans($, referencedIds, definedClasses);

    const nodesToTranslate = [];
    $("p, li, h1, h2, h3, h4, h5, h6, caption, title").each((i, el) => {
        const $el = $(el);
        const originalHtml = $el.html().trim();
        if (originalHtml) {
            const nodeId = `node_${i}`;
            $el.attr("data-t-id", nodeId);
            nodesToTranslate.push({ id: nodeId, content: originalHtml });
        }
    });
    const translationProcessor = {
        attrName: "data-t-id",
        prompt: (batchNodes) => {
            const batchText = batchNodes
                .map((n) => n.content)
                .join(" ")
                .toLowerCase();
            const relevantEntries = Object.entries(glossary).filter(([term]) =>
                batchText.includes(term.toLowerCase()),
            );
            const glossaryMarkdown =
                relevantEntries.length > 0
                    ? `\nGLOSSARY (Prefer these, but adapt if context requires):\n${relevantEntries
                          .map(([en, zh]) => `- ${en}: ${zh}`)
                          .join("\n")}\n`
                    : "";
            return `
TASK: Translate the content of each <node> into ${CONFIG.targetLanguage}.
CONTEXT: Book Chapter "${chapterTitle}".
Use glossary information when translating.
${glossaryMarkdown}
${STYLE_GUIDE}
🛑 RULES:
1. Return each node as: <node id="node_x">translated text</node>
2. Keep inline tags (<a>, <strong>, </node> etc.) intact.
        `;
        },
    };
    await processHtmlBatch(
        $,
        nodesToTranslate,
        translationProcessor,
        batchQueue,
        logger,
    );
    $("[data-t-id]").removeAttr("data-t-id");
    return $.xml();
};

// =================== 全书翻译调度 ===================
export const performTranslation = async (
    sortedChapters,
    chapterMap,
    glossary,
    aiProvider,
    batchQueue,
    logger,
    cache,
    referencedIds = new Set(),
    definedClasses = new Set(),
) => {
    console.log("\n✍️ Step 4: Translating Book Content...");
    const chaptersToProcess = TEST_MODE_LIMIT
        ? sortedChapters.slice(0, TEST_MODE_LIMIT)
        : sortedChapters;
    let skipped = 0;
    for (let i = 0; i < chaptersToProcess.length; i++) {
        const ch = chaptersToProcess[i];
        if (ch.isTOC) continue;
        const cached = cache.load(ch.id);
        if (cached) {
            chapterMap.get(ch.id).html = cached;
            skipped++;
            console.log(
                `⏭️  [${i + 1}/${chaptersToProcess.length}] Skipped (cached): "${ch.title}"`,
            );
            continue;
        }
        console.log(
            `🚀 [${i + 1}/${chaptersToProcess.length}] Processing Chapter: "${ch.title}"`,
        );
        try {
            const translatedHtml = await translateHtmlContent(
                ch.html,
                ch.title,
                glossary,
                aiProvider,
                batchQueue,
                logger,
                referencedIds,
                definedClasses,
            );
            if (chapterMap.has(ch.id)) {
                chapterMap.get(ch.id).html = translatedHtml;
                cache.save(ch.id, translatedHtml);
            }
        } catch (e) {
            logger.write(
                "ERROR",
                `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
            );
        }
    }
    if (skipped > 0) {
        console.log(`  ℹ️  ${skipped} chapter(s) restored from cache.`);
    }
    // Cache is now cleared in index.js after epub is saved
};
