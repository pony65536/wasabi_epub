import { createGoogleGenerativeAIAdapter } from "./sdk/googleGenerativeAI.js";
import { createOpenAIAdapter } from "./sdk/openai.js";
import { createRequestLimiter } from "./requestLimiter.js";
export { classifyProviderError } from "../models/errors.js";
export { parseSseCompletion, readCompletionContent } from "../models/response.js";

export const isContentPolicyError = (err) => {
    const message = String(err?.message || "").toLowerCase();
    if (!message) return false;

    const hasContentPolicySignal =
        message.includes("inappropriate content") ||
        message.includes("content policy") ||
        message.includes("content-filter") ||
        message.includes("content filter") ||
        message.includes("safety policy") ||
        message.includes("violates safety");

    if (!hasContentPolicySignal) return false;

    const excludedSignals = [
        "invalid json",
        "json",
        "timeout",
        "timed out",
        "rate limit",
        "429",
        "econnreset",
        "socket hang up",
    ];

    return !excludedSignals.some((token) => message.includes(token));
};

const withTimeout = async (promise, timeoutMs, timeoutLabel, onTimeout) => {
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
                        `${timeoutLabel} timed out after ${timeoutMs}ms`,
                    );
                    error.code = "ETIMEDOUT";
                    onTimeout?.();
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const DEFAULT_SDK_FACTORIES = {
    openai: createOpenAIAdapter,
    "@google/generative-ai": createGoogleGenerativeAIAdapter,
};

const buildResolvedModelGuidance = (model, err, isFallback) => {
    const normalized = String(err?.message || "").toLowerCase();
    const isDeprecatedModelError =
        normalized.includes("deprecated") ||
        normalized.includes("decommissioned") ||
        normalized.includes("no longer available") ||
        normalized.includes("model not found") ||
        normalized.includes("unknown model");

    if (!isDeprecatedModelError) return null;

    const label = isFallback ? "Configured fallback model" : "Configured model";
    return [
        `${label} "${model.id}" (${model.modelName}) is no longer available.`,
        `Update models.${model.id}.modelName in config/wasabi.local.json.`,
    ].join("\n");
};

const buildResolvedClient = (model, sdkFactories) => {
    const factory = sdkFactories[model.sdk];
    if (!factory) {
        throw new Error(`Unsupported SDK: ${model.sdk}`);
    }
    return factory(model);
};

export const createAIProvider = ({
    primaryModel,
    fallbackModel = null,
    onContentPolicy = false,
    logger,
    sdkFactories = DEFAULT_SDK_FACTORIES,
}) => {
    if (!primaryModel?.apiKey) {
        throw new Error(
            `Missing API key for model "${primaryModel?.id ?? "unknown"}"`,
        );
    }

    const primaryClient = buildResolvedClient(primaryModel, sdkFactories);
    const shouldEnableFallback =
        Boolean(onContentPolicy) &&
        Boolean(fallbackModel) &&
        fallbackModel.id !== primaryModel.id;
    const fallbackClient = shouldEnableFallback
        ? buildResolvedClient(fallbackModel, sdkFactories)
        : null;
    const requestLimiter = createRequestLimiter(primaryClient.concurrency || 4);

    const callWithClient = async (
        client,
        model,
        userContent,
        systemInstruction,
        forceJsonMode,
    ) => {
        logger.write(
            "REQUEST",
            `MODEL: ${client.id}\nMODEL_NAME: ${client.modelName}\nTIMEOUT_MS: ${model.timeoutMs}\nSYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
        );
        const startedAt = Date.now();
        const controller = new AbortController();
        const responseText = await requestLimiter.run(() => withTimeout(
            client.callRaw(systemInstruction, userContent, forceJsonMode, { signal: controller.signal }),
            model.timeoutMs, `${client.id}:${client.modelName}`, () => controller.abort(),
        ));
        logger.write(
            "RESPONSE",
            `MODEL: ${client.id}\nMODEL_NAME: ${client.modelName}\nELAPSED_MS: ${Date.now() - startedAt}\n${responseText}`,
        );
        return responseText;
    };

    const callAI = async (
        userContent,
        systemInstruction,
        forceJsonMode = false,
    ) => {
        if (!userContent?.trim()) return "";
        try {
            return await callWithClient(
                primaryClient,
                primaryModel,
                userContent,
                systemInstruction,
                forceJsonMode,
            );
        } catch (e) {
            if (fallbackClient && isContentPolicyError(e)) {
                logger.write(
                    "WARN",
                    `Content policy triggered on model "${primaryClient.id}". Falling back to "${fallbackClient.id}". Original error: ${e.message}`,
                );
                try {
                    return await callWithClient(
                        fallbackClient,
                        fallbackModel,
                        userContent,
                        systemInstruction,
                        forceJsonMode,
                    );
                } catch (fallbackError) {
                    const guidance = buildResolvedModelGuidance(
                        fallbackModel,
                        fallbackError,
                        true,
                    );
                    if (guidance) {
                        fallbackError.message = `${fallbackError.message}\n\n${guidance}`;
                    }
                    logger.write(
                        "ERROR",
                        `Fallback callAI Failed: ${fallbackError.stack || fallbackError.message}`,
                    );
                    throw fallbackError;
                }
            }

            const guidance = buildResolvedModelGuidance(
                primaryModel,
                e,
                false,
            );
            if (guidance) {
                e.message = `${e.message}\n\n${guidance}`;
            }
            logger.write("ERROR", `callAI Failed: ${e.stack || e.message}`);
            throw e;
        }
    };

    return {
        callAI,
        concurrency: primaryClient.concurrency,
        modelId: primaryClient.id,
        providerName: primaryClient.id,
        sdk: primaryClient.sdk,
        modelName: primaryClient.modelName,
        fallbackProviderName: fallbackClient?.id ?? null,
        fallbackModelId: fallbackClient?.id ?? null,
        getLimiterStats: () => ({ active: requestLimiter.active, pending: requestLimiter.pending }),
    };
};
