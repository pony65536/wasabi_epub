import test from "node:test";
import assert from "node:assert/strict";

import { translateDocument } from "../../src/pipeline/translateDocument.js";
import { performTranslation } from "../../src/translation/translator.js";

const silentLogger = { write: () => {} };

test("document cache hit reuses html and still runs postTranslate", async () => {
    const chapterMap = new Map([
        ["document", { id: "document", html: "<html><body>source</body></html>" }],
    ]);
    let postTranslateCalls = 0;

    const result = await translateDocument({
        chapters: [...chapterMap.values()],
        chapterMap,
        glossary: {},
        cache: {
            load: (key) =>
                key === "document"
                    ? "<html><body>translated</body></html>"
                    : null,
        },
        cacheMode: "document",
        cacheKey: "document",
        cachedMessage: "HTML",
        runtimeConfig: {},
        aiProvider: null,
        batchQueue: null,
        logger: silentLogger,
        debugMode: false,
        referencedIds: new Set(),
        definedClasses: new Set(),
        mode: "html",
        postTranslate: async () => {
            postTranslateCalls += 1;
        },
    });

    assert.equal(result.fromCache, true);
    assert.equal(
        chapterMap.get("document").html,
        "<html><body>translated</body></html>",
    );
    assert.equal(postTranslateCalls, 1);
});

test("performTranslation reports a chapter summary excluding TOC", async () => {
    const chapterMap = new Map([
        ["c1", { id: "c1", title: "One", html: "<p>One</p>" }],
        ["toc", { id: "toc", title: "Contents", html: "<p>Contents</p>" }],
    ]);
    const chapters = [
        { id: "c1", title: "One", html: "<p>One</p>" },
        { id: "toc", title: "Contents", html: "<p>Contents</p>", isTOC: true },
    ];
    const saved = [];
    const cache = {
        load: (id) => (id === "c1" ? "<p>Uno</p>" : null),
        save: (id, html) => saved.push([id, html]),
    };

    const summary = await performTranslation(
        chapters,
        chapterMap,
        {},
        {},
        null,
        { drainQueue: async () => {} },
        silentLogger,
        cache,
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );

    assert.deepEqual(summary, {
        total: 1,
        skipped: 1,
        translated: 0,
        failed: 0,
        failedIds: [],
    });
    assert.equal(chapterMap.get("c1").html, "<p>Uno</p>");
    assert.deepEqual(saved, []);
});
