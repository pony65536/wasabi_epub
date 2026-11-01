import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    runHtmlTranslationJob,
    runSubtitleTranslationJob,
} from "../../src/core.js";
import {
    captureStdout,
    seedVerifiedCache,
    makeRuntimeConfig,
    readNormalized,
} from "./testUtils.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../fixtures/workflows");
const tmpRoot = path.resolve(here, "../.tmp");

let caseCounter = 0;

const prepareCase = (format, caseName) => {
    const fixtureRoot = path.join(fixturesRoot, format, caseName);
    const caseConfig = JSON.parse(
        fs.readFileSync(path.join(fixtureRoot, "case.json"), "utf8"),
    );
    const projectRoot = path.join(
        tmpRoot,
        `${format}-${caseName}-${process.pid}-${caseCounter++}`,
    );

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.cpSync(path.join(fixtureRoot, "source"), path.join(projectRoot, "source"), {
        recursive: true,
    });
    fs.cpSync(
        path.join(fixtureRoot, "cache"),
        path.join(projectRoot, `${caseConfig.cacheDirName}_zh`),
        { recursive: true },
    );

    seedVerifiedCache({ projectRoot, inputPath: path.join(projectRoot, caseConfig.inputPath),
        cacheDir: path.join(projectRoot, `${caseConfig.cacheDirName}_zh`), kind: format });

    return {
        fixtureRoot,
        caseConfig,
        projectRoot,
        inputPath: path.join(projectRoot, caseConfig.inputPath),
        cacheDir: path.join(projectRoot, `${caseConfig.cacheDirName}_zh`),
    };
};

const assertExpectedOutput = (fixtureRoot, caseConfig, outputPath) => {
    assert.equal(path.basename(outputPath), caseConfig.outputName);
    assert.equal(
        readNormalized(outputPath).trimEnd(),
        readNormalized(
            path.join(fixtureRoot, caseConfig.expectedOutput),
        ).trimEnd(),
    );
};

test("HTML workflow fixture reuses cache and archives the input", async (t) => {
    const { fixtureRoot, caseConfig, projectRoot, inputPath, cacheDir } =
        prepareCase("html", "basic");
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const { value, error, lines } = await captureStdout(() =>
        runHtmlTranslationJob({
            projectRoot,
            inputPath,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
        }),
    );

    assert.equal(error, undefined);
    assert.equal(value.translationStatus, "complete");
    assert.equal(value.validationStatus, "ok");
    assertExpectedOutput(fixtureRoot, caseConfig, value.outputPath);
    assert.ok(
        fs.existsSync(path.join(projectRoot, "input", "doc.html")),
        "input should be archived",
    );
    assert.equal(fs.existsSync(inputPath), false);
    assert.equal(fs.existsSync(cacheDir), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, "log")), []);

    assert.ok(lines.some((line) => line.includes("📄 Input:  doc.html")));
    assert.ok(lines.some((line) => line.includes("📦 Cache:  .cache_doc_html_zh")));
    assert.ok(lines.some((line) => line.includes("🧭 Routing:")));
    assert.equal(value.translationStatus, "complete");
    assert.equal(value.usage.requests, 0);

});

test("Subtitle workflow fixture reuses cache and writes translated cues", async (t) => {
    const { fixtureRoot, caseConfig, projectRoot, inputPath, cacheDir } =
        prepareCase("subtitle", "basic");
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const { value, error, lines } = await captureStdout(() =>
        runSubtitleTranslationJob({
            projectRoot,
            inputPath,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
            ...(caseConfig.jobOptions || {}),
        }),
    );

    assert.equal(error, undefined);
    assertExpectedOutput(fixtureRoot, caseConfig, value.outputPath);
    assert.ok(
        fs.existsSync(path.join(projectRoot, "input", "doc.srt")),
        "input should be archived",
    );
    assert.equal(fs.existsSync(inputPath), false);
    assert.equal(fs.existsSync(cacheDir), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, "log")), []);
    assert.ok(lines.some((line) => line.includes("doc.srt")));
});
