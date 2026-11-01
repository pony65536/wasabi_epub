import { GoogleGenerativeAI as DefaultGoogleGenerativeAI } from "@google/generative-ai";

export const createGoogleGenerativeAIAdapter = (
    model,
    { GoogleGenerativeAI = DefaultGoogleGenerativeAI } = {},
) => {
    const client = new GoogleGenerativeAI(model.apiKey);
    const requestOptions = model.baseURL
        ? { baseUrl: model.baseURL }
        : undefined;
    const generativeModel = client.getGenerativeModel(
        { model: model.modelName },
        requestOptions,
    );

    const callCompletion = async (systemInstruction, userContent, _forceJsonMode, { signal, maxOutputTokens } = {}) => {
        const result = await generativeModel.generateContent(
            { contents: [{ role: "user", parts: [{ text: `${systemInstruction}\n\nUser Input:\n${userContent}` }] }],
                ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}) },
            signal ? { signal } : undefined,
        );
        const response = await result.response;
        const text = response.text().trim();
        if (!text) {
            const error = new Error("Provider returned empty content.");
            error.code = "EMPTY_CONTENT";
            throw error;
        }
        if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
            const error = new Error("Provider response was truncated (MAX_TOKENS).");
            error.code = "OUTPUT_TRUNCATED";
            throw error;
        }
        return { text, usage: response.usageMetadata ? {
            prompt_tokens: response.usageMetadata.promptTokenCount,
            completion_tokens: response.usageMetadata.candidatesTokenCount,
        } : null };
    };
    const callRaw = async (...args) => (await callCompletion(...args)).text;

    return {
        id: model.id,
        sdk: model.sdk,
        modelName: model.modelName,
        concurrency: model.concurrency,
        timeoutMs: model.timeoutMs,
        callRaw,
        callCompletion,
    };
};
