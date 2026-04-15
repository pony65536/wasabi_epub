import "dotenv/config";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    CURRENT_PROVIDER,
    DEFAULT_SOURCE_LANGUAGE,
    DEFAULT_TARGET_LANGUAGE,
    FALLBACK_PROVIDER,
    FALLBACK_ON_CONTENT_POLICY,
    CONFIG,
    JAPANESE_GLOSSARY_MODEL,
    JAPANESE_GLOSSARY_PROVIDER,
    RUSSIAN_GLOSSARY_MODEL,
    RUSSIAN_GLOSSARY_PROVIDER,
} from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createAIProvider } from "./src/aiProvider.js";
import { createProgressCache } from "./src/cache.js";
import { selectChaptersBySpec } from "./src/chapterSelection.js";
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

const printUsageAndExit = (message) => {
    if (message) {
        console.error(message);
        console.error("");
    }

    console.error(
        'Usage: node index.js "your-book.epub" [--chap "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]',
    );
    console.error("");
    console.error("Examples:");
    console.error('  node index.js "book.epub"');
    console.error('  node index.js "book.epub" --chap "1,3,5"');
    console.error('  node index.js "book.epub" --chap "1-3"');
    console.error(
        '  node index.js "book.epub" --chap "\'Blackhole\'-\'Gravity\'"',
    );
    console.error('  node index.js "book.epub" --from "es" --to "zh"');
    console.error('  node index.js "book.epub" --to "fr"');
    console.error('  node index.js "book.epub" --concurrency 5');
    console.error('  node index.js "book.epub" --debug');
    process.exit(1);
};

const SOURCE_LANGUAGE_ALIASES = {
    en: "English",
    english: "English",
    es: "Spanish",
    spanish: "Spanish",
    fr: "French",
    french: "French",
    ko: "Korean",
    korean: "Korean",
    ru: "Russian",
    russian: "Russian",
    ja: "Japanese",
    jp: "Japanese",
    japanese: "Japanese",
    zh: "Chinese (Simplified)",
    "zh-cn": "Chinese (Simplified)",
    "zh-hans": "Chinese (Simplified)",
    chinese: "Chinese (Simplified)",
};

const TARGET_LANGUAGE_ALIASES = {
    en: "English",
    english: "English",
    es: "Spanish",
    spanish: "Spanish",
    fr: "French",
    french: "French",
    ru: "Russian",
    russian: "Russian",
    ko: "Korean",
    korean: "Korean",
    ja: "Japanese",
    jp: "Japanese",
    japanese: "Japanese",
    zh: "Chinese (Simplified)",
    "zh-cn": "Chinese (Simplified)",
    "zh-hans": "Chinese (Simplified)",
    "ch-zh": "Chinese (Simplified)",
    "zh-ch": "Chinese (Simplified)",
};

const LANGUAGE_FILE_CODES = {
    English: "en",
    Spanish: "es",
    French: "fr",
    Russian: "ru",
    "Chinese (Simplified)": "zh",
    Korean: "ko",
    Japanese: "ja",
};

const resolveSourceLanguage = (value) => {
    if (!value) return DEFAULT_SOURCE_LANGUAGE;
    const normalized = value.trim().toLowerCase();
    return SOURCE_LANGUAGE_ALIASES[normalized] ?? value.trim();
};

const resolveTargetLanguage = (value) => {
    if (!value) return DEFAULT_TARGET_LANGUAGE;
    const normalized = value.trim().toLowerCase();
    return TARGET_LANGUAGE_ALIASES[normalized] ?? value.trim();
};

const getLanguageFileCode = (languageName) =>
    LANGUAGE_FILE_CODES[languageName] ||
    sanitizeFileToken(languageName.toLowerCase()).replace(/_+/g, "_");

const parseCliArgs = (argv) => {
    const result = {
        inputFileName: null,
        chapterSelector: null,
        sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
        targetLanguage: DEFAULT_TARGET_LANGUAGE,
        concurrency: null,
        debug: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--chap") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --chap.");
            }
            result.chapterSelector = nextValue;
            i++;
            continue;
        }

        if (arg.startsWith("--chap=")) {
            result.chapterSelector = arg.slice("--chap=".length);
            if (!result.chapterSelector) {
                printUsageAndExit("Missing value after --chap=.");
            }
            continue;
        }

        if (arg === "--from") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --from.");
            }
            result.sourceLanguage = resolveSourceLanguage(nextValue);
            i++;
            continue;
        }

        if (arg.startsWith("--from=")) {
            const value = arg.slice("--from=".length);
            if (!value) {
                printUsageAndExit("Missing value after --from=.");
            }
            result.sourceLanguage = resolveSourceLanguage(value);
            continue;
        }

        if (arg === "--to") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --to.");
            }
            result.targetLanguage = resolveTargetLanguage(nextValue);
            i++;
            continue;
        }

        if (arg.startsWith("--to=")) {
            const value = arg.slice("--to=".length);
            if (!value) {
                printUsageAndExit("Missing value after --to=.");
            }
            result.targetLanguage = resolveTargetLanguage(value);
            continue;
        }

        if (arg === "--concurrency") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --concurrency.");
            }
            const parsed = Number.parseInt(nextValue, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                printUsageAndExit(
                    "Invalid value for --concurrency. Use a positive integer.",
                );
            }
            result.concurrency = parsed;
            i++;
            continue;
        }

        if (arg.startsWith("--concurrency=")) {
            const value = arg.slice("--concurrency=".length);
            const parsed = Number.parseInt(value, 10);
            if (!value || !Number.isFinite(parsed) || parsed <= 0) {
                printUsageAndExit(
                    "Invalid value for --concurrency=. Use a positive integer.",
                );
            }
            result.concurrency = parsed;
            continue;
        }

        if (arg === "--debug") {
            result.debug = true;
            continue;
        }

        if (arg.startsWith("--")) {
            printUsageAndExit(`Unknown option: ${arg}`);
        }

        if (result.inputFileName) {
            printUsageAndExit(`Unexpected extra argument: ${arg}`);
        }

        result.inputFileName = arg;
    }

    if (!result.inputFileName) {
        printUsageAndExit();
    }

    return result;
};

const sanitizeFileToken = (value) =>
    value.replace(/['"]/g, "").replace(/[<>:"/\\|?*\s]+/g, "_");

const createSelectionSlug = (selection) => {
    if (!selection) return "";
    const sanitized = sanitizeFileToken(selection).replace(/_+/g, "_").trim();
    return sanitized.slice(0, 60) || "selected";
};

const countCachedChapters = (cache, chapters) =>
    chapters.reduce(
        (count, chapter) => count + (cache.load(chapter.id) ? 1 : 0),
        0,
    );

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const moveFileIfNeeded = (sourcePath, targetPath) => {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedSource === resolvedTarget) return;
    ensureDir(path.dirname(resolvedTarget));
    if (fs.existsSync(resolvedTarget)) {
        fs.unlinkSync(resolvedTarget);
    }
    fs.renameSync(resolvedSource, resolvedTarget);
};

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

const applyConcurrencyOverride = (concurrency) => {
    if (!concurrency) return;
    for (const providerName of ["gemini", "qwen", "mimo", "openrouter"]) {
        if (CONFIG[providerName]) CONFIG[providerName].concurrency = concurrency;
    }
};

const hasUsableProviderConfig = (providerName, config) => {
    const providerConfig = config?.[providerName];
    if (!providerConfig) return false;
    if (providerName === "openrouter") return Boolean(providerConfig.apiKey);
    if (providerName === "qwen") return Boolean(providerConfig.apiKey);
    if (providerName === "gemini") return Boolean(providerConfig.apiKey);
    if (providerName === "mimo") return Boolean(providerConfig.apiKey);
    return Boolean(providerConfig.apiKey);
};

const createGlossaryProvider = (logger) => {
    const primaryProvider = createAIProvider(
        CURRENT_PROVIDER,
        CONFIG,
        logger,
        FALLBACK_PROVIDER,
        FALLBACK_ON_CONTENT_POLICY,
    );

    let glossaryProviderName = null;
    let glossaryModelName = null;

    if (CONFIG.sourceLanguage === "Russian") {
        glossaryProviderName = RUSSIAN_GLOSSARY_PROVIDER;
        glossaryModelName = RUSSIAN_GLOSSARY_MODEL;
    } else if (CONFIG.sourceLanguage === "Japanese") {
        glossaryProviderName = JAPANESE_GLOSSARY_PROVIDER;
        glossaryModelName = JAPANESE_GLOSSARY_MODEL;
    }

    if (!glossaryProviderName || !glossaryModelName) {
        return primaryProvider;
    }

    const glossaryConfig = {
        ...CONFIG,
        [glossaryProviderName]: {
            ...CONFIG[glossaryProviderName],
            modelName: glossaryModelName,
        },
    };

    if (!hasUsableProviderConfig(glossaryProviderName, glossaryConfig)) {
        return primaryProvider;
    }

    return createAIProvider(glossaryProviderName, glossaryConfig, logger);
};

const resolveInputPath = () => {
    const cliArgs = parseCliArgs(process.argv.slice(2));
    const { inputFileName } = cliArgs;
    const inputCandidates = [
        path.resolve(__dirname, inputFileName),
        path.resolve(__dirname, "input", inputFileName),
    ];
    const inputPath = inputCandidates.find((candidate) =>
        fs.existsSync(candidate),
    );
    if (!inputPath) {
        console.error(`Input file not found: ${inputFileName}`);
        process.exit(1);
    }

    if (path.extname(inputPath).toLowerCase() !== ".epub") {
        console.error(`Input file must be an EPUB: ${inputFileName}`);
        process.exit(1);
    }

    return { inputPath, cliArgs };
};

const main = async () => {
    const { inputPath, cliArgs } = resolveInputPath();
    const debugMode = cliArgs.debug;
    CONFIG.sourceLanguage = cliArgs.sourceLanguage;
    CONFIG.targetLanguage = cliArgs.targetLanguage;
    applyConcurrencyOverride(cliArgs.concurrency);
    const logDir = path.resolve(__dirname, "log");
    const inputDir = path.resolve(__dirname, "input");
    const outputDir = path.resolve(__dirname, "output");
    ensureDir(logDir);
    ensureDir(inputDir);
    ensureDir(outputDir);
    const logger = createLogger(logDir);
    const aiProvider = createAIProvider(
        CURRENT_PROVIDER,
        CONFIG,
        logger,
        FALLBACK_PROVIDER,
        FALLBACK_ON_CONTENT_POLICY,
    );
    const glossaryProvider = createGlossaryProvider(logger);
    const batchQueue = createBatchQueue(aiProvider, logger);
    const fileInfo = path.parse(inputPath);
    const selectionSlug = createSelectionSlug(cliArgs.chapterSelector);
    const targetLanguageSlug = getLanguageFileCode(CONFIG.targetLanguage);
    const outputStem = cliArgs.chapterSelector
        ? `${fileInfo.name}_chap-${selectionSlug}_${targetLanguageSlug}`
        : `${fileInfo.name}_${targetLanguageSlug}`;
    const outputPath = path.resolve(
        outputDir,
        `${outputStem}.epub`,
    );
    const cacheDir = path.resolve(
        __dirname,
        cliArgs.chapterSelector
            ? `.cache_${fileInfo.name}_chap-${selectionSlug}`
            : `.cache_${fileInfo.name}`,
    );
    const cache = createProgressCache(cacheDir);
    console.log(`\n========================================`);
    console.log(`📖 Input:  ${path.basename(inputPath)}`);
    console.log(`💾 Output: ${path.basename(outputPath)}`);
    console.log(`📦 Cache:  ${path.basename(cacheDir)}`);
    console.log(`🐞 Debug: ${debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${CONFIG.sourceLanguage}`);
    console.log(`🌐 Target: ${CONFIG.targetLanguage}`);
    if (cliArgs.concurrency) {
        console.log(`⚙️ Concurrency: ${cliArgs.concurrency}`);
    }
    console.log(`🤖 Provider: ${aiProvider.providerName} (${aiProvider.modelName})`);
    if (aiProvider.fallbackProviderName) {
        console.log(`🛟 Fallback: ${aiProvider.fallbackProviderName}`);
    }
    if (cliArgs.chapterSelector) {
        console.log(`🎯 Chapters: ${cliArgs.chapterSelector}`);
    }
    console.log(`========================================\n`);
    let shouldKeepArtifacts = debugMode;
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

        const selectedChapters = cliArgs.chapterSelector
            ? selectChaptersBySpec(plan.sorted, cliArgs.chapterSelector)
            : plan.sorted;
        const selectedChapterMap = new Map(
            selectedChapters.map((chapter) => [chapter.id, chapterMap.get(chapter.id)]),
        );
        const selectedCachedChapterCount = countCachedChapters(
            cache,
            selectedChapters,
        );
        const totalSelectedChapters = selectedChapters.length;

        if (cliArgs.chapterSelector) {
            console.log(
                `\n🎯 Selected ${totalSelectedChapters} chapter(s) from --chap.`,
            );
        }

        // Step 2: 翻译前分析标题格式（如果缓存不存在）
        if (cachedHeadingRules && cachedHeadingRules.length > 0) {
            console.log(
                "\n🔍 Step 2: Loading heading format rules from cache...",
            );
            headingFormatRules = cachedHeadingRules;
        } else {
            headingFormatRules = await analyzeHeadingFormats(
                selectedChapterMap,
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
                selectedChapterMap,
                glossaryProvider,
                logger,
            );
            cache.saveGlossary(glossary);
        }

        // 如果有部分章节已完成翻译，显示进度
        if (selectedCachedChapterCount > 0) {
            console.log(
                `\n📑 Found ${selectedCachedChapterCount}/${totalSelectedChapters} selected chapter(s) already translated.`,
            );
        }

        // Step 4: 翻译
        await performTranslation(
            selectedChapters,
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
            selectedChapterMap,
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
        const finalInputPath = path.resolve(inputDir, path.basename(inputPath));
        moveFileIfNeeded(inputPath, finalInputPath);

        console.log(`\n✅ All done! Output: ${path.basename(outputPath)}`);
    } catch (e) {
        shouldKeepArtifacts = debugMode;
        logger.write(
            "ERROR",
            `Main Process Fatal Error: ${e.stack || e.message}`,
        );
        console.error("Fatal error occurred.", e.message);
        if (debugMode) {
            console.error("Check logs for details.");
        }
        process.exit(1);
    } finally {
        if (!shouldKeepArtifacts) {
            cache.removeDir();
            logger.remove();
        }
    }
};

main();
