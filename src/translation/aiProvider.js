import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

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
        });
        _callRaw = async (systemInstruction, userContent, forceJson) => {
            const options = {
                model: providerConfig.modelName,
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent },
                ],
                ...(providerConfig.requestOptions || {}),
                ...(forceJson && { response_format: { type: "json_object" } }),
            };
            const completion = await client.chat.completions.create(options);
            return completion.choices[0].message.content.trim();
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

    const callWithClient = async (
        client,
        userContent,
        systemInstruction,
        forceJsonMode,
    ) => {
        logger.write(
            "REQUEST",
            `PROVIDER: ${client.providerName}\nMODEL: ${client.modelName}\nSYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
        );
        const responseText = await client.callRaw(
            systemInstruction,
            userContent,
            forceJsonMode,
        );
        logger.write(
            "RESPONSE",
            `PROVIDER: ${client.providerName}\nMODEL: ${client.modelName}\n${responseText}`,
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
    };
};
