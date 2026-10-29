import DefaultOpenAI from "openai";

const RESERVED_REQUEST_KEYS = new Set([
    "model",
    "messages",
    "response_format",
    "stream",
    "apiKey",
    "baseURL",
    "timeout",
]);

export const createOpenAIAdapter = (
    model,
    { OpenAI = DefaultOpenAI } = {},
) => {
    const client = new OpenAI({
        apiKey: model.apiKey,
        baseURL: model.baseURL,
        timeout: model.timeoutMs,
    });

    const callRaw = async (
        systemInstruction,
        userContent,
        forceJsonMode,
    ) => {
        const requestOptions = { ...(model.requestOptions || {}) };
        for (const key of Object.keys(requestOptions)) {
            if (RESERVED_REQUEST_KEYS.has(key)) {
                throw new Error(
                    `requestOptions must not override reserved key "${key}"`,
                );
            }
        }

        const options = {
            ...requestOptions,
            model: model.modelName,
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userContent },
            ],
            ...(forceJsonMode && {
                response_format: { type: "json_object" },
            }),
        };
        const completion = await client.chat.completions.create(options);
        return completion.choices[0].message.content.trim();
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
