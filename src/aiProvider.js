import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

export const createAIProvider = (providerName, config, logger) => {
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
                ...(forceJson && { response_format: { type: "json_object" } }),
            };
            const completion = await client.chat.completions.create(options);
            return completion.choices[0].message.content.trim();
        };
    }

    const callAI = async (
        userContent,
        systemInstruction,
        forceJsonMode = false,
    ) => {
        if (!userContent?.trim()) return "";
        logger.write(
            "REQUEST",
            `SYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`,
        );
        try {
            const responseText = await _callRaw(
                systemInstruction,
                userContent,
                forceJsonMode,
            );
            logger.write("RESPONSE", responseText);
            return responseText;
        } catch (e) {
            logger.write("ERROR", `callAI Failed: ${e.stack || e.message}`);
            throw e;
        }
    };

    return {
        callAI,
        concurrency: providerConfig.concurrency,
        modelName: providerConfig.modelName,
    };
};
