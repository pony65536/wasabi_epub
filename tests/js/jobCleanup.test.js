import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
    runHtmlTranslationJob,
    runSubtitleTranslationJob,
} from "../../src/core.js";
import {
    captureStdout,
    makeRuntimeConfig,
    makeTempProject,
    writeFile,
} from "./testUtils.js";

test("HTML job removes cache and log after success", async (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const inputPath = path.join(projectRoot, "source", "doc.html");
    writeFile(inputPath, "<html><body><p>Hello</p></body></html>");

    const cacheDir = path.join(projectRoot, ".cache_doc_html");
    writeFile(
        path.join(cacheDir, "heading_rules.json"),
        JSON.stringify([{ level: 1 }]),
    );
    writeFile(
        path.join(cacheDir, "glossary.json"),
        JSON.stringify({ Hello: "你好" }),
    );
    writeFile(
        path.join(cacheDir, "document.html"),
        "<html><body><p>你好</p></body></html>",
    );

    const { value, error, lines } = await captureStdout(() =>
        runHtmlTranslationJob({
            projectRoot,
            inputPath,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
        }),
    );

    assert.equal(error, undefined);
    assert.deepEqual(Object.keys(value).sort(), [
        "cacheDir",
        "logFile",
        "outputPath",
    ]);
    assert.equal(
        value.outputPath,
        path.join(projectRoot, "output", "doc_zh.html"),
    );
    assert.match(fs.readFileSync(value.outputPath, "utf8"), /你好/);
    assert.ok(fs.existsSync(path.join(projectRoot, "input", "doc.html")));
    assert.equal(fs.existsSync(inputPath), false);
    assert.equal(fs.existsSync(cacheDir), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, "log")), []);
    assert.ok(lines.some((line) => line.includes("doc.html")));
    assert.ok(lines.some((line) => line.includes("doc_zh.html")));
});

test("HTML job surfaces the original error and removes artifacts on failure", async (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const inputPath = path.join(projectRoot, "source", "doc.html");
    writeFile(inputPath, "<html><body><p>Hello</p></body></html>");

    const cacheDir = path.join(projectRoot, ".cache_doc_html");
    writeFile(
        path.join(cacheDir, "heading_rules.json"),
        JSON.stringify([{ level: 1 }]),
    );
    writeFile(path.join(cacheDir, "glossary.json"), "{ not json");

    const { error } = await captureStdout(() =>
        runHtmlTranslationJob({
            projectRoot,
            inputPath,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
        }),
    );

    assert.ok(error instanceof SyntaxError);
    assert.doesNotMatch(String(error.message), /shouldKeepArtifacts/);
    assert.equal(fs.existsSync(cacheDir), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, "log")), []);
});

test("Subtitle job retains cache and log after failure", async (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const inputPath = path.join(projectRoot, "source", "doc.srt");
    writeFile(
        inputPath,
        "1\n00:00:01,000 --> 00:00:02,000\nHello world\n",
    );

    const cacheDir = path.join(projectRoot, ".cache_doc_subtitle");
    writeFile(path.join(cacheDir, "glossary.json"), "{ not json");

    const { error } = await captureStdout(() =>
        runSubtitleTranslationJob({
            projectRoot,
            inputPath,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
            sourceLanguageExplicit: true,
        }),
    );

    assert.ok(error instanceof SyntaxError);
    assert.doesNotMatch(String(error.message), /shouldKeepArtifacts/);
    assert.ok(fs.existsSync(cacheDir));
    assert.ok(fs.readdirSync(cacheDir).length > 0);
    assert.ok(fs.readdirSync(path.join(projectRoot, "log")).length > 0);
    assert.equal(fs.existsSync(inputPath), true);
});
