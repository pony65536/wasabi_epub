import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, "translate_pdf.py");

const getPythonCandidates = () => {
    const configuredPython = process.env.PYTHON || process.env.PYTHON_BIN;
    if (configuredPython) return [{ command: configuredPython, args: [] }];

    if (process.platform === "win32") {
        return [
            { command: "python", args: [] },
            { command: "py", args: ["-3"] },
            { command: "python3", args: [] },
        ];
    }

    return [
        { command: "python3", args: [] },
        { command: "python", args: [] },
    ];
};

const formatPythonCommand = ({ command, args }) =>
    [command, ...args]
        .map((part) => (part.includes(" ") ? `"${part}"` : part))
        .join(" ");

const createPythonNotFoundError = (attempts) =>
    new Error(
        `Unable to start the PDF Python helper. Tried: ${attempts
            .map((attempt) => formatPythonCommand(attempt.candidate))
            .join(", ")}. Install Python/PyMuPDF and, if needed, set PYTHON or PYTHON_BIN to the interpreter path.`,
    );

const runPythonWithCandidate = (candidate, args, logger) =>
    new Promise((resolve, reject) => {
        const child = spawn(
            candidate.command,
            [...candidate.args, SCRIPT_PATH, ...args],
            {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            reject({ type: "spawn", candidate, error, stdout, stderr });
        });
        child.on("close", (code) => {
            if (code === 0) {
                if (stdout.trim()) {
                    logger?.write("INFO", `PDF bridge stdout:\n${stdout}`);
                }
                if (stderr.trim()) {
                    logger?.write("WARN", `PDF bridge stderr:\n${stderr}`);
                }
                resolve({ stdout, stderr, candidate });
                return;
            }

            reject({ type: "exit", candidate, code, stdout, stderr });
        });
    });

const isCommandNotFound = (failure) =>
    failure?.error?.code === "ENOENT" ||
    failure?.code === 9009 ||
    /not recognized as an internal or external command/i.test(failure?.stderr || "");

const runPython = async (args, logger) => {
    const attempts = [];

    for (const candidate of getPythonCandidates()) {
        try {
            return await runPythonWithCandidate(candidate, args, logger);
        } catch (failure) {
            attempts.push({ candidate, failure });
            if (!isCommandNotFound(failure)) {
                if (failure.stdout?.trim()) {
                    logger?.write("INFO", `PDF bridge stdout:\n${failure.stdout}`);
                }
                if (failure.stderr?.trim()) {
                    logger?.write("WARN", `PDF bridge stderr:\n${failure.stderr}`);
                }
                throw new Error(
                    `PDF bridge failed with ${formatPythonCommand(candidate)} exit code ${failure.code}.${failure.stderr ? `\n${failure.stderr}` : ""}`,
                );
            }
        }
    }

    throw createPythonNotFoundError(attempts);
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
    await runPython(args, logger);
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
    await runPython(args, logger);
    return outputPath;
};
