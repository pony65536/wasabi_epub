import test from "node:test";
import assert from "node:assert/strict";

import {
    applyTranslatedHtmlToSubtitleJson,
    buildSubtitleJson,
    parseSrt,
    serializeSrt,
    subtitleJsonToHtml,
} from "../../src/subtitle/srt.js";

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:02,500
Hello <world> & "friends"

2
00:00:03,000 --> 00:00:04,000 X1:10 X2:20
Second line
continues
`;

test("parseSrt extracts cues, settings, and multi-line text", () => {
    const cues = parseSrt(SAMPLE_SRT);

    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0], {
        id: "node_00001",
        sequence: 1,
        cueIdentifier: null,
        start: "00:00:01,000",
        end: "00:00:02,500",
        settings: "",
        sourceText: 'Hello <world> & "friends"',
        translatedText: "",
    });
    assert.equal(cues[1].settings, "X1:10 X2:20");
    assert.equal(cues[1].sourceText, "Second line\ncontinues");
});

test("subtitle round-trip preserves timing and applies translations", () => {
    const subtitleJson = buildSubtitleJson({
        sourceFile: "sample.srt",
        sourceType: "srt",
        sourceLanguage: "English",
        targetLanguage: "Chinese (Simplified)",
        cues: parseSrt(SAMPLE_SRT),
    });

    const html = subtitleJsonToHtml(subtitleJson);
    assert.match(html, /data-subtitle-id="node_00001"/);
    assert.match(html, /Hello &lt;world&gt; &amp; &quot;friends&quot;/);

    const translatedHtml = html.replace(
        "Hello &lt;world&gt; &amp; &quot;friends&quot;",
        "你好，世界",
    );
    const applied = applyTranslatedHtmlToSubtitleJson(
        subtitleJson,
        translatedHtml,
    );

    assert.equal(applied.cues[0].translatedText, "你好，世界");
    assert.equal(applied.cues[1].translatedText, "Second line\ncontinues");

    const serialized = serializeSrt(applied);
    assert.match(serialized, /00:00:01,000 --> 00:00:02,500/);
    assert.match(serialized, /00:00:03,000 --> 00:00:04,000 X1:10 X2:20/);
    assert.match(serialized, /你好，世界/);

    const sourceOnly = serializeSrt(applied, { preferTranslated: false });
    assert.match(sourceOnly, /Hello <world> & "friends"/);
});

test("parseSrt rejects malformed cues", () => {
    assert.throws(
        () => parseSrt("1\nnot a time range\nbody"),
        /Invalid SRT time range/,
    );
});
