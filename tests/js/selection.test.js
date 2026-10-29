import test from "node:test";
import assert from "node:assert/strict";

import { selectChaptersBySpec } from "../../src/support/chapterSelection.js";
import { parsePageSelector } from "../../src/support/pageSelection.js";

const chapters = [
    { id: "intro", title: "Intro" },
    { id: "c1", title: "Chapter 1" },
    { id: "c2", title: "Chapter 2" },
    { id: "app", title: "Appendix" },
];

const ids = (selected) => selected.map((chapter) => chapter.id);

test("page selector parses lists and ranges", () => {
    assert.deepEqual(parsePageSelector("1,3-5,4"), [1, 3, 4, 5]);
    assert.equal(parsePageSelector(null), null);
});

test("page selector rejects invalid input", () => {
    assert.throws(() => parsePageSelector("5-2"), /Start page/);
    assert.throws(() => parsePageSelector("0"), /positive integers/);
    assert.throws(() => parsePageSelector("1,,2"), /Empty page selector/);
});

test("chapter selector returns all chapters without a spec", () => {
    assert.equal(selectChaptersBySpec(chapters, null), chapters);
    assert.deepEqual(ids(selectChaptersBySpec(chapters, "1,3")), [
        "intro",
        "c2",
    ]);
    assert.deepEqual(ids(selectChaptersBySpec(chapters, "2-4")), [
        "c1",
        "c2",
        "app",
    ]);
    assert.deepEqual(ids(selectChaptersBySpec(chapters, "3-2")), ["c1", "c2"]);
});

test("chapter selector matches titles and title ranges", () => {
    assert.deepEqual(ids(selectChaptersBySpec(chapters, "'chapter 1'")), [
        "c1",
    ]);
    assert.deepEqual(
        ids(selectChaptersBySpec(chapters, "'Chapter 1'-'Chapter 2'")),
        ["c1", "c2"],
    );
});

test("chapter selector reports invalid specs", () => {
    assert.throws(() => selectChaptersBySpec(chapters, "0"), /start from 1/);
    assert.throws(() => selectChaptersBySpec(chapters, "9"), /out of range/);
    assert.throws(
        () => selectChaptersBySpec(chapters, "'Missing'"),
        /not found/,
    );
    assert.throws(
        () => selectChaptersBySpec(chapters, "'Chapter 1"),
        /Unclosed quote/,
    );
});
