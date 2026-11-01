import { createOpenAIAdapter } from "../../translation/sdk/openai.js";

// The gateway and the standalone provider use the same SDK and response handling.
export const createOpenAIChatAdapter = ({ connectionName, connection, model, apiKey }) => {
    const adapter = createOpenAIAdapter({
        id: connectionName,
        apiKey,
        baseURL: connection.url,
        modelName: model.model,
        timeoutMs: model.timeoutMs ?? connection.timeoutMs,
        concurrency: connection.concurrency,
        jsonMode: model.jsonMode,
        requestOptions: model.reasoning !== null
            ? { reasoning: { enabled: model.reasoning } } : {},
    });
    return {
        providerName: connectionName,
        modelName: model.model,
        call: ({ system, user, json, signal, maxOutputTokens }) =>
            adapter.callCompletion(system, user, json, { signal, maxOutputTokens }),
    };
};
