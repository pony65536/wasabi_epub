import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { loadRuntimeConfig } from "../../src/config.js";
import { createProgressCache } from "../../src/support/cache.js";
import { resolveModelRouting } from "../../src/models/routing.js";
import { buildTaskSignature, computeFileDigest, computePromptDigest, computeTextDigest,
    TRANSLATION_PIPELINE_VERSION } from "../../src/support/taskIdentity.js";
import { createChapterMap } from "../../src/epub/chapterMap.js";
import { repairChapterMapInPlace } from "../../src/epub/epubDoctor.js";

export const seedVerifiedCache = ({ projectRoot, inputPath, cacheDir, kind,
    runtimeConfig = makeRuntimeConfig() }) => {
    const cache = createProgressCache(cacheDir);
    const routing = resolveModelRouting({ config: runtimeConfig.modelConfig });
    let sourceDigest = kind === "subtitle"
        ? computeTextDigest(fs.readFileSync(inputPath, "utf8")) : computeFileDigest(inputPath);
    let extras = { promptDigest: computePromptDigest(projectRoot, `${kind}_translation_prompt.txt`),
        modelRoutingFingerprint: routing.fingerprint };
    if (kind === "subtitle") extras = { inputType: "srt", ...extras };
    if (kind === "epub") {
        const zipEntries = new AdmZip(inputPath).getEntries();
        const report = repairChapterMapInPlace(createChapterMap(zipEntries), { write() {} }, { zipEntries });
        sourceDigest = report.sourceDigest;
        extras = { repairFingerprint: report.fingerprint,
            promptDigest: extras.promptDigest, chapterSelector: null,
            modelRoutingFingerprint: routing.fingerprint };
        cache.saveBookBible({});
    }
    const statuses = {};
    for (const file of fs.readdirSync(cacheDir).filter((name) => name.endsWith(".html"))) {
        const id = path.basename(file, ".html");
        statuses[id] = { status: "complete", protocolVersion: TRANSLATION_PIPELINE_VERSION,
            htmlDigest: computeTextDigest(cache.load(id)), failedNodeIds: [] };
    }
    cache.saveChapterStatus(statuses);
    cache.saveTaskMeta({ signature: buildTaskSignature({ kind, sourceDigest,
        sourceLanguage: runtimeConfig.sourceLanguage, targetLanguage: runtimeConfig.targetLanguage, extras }) });
};

const makeTestConfig = () => ({
    version: 1,
    models: {
        "test-primary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_PRIMARY_API_KEY",
            modelName: "test-primary",
        },
        "test-fallback": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_FALLBACK_API_KEY",
            modelName: "test-fallback",
        },
        "test-glossary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_GLOSSARY_API_KEY",
            modelName: "test-glossary",
        },
    },
    selection: {
        primary: "test-primary",
        fallback: { model: "test-fallback" },
        glossary: { default: "test-primary" },
    },
});

export const makeRuntimeConfig = (overrides = {}) =>
    loadRuntimeConfig({
        config: makeTestConfig(),
        env: {
            TEST_PRIMARY_API_KEY: "test-key",
            TEST_FALLBACK_API_KEY: "test-key",
            TEST_GLOSSARY_API_KEY: "test-key",
        },
        ...overrides,
    });

export const makeTempProject = () =>
    fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-core-"));

export const writeFile = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
};

export const readNormalized = (filePath) =>
    fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

export const captureStdout = async (fn) => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => {
        lines.push(args.map(String).join(" "));
    };

    let value;
    let error;
    try {
        value = await fn();
    } catch (caught) {
        error = caught;
    } finally {
        console.log = original;
    }

    return { value, error, lines };
};
