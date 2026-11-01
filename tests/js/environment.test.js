import test from "node:test";
import assert from "node:assert/strict";

import { loadRuntimeConfig } from "../../src/config.js";
import { getTranslationEnvReport } from "../../src/support/environment.js";

const makeConfig = () => ({
    version: 1,
    models: {
        "test-primary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_PRIMARY_KEY",
            modelName: "test-primary",
        },
        "test-fallback": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_FALLBACK_KEY",
            modelName: "test-fallback",
        },
        "test-glossary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_GLOSSARY_KEY",
            modelName: "test-glossary",
        },
        "test-ru": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_RU_KEY",
            modelName: "test-ru",
        },
    },
    selection: {
        primary: "test-primary",
        fallback: { model: "test-fallback" },
        glossary: {
            default: "test-glossary",
            bySourceLanguage: { Russian: "test-ru" },
        },
    },
});

const makeEnv = () => ({
    TEST_PRIMARY_KEY: "primary",
    TEST_FALLBACK_KEY: "fallback",
    TEST_GLOSSARY_KEY: "glossary",
    TEST_RU_KEY: "ru",
});

const load = (env) =>
    loadRuntimeConfig({ config: makeConfig(), env });

test("reports required keys from the selected models", () => {
    const report = getTranslationEnvReport(load(makeEnv()));

    assert.equal(report.primaryProviderReady, true);
    assert.deepEqual(
        report.checks.map((check) => [check.label, check.required, check.ok]),
        [
            ["Primary: test-primary", true, true],
            ["Fallback: test-fallback", true, true],
            ["Glossary: test-glossary", true, true],
            ["Glossary Russian: test-ru", false, true],
        ],
    );
});

test("marks the primary key as blocking when missing", () => {
    const report = getTranslationEnvReport(
        load({ ...makeEnv(), TEST_PRIMARY_KEY: "" }),
    );

    assert.equal(report.primaryProviderReady, false);
    const primary = report.checks.find((check) =>
        check.label.startsWith("Primary"),
    );
    assert.equal(primary.required, true);
    assert.equal(primary.ok, false);
    assert.equal(primary.envVar, "TEST_PRIMARY_KEY");
});

test("treats missing optional glossary keys as non-blocking warnings", () => {
    const report = getTranslationEnvReport(
        load({ ...makeEnv(), TEST_RU_KEY: "" }),
    );

    assert.equal(report.primaryProviderReady, true);
    const optional = report.checks.find((check) =>
        check.label.startsWith("Glossary Russian"),
    );
    assert.equal(optional.required, false);
    assert.equal(optional.ok, false);
});

test("omits fallback and duplicate glossary checks when not needed", () => {
    const config = makeConfig();
    delete config.selection.fallback;
    config.selection.glossary.default = "test-primary";
    const report = getTranslationEnvReport(
        loadRuntimeConfig({ config, env: makeEnv() }),
    );

    assert.deepEqual(
        report.checks.map((check) => check.label),
        ["Primary: test-primary", "Glossary Russian: test-ru"],
    );
});
