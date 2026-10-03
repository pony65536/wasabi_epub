import fs from "fs";
import os from "os";
import path from "path";
import { createProgressCache } from "../src/support/cache.js";
import {
    computeFileDigest,
    computeFastFingerprint,
} from "../src/support/taskIdentity.js";
import { createRequestLimiter } from "../src/translation/requestLimiter.js";
import { classifyProviderError } from "../src/translation/aiProvider.js";
import { createAIProvider } from "../src/translation/aiProvider.js";
import http from "http";
import { spawn } from "child_process";
import { runProcess, runProcessOrThrow } from "../src/support/process.js";
import { ContextRetriever } from "../src/content/retriever.js";
import { buildExtractorPrompt } from "../src/content/memory.js";
import {
    buildJobResult,
    finalizeJobArtifacts,
} from "../src/support/jobRuntime.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-recovery-"));
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const run = async () => {
    console.log("=== 2.2 identity: digest ignores mtime, fast fingerprint uses it ===");
    const file = path.join(tmpDir, "same.txt");
    fs.writeFileSync(file, "same content", "utf8");
    const digest1 = computeFileDigest(file);
    const fast1 = computeFastFingerprint(file);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(file, past, past);
    const digest2 = computeFileDigest(file);
    const fast2 = computeFastFingerprint(file);
    assert(digest1 === digest2, "content digest must ignore mtime");
    assert(fast1 !== fast2, "fast fingerprint must reflect mtime");

    fs.writeFileSync(file, "changed content", "utf8");
    assert(
        computeFileDigest(file) !== digest1,
        "content digest must change with content",
    );
    console.log("✅ digest stable under mtime, changes with content");

    console.log("\n=== 2.1 cache: atomic writes, corruption quarantine, task lock ===");
    const cacheDir = path.join(tmpDir, "cache");
    const cache = createProgressCache(cacheDir);
    cache.saveGlossary({ a: "b" });
    assert(
        JSON.stringify(cache.loadGlossary()) === JSON.stringify({ a: "b" }),
        "glossary round-trip",
    );
    fs.writeFileSync(path.join(cacheDir, "glossary.json"), "{broken", "utf8");
    assert(cache.loadGlossary() === null, "corrupt JSON must load as null");
    assert(
        fs
            .readdirSync(cacheDir)
            .some((name) => name.startsWith("glossary.json.corrupt-")),
        "corrupt file must be quarantined",
    );

    const lock1 = cache.acquireTaskLock();
    assert(lock1.acquired, "first lock acquisition must succeed");
    const sameProcessLock = cache.acquireTaskLock();
    assert(
        !sameProcessLock.acquired,
        "same process must not re-acquire the same cache lock",
    );
    // 模拟另一个进程持有锁（使用当前存活进程 pid，确保判定为活跃）
    fs.writeFileSync(
        path.join(cacheDir, "task.lock"),
        JSON.stringify({
            pid: process.pid,
            token: "other-token",
            startedAt: Date.now(),
        }),
        "utf8",
    );
    cache.releaseTaskLock();
    assert(
        fs.existsSync(path.join(cacheDir, "task.lock")),
        "release must not delete another holder's lock",
    );
    const lock2 = cache.acquireTaskLock();
    assert(!lock2.acquired, "fresh lock from another pid must block");
    // 已退出进程的锁：无论锁龄多短都应立即回收
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = deadChild.pid;
    await new Promise((resolve) => deadChild.on("close", resolve));
    fs.writeFileSync(
        path.join(cacheDir, "task.lock"),
        JSON.stringify({
            pid: deadPid,
            token: "stale-token",
            startedAt: Date.now(),
        }),
        "utf8",
    );
    const lock3 = cache.acquireTaskLock();
    assert(
        lock3.acquired,
        "lock from a dead process must be reclaimed regardless of age",
    );
    cache.releaseTaskLock();
    assert(
        !fs.existsSync(path.join(cacheDir, "task.lock")),
        "release must remove own lock",
    );
    console.log("✅ atomic cache, quarantine and task lock");

    console.log("\n=== 2.1 live-process lock is not stolen by age ===");
    const liveLockDir = path.join(tmpDir, "cache-live-lock");
    const liveCache = createProgressCache(liveLockDir);
    const child = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, 10000)",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(
        path.join(liveLockDir, "task.lock"),
        JSON.stringify({
            pid: child.pid,
            token: "live-token",
            startedAt: Date.now() - 7 * 60 * 60 * 1000,
        }),
        "utf8",
    );
    const liveBlocked = liveCache.acquireTaskLock();
    assert(
        !liveBlocked.acquired,
        "active process lock must not be reclaimed by age alone",
    );
    child.kill();
    await new Promise((resolve) => child.on("close", resolve));
    const deadReclaimed = liveCache.acquireTaskLock();
    assert(
        deadReclaimed.acquired,
        "lock from a dead process must be reclaimable",
    );
    liveCache.releaseTaskLock();
    console.log("✅ liveness-based lock reclamation");

    console.log("\n=== 2.3 request limiter caps concurrency ===");
    const limiter = createRequestLimiter(2);
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 6 }, () =>
        limiter.run(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
        }),
    );
    await Promise.all(tasks);
    assert(maxActive <= 2, `limiter must cap at 2, saw ${maxActive}`);
    assert(
        limiter.active === 0 && limiter.pending === 0,
        "limiter must drain",
    );
    console.log("✅ shared request limiter caps concurrency");

    console.log("\n=== 2.3 provider error classification ===");
    assert(
        classifyProviderError({ status: 401 }).retryable === false &&
            classifyProviderError({ status: 401 }).category === "auth",
        "auth errors must be non-retryable",
    );
    assert(
        classifyProviderError({ message: "model not found" }).category ===
            "model_missing",
        "missing model must be classified",
    );
    assert(
        classifyProviderError({ status: 429 }).retryable === true,
        "rate limit must be retryable",
    );
    assert(
        classifyProviderError({ code: "ETIMEDOUT" }).category === "timeout",
        "timeout must be classified",
    );
    console.log("✅ provider errors classified with retry policy");

    console.log("\n=== 2.3 timeout aborts the underlying request and frees the slot ===");
    let aborted = false;
    const server = http.createServer((req, res) => {
        req.on("aborted", () => {
            aborted = true;
        });
        req.on("close", () => {
            if (!res.writableEnded) aborted = true;
        });
        // 故意不响应，等待客户端超时取消
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const provider = createAIProvider(
        "qwen",
        {
            qwen: {
                apiKey: "test-key",
                baseURL: `http://127.0.0.1:${port}/v1`,
                modelName: "test-model",
                timeoutMs: 300,
                concurrency: 1,
            },
        },
        { write: () => {} },
    );
    let timedOut = false;
    try {
        await provider.callAI("hello", "system");
    } catch (error) {
        timedOut = /timed out/.test(String(error?.message || ""));
    }
    assert(timedOut, "callAI must reject with timeout");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(aborted, "underlying HTTP request must be aborted after timeout");
    assert(
        provider.getLimiterStats().active === 0 &&
            provider.getLimiterStats().pending === 0,
        `limiter slot must be released, got ${JSON.stringify(provider.getLimiterStats())}`,
    );
    await new Promise((resolve) => server.close(resolve));
    console.log("✅ timeout cancels request and releases the limiter slot");

    console.log("\n=== 2.6 subprocess runner: exit code, timeout, caps ===");
    const ok = await runProcess(process.execPath, ["-e", "console.log('hi')"]);
    assert(ok.code === 0 && ok.stdout.includes("hi"), "process must run");
    const bad = await runProcess(process.execPath, [
        "-e",
        "process.exit(3)",
    ]);
    assert(bad.code === 3, `expected exit 3, got ${bad.code}`);
    let thrown = false;
    try {
        await runProcessOrThrow(process.execPath, ["-e", "process.exit(2)"]);
    } catch (error) {
        thrown = error.category === "exit" && error.exitCode === 2;
    }
    assert(thrown, "runProcessOrThrow must throw structured error");
    const timeoutResult = await runProcess(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        { timeoutMs: 150 },
    );
    assert(timeoutResult.timedOut === true, "timeout must be reported");
    const capped = await runProcess(
        process.execPath,
        ["-e", "console.log('x'.repeat(100000))"],
        { maxOutputBytes: 128 },
    );
    assert(capped.stdout.length <= 128, "stdout must be capped");
    console.log("✅ subprocess runner: exit codes, timeout, output cap");

    console.log("\n=== 2.5 bilingual retriever + idempotent index ===");
    const retriever = new ContextRetriever();
    retriever.setGlossary({ "triple barrier": "三重障碍" });
    const paragraphText =
        "本章介绍三重障碍方法，用于金融数据标注，这是元标注的前置步骤。\n\n另一段讨论元标注与样本权重的关系，内容足够长以进入索引。";
    retriever.indexChapter("ch1", paragraphText);
    const sourceHit = retriever.queryContext(["triple barrier"], 2);
    assert(
        sourceHit.length >= 1 && sourceHit[0].chapterId === "ch1",
        "source-language query must hit translated text via glossary",
    );
    retriever.indexChapter("ch1", paragraphText);
    const duplicateHit = retriever.queryContext(["triple barrier"], 5);
    assert(
        duplicateHit.length <= 2,
        "re-indexing same chapter must not duplicate documents",
    );
    console.log("✅ bilingual query and idempotent indexing");

    console.log("\n=== 2.5 memory extractor uses source evidence ===");
    const prompt = buildExtractorPrompt("English", "Chinese (Simplified)");
    assert(
        prompt.includes("SOURCE") && prompt.includes("ORIGINAL source-language"),
        "extractor prompt must require source-language keys",
    );
    console.log("✅ memory extractor prompt requires source-language keys");

    console.log("\n=== 3.x job runtime result and retention contract ===");
    const result = buildJobResult({
        outputPath: "out.epub",
        cacheDir: "cache",
        logFile: "log.txt",
        translationStatus: "partial",
        validationStatus: "partial",
        counts: { chapters: 3, failedChapters: 1 },
        archivedInputPath: "input/book.1.epub",
    });
    assert(
        result.translationStatus === "partial" &&
            result.reportPath === null &&
            result.counts.chapters === 3 &&
            result.archivedInputPath === "input/book.1.epub",
        "buildJobResult must fill the full contract",
    );
    let removedCache = false;
    let removedLog = false;
    const finalizeRetained = finalizeJobArtifacts({
        cache: {
            releaseTaskLock: () => {},
            removeDir: () => {
                removedCache = true;
            },
        },
        logger: {
            remove: () => {
                removedLog = true;
            },
        },
        debugMode: false,
        keepArtifacts: true,
    });
    assert(
        finalizeRetained === "retained" && !removedCache && !removedLog,
        "partial/failed jobs must retain artifacts",
    );
    const finalizeRemoved = finalizeJobArtifacts({
        cache: {
            releaseTaskLock: () => {},
            removeDir: () => {
                removedCache = true;
            },
        },
        logger: {
            remove: () => {
                removedLog = true;
            },
        },
        debugMode: false,
        keepArtifacts: false,
    });
    assert(
        finalizeRemoved === "removed" && removedCache && removedLog,
        "complete jobs without debug must clean artifacts",
    );
    console.log("✅ job runtime contract and retention policy");

    console.log("\nAll recovery-contract audits passed.");
};

run().catch((error) => {
    console.error(`\n❌ RECOVERY CONTRACT AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
