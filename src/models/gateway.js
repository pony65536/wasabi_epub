import { createRequestLimiter } from "../translation/requestLimiter.js";
import { classifyProviderError } from "./errors.js";
import { createOpenAIChatAdapter } from "./adapters/openaiChat.js";
import { createGeminiNativeAdapter } from "./adapters/geminiNative.js";

export const GATEWAY_VERSION = 1;

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_FAILED_REQUESTS = 200;
const DEFAULT_CONSECUTIVE_FAILURES = 10;

// 只有这些类别允许进入 fallback（fallback 每个 call 最多一次）
const FALLBACK_CATEGORIES = new Set([
    "content_policy",
    "model_missing",
    "auth",
    "network",
    "rate_limit",
    "timeout",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, timeoutMs, onTimeout) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promise;
    }
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(
                        `Provider call timed out after ${timeoutMs}ms`,
                    );
                    error.code = "ETIMEDOUT";
                    try {
                        onTimeout?.();
                    } catch {
                        // 忽略取消异常
                    }
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const makeBudgetError = (code, message) => {
    const error = new Error(message);
    error.code = code;
    error.category = "budget";
    error.retryable = false;
    return error;
};

export const defaultCreateAdapter = ({
    connectionName,
    connection,
    model,
    env,
}) => {
    const apiKey = env?.[connection.tokenEnv];
    if (!apiKey) {
        const error = new Error(
            `Missing API key environment variable: ${connection.tokenEnv}`,
        );
        error.code = "MISSING_API_KEY";
        throw error;
    }
    if (connection.format === "gemini-native") {
        return createGeminiNativeAdapter({
            connectionName,
            connection,
            model,
            apiKey,
        });
    }
    return createOpenAIChatAdapter({
        connectionName,
        connection,
        model,
        apiKey,
    });
};

export const createModelGateway = ({
    routing,
    logger = { write: () => {} },
    env = process.env,
    globalConcurrency = null,
    connectionConcurrency = null,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    maxFailedRequests = DEFAULT_MAX_FAILED_REQUESTS,
    consecutiveFailureThreshold = DEFAULT_CONSECUTIVE_FAILURES,
    createAdapter = defaultCreateAdapter,
    retryDelayMs = 500,
} = {}) => {
    if (!routing?.stages?.translation) {
        throw new Error(
            "Model gateway requires resolved routing with a translation stage.",
        );
    }

    const globalLimit =
        globalConcurrency ||
        Number(env.WASABI_GLOBAL_CONCURRENCY) ||
        routing.stages.translation.connection.concurrency ||
        5;
    const globalLimiter = createRequestLimiter(globalLimit);
    const connectionLimiters = new Map();
    const adapters = new Map();

    const stats = {
        requests: 0,
        failures: 0,
        tokens: { prompt: 0, completion: 0 },
        byStage: {},
        byModel: {},
    };
    let failedRequests = 0;
    let consecutiveFailures = 0;

    const getConnectionLimiter = (config) => {
        const key = config.connectionName;
        if (!connectionLimiters.has(key)) {
            connectionLimiters.set(
                key,
                createRequestLimiter(
                    connectionConcurrency ||
                        config.connection.concurrency ||
                        globalLimit,
                ),
            );
        }
        return connectionLimiters.get(key);
    };

    const getAdapter = (config) => {
        const key = `${config.connectionName}:${config.modelName}`;
        if (!adapters.has(key)) {
            adapters.set(
                key,
                createAdapter({
                    connectionName: config.connectionName,
                    connection: config.connection,
                    model: config.model,
                    env,
                }),
            );
        }
        return adapters.get(key);
    };

    const recordSuccess = (stage, config, result) => {
        stats.requests += 1;
        stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
        const modelKey = `${config.connectionName}:${config.model.model}`;
        stats.byModel[modelKey] = (stats.byModel[modelKey] || 0) + 1;
        if (result?.usage) {
            stats.tokens.prompt += Number(result.usage.prompt_tokens || 0);
            stats.tokens.completion += Number(
                result.usage.completion_tokens || 0,
            );
        }
    };

    const invoke = async (stage, config, request) => {
        if (failedRequests >= maxFailedRequests) {
            throw makeBudgetError(
                "TASK_COST_LIMIT_REACHED",
                `Task failed-request budget reached (${maxFailedRequests}).`,
            );
        }
        if (consecutiveFailures >= consecutiveFailureThreshold) {
            throw makeBudgetError(
                "CONSECUTIVE_FAILURES",
                `Too many consecutive provider failures (${consecutiveFailureThreshold}).`,
            );
        }

        const adapter = getAdapter(config);
        const connectionLimiter = getConnectionLimiter(config);
        const timeoutMs = config.model.timeoutMs ?? config.connection.timeoutMs;
        const controller = new AbortController();
        const startedAt = Date.now();

        try {
            const result = await globalLimiter.run(() =>
                connectionLimiter.run(() =>
                    withTimeout(
                        adapter.call({
                            ...request,
                            signal: controller.signal,
                        }),
                        timeoutMs,
                        () => controller.abort(),
                    ),
                ),
            );
            consecutiveFailures = 0;
            recordSuccess(stage, config, result);
            return {
                text: result.text,
                provider: config.connectionName,
                model: config.model.model,
                elapsedMs: Date.now() - startedAt,
                usage: result.usage || null,
            };
        } catch (error) {
            failedRequests += 1;
            consecutiveFailures += 1;
            stats.failures += 1;
            error.category = classifyProviderError(error).category;
            throw error;
        }
    };

    const call = async (
        stage,
        { system = "", user = "", json = false, maxOutputTokens } = {},
    ) => {
        const stageConfig = routing.stages[stage];
        if (!stageConfig) {
            throw new Error(`Unknown model stage: "${stage}".`);
        }
        const request = {
            system,
            user,
            json,
            maxOutputTokens:
                maxOutputTokens ??
                stageConfig.model.maxOutputTokens ??
                undefined,
        };

        let lastError = null;
        let attempts = 0;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            attempts += 1;
            try {
                return await invoke(stage, stageConfig, request);
            } catch (error) {
                lastError = error;
                if (!classifyProviderError(error).retryable) break;
                if (attempt < maxAttempts) {
                    await sleep(retryDelayMs * attempt);
                }
            }
        }

        const category = classifyProviderError(lastError).category;
        const fallbackAllowed =
            Boolean(stageConfig.fallback) &&
            FALLBACK_CATEGORIES.has(category) &&
            (!routing.fallbackCategories || routing.fallbackCategories.includes(category)) &&
            (category !== "content_policy" ||
                routing.fallbackOnContentPolicy !== false);

        if (fallbackAllowed) {
            try {
                attempts += 1;
                return await invoke(stage, stageConfig.fallback, request);
            } catch (fallbackError) {
                lastError = fallbackError;
            }
        }

        lastError.category = classifyProviderError(lastError).category;
        lastError.attempts = attempts;
        lastError.stage = stage;
        lastError.model = stageConfig.model.model;
        throw lastError;
    };

    const forStage = (stage) => {
        const stageConfig = routing.stages[stage];
        if (!stageConfig) {
            throw new Error(`Unknown model stage: "${stage}".`);
        }
        return {
            callAI: async (user, system, json = false) =>
                (await call(stage, { user, system, json })).text,
            concurrency: globalLimit,
            providerName: stageConfig.connectionName,
            modelName: stageConfig.model.model,
            fallbackProviderName: stageConfig.fallback?.connectionName ?? null,
            getLimiterStats: () => {
                const connectionLimiter = connectionLimiters.get(
                    stageConfig.connectionName,
                );
                return {
                    global: {
                        active: globalLimiter.active,
                        pending: globalLimiter.pending,
                    },
                    connection: connectionLimiter
                        ? {
                              active: connectionLimiter.active,
                              pending: connectionLimiter.pending,
                          }
                        : { active: 0, pending: 0 },
                };
            },
        };
    };

    return {
        call,
        forStage,
        concurrency: globalLimit,
        routing,
        describe: () => routing.describe?.() ?? null,
        usage: () => ({
            requests: stats.requests,
            failures: stats.failures,
            failedRequests,
            consecutiveFailures,
            tokens: { ...stats.tokens },
            byStage: { ...stats.byStage },
            byModel: { ...stats.byModel },
        }),
        getLimiterStats: () => ({
            global: {
                active: globalLimiter.active,
                pending: globalLimiter.pending,
            },
        }),
        logger,
    };
};
