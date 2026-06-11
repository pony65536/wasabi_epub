import "dotenv/config";
import fs from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";
import {
    DEFAULT_SOURCE_LANGUAGE,
    DEFAULT_TARGET_LANGUAGE,
    createRuntimeConfig,
} from "./src/config.js";
import {
    formatPreflightFailureMessage,
    getPdfDependencyReport,
    getPreflightReport,
    installPdfRequirements,
    runDoctor,
} from "./src/support/environment.js";
import { parsePageSelector } from "./src/support/pageSelection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPPORTED_INPUT_EXTENSIONS = [
    ".epub",
    ".html",
    ".htm",
    ".pdf",
    ".srt",
    ".mkv",
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
];

const printUsageAndExit = (message) => {
    if (message) {
        console.error(message);
        console.error("");
    }

    console.error("Usage:");
    console.error(
        '  node index.js "your-book.epub|your-file.html|your-file.pdf|your-file.srt|your-video.mkv|your-video.mp4" [--chap "<selector>"] [--page "<selector>"] [--from "<lang>"] [--to "<lang>"] [--concurrency <n>] [--debug]',
    );
    console.error("  node index.js doctor");
    console.error("  node index.js setup --pdf");
    console.error("");
    console.error("Examples:");
    console.error('  node index.js "book.epub"');
    console.error('  node index.js "book.epub" --chap "1,3,5"');
    console.error('  node index.js "paper.pdf" --to "zh"');
    console.error("  node index.js doctor");
    console.error("  node index.js setup --pdf");
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
    const firstArg = argv[0];

    if (firstArg === "doctor") {
        if (argv.length !== 1) {
            printUsageAndExit("`doctor` does not accept extra arguments.");
        }
        return { mode: "doctor" };
    }

    if (firstArg === "setup") {
        const flags = argv.slice(1);
        if (flags.length !== 1 || flags[0] !== "--pdf") {
            printUsageAndExit("Usage: node index.js setup --pdf");
        }
        return { mode: "setup", setupTarget: "pdf" };
    }

    const result = {
        mode: "translate",
        inputFileName: null,
        chapterSelector: null,
        pageSelector: null,
        sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
        targetLanguage: DEFAULT_TARGET_LANGUAGE,
        sourceLanguageExplicit: false,
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

        if (arg === "--page") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --page.");
            }
            result.pageSelector = nextValue;
            i++;
            continue;
        }

        if (arg.startsWith("--page=")) {
            result.pageSelector = arg.slice("--page=".length);
            if (!result.pageSelector) {
                printUsageAndExit("Missing value after --page=.");
            }
            continue;
        }

        if (arg === "--from") {
            const nextValue = argv[i + 1];
            if (!nextValue || nextValue.startsWith("--")) {
                printUsageAndExit("Missing value after --from.");
            }
            result.sourceLanguage = resolveSourceLanguage(nextValue);
            result.sourceLanguageExplicit = true;
            i++;
            continue;
        }

        if (arg.startsWith("--from=")) {
            const value = arg.slice("--from=".length);
            if (!value) {
                printUsageAndExit("Missing value after --from=.");
            }
            result.sourceLanguage = resolveSourceLanguage(value);
            result.sourceLanguageExplicit = true;
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
    if (!SUPPORTED_INPUT_EXTENSIONS.includes(ext)) {
        printUsageAndExit(
            `Input file must be an EPUB, HTML, PDF, SRT, or supported video file: ${inputFileName}`,
        );
    }

    return inputPath;
};

const promptForConfirmation = async (question) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return false;
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        const answer = await rl.question(`${question} `);
        const normalized = String(answer || "").trim().toLowerCase();
        return normalized === "" || normalized === "y" || normalized === "yes";
    } finally {
        rl.close();
    }
};

const handlePdfSetupCommand = async () => {
    const pdfReport = await getPdfDependencyReport();
    if (!pdfReport.python.command) {
        throw pdfReport.python.error;
    }

    console.log(`Using Python: ${pdfReport.python.displayCommand}`);
    console.log("Installing PDF dependencies from src/pdf/requirements.txt...");
    await installPdfRequirements(__dirname, pdfReport.python);
    console.log("");
    console.log("PDF setup completed.");
};

const maybeInstallMissingPdfDependencies = async (preflightReport) => {
    if (preflightReport.backendName !== "PDF") {
        return false;
    }

    const installableMissing = preflightReport.missing.filter((entry) =>
        ["Python", "PyMuPDF", "pikepdf"].includes(entry),
    );
    if (installableMissing.length === 0) {
        return false;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return false;
    }

    const confirmed = await promptForConfirmation(
        "Install missing PDF dependencies now? [Y/n]",
    );
    if (!confirmed) {
        console.error("Installation declined. Exiting.");
        process.exit(1);
    }

    const pdfReport = preflightReport.pdfReport || (await getPdfDependencyReport());
    if (!pdfReport.python.command) {
        throw pdfReport.python.error;
    }

    console.log(`Using Python: ${pdfReport.python.displayCommand}`);
    console.log("Installing PDF dependencies...");
    await installPdfRequirements(__dirname, pdfReport.python);
    console.log("");
    console.log("PDF dependencies installed. Continuing...");
    return true;
};

const runTranslation = async (cliArgs) => {
    const inputPath = resolveInputPath(cliArgs.inputFileName);
    const inputExt = path.extname(inputPath).toLowerCase();
    let selectedPages = null;

    if (cliArgs.pageSelector) {
        try {
            selectedPages = parsePageSelector(cliArgs.pageSelector);
        } catch (error) {
            printUsageAndExit(error.message);
        }
    }

    const runtimeConfig = createRuntimeConfig({
        sourceLanguage: cliArgs.sourceLanguage,
        targetLanguage: cliArgs.targetLanguage,
        concurrency: cliArgs.concurrency,
    });

    let preflightReport = await getPreflightReport(inputExt, runtimeConfig);
    if (!preflightReport.ready) {
        const installed = await maybeInstallMissingPdfDependencies(preflightReport);
        if (installed) {
            preflightReport = await getPreflightReport(inputExt, runtimeConfig);
        }
    }

    if (!preflightReport.ready) {
        console.error(
            formatPreflightFailureMessage(preflightReport, cliArgs.inputFileName),
        );
        process.exit(1);
    }

    const {
        runHtmlTranslationJob,
        runPdfTranslationJob,
        runSubtitleTranslationJob,
        runTranslationJob,
    } = await import("./src/core.js");

    if (inputExt === ".epub") {
        if (cliArgs.pageSelector) {
            printUsageAndExit("--page is only supported for PDF input.");
        }
        await runTranslationJob({
            projectRoot: __dirname,
            inputPath,
            chapterSelector: cliArgs.chapterSelector,
            debugMode: cliArgs.debug,
            runtimeConfig,
        });
        return;
    }

    if (inputExt === ".pdf") {
        if (cliArgs.chapterSelector) {
            printUsageAndExit("--chap is only supported for EPUB input.");
        }

        await runPdfTranslationJob({
            projectRoot: __dirname,
            inputPath,
            pageSelector: cliArgs.pageSelector,
            selectedPages,
            debugMode: cliArgs.debug,
            runtimeConfig,
        });
        return;
    }

    if (inputExt === ".html" || inputExt === ".htm") {
        if (cliArgs.chapterSelector) {
            printUsageAndExit("--chap is only supported for EPUB input.");
        }
        if (cliArgs.pageSelector) {
            printUsageAndExit("--page is only supported for PDF input.");
        }

        await runHtmlTranslationJob({
            projectRoot: __dirname,
            inputPath,
            debugMode: cliArgs.debug,
            runtimeConfig,
        });
        return;
    }

    if (cliArgs.chapterSelector) {
        printUsageAndExit("--chap is only supported for EPUB input.");
    }
    if (cliArgs.pageSelector) {
        printUsageAndExit("--page is only supported for PDF input.");
    }

    await runSubtitleTranslationJob({
        projectRoot: __dirname,
        inputPath,
        debugMode: cliArgs.debug,
        runtimeConfig,
        sourceLanguageExplicit: cliArgs.sourceLanguageExplicit,
    });
};

const main = async () => {
    const cliArgs = parseCliArgs(process.argv.slice(2));

    try {
        if (cliArgs.mode === "doctor") {
            await runDoctor(createRuntimeConfig());
            return;
        }

        if (cliArgs.mode === "setup") {
            await handlePdfSetupCommand();
            return;
        }

        await runTranslation(cliArgs);
    } catch (error) {
        console.error("Fatal error occurred.", error.message);
        if (cliArgs?.debug) {
            console.error("Check logs for details.");
        }
        process.exit(1);
    }
};

main();
