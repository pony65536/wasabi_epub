import { GoogleGenerativeAI } from "@google/generative-ai";
import { cleanAIResponse } from "../../utils.js";

/**
 * Gemini 原生适配器：gemini-native 格式的连接。
 * 不支持 response_format 与 reasoning 参数（由模型配置声明，网关不传）。
 */
export const createGeminiNativeAdapter = ({
    connectionName,
    connection,
    model,
    apiKey,
}) => {
    const genAI = new GoogleGenerativeAI(apiKey);
    const client = genAI.getGenerativeModel({ model: model.model });

    return {
        providerName: connectionName,
        modelName: model.model,
        async call({ system, user }) {
            const result = await client.generateContent(
                `${system}\n\nUser Input:\n${user}`,
            );
            const text = (await result.response).text().trim();
            if (!text) {
                const error = new Error("Provider returned empty content.");
                error.code = "EMPTY_CONTENT";
                throw error;
            }
            return {
                text: cleanAIResponse(text),
                finishReason: null,
                usage: null,
            };
        },
    };
};
