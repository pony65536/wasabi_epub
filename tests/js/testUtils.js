import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfig } from "../../src/config.js";

const makeTestConfig = () => ({
    version: 1,
    models: {
        "test-primary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_PRIMARY_API_KEY",
            modelName: "test-primary",
        },
        "test-fallback": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_FALLBACK_API_KEY",
            modelName: "test-fallback",
        },
        "test-glossary": {
            sdk: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_GLOSSARY_API_KEY",
            modelName: "test-glossary",
        },
    },
    selection: {
        primary: "test-primary",
        fallback: { model: "test-fallback" },
        glossary: { default: "test-primary" },
    },
});

export const makeRuntimeConfig = (overrides = {}) =>
    loadRuntimeConfig({
        config: makeTestConfig(),
        env: {
            TEST_PRIMARY_API_KEY: "test-key",
            TEST_FALLBACK_API_KEY: "test-key",
            TEST_GLOSSARY_API_KEY: "test-key",
        },
        ...overrides,
    });

export const makeTempProject = () =>
    fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-core-"));

export const writeFile = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
};

export const readNormalized = (filePath) =>
    fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

export const captureStdout = async (fn) => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => {
        lines.push(args.map(String).join(" "));
    };

    let value;
    let error;
    try {
        value = await fn();
    } catch (caught) {
        error = caught;
    } finally {
        console.log = original;
    }

    return { value, error, lines };
};
