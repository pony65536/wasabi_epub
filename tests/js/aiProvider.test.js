import test from "node:test";
import assert from "node:assert/strict";

import { createAIProvider } from "../../src/translation/aiProvider.js";
import { createGoogleGenerativeAIAdapter } from "../../src/translation/sdk/googleGenerativeAI.js";
import { createOpenAIAdapter } from "../../src/translation/sdk/openai.js";

const makeModel = (overrides = {}) => ({
    id: "primary",
    sdk: "openai",
    baseURL: "https://example.com/v1",
    apiKey: "secret-key",
    apiKeyEnv: "PRIMARY_API_KEY",
    modelName: "primary-model",
    concurrency: 5,
    timeoutMs: 1000,
    requestOptions: {},
    ...overrides,
});

const makeLogger = () => {
    const writes = [];
    return {
        writes,
        write: (type, content) => writes.push({ type, content }),
    };
};

const makeFakeOpenAI = (calls) => {
    return class FakeOpenAI {
        constructor(options) {
            calls.push({ kind: "openai.ctor", options });
            this.chat = {
                completions: {
                    create: async (options) => {
                        calls.push({ kind: "openai.request", options });
                        return {
                            choices: [{ message: { content: "openai-response" } }],
                        };
                    },
                },
            };
        }
    };
};

const makeFakeGoogle = (calls) => {
    return class FakeGoogle {
        constructor(apiKey) {
            calls.push({ kind: "google.ctor", apiKey });
        }

        getGenerativeModel(params, requestOptions) {
            calls.push({ kind: "google.model", params, requestOptions });
            return {
                generateContent: async (content) => {
                    calls.push({ kind: "google.request", content });
                    return { response: { text: () => "google-response" } };
                },
            };
        }
    };
};

const makeSdkFactories = (calls) => ({
    openai: (model) =>
        createOpenAIAdapter(model, { OpenAI: makeFakeOpenAI(calls) }),
    "@google/generative-ai": (model) =>
        createGoogleGenerativeAIAdapter(model, {
            GoogleGenerativeAI: makeFakeGoogle(calls),
        }),
});

test("OpenAI adapter maps constructor, messages, JSON mode, and options", async () => {
    const calls = [];
    const provider = createAIProvider({
        primaryModel: makeModel({
            requestOptions: { reasoning: { enabled: true } },
        }),
        logger: makeLogger(),
        sdkFactories: makeSdkFactories(calls),
    });

    const result = await provider.callAI("user input", "system prompt", true);

    assert.equal(result, "openai-response");
    assert.deepEqual(calls[0], {
        kind: "openai.ctor",
        options: {
            apiKey: "secret-key",
            baseURL: "https://example.com/v1",
            timeout: 1000,
        },
    });
    assert.deepEqual(calls[1].options, {
        reasoning: { enabled: true },
        model: "primary-model",
        messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "user input" },
        ],
        response_format: { type: "json_object" },
    });
});

test("OpenAI adapter rejects reserved request keys", async () => {
    const adapter = createOpenAIAdapter(
        makeModel({ requestOptions: { model: "override" } }),
        { OpenAI: class FakeOpenAI {} },
    );

    await assert.rejects(
        () => adapter.callRaw("system", "user", false),
        /reserved key "model"/,
    );
});

test("Google adapter maps model and baseURL request options", async () => {
    const calls = [];
    const provider = createAIProvider({
        primaryModel: makeModel({
            id: "gemini",
            sdk: "@google/generative-ai",
            baseURL: "https://gemini.example.com",
            modelName: "gemini-model",
        }),
        logger: makeLogger(),
        sdkFactories: makeSdkFactories(calls),
    });

    const result = await provider.callAI("user input", "system prompt");

    assert.equal(result, "google-response");
    assert.deepEqual(calls[0], {
        kind: "google.ctor",
        apiKey: "secret-key",
    });
    assert.deepEqual(calls[1], {
        kind: "google.model",
        params: { model: "gemini-model" },
        requestOptions: { baseUrl: "https://gemini.example.com" },
    });
    assert.match(calls[2].content, /system prompt[\s\S]*user input/);
});

test("facade timeout applies to both SDK adapters", async () => {
    const sdkFactories = {
        openai: (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: () => new Promise(() => {}),
        }),
    };

    const provider = createAIProvider({
        primaryModel: makeModel({ timeoutMs: 20 }),
        logger: makeLogger(),
        sdkFactories,
    });

    await assert.rejects(
        () => provider.callAI("user", "system"),
        /timed out after 20ms/,
    );
});

test("falls back only on content policy errors", async () => {
    const calls = [];
    const sdkFactories = {
        openai: (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: async () => {
                calls.push(model.id);
                if (model.id === "primary") {
                    throw new Error("content policy violation");
                }
                return "fallback-response";
            },
        }),
    };
    const logger = makeLogger();
    const provider = createAIProvider({
        primaryModel: makeModel({ id: "primary" }),
        fallbackModel: makeModel({ id: "fallback" }),
        onContentPolicy: true,
        logger,
        sdkFactories,
    });

    const result = await provider.callAI("user", "system");

    assert.equal(result, "fallback-response");
    assert.deepEqual(calls, ["primary", "fallback"]);
    assert.ok(logger.writes.some((entry) => entry.type === "WARN"));
});

test("does not fall back on unrelated errors", async () => {
    let fallbackCalled = false;
    const sdkFactories = {
        openai: (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: async () => {
                if (model.id === "primary") {
                    throw new Error("invalid json response");
                }
                fallbackCalled = true;
                return "fallback-response";
            },
        }),
    };

    const provider = createAIProvider({
        primaryModel: makeModel({ id: "primary" }),
        fallbackModel: makeModel({ id: "fallback" }),
        onContentPolicy: true,
        logger: makeLogger(),
        sdkFactories,
    });

    await assert.rejects(() => provider.callAI("user", "system"), /invalid json/);
    assert.equal(fallbackCalled, false);
});

test("supports cross-SDK fallback and disabled fallback", async () => {
    const sdkFactories = {
        openai: (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: async () => {
                throw new Error("content policy violation");
            },
        }),
        "@google/generative-ai": (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: async () => "google-fallback",
        }),
    };

    const provider = createAIProvider({
        primaryModel: makeModel({ id: "primary", sdk: "openai" }),
        fallbackModel: makeModel({
            id: "fallback",
            sdk: "@google/generative-ai",
        }),
        onContentPolicy: true,
        logger: makeLogger(),
        sdkFactories,
    });
    assert.equal(await provider.callAI("user", "system"), "google-fallback");

    const disabled = createAIProvider({
        primaryModel: makeModel({ id: "primary" }),
        fallbackModel: makeModel({ id: "fallback" }),
        onContentPolicy: false,
        logger: makeLogger(),
        sdkFactories,
    });
    await assert.rejects(
        () => disabled.callAI("user", "system"),
        /content policy/,
    );
});

test("does not write API keys to the logger", async () => {
    const logger = makeLogger();
    const provider = createAIProvider({
        primaryModel: makeModel(),
        logger,
        sdkFactories: makeSdkFactories([]),
    });

    await provider.callAI("user", "system");

    assert.ok(logger.writes.length > 0);
    assert.ok(
        logger.writes.every((entry) => !entry.content.includes("secret-key")),
    );
});

test("deprecated model guidance points at the config model id", async () => {
    const sdkFactories = {
        openai: (model) => ({
            id: model.id,
            sdk: model.sdk,
            modelName: model.modelName,
            concurrency: model.concurrency,
            timeoutMs: model.timeoutMs,
            callRaw: async () => {
                throw new Error("model not found");
            },
        }),
    };

    const provider = createAIProvider({
        primaryModel: makeModel({ id: "primary" }),
        logger: makeLogger(),
        sdkFactories,
    });

    await assert.rejects(
        () => provider.callAI("user", "system"),
        /models\.primary\.modelName/,
    );
});
