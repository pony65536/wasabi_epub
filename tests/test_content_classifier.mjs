import { classifyTextNode } from "../src/content/content-classifier.js";
import {
    computeCoverageAudit,
} from "../src/translation/coverage.js";
import { translateHtmlContent } from "../src/translation/translator.js";
import { MIXED_LANGUAGE_HTML } from "./helpers/fixtures.mjs";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

class FakeEmitter {
    on(event, handler) {
        this[event] = handler;
        return this;
    }
    emit(event, payload) {
        if (this[event]) this[event](payload);
    }
}

const createEchoQueue = () => ({
    queue: {
        push(task) {
            const emitter = new FakeEmitter();
            setImmediate(() => {
                for (const node of task.batch) {
                    const $target = task.$parent(
                        `[${task.processor.attrName}="${node.id}"]`,
                    );
                    $target
                        .html(`[译]${node.content}`)
                        .removeAttr(task.processor.attrName);
                    const record = task.processor.planState?.get(node.id);
                    if (record) record.state = "written";
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

const run = async () => {
    console.log("=== 2.2 Unicode classification ===");
    const cases = [
        ["这是一段中文正文，需要翻译。", "KEEP"],
        ["これは日本語の文章です。", "KEEP"],
        ["Это русский текст для перевода.", "KEEP"],
        ["A normal English sentence.", "KEEP"],
        ["1,234.56", "KEEP"],
        ["= ∫ x^2 dx", "SKIP"],
        ["图 1 系统架构", "KEEP"],
    ];
    for (const [text, expected] of cases) {
        const result = classifyTextNode(text);
        assert(
            result.action === expected,
            `classify("${text.slice(0, 12)}") expected ${expected}, got ${result.action}/${result.reason}`,
        );
    }

    const broken = classifyTextNode(
        "This paragraph has one broken character � but is otherwise readable English text.",
    );
    assert(
        broken.action === "KEEP" && broken.uncertain === true,
        `replacement char long text must KEEP+uncertain, got ${broken.action}/${broken.reason}`,
    );
    const shortBroken = classifyTextNode("��");
    assert(
        shortBroken.action === "DROP",
        "short replacement-only text may be dropped",
    );
    console.log("✅ Unicode-aware classification");

    console.log("\n=== 3.x action/decision 口径一致 ===");
    assert(
        classifyTextNode("Hello world").decision === "translate" &&
            classifyTextNode("= ∫ x^2 dx").decision === "preserve",
        "decision must map action to translate/preserve",
    );
    assert(
        classifyTextNode(
            "One broken char � but plenty of readable letters here.",
        ).decision === "uncertain",
        "replacement-char keep must be uncertain",
    );
    console.log("✅ decision field matches action semantics");

    console.log("\n=== 2.2 coverage audit ===");
    const gapAudit = computeCoverageAudit({
        selectedUnits: [{ id: "n1", content: "hello world" }],
        preservedUnits: [
            { id: "n2", text: "这是一段被误判的中文正文", reason: "mostly_symbols" },
            { id: "n3", text: "1,234", reason: "numeric_only" },
        ],
    });
    assert(
        gapAudit.gaps.length === 1 && gapAudit.gaps[0].id === "n2",
        `expected one suspicious gap, got ${JSON.stringify(gapAudit.gaps)}`,
    );
    const cleanAudit = computeCoverageAudit({
        selectedUnits: [{ id: "n1", content: "hello" }],
        preservedUnits: [
            { id: "n2", text: "1,234", reason: "numeric_only" },
            { id: "n3", text: "x = y", reason: "formula_like_text" },
        ],
    });
    assert(cleanAudit.gaps.length === 0, "intentional preserves are not gaps");
    const candidateAudit = computeCoverageAudit({
        selectedUnits: [{ id: "n1", content: "english only" }],
        preservedUnits: [],
        candidateUnits: [
            { id: "n1", text: "english only" },
            {
                id: "div1",
                text: "未被枚举的 div 正文内容，应该被审计发现。",
            },
        ],
    });
    assert(
        candidateAudit.gaps.length === 1 &&
            candidateAudit.gaps[0].reason === "not_selected",
        `uncovered candidate text must be a gap, got ${JSON.stringify(candidateAudit.gaps)}`,
    );
    console.log("✅ coverage gaps distinguish suspicious from intentional");

    console.log("\n=== 2.2 mixed-language chapter translates all scripts ===");
    const result = await translateHtmlContent(
        MIXED_LANGUAGE_HTML,
        "Mixed",
        {},
        translationConfig,
        null,
        createEchoQueue(),
        { write: () => {} },
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        result.status === "complete",
        `mixed-language chapter must complete, got ${result.status}`,
    );
    assert(
        result.totalNodes >= 4,
        `all paragraphs must be selected, got ${result.totalNodes}`,
    );
    assert(
        result.coverage?.gaps?.length === 0,
        "no coverage gaps expected after Unicode fix",
    );
    assert(
        result.html.includes("[译]这是一段中文正文") &&
            result.html.includes("[译]Это русский текст"),
        "CJK/Cyrillic paragraphs must be translated",
    );
    console.log("✅ CJK/Cyrillic paragraphs selected and translated");

    console.log("\n=== 2.2 selected>0 but missed content must not complete ===");
    const missed = await translateHtmlContent(
        MIXED_LANGUAGE_HTML,
        "Mixed",
        {},
        translationConfig,
        null,
        createEchoQueue(),
        { write: () => {} },
        new Set(),
        new Set(),
        "epub",
        false,
        { coverageGaps: [] },
    );
    assert(missed.status === "complete", "sanity: normal case complete");
    const injected = computeCoverageAudit({
        selectedUnits: [{ id: "n1", content: "english only" }],
        preservedUnits: [
            { id: "n2", text: "另一段应翻未翻的正文", reason: "isolated_fragment" },
        ],
        failedNodeIds: [],
    });
    assert(
        injected.gaps.length === 1,
        "selected>0 with suspicious preserved content must report a gap",
    );
    console.log("✅ selected>0 with missed content is detected as gap");

    console.log("\n=== 2.2 zero-node branch must not report complete ===");
    const divOnlyResult = await translateHtmlContent(
        "<html><body><div>这是一段放在 div 里的正文，应该被审计发现并翻译。</div></body></html>",
        "DivOnly",
        {},
        translationConfig,
        null,
        createEchoQueue(),
        { write: () => {} },
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        divOnlyResult.status === "failed",
        `unprocessed div text must not complete, got ${divOnlyResult.status}`,
    );
    assert(
        divOnlyResult.coverage?.gaps?.length >= 1,
        "zero-node branch must report coverage gaps",
    );
    console.log("✅ zero-node branch audited via visible-text candidates");

    console.log("\n=== 2.2 same text must not mask extra untranslated content ===");
    const sameTextResult = await translateHtmlContent(
        "<html><body><p>Same sentence.</p><div>Same sentence. Extra unselected body text with enough letters.</div></body></html>",
        "SameText",
        {},
        translationConfig,
        null,
        createEchoQueue(),
        { write: () => {} },
        new Set(),
        new Set(),
        "epub",
        false,
        {},
    );
    assert(
        sameTextResult.status === "partial",
        `duplicated text with extra content must not complete, got ${sameTextResult.status}`,
    );
    assert(
        sameTextResult.coverage?.gaps?.length >= 1,
        "extra unselected text must be reported as a gap",
    );
    console.log("✅ same-text div does not mask the uncovered extra text");

    console.log("\nAll content-classifier audits passed.");
};

run().catch((error) => {
    console.error(`\n❌ CONTENT CLASSIFIER AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
