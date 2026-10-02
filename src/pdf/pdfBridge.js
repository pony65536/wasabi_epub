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

export const readPdfFillResult = (resultJsonPath, requestedOutputPath) => {
    if (!resultJsonPath) {
        // 旧协议：无法确认实际产物路径，明确标注兼容模式
        return {
            outputPath: requestedOutputPath,
            usedFallback: false,
            protocol: "legacy",
        };
    }
    if (!fs.existsSync(resultJsonPath)) {
        throw new Error(
            `PDF fill result file missing: ${resultJsonPath}. Refusing to guess the actual output path.`,
        );
    }
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(resultJsonPath, "utf8"));
    } catch {
        throw new Error(
            `PDF fill result file is corrupt: ${resultJsonPath}.`,
        );
    }
    if (
        !parsed ||
        typeof parsed.actualOutputPath !== "string" ||
        !parsed.actualOutputPath
    ) {
        throw new Error(
            `PDF fill result file has an invalid schema: ${resultJsonPath}.`,
        );
    }
    return {
        outputPath: parsed.actualOutputPath,
        usedFallback: Boolean(parsed.usedFallback),
        protocol: "v1",
    };
};

export const fillPdfFromJson = async (
    inputPath,
    translatedJsonPath,
    outputPath,
    logger,
    resultJsonPath = null,
) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = ["fill", inputPath, translatedJsonPath, outputPath];
    if (resultJsonPath) {
        fs.mkdirSync(path.dirname(resultJsonPath), { recursive: true });
        args.push("--result-json", resultJsonPath);
    }
    await runPython(args, logger, { streamOutputToTerminal: true });
    const result = readPdfFillResult(resultJsonPath, outputPath);
    if (result.usedFallback) {
        logger?.write?.(
            "WARN",
            `PDF target was locked; actual output written to fallback path: ${result.outputPath}`,
        );
    }
    return result;
};

export const validatePdfOutput = async (
    inputPath,
    translatedJsonPath,
    outputPath,
    validationPath,
    logger,
) => {
    fs.mkdirSync(path.dirname(validationPath), { recursive: true });
    const args = [
        "validate",
        inputPath,
        translatedJsonPath,
        outputPath,
        validationPath,
    ];
    await runPython(args, logger, { streamOutputToTerminal: true });
    return JSON.parse(fs.readFileSync(validationPath, "utf8"));
};
