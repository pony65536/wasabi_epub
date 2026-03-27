import { CONFIG, STYLE_GUIDE, TEST_MODE_LIMIT } from "./config.js";
import { loadHtml } from "./utils.js";
import {
    splitIntoBatches,
    dispatchBatches,
    collectFailedNodes,
} from "./batchQueue.js";

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

/**
 * 把章节内所有 batch 塞进全局队列，返回一个 Promise。
 * Promise resolve 时该章节已完全翻译完毕（含重试轮次）。
 */
const enqueueChapterTranslation = (
    htmlContent,
    chapterTitle,
    glossary,
    batchQueue,
    logger,
    referencedIds,
    definedClasses,
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

    if (nodesToTranslate.length === 0) {
        $("[data-t-id]").removeAttr("data-t-id");
        return Promise.resolve($.xml());
    }

    const makeProcessor = () => ({
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
    });

    // 把首轮所有 batch 入队，返回一个 Promise chain：
    // 首轮完成 → 检查失败节点 → 最多 3 轮重试 → resolve 最终 HTML
    const runRound = async (nodes, roundLabel) => {
        const processor = makeProcessor();
        const batches = splitIntoBatches(nodes);
        await Promise.all(
            dispatchBatches(batches, $, processor, batchQueue, logger),
        );

        const MAX_RETRY_ROUNDS = 3;
        for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
            const failedNodes = collectFailedNodes($, processor.attrName);
            if (failedNodes.length === 0) break;
            console.log(
                `    - ⚠️ [${roundLabel}] Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS})...`,
            );
            const retryBatches = splitIntoBatches(failedNodes);
            await Promise.all(
                dispatchBatches(retryBatches, $, processor, batchQueue, logger),
            );
        }
    };

    // 返回整个异步链，但 enqueue 动作是立即发生的（不等 await）
    return runRound(nodesToTranslate, chapterTitle).then(() => {
        $("[data-t-id]").removeAttr("data-t-id");
        return $.xml();
    });
};

// 兼容旧调用（headings.js 等地方可能直接调用）
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
    return enqueueChapterTranslation(
        htmlContent,
        chapterTitle,
        glossary,
        batchQueue,
        logger,
        referencedIds,
        definedClasses,
    );
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
    const total = chaptersToProcess.length;

    // 过滤掉已缓存和 TOC，剩余章节同时入队
    const pending = [];
    for (let i = 0; i < total; i++) {
        const ch = chaptersToProcess[i];
        if (ch.isTOC) continue;

        const cached = cache.load(ch.id);
        if (cached) {
            chapterMap.get(ch.id).html = cached;
            skipped++;
            console.log(
                `⏭️  [${i + 1}/${total}] Skipped (cached): "${ch.title}"`,
            );
            continue;
        }

        pending.push({ ch, index: i });
    }

    // 所有待翻译章节同时入队，各自拿到自己的完成 Promise
    const chapterPromises = pending.map(({ ch, index }) => {
        const translationPromise = enqueueChapterTranslation(
            ch.html,
            ch.title,
            glossary,
            batchQueue,
            logger,
            referencedIds,
            definedClasses,
        );

        // 每章独立 then：完成后立即写 cache，不等其他章节
        return translationPromise
            .then((translatedHtml) => {
                if (chapterMap.has(ch.id)) {
                    chapterMap.get(ch.id).html = translatedHtml;
                    cache.save(ch.id, translatedHtml);
                    console.log(
                        `✅ [${index + 1}/${total}] Done: "${ch.title}"`,
                    );
                }
            })
            .catch((e) => {
                logger.write(
                    "ERROR",
                    `Chapter "${ch.title}" Translation Failed: ${e.stack || e.message}`,
                );
                console.log(`❌ [${index + 1}/${total}] Failed: "${ch.title}"`);
            });
    });

    await Promise.all(chapterPromises);

    if (skipped > 0) {
        console.log(`  ℹ️  ${skipped} chapter(s) restored from cache.`);
    }
};
