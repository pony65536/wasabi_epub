import test from "node:test";
import assert from "node:assert/strict";

import {
    applyTranslatedHtmlToPdfJson,
    pdfJsonToHtml,
} from "../../src/pdf/pdfHtml.js";

const makePdfJson = () => ({
    version: 2,
    title: "Sample",
    blocks: [
        {
            id: "p1_b1",
            page: 1,
            text: "Hello world",
            role: "body",
            blockType: "text",
            bbox: [0, 0, 100, 10],
        },
        {
            id: "p1_b2",
            page: 1,
            text: "Section title",
            role: "heading",
            blockType: "heading",
            bbox: [0, 10, 100, 20],
        },
        {
            id: "p1_b3",
            page: 1,
            text: "Doi: 10.1000/example",
            role: "body",
            blockType: "reference_block",
            bbox: [0, 20, 100, 30],
        },
        {
            id: "p1_b4",
            page: 1,
            text: "Energy $E=mc^2$ is famous",
            role: "body",
            blockType: "text",
            bbox: [0, 30, 100, 40],
        },
    ],
});

test("pdfJsonToHtml tags translatable blocks and skips reference blocks", () => {
    const html = pdfJsonToHtml(makePdfJson());

    assert.match(html, /data-pdf-block-id="p1_b1"/);
    assert.match(html, /data-pdf-block-id="p1_b2"/);
    assert.doesNotMatch(html, /p1_b3/);
    assert.match(html, /WASABI_INLINE_FORMULA/);
    assert.doesNotMatch(html, /\$E=mc\^2\$/);
});

test("applyTranslatedHtmlToPdfJson maps text and restores formulas", () => {
    const pdfJson = makePdfJson();
    const html = pdfJsonToHtml(pdfJson);
    const translatedHtml = html
        .replace("Hello world", "Hola mundo")
        .replace("Section title", "Título");

    const applied = applyTranslatedHtmlToPdfJson(pdfJson, translatedHtml);
    const byId = new Map(
        applied.blocks.map((block) => [block.id, block]),
    );

    assert.equal(byId.get("p1_b1").translatedText, "Hola mundo");
    assert.equal(byId.get("p1_b2").translatedText, "Título");
    assert.equal(byId.get("p1_b3").translatedText, undefined);
    assert.match(byId.get("p1_b4").translatedText, /E=mc\^2/);
    assert.doesNotMatch(
        byId.get("p1_b4").translatedText,
        /WASABI_INLINE_FORMULA/,
    );
});

test("applyTranslatedHtmlToPdfJson ignores unknown block ids", () => {
    const pdfJson = makePdfJson();
    const translatedHtml =
        '<html><body><p data-pdf-block-id="missing">Unknown</p></body></html>';

    const applied = applyTranslatedHtmlToPdfJson(pdfJson, translatedHtml);

    assert.equal(applied.blocks.length, 4);
    assert.equal(applied.blocks[0].translatedText, undefined);
});
