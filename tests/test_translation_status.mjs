import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createProgressCache } from "../src/support/cache.js";
import {
    buildTaskSignature,
    computePromptDigest,
} from "../src/support/taskIdentity.js";
import {
    aggregateTranslationResults,
    mergeTranslationReports,
    performTranslation,
    translateHtmlContent,
} from "../src/translation/translator.js";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-status-audit-"));
const logger = { write: () => {}, remove: () => {} };

class FakeEmitter {
    on(event, handler) {
        this[event] = handler;
        return this;
    }
    emit(event, payload) {
        if (this[event]) this[event](payload);
    }
}

const createStubQueue = (shouldFailBatch = () => false, calls = null) => ({
    queue: {
        push(task) {
            if (calls) {
                calls.push(task.batch.map((node) => node.content));
            }
            const emitter = new FakeEmitter();
            setImmediate(() => {
                try {
                    if (shouldFailBatch(task.batch)) {
                        emitter.emit("failed", new Error("simulated batch failure"));
                        return;
                    }
                    for (const node of task.batch) {
                        const $target = task.$parent(
                            `[${task.processor.attrName}="${node.id}"]`,
                        );
                        if ($target.length === 0) {
                            emitter.emit(
                                "failed",
                                new Error(`missing node ${node.id}`),
                            );
                            return;
                        }
                        $target
                            .html(`[译]${node.content}`)
                            .removeAttr(task.processor.attrName);
                    }
                    emitter.emit("finish");
                } catch (error) {
                    emitter.emit("failed", error);
                }
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

const buildHtml = () => `<html><body>
<p>Alpha paragraph.</p>
<p>Beta paragraph.</p>
<p>Gamma paragraph.</p>
</body></html>`;

const buildTwoBatchHtml = () => `<html><body>
<p>Alpha ${"a".repeat(3000)}</p>
<p>Beta ${"b".repeat(3000)}</p>
</body></html>`;

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const runTranslation = (cache, chapterMap, queue, mode = "html") =>
    performTranslation(
        [...chapterMap.values()],
        chapterMap,
        {},
        translationConfig,
        null,
        queue,
        logger,
        cache,
        new Set(),
        new Set(),
        mode,
        false,
    );

const run = async () => {
    console.log("=== Fix 1: all requests fail => status failed, not complete ===");
    const failCache = createProgressCache(path.join(tmpDir, "cache-all-fail"));
    const failMap = new Map([
        ["document", { id: "document", html: buildHtml(), title: "Doc" }],
    ]);
    const failReport = await runTranslation(
        failCache,
        failMap,
        createStubQueue(() => true),
    );
    assert(
        failReport.status === "failed",
        `all-fail must be failed, got ${failReport.status}`,
    );
    assert(
        failReport.failedChapters.length === 1 &&
            failReport.failedChapters[0].failedNodeIds.length === 3,
        "all 3 nodes must be reported failed",
    );
    assert(
        failCache.loadChapterStatus().document?.status === "failed",
        "chapter status must be failed",
    );
    const failCachedHtml = failCache.load("document");
    assert(
        failCachedHtml.includes("data-t-id"),
        "failed cache must keep failure markers",
    );
    assert(
        !failMap.get("document").html.includes("data-t-id"),
        "output html must be stripped of markers",
    );
    assert(
        !failMap.get("document").html.includes("[译]"),
        "nothing should be translated on all-fail run",
    );
    console.log("✅ all-fail => failed, markers kept in cache only");

    console.log("\n=== Fix 2: failed cache is resumed, not skipped ===");
    const resumeFromFailed = await runTranslation(
        failCache,
        failMap,
        createStubQueue(() => false),
    );
    assert(
        resumeFromFailed.status === "complete",
        `resume from failed must complete, got ${resumeFromFailed.status}`,
    );
    const resumedHtml = failCache.load("document");
    assert(
        !resumedHtml.includes("data-t-id") &&
            resumedHtml.includes("[译]Alpha paragraph."),
        "resume must translate marked nodes and clear markers",
    );
    assert(
        failCache.loadChapterStatus().document?.status === "complete",
        "status must become complete after resume",
    );
    console.log("✅ failed cache resumed and completed");

    console.log("\n=== Fix 1: partial success is partial, not failed ===");
    const partialCache = createProgressCache(path.join(tmpDir, "cache-partial"));
    const partialMap = new Map([
        ["document", { id: "document", html: buildTwoBatchHtml(), title: "Doc" }],
    ]);
    const partialReport = await runTranslation(
        partialCache,
        partialMap,
        createStubQueue((batch) =>
            batch.some((node) => node.content.includes("Beta")),
        ),
    );
    assert(
        partialReport.status === "partial",
        `partial success must be partial, got ${partialReport.status}`,
    );
    assert(
        partialReport.partialChapters.length === 1 &&
            partialReport.partialChapters[0].failedNodeIds.length === 1,
        "exactly one node must be reported failed",
    );
    const partialHtml = partialCache.load("document");
    assert(
        partialHtml.includes("[译]Alpha") &&
            partialHtml.includes("data-t-id") &&
            !partialHtml.includes("[译]Beta"),
        "partial cache must contain translated Alpha and marked Beta",
    );
    console.log("✅ partial success => partial with precise failed node list");

    console.log("\n=== Fix 2: unverified/stale complete cache is not trusted ===");
    const staleCache = createProgressCache(path.join(tmpDir, "cache-stale"));
    staleCache.save(
        "document",
        '<html><body><p data-t-id="node_0">Stale source.</p></body></html>',
    );
    staleCache.saveChapterStatus({
        document: { status: "complete", failedNodeIds: [], updatedAt: "x" },
    });
    const staleMap = new Map([
        ["document", { id: "document", html: buildHtml(), title: "Doc" }],
    ]);
    const staleReport = await runTranslation(
        staleCache,
        staleMap,
        createStubQueue(() => false),
    );
    assert(
        staleReport.status === "complete",
        "stale cache must be resumed and completed",
    );
    const staleHtml = staleCache.load("document");
    assert(
        staleHtml.includes("[译]Stale source.") &&
            !staleHtml.includes("data-t-id"),
        "stale marked node must be retranslated",
    );
    console.log("✅ complete+markers cache is resumed instead of skipped");

    console.log("\n=== Fix 2: verified complete cache is reused without requests ===");
    const reuseCache = createProgressCache(path.join(tmpDir, "cache-reuse"));
    const reuseMap = new Map([
        ["document", { id: "document", html: buildHtml(), title: "Doc" }],
    ]);
    await runTranslation(reuseCache, reuseMap, createStubQueue(() => false));
    const reuseReport = await runTranslation(
        reuseCache,
        reuseMap,
        createStubQueue(() => {
            throw new Error("queue must not be used for verified cache");
        }),
    );
    assert(reuseReport.status === "complete", "verified cache must be reused");
    console.log("✅ verified complete cache reused without queue calls");

    console.log("\n=== 2.6 cached success joins result aggregation ===");
    const mixedCache = createProgressCache(path.join(tmpDir, "cache-mixed"));
    const cachedDoc = { id: "doc_cached", html: buildHtml(), title: "Cached" };
    await runTranslation(
        mixedCache,
        new Map([[cachedDoc.id, cachedDoc]]),
        createStubQueue(() => false),
    );
    const failingDoc = {
        id: "doc_fail",
        html: buildHtml(),
        title: "Failing",
    };
    const mixedMap = new Map([
        [cachedDoc.id, { ...cachedDoc, html: buildHtml() }],
        [failingDoc.id, failingDoc],
    ]);
    const mixedReport = await runTranslation(
        mixedCache,
        mixedMap,
        createStubQueue(() => true),
    );
    assert(
        mixedReport.status === "partial",
        `cached success + failing chapter must be partial, got ${mixedReport.status}`,
    );
    assert(
        mixedReport.chapters.length === 2 &&
            mixedReport.chapters.some((item) => item.cached === true),
        "cached chapter must appear in aggregation results",
    );
    console.log("✅ cached success included in reducer/counts");

    console.log("\n=== 2.6 coverage gaps survive resume ===");
    const gapCache = createProgressCache(path.join(tmpDir, "cache-gap-resume"));
    const gapHtml = `<html><body><p>Alpha paragraph with enough readable text.</p><div>This div body text must not be silently skipped during resume.</div></body></html>`;
    const gapMap = new Map([
        ["doc", { id: "doc", html: gapHtml, title: "Doc" }],
    ]);
    const firstGapRun = await runTranslation(
        gapCache,
        gapMap,
        createStubQueue(() => true),
        "epub",
    );
    assert(
        firstGapRun.status === "failed",
        `all-fail with gap must be failed, got ${firstGapRun.status}`,
    );
    const firstGaps = gapCache.loadChapterStatus().doc?.coverage?.gaps || [];
    assert(
        firstGaps.some((gap) => gap.reason === "not_selected"),
        "first run must record the not_selected gap",
    );
    const resumeGapRun = await runTranslation(
        gapCache,
        gapMap,
        createStubQueue(() => false),
        "epub",
    );
    assert(
        resumeGapRun.status === "partial",
        `resume must keep the coverage gap, got ${resumeGapRun.status}`,
    );
    assert(
        (resumeGapRun.chapters[0]?.coverage?.gaps?.length ?? 0) >= 1,
        "resumed chapter must still report the coverage gap",
    );
    console.log("✅ coverage gap re-checked and retained on resume");

    console.log(
        "\n=== 2.6 partial -> resume failed node -> complete (no false gaps) ===",
    );
    const partialResumeCache = createProgressCache(
        path.join(tmpDir, "cache-partial-resume"),
    );
    const partialResumeMap = new Map([
        ["doc", { id: "doc", html: buildTwoBatchHtml(), title: "Doc" }],
    ]);
    const firstPartialRun = await runTranslation(
        partialResumeCache,
        partialResumeMap,
        createStubQueue((batch) =>
            batch.some((node) => node.content.includes("Beta")),
        ),
        "epub",
    );
    assert(
        firstPartialRun.status === "partial",
        `first run must be partial, got ${firstPartialRun.status}`,
    );
    assert(
        (firstPartialRun.partialChapters[0]?.failedNodeIds?.length ?? 0) === 1,
        "exactly one failed node expected",
    );
    assert(
        (firstPartialRun.partialChapters[0]?.coverage?.gaps?.length ?? 0) === 0,
        "first partial run must not report false gaps",
    );
    const resumeCalls = [];
    const resumedRun = await runTranslation(
        partialResumeCache,
        partialResumeMap,
        createStubQueue(() => false, resumeCalls),
        "epub",
    );
    assert(
        resumeCalls.length === 1,
        `resume must send exactly one batch (only the failed node), got ${resumeCalls.length}`,
    );
    assert(
        resumeCalls[0].some((content) => content.includes("Beta")) &&
            !resumeCalls[0].some((content) => content.includes("Alpha")),
        "resume must not re-send already translated nodes",
    );
    assert(
        resumedRun.status === "complete",
        `resume must complete, got ${resumedRun.status} gaps=${JSON.stringify(resumedRun.chapters[0]?.coverage?.gaps || [])}`,
    );
    assert(
        (resumedRun.chapters[0]?.coverage?.gaps?.length ?? 0) === 0,
        "previously translated nodes must not be reported as not_selected gaps",
    );
    assert(
        partialResumeCache.loadChapterStatus().doc?.status === "complete",
        "chapter status must be complete after resume",
    );
    console.log("✅ partial → resume failed node → complete without false gaps");

    console.log(
        "\n=== Cache boundary: non-complete status without markers => retranslate source ===",
    );
    for (const badStatus of ["failed", "partial", "missing"]) {
        const boundaryCache = createProgressCache(
            path.join(tmpDir, `cache-boundary-${badStatus}`),
        );
        boundaryCache.save(
            "document",
            "<html><body><p>Untranslated source text.</p></body></html>",
        );
        if (badStatus !== "missing") {
            boundaryCache.saveChapterStatus({
                document: {
                    status: badStatus,
                    failedNodeIds: [],
                    updatedAt: "x",
                },
            });
        }
        const boundaryMap = new Map([
            ["document", { id: "document", html: buildHtml(), title: "Doc" }],
        ]);
        const countingQueue = createStubQueue(() => false);
        let queueCalls = 0;
        const originalPush = countingQueue.queue.push.bind(
            countingQueue.queue,
        );
        countingQueue.queue.push = (task) => {
            queueCalls++;
            return originalPush(task);
        };
        const boundaryReport = await runTranslation(
            boundaryCache,
            boundaryMap,
            countingQueue,
        );
        assert(
            boundaryReport.status === "complete",
            `status=${badStatus}: expected complete after retranslation, got ${boundaryReport.status}`,
        );
        assert(
            queueCalls > 0,
            `status=${badStatus}: unverifiable cache must trigger real requests`,
        );
        assert(
            boundaryCache.load("document").includes("[译]Alpha paragraph."),
            `status=${badStatus}: source must be retranslated`,
        );
        assert(
            boundaryCache.loadChapterStatus().document?.status === "complete",
            `status=${badStatus}: status must become complete`,
        );
    }
    console.log(
        "✅ failed/partial/missing status without markers retranslates source",
    );

    console.log(
        "\n=== Defense: resume without markers is rejected, never reported complete ===",
    );
    const defenseResult = await translateHtmlContent(
        "<html><body><p>No markers here.</p></body></html>",
        "Doc",
        {},
        translationConfig,
        null,
        createStubQueue(() => {
            throw new Error("queue must not be used without markers");
        }),
        logger,
        new Set(),
        new Set(),
        "html",
        false,
        { resumeFailedOnly: true },
    );
    assert(
        defenseResult.status === "failed",
        `resume without markers must fail, got ${defenseResult.status}`,
    );
    assert(
        String(defenseResult.error || "").includes("no failure markers"),
        "failure must explain the missing markers",
    );
    console.log("✅ resume without markers rejected as failed");

    console.log("\n=== 2.1 unified status reducer ===");
    const mixedChapters = [
        { id: "a", status: "failed" },
        { id: "b", status: "partial" },
    ];
    assert(
        aggregateTranslationResults(mixedChapters).status === "partial",
        "mixed failed+partial must be partial",
    );
    assert(
        mergeTranslationReports([
            { chapters: [{ id: "a", status: "failed" }] },
            { chapters: [{ id: "b", status: "complete" }] },
        ]).status === "partial",
        "merge(complete+failed) must be partial",
    );
    assert(
        mergeTranslationReports([
            { chapters: [{ id: "a", status: "failed" }] },
        ]).status === "failed",
        "merge(all failed) must be failed",
    );
    assert(
        mergeTranslationReports([]).status === "complete",
        "merge(empty) must be complete",
    );
    const singleMixedReport = mergeTranslationReports([
        {
            status: "partial",
            failedChapters: [{ id: "a", status: "failed" }],
            partialChapters: [{ id: "b", status: "partial" }],
            chapters: [
                { id: "a", status: "failed" },
                { id: "b", status: "partial" },
            ],
        },
    ]);
    assert(
        singleMixedReport.status === "partial",
        "merge([mixed]) must preserve partial semantics",
    );
    console.log("✅ reducer semantics consistent across entry points");

    console.log("\n=== Fix 3: task signature isolation ===");
    const base = {
        kind: "html",
        sourceDigest: "abc",
        sourceLanguage: "English",
        targetLanguage: "Chinese (Simplified)",
        extras: { promptDigest: "p1" },
    };
    const sigZh = buildTaskSignature(base);
    assert(sigZh !== buildTaskSignature({ ...base, targetLanguage: "Japanese" }));
    assert(sigZh !== buildTaskSignature({ ...base, sourceDigest: "xyz" }));
    assert(
        sigZh !==
            buildTaskSignature({ ...base, extras: { promptDigest: "p2" } }),
    );
    assert(
        computePromptDigest(projectRoot, "epub_translation_prompt.txt") !==
            "missing",
        "epub prompt digest must exist",
    );
    console.log("✅ signature changes with target language / source / rules");

    console.log(`\nAll status/cache audits passed. Temp: ${tmpDir}`);
};

run().catch((error) => {
    console.error(`\n❌ STATUS AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
