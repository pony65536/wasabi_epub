import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { createRequestLimiter } from "./requestLimiter.js";
import {
    classifyProviderError,
    isContentPolicyError,
} from "../models/errors.js";
import {
    parseSseCompletion,
    readCompletionContent,
} from "../models/response.js";

export { classifyProviderError, isContentPolicyError };
export { parseSseCompletion, readCompletionContent };

const buildDeprecatedModelGuidance = (client, err) => {
    const message = String(err?.message || "");
    const normalized = message.toLowerCase();
    const isDeprecatedModelError =
        normalized.includes("deprecated") ||
        normalized.includes("decommissioned") ||
        normalized.includes("no longer available") ||
        normalized.includes("model not found") ||
        normalized.includes("unknown model");

    if (!isDeprecatedModelError) return null;

    const providerLine = `Provider: ${client.providerName}`;
    const modelLine = `Model: ${client.modelName}`;

    if (client.providerName === "openrouter") {
        return [
            "Configured fallback model is no longer available.",
            providerLine,
            modelLine,
            "",
            "Update your environment config, for example:",
            "FALLBACK_MODEL=x-ai/grok-4.3",
            "OPENROUTER_MODEL=x-ai/grok-4.3",
        ].join("\n");
    }

    return [
        "Configured model is no longer available.",
        providerLine,
        modelLine,
        "",
        "Update the model name in your environment configuration.",
    ].join("\n");
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
                    try {
                        onTimeout?.();
                    } catch {}
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const buildProviderClient = (providerName, config) => {
    const providerConfig = config[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);

    let _callRaw;

    if (providerName === "gemini") {
        const genAI = new GoogleGenerativeAI(providerConfig.apiKey);
        const model = genAI.getGenerativeModel({
            model: providerConfig.modelName,
        });
        _callRaw = async (systemInstruction, userContent) => {
            const result = await model.generateContent(
                `${systemInstruction}\n\nUser Input:\n${userContent}`,
            );
            return (await result.response).text().trim();
        };
    } else {
        const client = new OpenAI({
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseURL,
            timeout: providerConfig.timeoutMs,
        });
        _callRaw = async (systemInstruction, userContent, forceJson, requestOptions = {}) => {
            const { signal, ...bodyOptions } = requestOptions;
            const options = {
                model: providerConfig.modelName,
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent },
                ],
                ...(providerConfig.requestOptions || {}),
                ...(forceJson && { response_format: { type: "json_object" } }),
            };
            // signal 必须作为请求选项传入（第二参数），不能混进请求正文
            const completion = await client.chat.completions.create(
                options,
                signal ? { signal } : undefined,
            );
            // 兼容某些第三方中转站当传入 response_format 时强行返回 SSE string 的情况
            if (typeof completion === "string") {
                if (completion.includes("data:")) {
                    const sseContent = parseSseCompletion(completion);
                    if (sseContent) return sseContent;
                    // 禁止把原始 SSE 协议内容当成译文写回（例如只有 reasoning 增量）
                    const sseError = new Error(
                        "SSE response contained no assistant content (reasoning-only or empty).",
                    );
                    sseError.code = "EMPTY_CONTENT";
                    throw sseError;
                }
                return completion.trim();
            }
            return readCompletionContent(completion);
        };
    }

    return {
        providerName,
        providerConfig,
        modelName: providerConfig.modelName,
        concurrency: providerConfig.concurrency,
        callRaw: _callRaw,
    };
};

export const createAIProvider = (
    providerName,
    config,
    logger,
    fallbackProviderName = null,
    fallbackOnContentPolicy = false,
) => {
    const primaryClient = buildProviderClient(providerName, config);
    const shouldEnableFallback =
        Boolean(fallbackOnContentPolicy) &&
        Boolean(fallbackProviderName) &&
        fallbackProviderName !== providerName;
    const fallbackClient = shouldEnableFallback
        ? buildProviderClient(fallbackProviderName, config)
        : null;
    // 正文与辅助请求共用同一个限流器，避免辅助调用绕过并发上限
    const requestLimiter = createRequestLimiter(primaryClient.concurrency || 4);

    const callWithClient = async (
        client,
        userContent,
        systemInstruction,
        forceJsonMode,
    ) => {
        logger.write(
            "REQUEST",
            `PROVIDER: ${client.providerName}\nMODEL: ${client.modelName}\nTIMEOUT_MS: ${client.providerConfig.timeoutMs ?? "none"}\nSYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
        );
        const startedAt = Date.now();
        const controller = new AbortController();
        const responseText = await requestLimiter.run(() =>
            withTimeout(
                client.callRaw(
                    systemInstruction,
                    userContent,
                    forceJsonMode,
                    { signal: controller.signal },
                ),
                client.providerConfig.timeoutMs,
                `${client.providerName}:${client.modelName}`,
                () => controller.abort(),
            ),
        );
        logger.write(
            "RESPONSE",
            `PROVIDER: ${client.providerName}\nMODEL: ${client.modelName}\nELAPSED_MS: ${Date.now() - startedAt}\n${responseText}`,
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
                userContent,
                systemInstruction,
                forceJsonMode,
            );
        } catch (e) {
            if (fallbackClient && isContentPolicyError(e)) {
                logger.write(
                    "WARN",
                    `Content policy triggered on provider "${primaryClient.providerName}". Falling back to "${fallbackClient.providerName}". Original error: ${e.message}`,
                );
                try {
                    return await callWithClient(
                        fallbackClient,
                        userContent,
                        systemInstruction,
                        forceJsonMode,
                    );
                } catch (fallbackError) {
                    const guidance = buildDeprecatedModelGuidance(
                        fallbackClient,
                        fallbackError,
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

            const guidance = buildDeprecatedModelGuidance(primaryClient, e);
            if (guidance) {
                e.message = `${e.message}\n\n${guidance}`;
            }
            logger.write(
                "ERROR",
                `callAI Failed: ${e.stack || e.message}`,
            );
            throw e;
        }
    };

    return {
        callAI,
        concurrency: primaryClient.concurrency,
        modelName: primaryClient.modelName,
        providerName: primaryClient.providerName,
        fallbackProviderName: fallbackClient?.providerName ?? null,
        getLimiterStats: () => ({
            active: requestLimiter.active,
            pending: requestLimiter.pending,
        }),
    };
};
