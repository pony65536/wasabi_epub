import { normalizeModelConfig, synthesizeLegacyModelConfig } from "../models/config.js";

export const FALLBACK_ERRORS = [
    "content_policy", "model_missing", "auth", "network", "rate_limit", "timeout",
];

// Keep the public model registry and the gateway's connection-based scheduler in sync.
// Models using the same SDK, URL and credential variable share a connection limiter.
export const toGatewayConfig = (definitions, selection, source) => {
    const connections = {};
    const models = {};
    const connectionIds = new Map();
    const reservedIds = new Set([...definitions.values()].map((model) => model.connection).filter(Boolean));
    for (const [id, model] of definitions) {
        const signature = model.connection || JSON.stringify([model.sdk, model.baseURL, model.apiKeyEnv]);
        let connectionId = connectionIds.get(signature);
        if (!connectionId) {
            let index = connectionIds.size + 1;
            while (reservedIds.has(`connection-${index}`) || connections[`connection-${index}`]) index++;
            connectionId = model.connection || `connection-${index}`;
            connectionIds.set(signature, connectionId);
            connections[connectionId] = {
                url: model.baseURL || "https://generativelanguage.googleapis.com",
                format: model.sdk === "openai" ? "openai-chat" : "gemini-native",
                tokenEnv: model.apiKeyEnv,
                concurrency: model.concurrency,
                timeoutMs: model.timeoutMs,
            };
        } else {
            const existing = connections[connectionId];
            if (existing.url !== (model.baseURL || "https://generativelanguage.googleapis.com") ||
                existing.tokenEnv !== model.apiKeyEnv ||
                existing.format !== (model.sdk === "openai" ? "openai-chat" : "gemini-native")) {
                throw new Error(`Models sharing connection "${connectionId}" must use the same SDK, baseURL and apiKeyEnv.`);
            }
            connections[connectionId].concurrency = Math.min(
                connections[connectionId].concurrency, model.concurrency,
            );
        }
        models[id] = {
            connection: connectionId,
            model: model.modelName,
            jsonMode: model.jsonMode,
            reasoning: model.requestOptions.reasoning?.enabled ?? null,
            maxOutputTokens: model.maxOutputTokens,
            timeoutMs: model.timeoutMs,
        };
    }
    const normalized = normalizeModelConfig({
        connections, models,
        routing: {
            primary: selection.primary,
            fallback: selection.fallback?.model ?? null,
            stages: { glossary: selection.glossary.default, ...selection.stages },
            stageFallback: selection.stageFallback,
            stageRequirements: selection.stageRequirements,
            fallbackOnContentPolicy: selection.fallback?.onContentPolicy ?? true,
        },
    }, { source });
    normalized.routing.fallbackCategories = selection.fallback?.onErrors || ["content_policy"];
    return normalized;
};

export const fromLegacyConfig = (config, environment = null) => {
    const models = {};
    for (const [id, model] of Object.entries(config.models)) {
        const connection = config.connections[model.connection];
        models[id] = {
            sdk: connection.format === "openai-chat" ? "openai" : "@google/generative-ai",
            baseURL: connection.url,
            apiKeyEnv: connection.tokenEnv,
            modelName: model.model,
            connection: model.connection,
            concurrency: connection.concurrency,
            timeoutMs: model.timeoutMs ?? connection.timeoutMs,
            jsonMode: model.jsonMode,
            ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
            ...(model.reasoning !== null && connection.format === "openai-chat"
                ? { requestOptions: { reasoning: { enabled: model.reasoning } } } : {}),
        };
    }
    const result = {
        version: 1, models,
        selection: {
            primary: config.routing.primary,
            ...(config.routing.fallback ? { fallback: {
                model: config.routing.fallback,
                onContentPolicy: config.routing.fallbackOnContentPolicy,
                onErrors: FALLBACK_ERRORS.filter((category) =>
                    category !== "content_policy" || config.routing.fallbackOnContentPolicy),
            } } : {}),
            stages: config.routing.stages,
            stageFallback: config.routing.stageFallback,
            stageRequirements: config.routing.stageRequirements,
        },
    };
    if (environment && config.source === "legacy-env") {
        const bySourceLanguage = {};
        for (const language of ["Russian", "Japanese"]) {
            const localized = synthesizeLegacyModelConfig(environment, { sourceLanguage: language });
            if (!localized.routing.stages.glossary) continue;
            const converted = fromLegacyConfig(localized);
            const id = `legacy-${language.toLowerCase()}-glossary`;
            result.models[id] = converted.models.glossary;
            bySourceLanguage[language] = id;
        }
        result.selection.stages = { ...result.selection.stages };
        delete result.selection.stages.glossary;
        result.selection.glossary = { default: result.selection.primary, bySourceLanguage };
    }
    return result;
};
