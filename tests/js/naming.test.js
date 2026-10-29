import test from "node:test";
import assert from "node:assert/strict";

import {
    createSelectionSlug,
    getLanguageFileCode,
    sanitizeFileToken,
} from "../../src/support/naming.js";

test("sanitizeFileToken removes quotes and unsafe characters", () => {
    assert.equal(sanitizeFileToken(`a'b"c`), "abc");
    assert.equal(sanitizeFileToken("a b/c:d"), "a_b_c_d");
    assert.equal(sanitizeFileToken("plain-name"), "plain-name");
});

test("createSelectionSlug normalizes selectors", () => {
    assert.equal(createSelectionSlug(null), "");
    assert.equal(createSelectionSlug("''"), "selected");
    assert.equal(createSelectionSlug("1, 3-5"), "1,_3-5");
    assert.equal(createSelectionSlug("a".repeat(80)).length, 60);
});

test("getLanguageFileCode maps known and unknown languages", () => {
    assert.equal(getLanguageFileCode("Chinese (Simplified)"), "zh");
    assert.equal(getLanguageFileCode("English"), "en");
    assert.equal(getLanguageFileCode("Japanese"), "ja");
    assert.equal(getLanguageFileCode("Klingon"), "klingon");
});
