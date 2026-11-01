import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";

import { loadRuntimeConfig } from "../../src/config.js";
import { createJobContext, finishJob } from "../../src/pipeline/jobContext.js";
import { translateDocument } from "../../src/pipeline/translateDocument.js";
import { ensureCacheIdentity } from "../../src/pipeline/jobSupport.js";
import { createProgressCache } from "../../src/support/cache.js";
import { moveFileIfNeeded } from "../../src/support/files.js";
import { createChapterMap } from "../../src/epub/chapterMap.js";
import { resolveModelRouting } from "../../src/models/routing.js";
import { getTranslationEnvReport } from "../../src/support/environment.js";
import { shouldRetainArtifacts } from "../../src/pipeline/artifactPolicy.js";
import { buildSyntheticEpub } from "../helpers/fixtures.mjs";
import { captureStdout, makeTempProject, writeFile } from "./testUtils.js";

const definition = (overrides = {}) => ({ sdk: "openai", baseURL: "https://example.invalid/v1",
    apiKeyEnv: "TEST_KEY", modelName: "shared-model", concurrency: 2, timeoutMs: 1000, ...overrides });
const registry = () => ({ version: 1, models: { primary: definition(), critic: definition({ jsonMode: false }) },
    selection: { primary: "primary", stages: { critic: "critic" } } });
const runtime = (config = registry(), env = { TEST_KEY: "test-secret" }) => loadRuntimeConfig({ config, env });
const silent = { write() {} };

test("JSON registry drives stage routing, shared connection limits and adapter identity", async (t) => {
    const projectRoot = makeTempProject();
    let active = 0;
    let peak = 0;
    const created = [];
    const ctx = createJobContext({ projectRoot, runtimeConfig: runtime(),
        cacheDir: path.join(projectRoot, ".cache"), debugMode: false,
        createAdapter: ({ model }) => {
            created.push(model.jsonMode);
            return { call: async () => {
                peak = Math.max(peak, ++active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active--;
                return { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 2 } };
            } };
        } });
    t.after(() => { finishJob(ctx, { completed: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
        ctx.gateway.forStage(i % 2 ? "critic" : "translation").callAI("user", "system", true)));
    assert.ok(peak <= 2);
    assert.deepEqual(created.sort(), [false, true]);
    assert.equal(ctx.gateway.usage().requests, 8);
    assert.deepEqual(ctx.gateway.usage().tokens, { prompt: 8, completion: 16 });
    assert.equal(ctx.gateway.routing.stages.critic.connectionName, ctx.gateway.routing.stages.translation.connectionName);
});

test("CLI model override and explicitly selected stages are checked before model requests", () => {
    const config = registry();
    config.models.critic.apiKeyEnv = "CRITIC_KEY";
    const loaded = loadRuntimeConfig({ config, env: { TEST_KEY: "ok" }, modelName: "critic" });
    const report = getTranslationEnvReport(loaded);
    assert.equal(report.primaryProviderReady, false);
    assert.ok(report.checks.some((check) => check.envVar === "CRITIC_KEY" && !check.ok));
    const resolved = resolveModelRouting({ config: loaded.modelConfig, cli: { model: "critic" } });
    assert.equal(resolved.stages.translation.modelName, "critic");
    assert.equal(resolved.stages.planner.modelName, "primary");
    assert.throws(() => resolveModelRouting({ config: loaded.modelConfig, cli: { model: "missing" } }), /unknown model/);
});

test("language-specific glossary routing changes the cache fingerprint and restores the default", (t) => {
    const projectRoot = makeTempProject();
    const config = registry();
    config.selection.glossary = { default: "primary", bySourceLanguage: { Russian: "critic" } };
    const loaded = runtime(config);
    const ctx = createJobContext({ projectRoot, runtimeConfig: loaded, cacheDir: path.join(projectRoot, ".cache") });
    t.after(() => { finishJob(ctx, { completed: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });
    const original = ctx.gateway.routing.fingerprint;
    loaded.sourceLanguage = "Russian";
    ctx.getGlossaryProvider();
    assert.equal(ctx.gateway.routing.stages.glossary.modelName, "critic");
    assert.notEqual(ctx.gateway.routing.fingerprint, original);
    loaded.sourceLanguage = "English";
    ctx.getGlossaryProvider();
    assert.equal(ctx.gateway.routing.fingerprint, original);
});

test("explicit configuration errors fail fast and legacy files preserve connection routing", (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const env = { TEST_KEY: "secret", WASABI_MODELS_FILE: "models.json" };
    assert.throws(() => loadRuntimeConfig({ projectRoot, env }), /missing file/);
    writeFile(path.join(projectRoot, "models.json"), JSON.stringify({ connections: {
        relay: { url: "https://example.invalid/v1", format: "openai-chat", tokenEnv: "TEST_KEY", concurrency: 2 },
    }, models: { main: { connection: "relay", model: "a", jsonMode: true },
        careful: { connection: "relay", model: "b", jsonMode: true } },
    routing: { primary: "main", stages: { critic: "careful" } } }));
    const loaded = loadRuntimeConfig({ projectRoot, env });
    const resolved = resolveModelRouting({ config: loaded.modelConfig });
    assert.equal(resolved.stages.critic.model.model, "b");
    assert.equal(resolved.stages.critic.connectionName, "relay");
    assert.equal(resolved.stages.translation.connectionName, "relay");
    assert.throws(() => loadRuntimeConfig({ projectRoot, env: { ...env, WASABI_CONFIG: "also.json" } }), /choose one/);
});

test("legacy environment supports glossary language changes without reloading process.env", () => {
    const loaded = loadRuntimeConfig({ env: { PRIMARY_PROVIDER: "qwen", FALLBACK_PROVIDER: "",
        QWEN_API_KEY: "test", OPENROUTER_API_KEY: "optional" } });
    assert.ok(loaded.models.glossaryBySourceLanguage.Russian);
    assert.ok(loaded.models.glossaryBySourceLanguage.Japanese);
});

test("fallback policy changes cache identity while secret rotation does not", () => {
    const config = registry();
    config.selection.fallback = { model: "critic" };
    const first = resolveModelRouting({ config: runtime(config).modelConfig }).fingerprint;
    config.selection.fallback.onErrors = ["content_policy", "timeout"];
    const second = resolveModelRouting({ config: runtime(config).modelConfig }).fingerprint;
    assert.notEqual(first, second);
    assert.equal(second, resolveModelRouting({ config: runtime(config, { TEST_KEY: "rotated" }).modelConfig }).fingerprint);
});

test("gateway uses the shared SDK path to decode relay SSE and rejects empty/truncated responses", async (t) => {
    let response = 'data: {"choices":[{"delta":{"content":"translated"}}]}\n\ndata: [DONE]\n';
    let contentType = "text/event-stream";
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(200, { "Content-Type": contentType });
        res.end(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const projectRoot = makeTempProject();
    const config = registry();
    config.models.primary.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const ctx = createJobContext({ projectRoot, runtimeConfig: runtime(config), cacheDir: path.join(projectRoot, ".cache") });
    t.after(async () => {
        finishJob(ctx, { completed: true });
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });
    assert.equal(await ctx.aiProvider.callAI("user", "system", true), "translated");
    response = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n';
    await assert.rejects(() => ctx.aiProvider.callAI("user", "system", true), { code: "EMPTY_CONTENT" });
    contentType = "application/json";
    response = JSON.stringify({ choices: [{ message: { content: "cut off" }, finish_reason: "length" }] });
    await assert.rejects(() => ctx.aiProvider.callAI("user", "system"), { code: "OUTPUT_TRUNCATED" });
    assert.equal(requests, 5, "SDK retries must not multiply the gateway's two-attempt retry budget");
});

test("unsigned document cache is invalidated while its active task lock remains held", async (t) => {
    const projectRoot = makeTempProject();
    const cacheDir = path.join(projectRoot, ".cache");
    const cache = createProgressCache(cacheDir);
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    cache.acquireTaskLock();
    cache.save("document", "old translation");
    await captureStdout(() => ensureCacheIdentity(cache, "new-task", { kind: "html" }, silent));
    assert.equal(cache.load("document"), null);
    assert.equal(cache.loadTaskMeta().signature, "new-task");
    assert.equal(createProgressCache(cacheDir).acquireTaskLock().acquired, false);
    cache.releaseTaskLock();
});

test("shared filesystem module archives collisions without overwriting either input", (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const source = path.join(projectRoot, "source", "book.epub");
    const target = path.join(projectRoot, "input", "book.epub");
    writeFile(source, "new book");
    writeFile(target, "old book");
    const archived = moveFileIfNeeded(source, target);
    assert.equal(fs.readFileSync(target, "utf8"), "old book");
    assert.equal(fs.readFileSync(archived, "utf8"), "new book");
    assert.notEqual(target, archived);
});

test("extracted chapter map keeps OPF spine order when manifest order differs", () => {
    const zip = buildSyntheticEpub({ chapters: [
        { id: "second", href: "second.xhtml", html: "<html><body><p>Second</p></body></html>" },
        { id: "first", href: "first.xhtml", html: "<html><body><p>First</p></body></html>" },
    ], spineOrder: ["first", "second"] });
    assert.deepEqual([...createChapterMap(zip.getEntries()).keys()], ["first", "second"]);
});

test("shared document pipeline resumes partial nodes and reports complete only after recovery", async (t) => {
    const projectRoot = makeTempProject();
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const cache = createProgressCache(path.join(projectRoot, ".cache"));
    const source = `<html><body><p>Alpha ${"a".repeat(3000)}</p><p>Beta ${"b".repeat(3000)}</p></body></html>`;
    let failBeta = true;
    const written = [];
    const queue = { drainQueue: async () => {}, queue: { push: (task) => {
        const emitter = new EventEmitter();
        setImmediate(() => {
            if (failBeta && task.batch.some((node) => node.content.includes("Beta"))) {
                emitter.emit("failed", new Error("simulated failure"));
                return;
            }
            for (const node of task.batch) {
                written.push(node.content);
                task.$parent(`[${task.processor.attrName}="${node.id}"]`).html(`[译]${node.content}`).removeAttr(task.processor.attrName);
                const record = task.processor.planState?.get(node.id);
                if (record) record.state = "written";
            }
            emitter.emit("finish", { writtenNodeIds: task.batch.map((node) => node.id), failedNodes: [] });
        });
        return emitter;
    } } };
    const run = async () => {
        const chapterMap = new Map([["document", { id: "document", title: "Doc", html: source }]]);
        return (await captureStdout(() => translateDocument({ chapters: [...chapterMap.values()], chapterMap,
            glossary: {}, cache, runtimeConfig: { sourceLanguage: "English", targetLanguage: "Chinese (Simplified)" },
            aiProvider: null, batchQueue: queue, logger: silent, mode: "html" }))).value;
    };
    const partial = await run();
    assert.equal(partial.summary.status, "partial");
    assert.equal(shouldRetainArtifacts({ completed: true, translationStatus: partial.summary.status }), true);
    failBeta = false;
    written.length = 0;
    const resumed = await run();
    assert.equal(resumed.summary.status, "complete");
    assert.ok(written.length > 0 && written.every((text) => text.includes("Beta")));
});
