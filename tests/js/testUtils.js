import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRuntimeConfig } from "../../src/config.js";

export const makeRuntimeConfig = () => {
    const runtimeConfig = createRuntimeConfig();
    for (const provider of ["gemini", "qwen", "mimo", "openrouter"]) {
        runtimeConfig[provider].apiKey = "test-key";
    }
    return runtimeConfig;
};

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
