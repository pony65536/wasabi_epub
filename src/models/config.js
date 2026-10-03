import fs from "fs";
import path from "path";

/**
 * 模型配置加载：connections（连接）+ models（模型）+ routing（阶段路由）。
 *
 * 来源优先级：WASABI_MODELS_FILE > <projectRoot>/models.json > legacy env 合成。
 * 连接只保存 url/format/tokenEnv 与限额；密钥永远从 tokenEnv 指向的环境变量读取。
 */

export const MODEL_CONFIG_VERSION = 1;
export const SUPPORTED_CONNECTION_FORMATS = new Set([
    "openai-chat",
    "gemini-native",
]);
export const MODEL_STAGES = [
    "planner",
    "translation",
    "director",
    "glossary",
    "memory",
    "critic",
    "headings",
];
export const MODEL_CAPABILITIES = ["jsonMode", "reasoning"];

const DEFAULT_BASE_URLS = {
    gemini: "https://generativelanguage.googleapis.com",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mimo: "https://api.xiaomimimo.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
};

const DEFAULT_MODELS = {
    gemini: "gemini-2.5-pro",
    qwen: "qwen-plus",
    mimo: "mimo-v2-pro",
    openrouter: "x-ai/grok-4.3",
};

const LEGACY_GLOSSARY_DEFAULTS = {
    Russian: {
        providerEnv: "RUSSIAN_GLOSSARY_PROVIDER",
        modelEnv: "RUSSIAN_GLOSSARY_MODEL",
        defaultModel: "mistralai/mistral-small-3.1-24b-instruct",
    },
    Japanese: {
        providerEnv: "JAPANESE_GLOSSARY_PROVIDER",
        modelEnv: "JAPANESE_GLOSSARY_MODEL",
        defaultModel: "anthropic/claude-sonnet-4.5",
    },
};

const envInt = (value, fallback) => {
    if (value == null || value === "") return fallback;
    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const envFlag = (value, fallback = false) => {
    if (value == null || value === "") return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const normalizeName = (value, fallback = null) => {
    const normalized = String(value || fallback || "").trim().toLowerCase();
    return normalized || null;
};

const formatForConnection = (name) =>
    name === "gemini" ? "gemini-native" : "openai-chat";

const assert = (condition, message) => {
    if (!condition) {
        throw new Error(`Invalid model config: ${message}`);
    }
};

const assertBoolean = (value, label, fallback = false) => {
    if (value === undefined) return fallback;
    assert(typeof value === "boolean", `${label} must be a boolean`);
    return value;
};

const assertOptionalBoolean = (value, label) => {
    if (value === undefined || value === null) return null;
    assert(typeof value === "boolean", `${label} must be a boolean`);
    return value;
};

const assertOptionalPositiveInt = (value, label) => {
    if (value === undefined || value === null) return null;
    assert(
        Number.isInteger(value) && value > 0,
        `${label} must be a positive integer`,
    );
    return value;
};

const assertPositiveInt = (value, label, fallback) => {
    if (value === undefined || value === null) return fallback;
    assert(
        Number.isInteger(value) && value > 0,
        `${label} must be a positive integer`,
    );
    return value;
};

export const normalizeModelConfig = (raw, { source = "models.json" } = {}) => {
    assert(raw && typeof raw === "object", `${source} must be an object`);

    const connections = {};
    for (const [name, conn] of Object.entries(raw.connections || {})) {
        assert(conn?.url, `connection "${name}" is missing url`);
        assert(
            SUPPORTED_CONNECTION_FORMATS.has(conn.format),
            `connection "${name}" has unsupported format "${conn.format}"`,
        );
        assert(conn.tokenEnv, `connection "${name}" is missing tokenEnv`);
        connections[name] = {
            url: String(conn.url),
            format: conn.format,
            tokenEnv: String(conn.tokenEnv),
            concurrency: assertPositiveInt(
                conn.concurrency,
                `connections.${name}.concurrency`,
                5,
            ),
            timeoutMs: assertPositiveInt(
                conn.timeoutMs,
                `connections.${name}.timeoutMs`,
                90000,
            ),
        };
    }

    const models = {};
    for (const [name, model] of Object.entries(raw.models || {})) {
        assert(model?.connection, `model "${name}" is missing connection`);
        assert(
            connections[model.connection],
            `model "${name}" references unknown connection "${model.connection}"`,
        );
        assert(model.model, `model "${name}" is missing model id`);
        models[name] = {
            connection: model.connection,
            model: String(model.model),
            jsonMode: assertBoolean(
                model.jsonMode,
                `models.${name}.jsonMode`,
                false,
            ),
            reasoning: assertOptionalBoolean(
                model.reasoning,
                `models.${name}.reasoning`,
            ),
            maxOutputTokens: assertOptionalPositiveInt(
                model.maxOutputTokens,
                `models.${name}.maxOutputTokens`,
            ),
            timeoutMs: assertOptionalPositiveInt(
                model.timeoutMs,
                `models.${name}.timeoutMs`,
            ),
        };
    }

    const routingRaw = raw.routing || {};
    assert(routingRaw.primary, "routing.primary is required");
    assert(
        models[routingRaw.primary],
        `routing.primary references unknown model "${routingRaw.primary}"`,
    );

    const stages = {};
    for (const [stage, modelName] of Object.entries(routingRaw.stages || {})) {
        assert(
            MODEL_STAGES.includes(stage),
            `unknown stage "${stage}" in routing.stages`,
        );
        assert(
            models[modelName],
            `routing.stages.${stage} references unknown model "${modelName}"`,
        );
        stages[stage] = modelName;
    }

    const stageFallback = {};
    for (const [stage, fallbackName] of Object.entries(
        routingRaw.stageFallback || {},
    )) {
        assert(
            MODEL_STAGES.includes(stage),
            `unknown stage "${stage}" in routing.stageFallback`,
        );
        if (fallbackName === null) {
            stageFallback[stage] = null;
            continue;
        }
        assert(
            models[fallbackName],
            `routing.stageFallback.${stage} references unknown model "${fallbackName}"`,
        );
        stageFallback[stage] = fallbackName;
    }

    const stageRequirements = {};
    for (const [stage, capabilities] of Object.entries(
        routingRaw.stageRequirements || {},
    )) {
        assert(
            MODEL_STAGES.includes(stage),
            `unknown stage "${stage}" in routing.stageRequirements`,
        );
        assert(
            Array.isArray(capabilities),
            `routing.stageRequirements.${stage} must be an array`,
        );
        for (const capability of capabilities) {
            assert(
                MODEL_CAPABILITIES.includes(capability),
                `unknown capability "${capability}" in routing.stageRequirements.${stage}`,
            );
        }
        stageRequirements[stage] = [...capabilities];
    }

    let fallback = routingRaw.fallback ?? null;
    if (fallback !== null) {
        assert(
            models[fallback],
            `routing.fallback references unknown model "${fallback}"`,
        );
    }

    return {
        version: MODEL_CONFIG_VERSION,
        source,
        connections,
        models,
        routing: {
            primary: routingRaw.primary,
            fallback,
            stages,
            stageFallback,
            stageRequirements,
            fallbackOnContentPolicy: assertBoolean(
                routingRaw.fallbackOnContentPolicy,
                "routing.fallbackOnContentPolicy",
                true,
            ),
        },
    };
};

const buildLegacyConnection = (env, name) => ({
    url:
        env[`${name.toUpperCase()}_BASE_URL`] ||
        DEFAULT_BASE_URLS[name] ||
        "",
    format: formatForConnection(name),
    tokenEnv: `${name.toUpperCase()}_API_KEY`,
    concurrency: envInt(
        env[`${name.toUpperCase()}_CONCURRENCY`] || env.PROVIDER_CONCURRENCY,
        5,
    ),
    timeoutMs: envInt(
        env[`${name.toUpperCase()}_TIMEOUT_MS`] || env.PROVIDER_TIMEOUT_MS,
        90000,
    ),
});

export const synthesizeLegacyModelConfig = (
    env = process.env,
    { sourceLanguage } = {},
) => {
    const primaryName = normalizeName(
        env.PRIMARY_PROVIDER || env.PROVIDER,
        "qwen",
    );
    // 与旧 config.js 保持一致：FALLBACK_PROVIDER 未设置时默认 openrouter
    const fallbackName = normalizeName(env.FALLBACK_PROVIDER, "openrouter");

    const connections = {};
    const models = {};
    const legacyWarnings = [];

    const addConnection = (name) => {
        if (!connections[name]) {
            connections[name] = buildLegacyConnection(env, name);
        }
    };

    const addModel = (configName, providerName, modelId) => {
        addConnection(providerName);
        models[configName] = {
            connection: providerName,
            model: modelId,
            jsonMode: providerName !== "gemini",
            // 只有 openrouter 类中转才发送 reasoning 参数；其它连接为 null（不发送）
            reasoning:
                providerName === "openrouter"
                    ? envFlag(env.OPENROUTER_REASONING_ENABLED, true)
                    : null,
            maxOutputTokens: null,
            timeoutMs: null,
        };
    };

    const providerModelEnv = `${primaryName.toUpperCase()}_MODEL`;
    const primaryModelId =
        env[providerModelEnv] ||
        env.PRIMARY_MODEL ||
        DEFAULT_MODELS[primaryName] ||
        `${primaryName}-default`;
    if (
        env[providerModelEnv] &&
        env.PRIMARY_MODEL &&
        env[providerModelEnv] !== env.PRIMARY_MODEL
    ) {
        legacyWarnings.push(
            `Legacy env precedence: ${providerModelEnv}="${env[providerModelEnv]}" overrides PRIMARY_MODEL="${env.PRIMARY_MODEL}".`,
        );
    }
    addModel("primary", primaryName, primaryModelId);

    const fallbackOnContentPolicy = envFlag(
        env.FALLBACK_ON_CONTENT_POLICY || env.FALLBACK_ON_CONTENT_FILTER,
        true,
    );

    let fallback = null;
    // 旧语义：FALLBACK_ON_CONTENT_POLICY=false 时不启用 fallback
    if (fallbackName && fallbackOnContentPolicy) {
        const fallbackProviderModelEnv = `${fallbackName.toUpperCase()}_MODEL`;
        const fallbackModelId =
            env[fallbackProviderModelEnv] ||
            env.FALLBACK_MODEL ||
            DEFAULT_MODELS[fallbackName] ||
            `${fallbackName}-default`;
        // 同一连接但不同模型也应保留为主备
        if (
            fallbackName !== primaryName ||
            fallbackModelId !== primaryModelId
        ) {
            addModel("fallback", fallbackName, fallbackModelId);
            fallback = "fallback";
        }
    }

    const stages = {};
    const glossarySpec = LEGACY_GLOSSARY_DEFAULTS[sourceLanguage];
    if (glossarySpec) {
        const providerName = normalizeName(
            env[glossarySpec.providerEnv],
            "openrouter",
        );
        const hasKey = Boolean(
            env[`${providerName.toUpperCase()}_API_KEY`],
        );
        if (hasKey) {
            addModel(
                "glossary",
                providerName,
                env[glossarySpec.modelEnv] || glossarySpec.defaultModel,
            );
            stages.glossary = "glossary";
        }
    }

    return {
        version: MODEL_CONFIG_VERSION,
        source: "legacy-env",
        legacyWarnings,
        connections,
        models,
        routing: {
            primary: "primary",
            fallback,
            stages,
            stageFallback: {},
            stageRequirements: {},
            fallbackOnContentPolicy,
        },
    };
};

export const loadModelConfig = ({
    projectRoot,
    env = process.env,
    sourceLanguage,
} = {}) => {
    const explicit = env.WASABI_MODELS_FILE;
    if (explicit) {
        const explicitFile = path.resolve(projectRoot || ".", explicit);
        if (!fs.existsSync(explicitFile)) {
            throw new Error(
                `WASABI_MODELS_FILE points to a missing file: ${explicitFile}`,
            );
        }
        let explicitRaw;
        try {
            explicitRaw = JSON.parse(
                fs.readFileSync(explicitFile, "utf8"),
            );
        } catch (error) {
            throw new Error(
                `Failed to parse model config ${explicitFile}: ${error.message}`,
            );
        }
        return normalizeModelConfig(explicitRaw, {
            source: explicitFile,
        });
    }

    const file = path.join(projectRoot || ".", "models.json");
    if (fs.existsSync(file)) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (error) {
            throw new Error(
                `Failed to parse model config ${file}: ${error.message}`,
            );
        }
        return normalizeModelConfig(raw, { source: file });
    }

    return synthesizeLegacyModelConfig(env, { sourceLanguage });
};
