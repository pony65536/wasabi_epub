import test from "node:test";
import assert from "node:assert/strict";

import {
    collectDefinedClasses,
    collectReferencedIds,
    sanitizeCachedPlan,
} from "../../src/epub/chapterMap.js";

const silentLogger = () => {
    const warnings = [];
    return {
        warnings,
        write: (type, message) => warnings.push({ type, message }),
    };
};

test("sanitizeCachedPlan drops unknown, duplicate, and empty ids", () => {
    const chapterMap = new Map([
        ["a", { id: "a" }],
        ["b", { id: "b" }],
    ]);
    const logger = silentLogger();

    const result = sanitizeCachedPlan(
        {
            sorted: [
                { id: "a" },
                { id: "a" },
                { id: "missing" },
                { id: null },
                { id: "b" },
            ],
            tocId: "a",
        },
        chapterMap,
        logger,
    );

    assert.deepEqual(
        result.sorted.map((chapter) => chapter.id),
        ["a", "b"],
    );
    assert.equal(result.tocId, "a");
    assert.equal(logger.warnings.length, 1);
    assert.equal(logger.warnings[0].type, "WARN");
    assert.match(logger.warnings[0].message, /Dropped 3/);
});

test("sanitizeCachedPlan rejects malformed plans", () => {
    const chapterMap = new Map();
    const logger = silentLogger();

    assert.equal(sanitizeCachedPlan(null, chapterMap, logger), null);
    assert.equal(
        sanitizeCachedPlan({ sorted: "not-an-array" }, chapterMap, logger),
        null,
    );
    assert.equal(logger.warnings.length, 0);
});

test("collectReferencedIds gathers anchor fragments", () => {
    const chapterMap = new Map([
        [
            "c1",
            {
                html: '<html><body><a href="x#target">t</a><a href="y">n</a><a href="#local">l</a></body></html>',
            },
        ],
    ]);

    assert.deepEqual([...collectReferencedIds(chapterMap)], ["target", "local"]);
});

test("collectDefinedClasses reads classes from CSS entries only", () => {
    const entries = [
        {
            entryName: "style.css",
            getData: () => Buffer.from(".foo{} .bar-baz{}"),
        },
        {
            entryName: "chapter.xhtml",
            getData: () => Buffer.from(".ignored{}"),
        },
    ];

    assert.deepEqual([...collectDefinedClasses(entries)].sort(), [
        "bar-baz",
        "foo",
    ]);
});
