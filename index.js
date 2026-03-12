import "dotenv/config";
import { EPub } from "epub2";
import AdmZip from "adm-zip";
import path from "path";
import { fileURLToPath } from "url";

import { INPUT_FILE_NAME, CURRENT_PROVIDER, CONFIG } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createAIProvider } from "./src/aiProvider.js";
import { createProgressCache } from "./src/cache.js";
import { extractFirstHeading } from "./src/utils.js";
import { createBatchQueue } from "./src/batchQueue.js";
import { planTranslationOrder } from "./src/agent.js";
import { analyzeHeadingFormats, standardizeHeadingsByRules } from "./src/headings.js";
import { generateInitialGlossary } from "./src/glossary.js";
import { performTranslation } from "./src/translator.js";
import { synchronizeTocHtml, synchronizeNcx } from "./src/tocSync.js";
import { saveEpub } from "./src/epubSaver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        const epub = await EPub.createAsync(inputPath);
        const zipEntries = zip.getEntries();
        const chapterMap = new Map();

        epub.flow.forEach((chapter) => {
            const zipEntry = zipEntries.find((e) =>
                decodeURIComponent(e.entryName).endsWith(
                    decodeURIComponent(chapter.href),
                ),
            );
            const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
            const data = {
                ...chapter,
                html,
                entryName: zipEntry?.entryName,
                title: chapter.title || extractFirstHeading(html) || "Untitled",
            };
            if (data.entryName) chapterMap.set(data.id, data);
        });

        // Step 1: 规划顺序
        const plan = await planTranslationOrder(
            [...chapterMap.values()],
            aiProvider,
            logger,
        );

        // Step 2: 翻译前分析标题格式
        const headingFormatRules = await analyzeHeadingFormats(
            chapterMap,
            aiProvider,
            logger,
        );

        // Step 3: 生成术语表
        const glossary = await generateInitialGlossary(
            chapterMap,
            aiProvider,
            logger,
        );

        // Step 4: 翻译
        await performTranslation(
            plan.sorted,
            chapterMap,
            glossary,
            aiProvider,
            batchQueue,
            logger,
            cache,
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
        const { ncxEntry, ncxContent } = await synchronizeNcx(
            chapterMap,
            zipEntries,
        );

        // Step 8: 保存文件
        await saveEpub(
            zip,
            chapterMap,
            ncxEntry ?? null,
            ncxContent ?? null,
            outputPath,
            logger,
        );

        console.log(
            `\n✅ All done! Cache preserved at: ${path.basename(cacheDir)}`,
        );
        console.log(
            `   (Delete the cache folder to force a full re-translation next time)`,
        );
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
