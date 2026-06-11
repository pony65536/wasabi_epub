import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    formatPdfBackendError,
    getPythonSelection,
    runSelectedPython,
} from "../support/environment.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, "translate_pdf.py");

const runPython = async (args, logger, options = {}) => {
    const pythonSelection = await getPythonSelection();

    try {
        const result = await runSelectedPython(
            pythonSelection,
            [SCRIPT_PATH, ...args],
            options,
        );
        if (result.stdout.trim()) {
            logger?.write("INFO", `PDF bridge stdout:\n${result.stdout}`);
        }
        if (result.stderr.trim()) {
            logger?.write("WARN", `PDF bridge stderr:\n${result.stderr}`);
        }
        return result;
    } catch (failure) {
        if (failure?.stdout?.trim()) {
            logger?.write("INFO", `PDF bridge stdout:\n${failure.stdout}`);
        }
        if (failure?.stderr?.trim()) {
            logger?.write("WARN", `PDF bridge stderr:\n${failure.stderr}`);
        }
        throw new Error(
            formatPdfBackendError(
                failure?.stderr || failure?.error?.message || failure?.message,
            ),
        );
    }
};

export const extractPdfToJson = async (
    inputPath,
    jsonPath,
    logger,
    selectedPages = null,
) => {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    const args = ["extract", inputPath, jsonPath];
    if (selectedPages?.length) {
        args.push("--pages", selectedPages.join(","));
    }
    await runPython(args, logger, { streamOutputToTerminal: false });
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
};

export const fillPdfFromJson = async (
    inputPath,
    translatedJsonPath,
    outputPath,
    logger,
) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = ["fill", inputPath, translatedJsonPath, outputPath];
    await runPython(args, logger, { streamOutputToTerminal: false });
    return outputPath;
};
