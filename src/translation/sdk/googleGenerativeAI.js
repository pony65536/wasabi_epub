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

    const callRaw = async (systemInstruction, userContent) => {
        const result = await generativeModel.generateContent(
            `${systemInstruction}\n\nUser Input:\n${userContent}`,
        );
        return (await result.response).text().trim();
    };

    return {
        id: model.id,
        sdk: model.sdk,
        modelName: model.modelName,
        concurrency: model.concurrency,
        timeoutMs: model.timeoutMs,
        callRaw,
    };
};
