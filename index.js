// import "dotenv/config";
// // import { EPub } from "epub2";
// import AdmZip from "adm-zip";
// import path from "path";
// import { fileURLToPath } from "url";

// import { INPUT_FILE_NAME, CURRENT_PROVIDER, CONFIG } from "./src/config.js";
// import { createLogger } from "./src/logger.js";
// import { createAIProvider } from "./src/aiProvider.js";
// import { createProgressCache } from "./src/cache.js";
// import { extractFirstHeading, loadHtml } from "./src/utils.js";
// import { createBatchQueue } from "./src/batchQueue.js";
// import { planTranslationOrder } from "./src/agent.js";
// import {
//     analyzeHeadingFormats,
//     standardizeHeadingsByRules,
// } from "./src/headings.js";
// import { generateInitialGlossary } from "./src/glossary.js";
// import { performTranslation } from "./src/translator.js";
// import { synchronizeTocHtml, synchronizeNcx } from "./src/tocSync.js";
// import { saveEpub } from "./src/epubSaver.js";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const collectReferencedIds = (chapterMap) => {
//     const referencedIds = new Set();
//     for (const chapter of chapterMap.values()) {
//         const $ = loadHtml(chapter.html);
//         $("a[href]").each((_, el) => {
//             const hash = $(el).attr("href")?.split("#")[1];
//             if (hash) referencedIds.add(hash);
//         });
//     }
//     return referencedIds;
// };

// const collectDefinedClasses = (zipEntries) => {
//     const definedClasses = new Set();
//     const cssEntries = zipEntries.filter((e) => e.entryName.endsWith(".css"));
//     for (const entry of cssEntries) {
//         const css = entry.getData().toString("utf8");
//         const matches = css.matchAll(/\.([a-zA-Z][\w-]*)/g);
//         for (const m of matches) definedClasses.add(m[1]);
//     }
//     return definedClasses;
// };

// const main = async () => {
//     const logger = createLogger(path.resolve(__dirname, "log"));
//     const aiProvider = createAIProvider(CURRENT_PROVIDER, CONFIG, logger);
//     const batchQueue = createBatchQueue(aiProvider, logger);

//     const fileInfo = path.parse(INPUT_FILE_NAME);
//     const activeModelName = aiProvider.modelName.replace(/[\/\\]/g, "-");
//     const inputPath = path.resolve(__dirname, INPUT_FILE_NAME);
//     const outputPath = path.resolve(
//         __dirname,
//         `${fileInfo.name}_${activeModelName}.epub`,
//     );

//     const cacheDir = path.resolve(__dirname, `.cache_${fileInfo.name}`);
//     const cache = createProgressCache(cacheDir);

//     console.log(`\n========================================`);
//     console.log(`📖 Input:  ${path.basename(inputPath)}`);
//     console.log(`💾 Output: ${path.basename(outputPath)}`);
//     console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
//     console.log(`========================================\n`);

//     try {
//         const zip = new AdmZip(inputPath);
//         // const epub = await EPub.createAsync(inputPath);
//         const zipEntries = zip.getEntries();
//         const chapterMap = new Map();

//         Object.values(epub.manifest).forEach((item) => {
//             if (item.mediaType !== "application/xhtml+xml") return;

//             const zipEntry = zipEntries.find((e) =>
//                 decodeURIComponent(e.entryName).endsWith(
//                     decodeURIComponent(item.href),
//                 ),
//             );
//             const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
//             const data = {
//                 ...item,
//                 html,
//                 entryName: zipEntry?.entryName,
//                 title: item.title || extractFirstHeading(html) || "Untitled",
//             };
//             if (data.entryName) chapterMap.set(data.id, data);
//         });

import "dotenv/config";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import { INPUT_FILE_NAME, CURRENT_PROVIDER, CONFIG } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createAIProvider } from "./src/aiProvider.js";
import { createProgressCache } from "./src/cache.js";
import { extractFirstHeading, loadHtml } from "./src/utils.js";
import { createBatchQueue } from "./src/batchQueue.js";
import { planTranslationOrder } from "./src/agent.js";
import {
    analyzeHeadingFormats,
    standardizeHeadingsByRules,
} from "./src/headings.js";
import { generateInitialGlossary } from "./src/glossary.js";
import { performTranslation } from "./src/translator.js";
import { synchronizeTocHtml, synchronizeNcx } from "./src/tocSync.js";
import { saveEpub } from "./src/epubSaver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const collectReferencedIds = (chapterMap) => {
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

const collectDefinedClasses = (zipEntries) => {
    const definedClasses = new Set();
    const cssEntries = zipEntries.filter((e) => e.entryName.endsWith(".css"));
    for (const entry of cssEntries) {
        const css = entry.getData().toString("utf8");
        const matches = css.matchAll(/\.([a-zA-Z][\w-]*)/g);
        for (const m of matches) definedClasses.add(m[1]);
    }
    return definedClasses;
};

const main = async () => {
    const logger = createLogger(path.resolve(__dirname, "log"));
    const aiProvider = createAIProvider(CURRENT_PROVIDER, CONFIG, logger);
    const batchQueue = createBatchQueue(aiProvider, logger);
    const fileInfo = path.parse(INPUT_FILE_NAME);
    const activeModelName = aiProvider.modelName.replace(/[\/\\]/g, "-");
    const inputPath = path.resolve(__dirname, INPUT_FILE_NAME);
    const outputPath = path.resolve(
        __dirname,
        `${fileInfo.name}_${activeModelName}.epub`,
    );
    const cacheDir = path.resolve(__dirname, `.cache_${fileInfo.name}`);
    const cache = createProgressCache(cacheDir);
    console.log(`\n========================================`);
    console.log(`📖 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPath)}`);
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`========================================\n`);
    try {
        const zip = new AdmZip(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = new Map();

        // 各步骤结果的默认值，注释掉任意步骤时保证后续步骤正常运行
        let plan = { sorted: [], tocId: null };
        let headingFormatRules = [];
        let glossary = {};
        let ncxEntry = null;
        let ncxContent = null;

        // 解析 OPF
        const opfEntry = zipEntries.find((e) => e.entryName.endsWith(".opf"));
        const opfBasePath = opfEntry.entryName.replace(/[^/]+$/, "");
        const $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
            xmlMode: true,
        });
        $opf("[media-type='application/xhtml+xml']").each((_, el) => {
            const item = {
                id: $opf(el).attr("id"),
                href: $opf(el).attr("href"),
                mediaType: $opf(el).attr("media-type"),
            };
            if (item.mediaType !== "application/xhtml+xml") return;
            const fullHref = opfBasePath + item.href;
            const zipEntry = zipEntries.find(
                (e) => decodeURIComponent(e.entryName) === fullHref,
            );
            const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
            const data = {
                ...item,
                html,
                entryName: zipEntry?.entryName,
                title: extractFirstHeading(html) || item.id || "Untitled",
            };
            if (data.entryName) chapterMap.set(data.id, data);
        });

        const referencedIds = collectReferencedIds(chapterMap);
        const definedClasses = collectDefinedClasses(zipEntries);

        // 尝试从缓存加载翻译计划、术语表、标题规则
        const cachedPlan = cache.loadPlan();
        const cachedGlossary = cache.loadGlossary();
        const cachedHeadingRules = cache.loadHeadingRules();
        const cachedChapterCount = cache.count();
        const totalChapters = chapterMap.size;

        // Step 1: 规划顺序（如果缓存不存在）
        if (cachedPlan) {
            console.log("\n🕵️ Step 1: Loading translation plan from cache...");
            plan = cachedPlan;
            // 恢复 chapterMap 中的 isTOC 标记
            if (plan.tocId) {
                const tocChapter = chapterMap.get(plan.tocId);
                if (tocChapter) tocChapter.isTOC = true;
            }
        } else {
            plan = await planTranslationOrder(
                [...chapterMap.values()],
                aiProvider,
                logger,
            );
            cache.savePlan(plan);
        }

        // Step 2: 翻译前分析标题格式（如果缓存不存在）
        if (cachedHeadingRules && cachedHeadingRules.length > 0) {
            console.log("\n🔍 Step 2: Loading heading format rules from cache...");
            headingFormatRules = cachedHeadingRules;
        } else {
            headingFormatRules = await analyzeHeadingFormats(
                chapterMap,
                aiProvider,
                logger,
            );
            cache.saveHeadingRules(headingFormatRules);
        }

        // Step 3: 生成术语表（如果缓存不存在）
        if (cachedGlossary && Object.keys(cachedGlossary).length > 0) {
            console.log("\n📊 Step 3: Loading glossary from cache...");
            glossary = cachedGlossary;
        } else {
            glossary = await generateInitialGlossary(
                chapterMap,
                aiProvider,
                logger,
            );
            cache.saveGlossary(glossary);
        }

        // 如果有部分章节已完成翻译，显示进度
        if (cachedChapterCount > 0) {
            console.log(
                `\n📑 Found ${cachedChapterCount}/${totalChapters} chapters already translated.`,
            );
        }

        // Step 4: 翻译
        await performTranslation(
            plan.sorted,
            chapterMap,
            glossary,
            aiProvider,
            batchQueue,
            logger,
            cache,
            referencedIds,
            definedClasses,
        );

        // 等待队列完全排干
        await batchQueue.drainQueue();

        // Step 5: 标题标准化
        await standardizeHeadingsByRules(
            chapterMap,
            headingFormatRules,
            aiProvider,
            batchQueue,
            logger,
        );

        // Step 6: 同步 HTML 目录
        await synchronizeTocHtml(chapterMap, plan.tocId);

        // Step 7: 同步 NCX
        ({ ncxEntry, ncxContent } = await synchronizeNcx(
            chapterMap,
            zipEntries,
        ));

        // Step 8: 保存文件
        await saveEpub(
            zip,
            chapterMap,
            ncxEntry ?? null,
            ncxContent ?? null,
            outputPath,
            logger,
        );

        // 翻译全部完成后清除缓存
        cache.clear();

        console.log(`\n✅ All done! Output: ${path.basename(outputPath)}`);
    } catch (e) {
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${e.stack || e.message}`,
        );
        console.error(
            "Fatal error occurred. Check logs for details.",
            e.message,
        );
        process.exit(1);
    }
};

main();
