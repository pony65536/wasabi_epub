import DefaultOpenAI from "openai";
import { parseSseCompletion, readCompletionContent } from "../../models/response.js";
import { cleanAIResponse } from "../../utils.js";

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
        maxRetries: 0,
    });

    const callCompletion = async (
        systemInstruction,
        userContent,
        forceJsonMode,
        { signal, maxOutputTokens } = {},
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
            ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
            ...(forceJsonMode && model.jsonMode !== false && {
                response_format: { type: "json_object" },
            }),
        };
        const completion = await client.chat.completions.create(options, signal ? { signal } : undefined);
        let text;
        if (typeof completion === "string") {
            text = completion.includes("data:") ? parseSseCompletion(completion) : completion.trim();
            if (!text) {
                const error = new Error("SSE response contained no assistant content (reasoning-only or empty).");
                error.code = "EMPTY_CONTENT";
                throw error;
            }
        } else {
            text = readCompletionContent(completion);
        }
        return { text: cleanAIResponse(text), usage: completion?.usage || null,
            finishReason: completion?.choices?.[0]?.finish_reason || null };
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
