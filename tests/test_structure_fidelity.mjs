import {
    encodeInlineTags,
    decodeInlineTagsDetailed,
    decodeInlineTags,
} from "../src/content/inlineSlots.js";
import { validateProtectedStructure } from "../src/translation/structureGuard.js";
import { createBatchQueue } from "../src/translation/batchQueue.js";
import { translateHtmlContent } from "../src/translation/translator.js";
import { splitLargeChapter } from "../src/epub/epubDoctor.js";
import { saveEpub } from "../src/epub/epubSaver.js";
import {
    buildLinkContext,
} from "../src/epub/linkRewriter.js";
import { synchronizeTocHtml } from "../src/epub/tocSync.js";
import { readPdfFillResult } from "../src/pdf/pdfBridge.js";
import { applyTranslatedHtmlToPdfJson } from "../src/pdf/pdfHtml.js";
import {
    parseSseCompletion,
    readCompletionContent,
} from "../src/translation/aiProvider.js";
import {
    extractAndFormatNotes,
    appendFootnotesSection,
    findMaxFootnoteIndex,
} from "../src/content/footnotes.js";
import { loadHtml, cleanAIResponse, callAIWithRetry } from "../src/utils.js";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";
import {
    SLOT_FIXTURES,
    buildChapterHtml,
    buildSyntheticEpub,
} from "./helpers/fixtures.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-structure-"));

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const logger = { write: () => {} };

const pushTask = (batchQueue, task) =>
    new Promise((resolve, reject) => {
        batchQueue.queue
            .push(task)
            .on("finish", (result) => resolve(result || null))
            .on("failed", (error) => reject(error));
    });

const run = async () => {
    console.log("=== 2.3 inlineSlots: no caps, full round-trip ===");
    const encoded = encodeInlineTags(SLOT_FIXTURES.thirtyFiveEms);
    assert(
        Object.keys(encoded.slotMap).length === 35,
        `all 35 ems must be encoded, got ${Object.keys(encoded.slotMap).length}`,
    );
    assert(encoded.incomplete === false, "encoding must not be incomplete");
    const decoded = decodeInlineTagsDetailed(
        encoded.encodedText,
        encoded.slotMap,
        encoded.slotTag,
    );
    assert(
        decoded.missingSlots.length === 0 &&
            decoded.unknownSlots.length === 0 &&
            decoded.duplicateSlots.length === 0 &&
            decoded.residualSlots === 0,
        `decode must be clean: ${JSON.stringify(decoded)}`,
    );
    assert(
        (decoded.html.match(/<em>/g) || []).length === 35 &&
            !decoded.html.includes("ws-slot"),
        "all 35 em tags must be restored with no residual slots",
    );

    const nested = encodeInlineTags(SLOT_FIXTURES.nested);
    const nestedDecoded = decodeInlineTagsDetailed(
        nested.encodedText,
        nested.slotMap,
        nested.slotTag,
    );
    assert(
        nestedDecoded.html === SLOT_FIXTURES.nested,
        `nested slot round-trip failed: ${nestedDecoded.html}`,
    );
    console.log("✅ 35 tags encode/decode fully; nesting preserved");

    console.log("\n=== 2.3 structure guard ===");
    const before =
        '<span id="anchor" class="meaningful">word</span> <a href="a.html" class="lnk">link</a>';
    const same =
        '<span id="anchor" class="meaningful">词</span> <a href="a.html" class="lnk">链接</a>';
    assert(
        validateProtectedStructure(before, same).ok,
        "text-only changes must pass",
    );
    const changedId =
        '<span id="other" class="meaningful">词</span> <a href="a.html" class="lnk">链接</a>';
    assert(
        !validateProtectedStructure(before, changedId).ok,
        "changed id must fail",
    );
    const changedHref =
        '<span id="anchor" class="meaningful">词</span> <a href="b.html" class="lnk">链接</a>';
    assert(
        !validateProtectedStructure(before, changedHref).ok,
        "changed href must fail",
    );
    const changedNesting =
        '<a href="a.html" class="lnk"><span id="anchor" class="meaningful">词</span></a>';
    assert(
        !validateProtectedStructure(before, changedNesting).ok,
        "changed nesting must fail",
    );
    const changedCount =
        '<span id="anchor" class="meaningful">词</span>';
    assert(
        !validateProtectedStructure(before, changedCount).ok,
        "dropped protected element must fail",
    );
    const spansBefore =
        '<span class="s1"><a href="a.html">A</a></span><span class="s2"><a href="b.html">B</a></span>';
    const spansSwapped =
        '<span class="s1"><a href="b.html">B</a></span><span class="s2"><a href="a.html">A</a></span>';
    assert(
        !validateProtectedStructure(spansBefore, spansSwapped).ok,
        "swapped links under different spans must fail",
    );
    const inlineBefore = "<em><strong>x</strong></em>";
    const inlineReversed = "<strong><em>x</em></strong>";
    assert(
        !validateProtectedStructure(inlineBefore, inlineReversed).ok,
        "attribute-less em/strong nesting reversal must fail",
    );
    assert(
        validateProtectedStructure(
            inlineBefore,
            "<em><strong>译文</strong></em>",
        ).ok,
        "text-only inline change must pass",
    );
    console.log("✅ protected attributes and nesting validated");

    console.log("\n=== 2.3 batchQueue preserves anchors through real queue ===");
    const echoProvider = {
        concurrency: 1,
        callAI: async (input) => input,
    };
    const queue = createBatchQueue(echoProvider, logger);
    const $doc = loadHtml(
        `<html><body><p data-t-id="node_0">A<span id="anchor" class="meaningful">word</span> tail</p></body></html>`,
    );
    const $targetParagraph = $doc("p");
    await pushTask(queue, {
        batch: [
            {
                id: "node_0",
                content: SLOT_FIXTURES.protectedAnchor,
            },
        ],
        $parent: $doc,
        processor: {
            attrName: "data-t-id",
            targetLanguage: "Chinese (Simplified)",
            prompt: "translate",
        },
    });
    const written = $targetParagraph.html();
    assert(
        written.includes('<span id="anchor" class="meaningful">word</span>'),
        `anchor and class must survive, got: ${written}`,
    );
    console.log("✅ anchor + class preserved through queue");

    console.log("\n=== 2.3 missing slot fails the batch ===");
    const missingSlotProvider = {
        concurrency: 1,
        callAI: async (input) =>
            String(input).replace(
                /<ws-slot id="1">word<\/ws-slot>/,
                "word",
            ),
    };
    const failQueue = createBatchQueue(missingSlotProvider, logger);
    const $failDoc = loadHtml(
        `<html><body><p data-t-id="node_0">A<span id="anchor">word</span> tail</p></body></html>`,
    );
    let failedMessage = "";
    try {
        await pushTask(failQueue, {
            batch: [
                { id: "node_0", content: SLOT_FIXTURES.protectedAnchor },
            ],
            $parent: $failDoc,
            processor: {
                attrName: "data-t-id",
                targetLanguage: "Chinese (Simplified)",
                prompt: "translate",
            },
        });
    } catch (error) {
        failedMessage = error.message;
    }
    assert(
        failedMessage.includes("slot integrity failed"),
        `missing slot must fail with slot integrity error, got: ${failedMessage}`,
    );
    console.log("✅ missing slot rejected instead of silently dropping");

    console.log("\n=== 2.3 protected attribute change fails the batch ===");
    const attrProvider = {
        concurrency: 1,
        callAI: async (input) =>
            String(input).replace(/src="a\.png"/, 'src="b.png"'),
    };
    const attrQueue = createBatchQueue(attrProvider, logger);
    const $attrDoc = loadHtml(
        `<html><body><p data-t-id="node_0">before <img src="a.png"/> after</p></body></html>`,
    );
    let attrFailed = "";
    try {
        await pushTask(attrQueue, {
            batch: [
                { id: "node_0", content: 'before <img src="a.png"/> after' },
            ],
            $parent: $attrDoc,
            processor: {
                attrName: "data-t-id",
                targetLanguage: "Chinese (Simplified)",
                prompt: "translate",
            },
        });
    } catch (error) {
        attrFailed = error.message;
    }
    assert(
        attrFailed.includes("protected structure changed"),
        `changed src must fail, got: ${attrFailed}`,
    );
    console.log("✅ protected attribute value change rejected");

    console.log("\n=== thinking/reasoning 输出剥离 ===");
    const THINK_OPEN = "<" + "thinking>";
    const THINK_CLOSE = "</" + "thinking" + ">";
    const withClosedThinking = cleanAIResponse(
        `${THINK_OPEN}secret reasoning${THINK_CLOSE}<node id="node_0">x</node>`,
    );
    assert(
        !withClosedThinking.includes("secret") &&
            withClosedThinking.includes('<node id="node_0">'),
        `closed thinking must be stripped: ${withClosedThinking}`,
    );
    const withTruncatedThinking = cleanAIResponse(
        `${THINK_OPEN}only reasoning without answer`,
    );
    assert(
        withTruncatedThinking === "" &&
            !withTruncatedThinking.includes("thinking"),
        "unclosed leading thinking must be stripped",
    );
    const withAttributedThinking = cleanAIResponse(
        `<think role="analysis">secret` +
            "</" +
            "think>" +
            `<node id="node_0">x</node>`,
    );
    assert(
        !withAttributedThinking.includes("secret") &&
            withAttributedThinking.includes('<node id="node_0">'),
        "thinking tag with attributes must be stripped",
    );
    const fencedThinking = cleanAIResponse(
        "```xml\n" +
            `${THINK_OPEN}secret${THINK_CLOSE}\n<node id="node_0">x</node>\n` +
            "```",
    );
    assert(
        fencedThinking.startsWith('<node id="node_0">') &&
            !fencedThinking.includes("secret"),
        "fenced thinking must be stripped",
    );
    // 只剥离答案最外层：正文/JSON 字符串里的字面推理标签必须保留
    const literalThinking = '{"improved":"keep <thinking> literal tag"}';
    assert(
        cleanAIResponse(literalThinking) === literalThinking,
        "literal thinking tags inside JSON must be preserved",
    );
    const inlineThinking = cleanAIResponse(
        `prefix ${THINK_OPEN}unfinished reasoning`,
    );
    assert(
        inlineThinking.includes("prefix") &&
            inlineThinking.includes(THINK_OPEN),
        "non-leading thinking content must be preserved",
    );
    const jsonFromThinking = await callAIWithRetry(
        {
            callAI: async () =>
                `${THINK_OPEN}let me think ${THINK_CLOSE}{"improved":"ok","hasSevereIssue":false}`,
        },
        "user",
        "system",
    );
    assert(
        jsonFromThinking.improved === "ok",
        "JSON parsing must succeed after thinking is stripped",
    );

    console.log("\n=== SSE / 截断响应判定 ===");
    assert(
        parseSseCompletion(
            'data: {"choices":[{"delta":{"reasoning":"only thoughts"}}]}\ndata: [DONE]',
        ) === "",
        "reasoning-only SSE must yield no content",
    );
    assert(
        parseSseCompletion(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\ndata: [DONE]',
        ) === "hello",
        "SSE content must be extracted",
    );
    let truncatedCode = null;
    try {
        readCompletionContent({
            choices: [{ finish_reason: "length", message: { content: "half" } }],
        });
    } catch (error) {
        truncatedCode = error.code;
    }
    assert(
        truncatedCode === "OUTPUT_TRUNCATED",
        "finish_reason=length must be rejected as truncated",
    );
    assert(
        readCompletionContent({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }) === "ok",
        "complete response must be returned",
    );
    let reasoningOnlyCode = null;
    try {
        readCompletionContent({
            choices: [
                {
                    finish_reason: "stop",
                    message: { content: "", reasoning_content: "thoughts" },
                },
            ],
        });
    } catch (error) {
        reasoningOnlyCode = error.code;
    }
    assert(
        reasoningOnlyCode === "EMPTY_CONTENT",
        "reasoning-only completion must be rejected",
    );
    const thinkingProvider = {
        concurrency: 1,
        callAI: async (input) => `${THINK_OPEN}reasoning text${THINK_CLOSE}${input}`,
    };
    const thinkingQueue = createBatchQueue(thinkingProvider, logger);
    const $thinkingDoc = loadHtml(
        `<html><body><p data-t-id="node_0">Hello</p></body></html>`,
    );
    await pushTask(thinkingQueue, {
        batch: [{ id: "node_0", content: "Hello" }],
        $parent: $thinkingDoc,
        processor: {
            attrName: "data-t-id",
            targetLanguage: "Chinese (Simplified)",
            prompt: "translate",
        },
    });
    assert(
        $thinkingDoc("p").html().includes("Hello"),
        "batch must succeed when response has a thinking prefix",
    );
    console.log("✅ thinking stripped for XML and JSON responses");

    console.log("\n=== 父子节点去重：不重叠、不互相替换 ===");
    const createRecordingQueue = (calls) => ({
        queue: {
            push(task) {
                calls.push(
                    task.batch.map((node) => ({
                        id: node.id,
                        content: node.content,
                    })),
                );
                const emitter = {
                    handlers: {},
                    on(event, handler) {
                        this.handlers[event] = handler;
                        return this;
                    },
                    emit(event, payload) {
                        if (this.handlers[event]) this.handlers[event](payload);
                    },
                };
                setImmediate(() => {
                    for (const node of task.batch) {
                        const $target = task.$parent(
                            `[${task.processor.attrName}="${node.id}"]`,
                        );
                        if ($target.length > 0) {
                            $target
                                .html(`[译]${node.content}`)
                                .removeAttr(task.processor.attrName);
                            const record = task.processor.planState?.get(
                                node.id,
                            );
                            if (record) record.state = "written";
                        }
                    }
                    emitter.emit("finish", {
                        writtenNodeIds: task.batch.map((node) => node.id),
                        alreadyWrittenNodeIds: [],
                        failedNodes: [],
                    });
                });
                return emitter;
            },
        },
        drainQueue: async () => {},
    });
    const translationConfig = {
        sourceLanguage: "English",
        targetLanguage: "Chinese (Simplified)",
    };
    const leafCalls = [];
    const leafResult = await translateHtmlContent(
        "<html><body><ul><li><p>Alpha paragraph text.</p></li></ul></body></html>",
        "Nested",
        {},
        translationConfig,
        null,
        createRecordingQueue(leafCalls),
        logger,
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        leafResult.status === "complete",
        `nested leaf selection must complete, got ${leafResult.status}`,
    );
    assert(
        leafCalls.length === 1 &&
            leafCalls[0].length === 1 &&
            leafCalls[0][0].content.includes("Alpha paragraph text."),
        `only the leaf <p> must be selected, got ${JSON.stringify(leafCalls)}`,
    );

    const outerCalls = [];
    const outerResult = await translateHtmlContent(
        "<html><body><ul><li>Outer intro text.<ul><li>Inner item text.</li></ul></li></ul></body></html>",
        "NestedList",
        {},
        translationConfig,
        null,
        createRecordingQueue(outerCalls),
        logger,
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        outerResult.status === "complete" &&
            outerCalls.length === 1 &&
            outerCalls[0].length === 1 &&
            outerCalls[0][0].content.includes("Outer intro text.") &&
            outerCalls[0][0].content.includes("Inner item text."),
        `outer list item with direct text must be selected once, got ${JSON.stringify(outerCalls)}`,
    );
    console.log("✅ parent/child selection deduplicated");

    console.log("\n=== strong 引言 + p 正文合并为单一单元 ===");
    const strongCalls = [];
    const strongResult = await translateHtmlContent(
        "<html><body><ul><li><strong>Intro line.</strong><p>Body paragraph text.</p></li></ul></body></html>",
        "StrongIntro",
        {},
        translationConfig,
        null,
        createRecordingQueue(strongCalls),
        logger,
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        strongResult.status === "complete" &&
            strongCalls.length === 1 &&
            strongCalls[0].length === 1 &&
            strongCalls[0][0].content.includes("Intro line.") &&
            strongCalls[0][0].content.includes("Body paragraph text."),
        `intro + body must share one unit, got ${JSON.stringify(strongCalls)}`,
    );
    console.log("✅ container with inline intro takes over descendants");

    console.log("\n=== 正文块结构保护（内层列表不得消失） ===");
    assert(
        !validateProtectedStructure(
            "<ul><li><p>A</p></li></ul>",
            "<ul><li>A</li></ul>",
        ).ok,
        "flattened inner list must be rejected",
    );
    assert(
        validateProtectedStructure(
            "<ul><li><p>A</p></li></ul>",
            "<ul><li><p>译文</p></li></ul>",
        ).ok,
        "same body structure with translated text must pass",
    );
    console.log("✅ body block structure validated");

    console.log("\n=== TARGET_MISSING 不计 written、不重试 ===");
    const missingQueue = createBatchQueue(
        { concurrency: 1, callAI: async (input) => input },
        logger,
    );
    const $missingDoc = loadHtml(
        `<html><body><p>source text</p></body></html>`,
    );
    const missingPlan = new Map([
        [
            "node_0",
            {
                id: "node_0",
                element: $missingDoc("p").get(0),
                state: "pending",
            },
        ],
    ]);
    const missingResult = await pushTask(missingQueue, {
        batch: [{ id: "node_0", content: "source text" }],
        $parent: $missingDoc,
        processor: {
            attrName: "data-t-id",
            planState: missingPlan,
            targetLanguage: "Chinese (Simplified)",
            prompt: "translate",
        },
    });
    assert(
        missingResult?.failedNodes?.some(
            (failure) =>
                failure.id === "node_0" &&
                failure.code === "TARGET_MISSING" &&
                failure.retryable === false,
        ),
        `missing target must be a structural failure, got ${JSON.stringify(missingResult)}`,
    );
    assert(
        missingPlan.get("node_0").state === "pending",
        "TARGET_MISSING must not be recorded as written",
    );
    console.log("✅ missing target recorded as structural failure");

    console.log("\n=== 写回目标被祖先覆盖时跳过而非重试 ===");
    const supersededQueue = createBatchQueue(
        { concurrency: 1, callAI: async (input) => input },
        logger,
    );
    const $supersededDoc = loadHtml(
        `<html><body><div data-t-id="node_0"><span data-t-id="node_1">inner</span></div></body></html>`,
    );
    const supersededResult = await pushTask(supersededQueue, {
        batch: [
            { id: "node_0", content: "outer content" },
            { id: "node_1", content: "inner content" },
        ],
        $parent: $supersededDoc,
        processor: {
            attrName: "data-t-id",
            targetLanguage: "Chinese (Simplified)",
            prompt: "translate",
        },
    });
    assert(
        $supersededDoc("div").html().includes("outer content"),
        "ancestor write-back must win",
    );
    assert(
        supersededResult?.failedNodes?.some(
            (failure) =>
                failure.id === "node_1" &&
                failure.code === "TARGET_MISSING",
        ),
        "superseded child target must be recorded as structural failure",
    );
    console.log("✅ superseded target recorded, not silently skipped");

    // 兼容包装仍返回字符串
    assert(
        typeof decodeInlineTags(
            encoded.encodedText,
            encoded.slotMap,
            encoded.slotTag,
        ) === "string",
        "decodeInlineTags compatibility wrapper must return a string",
    );

    console.log("\n=== 2.4 epubDoctor preserves document shell and direct text ===");
    const bigHtml = buildChapterHtml({
        htmlAttrs: {
            lang: "en",
            "xmlns:epub": "http://www.idpf.org/2007/ops",
        },
        bodyAttrs: { class: "book", id: "main-body" },
        bodyContent: [
            "DIRECT-START",
            "<p>CHAPTER 1 Start</p>",
            "<p>Some paragraph content.</p>",
            "DIRECT-END",
        ].join("\n"),
    });
    const split = splitLargeChapter(
        {
            id: "big",
            entryName: "OEBPS/big.html",
            title: "Big",
            html: bigHtml,
        },
        1,
        {},
    );
    assert(split?.parts?.length === 2, "chapter must split into 2 parts");
    assert(
        split.parts[0].html.includes('lang="en"') &&
            split.parts[0].html.includes('xmlns:epub=') &&
            split.parts[0].html.includes('class="book"') &&
            split.parts[0].html.includes('id="main-body"'),
        "first part must keep html/body attributes including body id",
    );
    assert(
        split.parts[1].html.includes('class="book"') &&
            !split.parts[1].html.includes('id="main-body"'),
        "later parts keep body class but not the body id",
    );
    assert(
        split.parts[0].html.includes("DIRECT-START") &&
            split.parts[1].html.includes("DIRECT-END"),
        "direct body text must be preserved in order",
    );
    console.log("✅ document shell, body attributes and direct text preserved");

    console.log("\n=== 2.4 epubSaver inherits itemref semantics ===");
    const zip = buildSyntheticEpub({
        chapters: [
            {
                id: "big",
                href: "big.html",
                html: "<html><body><p>x</p></body></html>",
            },
        ],
        itemrefs: {
            big: '<itemref id="ir-big" idref="big" linear="no"/>',
        },
    });
    const splitMap = new Map([
        [
            "big_part_1",
            {
                id: "big_part_1",
                entryName: "OEBPS/big_p1.html",
                html: "<html><body><p>1</p></body></html>",
                isGeneratedSplit: true,
            },
        ],
        [
            "big_part_2",
            {
                id: "big_part_2",
                entryName: "OEBPS/big_p2.html",
                html: "<html><body><p>2</p></body></html>",
                isGeneratedSplit: true,
            },
        ],
    ]);
    const outputPath = path.join(tmpDir, "saver.epub");
    await saveEpub(zip, splitMap, null, null, outputPath, logger, {
        replaced: [
            {
                id: "big",
                entryName: "OEBPS/big.html",
                partIds: ["big_part_1", "big_part_2"],
            },
        ],
    });
    const outZip = new AdmZip(outputPath);
    const opfEntry = outZip
        .getEntries()
        .find((entry) => entry.entryName.endsWith(".opf"));
    const opfXml = opfEntry.getData().toString("utf8");
    const $opf = loadHtml(opfXml);
    const partItemrefs = $opf("spine itemref").toArray().filter((node) =>
        ["big_part_1", "big_part_2"].includes($opf(node).attr("idref")),
    );
    assert(partItemrefs.length === 2, "both split itemrefs must exist");
    for (const node of partItemrefs) {
        assert(
            $opf(node).attr("linear") === "no",
            "linear must be inherited by split itemrefs",
        );
        assert(
            $opf(node).attr("id") == null,
            "original itemref id must not be duplicated",
        );
    }
    assert(
        !outZip
            .getEntries()
            .some((entry) => entry.entryName === "OEBPS/big.html"),
        "replaced original entry must be removed",
    );
    console.log("✅ split itemrefs inherit linear without duplicating id");

    console.log("\n=== 2.4 HTML TOC sync scoped to TOC container (EPUB2) ===");
    const tocChapter = {
        id: "toc",
        href: "toc.html",
        entryName: "OEBPS/toc.html",
        html: `<html><body><div id="other-links"><a href="toc.html#x">Outside Link</a></div><nav epub:type="toc"><a href="dest.html">old label</a></nav></body></html>`,
    };
    const destChapter = {
        id: "dest",
        href: "dest.html",
        entryName: "OEBPS/dest.html",
        html: "<html><body><h1>Dest Title</h1></body></html>",
    };
    const tocMap = new Map([
        ["toc", tocChapter],
        ["dest", destChapter],
    ]);
    const tocResult = await synchronizeTocHtml(
        tocMap,
        "toc",
        buildLinkContext(tocMap),
    );
    assert(tocResult.ok, "TOC sync must report ok");
    assert(
        tocResult.stats.mode === "explicit" &&
            tocResult.stats.changed === 1,
        `expected one scoped change, got ${JSON.stringify(tocResult.stats)}`,
    );
    const $tocAfter = loadHtml(tocChapter.html);
    assert(
        $tocAfter("nav a").text() === "Dest Title",
        "TOC container link must be updated",
    );
    assert(
        $tocAfter("#other-links a").text() === "Outside Link",
        "links outside the TOC container must not be touched",
    );
    console.log("✅ TOC sync scoped; outside links untouched");

    console.log("\n=== 2.5 footnotes are idempotent with stable ids ===");
    const noteHtml =
        '<p>Text with note <ws-note term="foo &amp; bar">explanation</ws-note>.</p>';
    const firstNotes = [];
    const firstPass = extractAndFormatNotes(
        noteHtml,
        firstNotes,
        "chapter-1",
    );
    assert(
        firstPass.includes('id="noteref-chapter-1-1"') &&
            firstNotes.length === 1,
        "first note must be numbered 1 with stable chapter id",
    );
    const chapterShell = `<html><body>${firstPass}</body></html>`;
    const firstAssembly = appendFootnotesSection(chapterShell, firstNotes);
    const secondAssembly = appendFootnotesSection(
        firstAssembly,
        firstNotes,
    );
    assert(
        secondAssembly === firstAssembly,
        "re-appending the same notes must be a no-op (idempotent)",
    );
    const $assembled = loadHtml(secondAssembly);
    assert(
        $assembled('aside[id^="note-chapter-1-"]').length === 1,
        "exactly one footnote aside must exist",
    );
    assert(
        secondAssembly.includes("foo &amp; bar") &&
            !secondAssembly.includes("<script>"),
        "term must be HTML-escaped",
    );

    const resumedHtml = `<html><body>
<p>Already translated <sup><a id="noteref-chapter-1-1" href="#note-chapter-1-1" epub:type="noteref" class="footnote-ref">[注1]</a></sup>.</p>
<p>New note <ws-note term="baz">second explanation</ws-note>.</p>
<section epub:type="footnotes" class="footnotes-section"><hr class="footnote-divider"/>
  <aside id="note-chapter-1-1" epub:type="footnote" class="footnote-body"><p><a href="#noteref-chapter-1-1">[注1]</a> old</p></aside>
</section></body></html>`;
    const startIndex = findMaxFootnoteIndex(resumedHtml);
    assert(startIndex === 1, `resume startIndex must be 1, got ${startIndex}`);
    const resumedNotes = [];
    const resumedBody = extractAndFormatNotes(
        '<p>New note <ws-note term="baz">second explanation</ws-note>.</p>',
        resumedNotes,
        "chapter-1",
        { startIndex },
    );
    assert(
        resumedNotes.length === 1 && resumedNotes[0].index === 2,
        "resumed note must continue numbering at 2",
    );
    const resumedAssembled = appendFootnotesSection(
        resumedHtml.replace(
            /<p>New note <ws-note term="baz">second explanation<\/ws-note>\.<\/p>/,
            resumedBody,
        ),
        resumedNotes,
    );
    const $resumed = loadHtml(resumedAssembled);
    const noteIds = $resumed('aside[epub\\:type="footnote"]')
        .toArray()
        .map((node) => $resumed(node).attr("id"));
    assert(
        noteIds.length === 2 &&
            new Set(noteIds).size === 2 &&
            noteIds.includes("note-chapter-1-2"),
        `resumed footnotes must be unique, got ${JSON.stringify(noteIds)}`,
    );
    console.log("✅ footnotes idempotent; resume continues numbering");

    console.log("\n=== 2.7 PDF fill result protocol ===");
    const pdfResultPath = path.join(tmpDir, "pdf_fill_result.json");
    fs.writeFileSync(
        pdfResultPath,
        JSON.stringify({
            protocolVersion: 1,
            requestedOutputPath: "out.pdf",
            actualOutputPath: "out_20260101.pdf",
            usedFallback: true,
        }),
        "utf8",
    );
    const parsedResult = readPdfFillResult(pdfResultPath, "out.pdf");
    assert(
        parsedResult.outputPath === "out_20260101.pdf" &&
            parsedResult.usedFallback === true &&
            parsedResult.protocol === "v1",
        "valid result json must be used",
    );

    let missingThrown = false;
    try {
        readPdfFillResult(path.join(tmpDir, "missing_result.json"), "out.pdf");
    } catch (error) {
        missingThrown = /result file missing/.test(error.message);
    }
    assert(missingThrown, "missing result file must fail explicitly");

    const corruptPath = path.join(tmpDir, "corrupt_result.json");
    fs.writeFileSync(corruptPath, "{not json", "utf8");
    let corruptThrown = false;
    try {
        readPdfFillResult(corruptPath, "out.pdf");
    } catch (error) {
        corruptThrown = /corrupt/.test(error.message);
    }
    assert(corruptThrown, "corrupt result file must fail explicitly");

    const legacy = readPdfFillResult(null, "out.pdf");
    assert(
        legacy.protocol === "legacy" && legacy.outputPath === "out.pdf",
        "legacy protocol only when no result path is requested",
    );
    console.log("✅ PDF result protocol: v1 used, missing/corrupt rejected");

    console.log("\n=== 3.x PDF HTML→JSON mapping report ===");
    const pdfJson = {
        blocks: [
            { id: "b1", text: "hello" },
            { id: "b2", text: "missing from html" },
            { id: "b3", text: "preserved", preserveOriginal: true },
        ],
    };
    const translatedHtml = `<html><body>
<p data-pdf-block-id="b1">译文</p>
<p data-pdf-block-id="b1">重复块</p>
<p data-pdf-block-id="b9">未知块</p>
</body></html>`;
    const mapped = applyTranslatedHtmlToPdfJson(pdfJson, translatedHtml);
    const report = mapped.translationReport;
    assert(
        report.matchedBlocks === 2 &&
            report.duplicateBlockIds.includes("b1") &&
            report.unknownBlockIds.includes("b9") &&
            report.missingBlockIds.includes("b2") &&
            !report.missingBlockIds.includes("b3"),
        `mapping report incorrect: ${JSON.stringify(report)}`,
    );
    console.log("✅ mapping report lists missing/unknown/duplicate");

    console.log("\nAll structure-fidelity audits passed.");
};

run().catch((error) => {
    console.error(`\n❌ STRUCTURE FIDELITY AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
