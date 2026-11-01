import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

import { runTranslationJob } from "../../src/core.js";
import {
    captureStdout,
    seedVerifiedCache,
    makeRuntimeConfig,
    makeTempProject,
    writeFile,
} from "./testUtils.js";

const buildEpub = (filePath) => {
    const zip = new AdmZip();
    zip.addFile("mimetype", Buffer.from("application/epub+zip", "utf8"));
    zip.addFile(
        "META-INF/container.xml",
        Buffer.from(
            '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
            "utf8",
        ),
    );
    zip.addFile(
        "OEBPS/content.opf",
        Buffer.from(
            '<?xml version="1.0"?><package><manifest><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest></package>',
            "utf8",
        ),
    );
    zip.addFile(
        "OEBPS/chapter1.xhtml",
        Buffer.from(
            "<html><body><p>Hello</p></body></html>",
            "utf8",
        ),
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    zip.writeZip(filePath);
};

test("EPUB job restores a cached chapter and repacks the book", async (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const inputPath = path.join(projectRoot, "source", "doc.epub");
    buildEpub(inputPath);

    const cacheDir = path.join(projectRoot, ".cache_doc_zh");
    writeFile(
        path.join(cacheDir, "translation_plan.json"),
        JSON.stringify({
            sorted: [{ id: "chapter1", title: "Chapter 1" }],
            tocId: null,
        }),
    );
    writeFile(
        path.join(cacheDir, "glossary.json"),
        JSON.stringify({ Hello: "你好" }),
    );
    writeFile(
        path.join(cacheDir, "heading_rules.json"),
        JSON.stringify([{ level: 1 }]),
    );
    writeFile(
        path.join(cacheDir, "chapter1.html"),
        "<html><body><p>你好</p></body></html>",
    );

    seedVerifiedCache({ projectRoot, inputPath, cacheDir, kind: "epub" });

    const { value, error, lines } = await captureStdout(() =>
        runTranslationJob({
            projectRoot,
            inputPath,
            chapterSelector: null,
            debugMode: false,
            runtimeConfig: makeRuntimeConfig(),
        }),
    );

    assert.equal(error, undefined);
    assert.equal(value.translationStatus, "complete");
    assert.equal(value.validationStatus, "ok");
    assert.equal(value.outputPath, path.join(projectRoot, "output", "doc_zh.epub"));
    assert.ok(fs.existsSync(value.outputPath));

    const outputZip = new AdmZip(value.outputPath);
    const chapterHtml = outputZip
        .getEntry("OEBPS/chapter1.xhtml")
        .getData()
        .toString("utf8");
    assert.match(chapterHtml, /你好/);

    assert.ok(fs.existsSync(path.join(projectRoot, "input", "doc.epub")));
    assert.equal(fs.existsSync(inputPath), false);
    assert.equal(fs.existsSync(cacheDir), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, "log")), []);
    assert.ok(lines.some((line) => line.includes("doc.epub")));
    assert.ok(lines.some((line) => line.includes("doc_zh.epub")));
});
