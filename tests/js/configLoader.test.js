import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfig } from "../../src/config.js";

const makeConfig = () => ({
    version: 1,
    models: {
        "primary-model": {
            sdk: "openai",
            baseURL: "https://example.com/v1",
            apiKeyEnv: "PRIMARY_API_KEY",
            modelName: "primary",
        },
        "fallback-model": {
            sdk: "openai",
            baseURL: "https://example.com/v1",
            apiKeyEnv: "FALLBACK_API_KEY",
            modelName: "fallback",
            concurrency: 2,
            timeoutMs: 1000,
        },
        "ru-model": {
            sdk: "openai",
            baseURL: "https://example.com/v1",
            apiKeyEnv: "GLOSSARY_API_KEY",
            modelName: "ru",
        },
        "ja-model": {
            sdk: "openai",
            baseURL: "https://example.com/v1",
            apiKeyEnv: "GLOSSARY_API_KEY",
            modelName: "ja",
        },
        "gemini-model": {
            sdk: "@google/generative-ai",
            apiKeyEnv: "GEMINI_API_KEY",
            modelName: "gemini",
        },
    },
    selection: {
        primary: "primary-model",
        fallback: { model: "fallback-model" },
        glossary: {
            default: "primary-model",
            bySourceLanguage: {
                Russian: "ru-model",
                Japanese: "ja-model",
            },
        },
    },
});

const makeEnv = () => ({
    PRIMARY_API_KEY: "primary-key",
    FALLBACK_API_KEY: "fallback-key",
    GLOSSARY_API_KEY: "glossary-key",
    GEMINI_API_KEY: "gemini-key",
});

const load = (overrides = {}) =>
    loadRuntimeConfig({
        config: makeConfig(),
        env: makeEnv(),
        ...overrides,
    });

test("loads models, selection, defaults, and optional models", () => {
    const runtime = load();

    assert.equal(runtime.models.primary.id, "primary-model");
    assert.equal(runtime.models.primary.apiKey, "primary-key");
    assert.equal(runtime.models.primary.concurrency, 5);
    assert.equal(runtime.models.primary.timeoutMs, 90000);

    assert.equal(runtime.models.fallback.id, "fallback-model");
    assert.equal(runtime.models.fallback.concurrency, 2);
    assert.equal(runtime.models.fallback.timeoutMs, 1000);

    assert.equal(runtime.models.glossaryDefault.id, "primary-model");
    assert.equal(runtime.models.glossaryBySourceLanguage.Russian, "ru-model");
    assert.equal(runtime.models.glossaryBySourceLanguage.Japanese, "ja-model");

    const optional = runtime.resolveOptionalModel("ru-model");
    assert.equal(optional.model.id, "ru-model");
    assert.equal(optional.model.apiKey, "glossary-key");
    assert.equal(optional.unavailableReason, null);
});

test("omitted or disabled fallback resolves to null", () => {
    const withoutFallback = makeConfig();
    delete withoutFallback.selection.fallback;
    assert.equal(
        loadRuntimeConfig({ config: withoutFallback, env: makeEnv() }).models
            .fallback,
        null,
    );

    const disabledFallback = makeConfig();
    disabledFallback.selection.fallback.onContentPolicy = false;
    assert.equal(
        loadRuntimeConfig({ config: disabledFallback, env: makeEnv() }).models
            .fallback,
        null,
    );
});

test("missing required keys are reported only when required", () => {
    const runtime = load({ env: {} });
    assert.equal(runtime.models.primary.apiKey, null);

    assert.throws(
        () => load({ env: {}, requireKeys: true }),
        /PRIMARY_API_KEY/,
    );
});

test("optional model reports missing_api_key without failing", () => {
    const runtime = load({ env: { PRIMARY_API_KEY: "primary-key" } });
    const optional = runtime.resolveOptionalModel("ru-model");

    assert.equal(optional.model, null);
    assert.equal(optional.unavailableReason, "missing_api_key");
});

test("concurrency override is passed through without mutating models", () => {
    const runtime = load({ concurrency: 7 });

    assert.equal(runtime.concurrencyOverride, 7);
    assert.equal(runtime.models.primary.concurrency, 5);
});

test("rejects unknown fields and invalid values", () => {
    const unknownTopLevel = makeConfig();
    unknownTopLevel.extra = true;
    assert.throws(
        () => loadRuntimeConfig({ config: unknownTopLevel, env: makeEnv() }),
        /unknown field/,
    );

    const unknownModelField = makeConfig();
    unknownModelField.models["primary-model"].timeout = 1;
    assert.throws(
        () => loadRuntimeConfig({ config: unknownModelField, env: makeEnv() }),
        /unknown field/,
    );

    const unknownSdk = makeConfig();
    unknownSdk.models["primary-model"].sdk = "custom";
    assert.throws(
        () => loadRuntimeConfig({ config: unknownSdk, env: makeEnv() }),
        /sdk/,
    );

    const missingBaseURL = makeConfig();
    delete missingBaseURL.models["primary-model"].baseURL;
    assert.throws(
        () => loadRuntimeConfig({ config: missingBaseURL, env: makeEnv() }),
        /baseURL is required/,
    );

    const credentialsInURL = makeConfig();
    credentialsInURL.models["primary-model"].baseURL =
        "https://user:pass@example.com/v1";
    assert.throws(
        () => loadRuntimeConfig({ config: credentialsInURL, env: makeEnv() }),
        /credentials/,
    );

    const badEnvName = makeConfig();
    badEnvName.models["primary-model"].apiKeyEnv = "primary-key";
    assert.throws(
        () => loadRuntimeConfig({ config: badEnvName, env: makeEnv() }),
        /environment variable name/,
    );

    const badVersion = makeConfig();
    badVersion.version = 2;
    assert.throws(
        () => loadRuntimeConfig({ config: badVersion, env: makeEnv() }),
        /version/,
    );
});

test("rejects invalid selection references", () => {
    const unknownPrimary = makeConfig();
    unknownPrimary.selection.primary = "missing-model";
    assert.throws(
        () => loadRuntimeConfig({ config: unknownPrimary, env: makeEnv() }),
        /unknown model id/,
    );

    const sameFallback = makeConfig();
    sameFallback.selection.fallback.model = "primary-model";
    assert.throws(
        () => loadRuntimeConfig({ config: sameFallback, env: makeEnv() }),
        /must differ/,
    );

    const unknownGlossary = makeConfig();
    unknownGlossary.selection.glossary.bySourceLanguage.Russian =
        "missing-model";
    assert.throws(
        () => loadRuntimeConfig({ config: unknownGlossary, env: makeEnv() }),
        /unknown model id/,
    );

    const unknownLanguage = makeConfig();
    unknownLanguage.selection.glossary.bySourceLanguage.Klingon = "ru-model";
    assert.throws(
        () => loadRuntimeConfig({ config: unknownLanguage, env: makeEnv() }),
        /Russian, Japanese/,
    );
});

test("requestOptions only allows reasoning.enabled for openai", () => {
    const headers = makeConfig();
    headers.models["primary-model"].requestOptions = {
        headers: { Authorization: "Bearer secret" },
    };
    assert.throws(
        () => loadRuntimeConfig({ config: headers, env: makeEnv() }),
        /unknown field/,
    );

    const badEnabled = makeConfig();
    badEnabled.models["primary-model"].requestOptions = {
        reasoning: { enabled: "yes" },
    };
    assert.throws(
        () => loadRuntimeConfig({ config: badEnabled, env: makeEnv() }),
        /boolean/,
    );

    const geminiOptions = makeConfig();
    geminiOptions.models["gemini-model"].requestOptions = {
        reasoning: { enabled: true },
    };
    assert.throws(
        () => loadRuntimeConfig({ config: geminiOptions, env: makeEnv() }),
        /only supported for sdk/,
    );

    const valid = makeConfig();
    valid.models["primary-model"].requestOptions = {
        reasoning: { enabled: true },
    };
    assert.deepEqual(
        loadRuntimeConfig({ config: valid, env: makeEnv() }).models.primary
            .requestOptions,
        { reasoning: { enabled: true } },
    );
});

test("loads from a file and honours WASABI_CONFIG", (t) => {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "wasabi-config-"),
    );
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const configDir = path.join(projectRoot, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, "wasabi.local.json"),
        JSON.stringify(makeConfig()),
        "utf8",
    );

    const runtime = loadRuntimeConfig({
        projectRoot,
        env: makeEnv(),
        requireKeys: false,
    });
    assert.equal(
        runtime.configPath,
        path.join(configDir, "wasabi.local.json"),
    );
    assert.equal(runtime.models.primary.id, "primary-model");

    const customPath = path.join(projectRoot, "custom.json");
    fs.writeFileSync(customPath, JSON.stringify(makeConfig()), "utf8");
    const custom = loadRuntimeConfig({
        projectRoot,
        env: { ...makeEnv(), WASABI_CONFIG: "custom.json" },
    });
    assert.equal(custom.configPath, customPath);
});

test("missing config file includes a copy hint", (t) => {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "wasabi-config-missing-"),
    );
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    assert.throws(
        () =>
            loadRuntimeConfig({
                projectRoot,
                env: makeEnv(),
            }),
        /Missing config file[\s\S]*Copy config\/wasabi\.example\.json/,
    );
});
