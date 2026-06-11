import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { CURRENT_PROVIDER } from "../config.js";

const MINIMUM_PYTHON_VERSION = {
    major: 3,
    minor: 10,
};

const PYTHON_CANDIDATES = () => {
    if (process.env.WASABI_PDF_PYTHON) {
        return [{ command: process.env.WASABI_PDF_PYTHON, args: [] }];
    }

    return [
        { command: "python3", args: [] },
        { command: "python", args: [] },
    ];
};

const TRANSLATION_ENV_CHECKS = [
    { label: "Gemini API Key", envVar: "GEMINI_API_KEY" },
    { label: "Qwen API Key", envVar: "QWEN_API_KEY" },
    { label: "Mimo API Key", envVar: "MIMO_API_KEY" },
    { label: "OpenRouter API Key", envVar: "OPENROUTER_API_KEY" },
];

const PYTHON_MODULE_CHECKS = [
    {
        key: "fitz",
        label: "PyMuPDF",
        importName: "fitz",
        required: true,
    },
    {
        key: "pikepdf",
        label: "pikepdf",
        importName: "pikepdf",
        required: true,
    },
    {
        key: "docling",
        label: "docling",
        importName: "docling.document_converter",
        required: false,
    },
];

const formatCommand = (command, args = []) =>
    [command, ...args]
        .map((part) => (String(part).includes(" ") ? `"${part}"` : String(part)))
        .join(" ");

const formatStatus = (ok, optional = false) => {
    if (ok) return "OK";
    return optional ? "missing (optional)" : "MISSING";
};

const commandFailureLooksLikeNotFound = (failure) =>
    (failure?.type === "spawn" &&
        (failure?.error?.code === "ENOENT" ||
            failure?.error?.code === "EPERM" ||
            /not recognized as an internal or external command/i.test(
                failure?.error?.message || "",
            ))) ||
    (failure?.type === "exit" &&
        !String(failure?.stdout || "").trim() &&
        !String(failure?.stderr || "").trim());

const runProcess = (command, args = [], options = {}) =>
    new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd || process.cwd(),
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            reject({ type: "spawn", command, args, error, stdout: "", stderr: "" });
            return;
        }

        let stdout = "";
        let stderr = "";

        const writeChunk = (writer, chunk) => {
            try {
                writer.write(chunk);
            } catch {}
        };

        if (options.stdinText != null) {
            child.stdin.write(String(options.stdinText));
        }
        child.stdin.end();

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            if (options.streamOutputToTerminal) {
                writeChunk(process.stdout, chunk);
            }
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            if (options.streamOutputToTerminal) {
                writeChunk(process.stderr, chunk);
            }
        });

        child.on("error", (error) => {
            reject({ type: "spawn", command, args, error, stdout, stderr });
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve({ command, args, code, stdout, stderr });
                return;
            }

            reject({ type: "exit", command, args, code, stdout, stderr });
        });
    });

const extractVersionText = (result) =>
    String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || null;

const parsePythonVersion = (versionText) => {
    const match = String(versionText || "").match(
        /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i,
    );
    if (!match) return null;
    return {
        major: Number.parseInt(match[1], 10),
        minor: Number.parseInt(match[2], 10),
        patch: Number.parseInt(match[3] || "0", 10),
    };
};

const formatMinimumPythonVersion = () =>
    `${MINIMUM_PYTHON_VERSION.major}.${MINIMUM_PYTHON_VERSION.minor}`;

const isSupportedPythonVersion = (version) => {
    if (!version) return false;
    if (version.major !== MINIMUM_PYTHON_VERSION.major) {
        return version.major > MINIMUM_PYTHON_VERSION.major;
    }
    return version.minor >= MINIMUM_PYTHON_VERSION.minor;
};

const createPythonSelectionError = (attempts) => {
    const attemptSummary = attempts.length
        ? attempts
              .map((attempt) => {
                  const label = formatCommand(attempt.command, attempt.args);
                  return attempt.versionText
                      ? `${label} (${attempt.versionText})`
                      : label;
              })
              .join(", ")
        : "python3, python";
    const hasUnsupportedVersion = attempts.some(
        (attempt) => attempt.reason === "unsupported_version",
    );

    if (hasUnsupportedVersion) {
        return new Error(
            `Python ${formatMinimumPythonVersion()}+ is required for PDF support. Tried: ${attemptSummary}.\n\nInstall Python ${formatMinimumPythonVersion()}+, or set WASABI_PDF_PYTHON to a compatible interpreter.\n\nThen run:\n\nnode index.js setup --pdf`,
        );
    }

    return new Error(
        `Python is not available for PDF support. Tried: ${attemptSummary}.\n\nInstall Python ${formatMinimumPythonVersion()}+, or set WASABI_PDF_PYTHON to an existing interpreter.\n\nThen run:\n\nnode index.js setup --pdf`,
    );
};

export const getPythonSelection = async () => {
    const attempts = [];

    for (const candidate of PYTHON_CANDIDATES()) {
        try {
            const result = await runProcess(candidate.command, [
                ...candidate.args,
                "--version",
            ]);
            const selection = {
                ...candidate,
                displayCommand: formatCommand(candidate.command, candidate.args),
                version: extractVersionText(result),
                fromEnv: Boolean(process.env.WASABI_PDF_PYTHON),
            };
            const parsedVersion = parsePythonVersion(selection.version);
            if (!isSupportedPythonVersion(parsedVersion)) {
                attempts.push({
                    ...candidate,
                    reason: "unsupported_version",
                    versionText: selection.version,
                });
                continue;
            }
            return selection;
        } catch (failure) {
            attempts.push({
                ...candidate,
                reason: "not_found",
            });
            if (!commandFailureLooksLikeNotFound(failure)) {
                throw new Error(
                    `Failed to query Python version via ${formatCommand(candidate.command, candidate.args)}.${failure.stderr ? `\n${failure.stderr.trim()}` : ""}`,
                );
            }
        }
    }

    return {
        command: null,
        args: [],
        displayCommand: null,
        version: null,
        fromEnv: Boolean(process.env.WASABI_PDF_PYTHON),
        error: createPythonSelectionError(attempts),
    };
};

export const runSelectedPython = async (
    pythonSelection,
    args,
    options = {},
) => {
    if (!pythonSelection?.command) {
        throw pythonSelection?.error || createPythonSelectionError(PYTHON_CANDIDATES());
    }

    return runProcess(
        pythonSelection.command,
        [...pythonSelection.args, ...args],
        options,
    );
};

const buildImportCheckSnippet = (importName) => `
import importlib
import sys
try:
    importlib.import_module(${JSON.stringify(importName)})
except Exception:
    sys.exit(1)
sys.exit(0)
`.trim();

const checkPythonModule = async (pythonSelection, importName) => {
    if (!pythonSelection?.command) return false;

    try {
        await runSelectedPython(
            pythonSelection,
            ["-c", buildImportCheckSnippet(importName)],
            { streamOutputToTerminal: false },
        );
        return true;
    } catch {
        return false;
    }
};

const checkExternalCommand = async (command, args = ["-version"]) => {
    try {
        const result = await runProcess(command, args);
        return {
            ok: true,
            version: extractVersionText(result),
        };
    } catch (failure) {
        if (commandFailureLooksLikeNotFound(failure)) {
            return { ok: false, version: null };
        }

        return {
            ok: false,
            version: extractVersionText(failure) || null,
        };
    }
};

export const getTranslationEnvReport = (runtimeConfig) => {
    const checks = TRANSLATION_ENV_CHECKS.map((check) => ({
        ...check,
        ok: Boolean(process.env[check.envVar]),
        relevant:
            check.envVar === `${String(CURRENT_PROVIDER).toUpperCase()}_API_KEY`,
    }));

    return {
        checks,
        primaryProviderReady: checks.some(
            (check) => check.relevant && check.ok,
        ),
    };
};

export const getPdfDependencyReport = async () => {
    const python = await getPythonSelection();
    const checks = [];

    for (const moduleCheck of PYTHON_MODULE_CHECKS) {
        const ok = await checkPythonModule(python, moduleCheck.importName);
        checks.push({
            ...moduleCheck,
            ok,
        });
    }

    return {
        python,
        checks,
        ready:
            Boolean(python.command) &&
            checks.filter((check) => check.required).every((check) => check.ok),
    };
};

export const getVideoDependencyReport = async () => {
    const ffmpeg = await checkExternalCommand("ffmpeg");
    const ffprobe = await checkExternalCommand("ffprobe");

    return {
        ffmpeg,
        ffprobe,
        ready: ffmpeg.ok && ffprobe.ok,
    };
};

export const installPdfRequirements = async (
    projectRoot,
    pythonSelection,
) => {
    const requirementsPath = path.resolve(
        projectRoot,
        "src",
        "pdf",
        "requirements.txt",
    );

    if (!fs.existsSync(requirementsPath)) {
        throw new Error(
            `PDF requirements file not found: ${requirementsPath}`,
        );
    }

    if (!pythonSelection?.command) {
        throw pythonSelection?.error || createPythonSelectionError(PYTHON_CANDIDATES());
    }

    await runSelectedPython(
        pythonSelection,
        ["-m", "pip", "install", "-r", requirementsPath],
        {
            cwd: projectRoot,
            streamOutputToTerminal: true,
        },
    );
};

const printSection = (title) => {
    console.log(title);
    console.log("-".repeat(title.length));
};

export const runDoctor = async (runtimeConfig) => {
    const pdfReport = await getPdfDependencyReport();
    const videoReport = await getVideoDependencyReport();
    const translationReport = getTranslationEnvReport(runtimeConfig);

    let allRequiredReady = true;

    printSection("Node");
    console.log(`Executable      ${process.execPath}`);
    console.log(`Version         ${process.version}`);
    console.log("");

    printSection("Python");
    console.log(
        `WASABI_PDF_PYTHON   ${process.env.WASABI_PDF_PYTHON ? "set" : "not set"}`,
    );
    console.log(`Selected Python     ${pdfReport.python.displayCommand || "not found"}`);
    console.log(`Python Version      ${pdfReport.python.version || "unavailable"}`);
    console.log(`Python Minimum      ${formatMinimumPythonVersion()}+`);
    console.log("");

    printSection("PDF Backend");
    for (const check of pdfReport.checks) {
        console.log(
            `${check.label.padEnd(13)} ${formatStatus(check.ok, !check.required)}`,
        );
        if (check.required && !check.ok) {
            allRequiredReady = false;
        }
    }
    if (!pdfReport.python.command) {
        allRequiredReady = false;
    }
    console.log("");

    printSection("Video Backend");
    console.log(`ffmpeg         ${formatStatus(videoReport.ffmpeg.ok)}`);
    console.log(`ffprobe        ${formatStatus(videoReport.ffprobe.ok)}`);
    if (!videoReport.ready) {
        allRequiredReady = false;
    }
    console.log("");

    printSection("Translation");
    for (const check of translationReport.checks) {
        console.log(`${check.label.padEnd(18)} ${formatStatus(check.ok)}`);
    }
    if (!translationReport.primaryProviderReady) {
        allRequiredReady = false;
    }
    console.log("");

    printSection("Summary");
    if (allRequiredReady) {
        console.log("Environment looks ready.");
    } else {
        console.log("Environment is incomplete. Run `node index.js setup --pdf` for PDF dependencies and check `node index.js doctor` for missing tools or API keys.");
    }
};

export const getPreflightReport = async (inputExt, runtimeConfig) => {
    const translationReport = getTranslationEnvReport(runtimeConfig);
    const report = {
        inputExt,
        backendName: null,
        translationReport,
        missing: [],
        installable: false,
        pdfReport: null,
        videoReport: null,
    };

    if (!translationReport.primaryProviderReady) {
        report.missing.push(
            "Translation provider API key for the selected configuration",
        );
    }

    if (inputExt === ".pdf") {
        report.backendName = "PDF";
        report.installable = true;
        report.pdfReport = await getPdfDependencyReport();

        if (!report.pdfReport.python.command) {
            report.missing.push(`Python ${formatMinimumPythonVersion()}+`);
        }

        for (const check of report.pdfReport.checks.filter(
            (entry) => entry.required && !entry.ok,
        )) {
            report.missing.push(check.label);
        }
    } else if ([".mkv", ".mp4", ".mov", ".m4v", ".webm"].includes(inputExt)) {
        report.backendName = "Video";
        report.videoReport = await getVideoDependencyReport();
        if (!report.videoReport.ffmpeg.ok) report.missing.push("ffmpeg");
        if (!report.videoReport.ffprobe.ok) report.missing.push("ffprobe");
    } else if (inputExt === ".srt") {
        report.backendName = "Subtitle";
    } else if (inputExt === ".epub") {
        report.backendName = "EPUB";
    } else {
        report.backendName = "HTML";
    }

    report.ready = report.missing.length === 0;
    return report;
};

export const formatPreflightFailureMessage = (preflightReport, inputFileName) => {
    const lines = [];
    lines.push(`${preflightReport.backendName} support is not ready.`);
    lines.push("");
    lines.push("Missing dependencies:");
    for (const entry of preflightReport.missing) {
        lines.push(`- ${entry}`);
    }

    if (preflightReport.backendName === "PDF") {
        lines.push("");
        lines.push("Run:");
        lines.push("");
        lines.push("node index.js setup --pdf");
    } else if (preflightReport.backendName === "Video") {
        lines.push("");
        lines.push("Install ffmpeg and ffprobe, then rerun `node index.js doctor`.");
    } else {
        lines.push("");
        lines.push("Run `node index.js doctor` to inspect the current environment.");
    }

    return lines.join("\n");
};

export const formatPdfBackendError = (message) => {
    const normalized = String(message || "");
    if (
        /PyMuPDF is required|No module named ['"]fitz['"]/i.test(normalized) ||
        /pikepdf is required|No module named ['"]pikepdf['"]/i.test(normalized) ||
        /Python is not available for PDF support/i.test(normalized)
    ) {
        return [
            "PDF support is missing.",
            "",
            "Run:",
            "",
            "node index.js setup --pdf",
        ].join("\n");
    }

    return normalized;
};
