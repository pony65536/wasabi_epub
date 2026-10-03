import OpenAI from "openai";
import { cleanAIResponse } from "../../utils.js";
import {
    parseSseCompletion,
    readCompletionContent,
} from "../response.js";

/**
 * OpenAI Chat 兼容适配器：openai-chat 格式的连接（含各类中转）。
 * 能力由模型配置决定：jsonMode → response_format；reasoning（非 null）→ reasoning 参数。
 */
export const createOpenAIChatAdapter = ({
    connectionName,
    connection,
    model,
    apiKey,
}) => {
    const client = new OpenAI({
        apiKey,
        baseURL: connection.url,
        timeout: model.timeoutMs ?? connection.timeoutMs,
        maxRetries: 0,
    });

    return {
        providerName: connectionName,
        modelName: model.model,
        async call({ system, user, json = false, signal, maxOutputTokens }) {
            const options = {
                model: model.model,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
                ...(model.jsonMode && json
                    ? { response_format: { type: "json_object" } }
                    : {}),
                ...(model.reasoning !== null
                    ? { reasoning: { enabled: model.reasoning } }
                    : {}),
            };

            const completion = await client.chat.completions.create(
                options,
                signal ? { signal } : undefined,
            );

            // 某些中转在 JSON 模式下返回 SSE 字符串
            if (typeof completion === "string") {
                if (completion.includes("data:")) {
                    const sseContent = parseSseCompletion(completion);
                    if (sseContent) {
                        return {
                            text: cleanAIResponse(sseContent),
                            finishReason: null,
                            usage: null,
                        };
                    }
                    const error = new Error(
                        "SSE response contained no assistant content (reasoning-only or empty).",
                    );
                    error.code = "EMPTY_CONTENT";
                    throw error;
                }
                return {
                    text: cleanAIResponse(completion.trim()),
                    finishReason: null,
                    usage: null,
                };
            }

            const text = readCompletionContent(completion);
            return {
                text: cleanAIResponse(text),
                finishReason:
                    completion?.choices?.[0]?.finish_reason || null,
                usage: completion?.usage || null,
            };
        },
    };
};
