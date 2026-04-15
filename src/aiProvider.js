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
                    logger.write(
                        "ERROR",
                        `Fallback callAI Failed: ${fallbackError.stack || fallbackError.message}`,
                    );
                    throw fallbackError;
                }
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
