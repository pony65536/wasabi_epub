import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    DEFAULT_SOURCE_LANGUAGE,
    DEFAULT_TARGET_LANGUAGE,
    createRuntimeConfig,
} from "./src/config.js";
import { runHtmlTranslationJob, runTranslationJob } from "./src/core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const printUsageAndExit = (message) => {
    if (message) {
        console.error(message);
        console.error("");
    }

    console.error(
        'Usage: node index.js "your-book.epub|your-file.html" [--chap "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]',
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
    console.error('  node index.js "chapter.html" --to "zh"');
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

const resolveInputPath = (inputFileName) => {
    const inputCandidates = [
        path.resolve(__dirname, inputFileName),
        path.resolve(__dirname, "input", inputFileName),
    ];
    const inputPath = inputCandidates.find((candidate) =>
        fs.existsSync(candidate),
    );

    if (!inputPath) {
        printUsageAndExit(`Input file not found: ${inputFileName}`);
    }

    const ext = path.extname(inputPath).toLowerCase();
    if (![".epub", ".html", ".htm"].includes(ext)) {
        printUsageAndExit(
            `Input file must be an EPUB or HTML document: ${inputFileName}`,
        );
    }

    return inputPath;
};

const main = async () => {
    const cliArgs = parseCliArgs(process.argv.slice(2));
    const inputPath = resolveInputPath(cliArgs.inputFileName);
    const inputExt = path.extname(inputPath).toLowerCase();
    const runtimeConfig = createRuntimeConfig({
        sourceLanguage: cliArgs.sourceLanguage,
        targetLanguage: cliArgs.targetLanguage,
        concurrency: cliArgs.concurrency,
    });

    try {
        if (inputExt === ".epub") {
            await runTranslationJob({
                projectRoot: __dirname,
                inputPath,
                chapterSelector: cliArgs.chapterSelector,
                debugMode: cliArgs.debug,
                runtimeConfig,
            });
        } else {
            if (cliArgs.chapterSelector) {
                printUsageAndExit("--chap is only supported for EPUB input.");
            }

            await runHtmlTranslationJob({
                projectRoot: __dirname,
                inputPath,
                debugMode: cliArgs.debug,
                runtimeConfig,
            });
        }
    } catch (error) {
        console.error("Fatal error occurred.", error.message);
        if (cliArgs.debug) {
            console.error("Check logs for details.");
        }
        process.exit(1);
    }
};

main();
