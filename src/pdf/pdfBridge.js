import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, "translate_pdf.py");

const getCondaCommand = () =>
    process.env.CONDA_EXE || process.env._CONDA_EXE || "conda";

const getConfiguredDoclingPrefix = () =>
    process.env.DOCLING_CONDA_PREFIX || process.env.WASABI_CONDA_PREFIX || null;

const discoverDoclingCondaPrefix = () => {
    const configuredPrefix = getConfiguredDoclingPrefix();
    if (configuredPrefix) return configuredPrefix;

    try {
        const raw = execFileSync(
            getCondaCommand(),
            ["env", "list", "--json"],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
            },
        );
        const payload = JSON.parse(raw);
        const envs = Array.isArray(payload?.envs) ? payload.envs : [];
        return (
            envs.find((envPath) =>
                /[\\/]envs[\\/]+docling$/i.test(String(envPath || "")),
            ) || null
        );
    } catch {
        return null;
    }
};

const getPythonCandidates = () => {
    const configuredPython = process.env.PYTHON || process.env.PYTHON_BIN;
    if (configuredPython) return [{ command: configuredPython, args: [] }];

    const condaCommand = getCondaCommand();
    const doclingPrefix = discoverDoclingCondaPrefix();
    const condaCandidates = [];
    if (doclingPrefix) {
        condaCandidates.push({
            command: condaCommand,
            args: ["run", "--no-capture-output", "-p", doclingPrefix, "python"],
        });
    }
    condaCandidates.push({
        command: condaCommand,
        args: ["run", "--no-capture-output", "-n", "docling", "python"],
    });

    if (process.platform === "win32") {
        return [
            ...condaCandidates,
            { command: "python", args: [] },
            { command: "py", args: ["-3"] },
            { command: "python3", args: [] },
        ];
    }

    return [
        ...condaCandidates,
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
            .join(", ")}. Ensure the Conda env 'docling' is available, or set DOCLING_CONDA_PREFIX / PYTHON / PYTHON_BIN explicitly.`,
    );

const runPythonWithCandidate = (
    candidate,
    args,
    logger,
    options = {},
) =>
    new Promise((resolve, reject) => {
        const streamOutputToTerminal = options.streamOutputToTerminal !== false;
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
        const streamOutput = (text, writer) => {
            if (!text) return;
            try {
                writer.write(text);
            } catch {}
        };
        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdout += text;
            if (streamOutputToTerminal) {
                streamOutput(text, process.stdout);
            }
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            stderr += text;
            if (streamOutputToTerminal) {
                streamOutput(text, process.stderr);
            }
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

const runPython = async (args, logger, options = {}) => {
    const attempts = [];

    for (const candidate of getPythonCandidates()) {
        try {
            return await runPythonWithCandidate(candidate, args, logger, options);
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
