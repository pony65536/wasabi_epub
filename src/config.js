import fs from "node:fs";
import path from "node:path";

// =================== 核心设置 ===================
const env = process.env;

const normalizeProvider = (value, fallback) =>
    (value || fallback || "").trim().toLowerCase();

const envFlag = (value, fallback = false) => {
    if (value == null || value === "") return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const envInt = (value, fallback) => {
    if (value == null || value === "") return fallback;
    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getProviderModel = (providerName, defaultModel) => {
    const upper = providerName.toUpperCase();
    const directEnvModel = env[`${upper}_MODEL`];
    if (directEnvModel) return directEnvModel;

    if (CURRENT_PROVIDER === providerName && env.PRIMARY_MODEL) {
        return env.PRIMARY_MODEL;
    }

    if (FALLBACK_PROVIDER === providerName && env.FALLBACK_MODEL) {
        return env.FALLBACK_MODEL;
    }

    return defaultModel;
};

const getProviderTimeoutMs = (providerName, defaultTimeoutMs = 90000) => {
    const upper = providerName.toUpperCase();
    return envInt(
        env[`${upper}_TIMEOUT_MS`] || env.PROVIDER_TIMEOUT_MS,
        defaultTimeoutMs,
    );
};

export const CURRENT_PROVIDER = normalizeProvider(
    env.PRIMARY_PROVIDER || env.PROVIDER,
    "qwen",
);
export const FALLBACK_PROVIDER = normalizeProvider(env.FALLBACK_PROVIDER, "openrouter");
export const FALLBACK_ON_CONTENT_POLICY = envFlag(
    env.FALLBACK_ON_CONTENT_POLICY || env.FALLBACK_ON_CONTENT_FILTER,
    true,
);
export const DEFAULT_SOURCE_LANGUAGE = "English";
export const DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";

export const RUSSIAN_GLOSSARY_PROVIDER = normalizeProvider(
    env.RUSSIAN_GLOSSARY_PROVIDER,
    "openrouter",
);
export const RUSSIAN_GLOSSARY_MODEL =
    env.RUSSIAN_GLOSSARY_MODEL ||
    "mistralai/mistral-small-3.1-24b-instruct";
export const JAPANESE_GLOSSARY_PROVIDER = normalizeProvider(
    env.JAPANESE_GLOSSARY_PROVIDER,
    "openrouter",
);
export const JAPANESE_GLOSSARY_MODEL =
    env.JAPANESE_GLOSSARY_MODEL ||
    "anthropic/claude-sonnet-4.5";

export const CONFIG = {
    sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
        modelName: getProviderModel("gemini", "gemini-2.5-pro"),
        concurrency: 5,
        timeoutMs: getProviderTimeoutMs("gemini"),
    },
    qwen: {
        apiKey: process.env.QWEN_API_KEY,
        baseURL:
            process.env.QWEN_BASE_URL ||
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: getProviderModel("qwen", "qwen-plus"),
        concurrency: 5,
        timeoutMs: getProviderTimeoutMs("qwen"),
    },
    mimo: {
        apiKey: process.env.MIMO_API_KEY,
        baseURL: process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1",
        modelName: getProviderModel("mimo", "mimo-v2-pro"),
        concurrency: 5,
        timeoutMs: getProviderTimeoutMs("mimo"),
    },
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        modelName: getProviderModel("openrouter", "x-ai/grok-4.3"),
        concurrency: 5,
        timeoutMs: getProviderTimeoutMs("openrouter"),
        requestOptions: {
            reasoning: {
                enabled: envFlag(process.env.OPENROUTER_REASONING_ENABLED, true),
            },
        },
    },
};

export const createRuntimeConfig = ({
    sourceLanguage = DEFAULT_SOURCE_LANGUAGE,
    targetLanguage = DEFAULT_TARGET_LANGUAGE,
    concurrency = null,
} = {}) => {
    const runtimeConfig = {
        ...CONFIG,
        sourceLanguage,
        targetLanguage,
        gemini: { ...CONFIG.gemini },
        qwen: { ...CONFIG.qwen },
        mimo: { ...CONFIG.mimo },
        openrouter: {
            ...CONFIG.openrouter,
            requestOptions: {
                ...(CONFIG.openrouter.requestOptions || {}),
            },
        },
    };

    if (concurrency) {
        for (const providerName of ["gemini", "qwen", "mimo", "openrouter"]) {
            runtimeConfig[providerName].concurrency = concurrency;
        }
    }

    return runtimeConfig;
};

export const buildStyleGuide = (targetLanguage) => `
TRANSLATION STYLE GUIDE (Target: ${targetLanguage}):
1. **Write Natural ${targetLanguage}**: Prefer clear, accurate, fluent modern language over mechanical source-like syntax.
2. **Adapt to Genre**: Keep expository, scientific, or technical passages clearer and more direct; allow more expressive wording when the source is narrative or literary.
3. **Keep the Meaning Intact**: Preserve logical relations, semantic links, and meaningful modifiers, including scope, degree, contrast, sequence, jointly, respectively, collectively, and simultaneously.
4. **Split When Helpful**: Break long sentences when it improves clarity, but keep the full meaning and flow.
5. **Use Style with Restraint**: Idioms or more refined wording are welcome when natural and fitting, but avoid showy or over-elevated phrasing.
6. **Keep It Clean**: Do not add glossary-style notes, bilingual pairs, translator comments, or explanatory brackets unless they appear in the source.

HEADING FORMATTING RULES:
1. **Consistency**: Table of Contents must match Main Body.
2. **Preserve Prefix**: Keep numeric/alphabetic numbering prefix (e.g. "1.2 ", "A. ") as-is; only translate the title text after it.
`;

const CONFIG_VERSION = 1;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SUPPORTED_SDKS = new Set(["openai", "@google/generative-ai"]);
const TOP_LEVEL_FIELDS = new Set(["version", "models", "selection"]);
const MODEL_FIELDS = new Set([
    "sdk",
    "baseURL",
    "apiKeyEnv",
    "modelName",
    "concurrency",
    "timeoutMs",
    "requestOptions",
]);
const SELECTION_FIELDS = new Set(["primary", "fallback", "glossary"]);
const FALLBACK_FIELDS = new Set(["model", "onContentPolicy"]);
const GLOSSARY_FIELDS = new Set(["default", "bySourceLanguage"]);
const GLOSSARY_LANGUAGES = new Set(["Russian", "Japanese"]);
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 90000;

const configError = (filePath, field, message) =>
    new Error(`Invalid config (${filePath}: ${field}): ${message}`);

const assertObject = (value, filePath, field) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw configError(filePath, field, "expected an object");
    }
};

const assertNoUnknownFields = (value, allowed, filePath, field) => {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw configError(
                filePath,
                field ? `${field}.${key}` : key,
                "unknown field",
            );
        }
    }
};

const assertNonEmptyString = (value, filePath, field) => {
    if (typeof value !== "string" || !value.trim()) {
        throw configError(filePath, field, "expected a non-empty string");
    }
};

const assertPositiveInteger = (value, filePath, field) => {
    if (!Number.isInteger(value) || value <= 0) {
        throw configError(filePath, field, "expected a positive integer");
    }
};

const validateBaseURL = (value, filePath, field) => {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw configError(filePath, field, "expected a valid http(s) URL");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw configError(filePath, field, "expected a http(s) URL");
    }
    if (parsed.username || parsed.password) {
        throw configError(filePath, field, "URL must not contain credentials");
    }
};

const validateRequestOptions = (rawModel, filePath, field) => {
    if (rawModel.requestOptions === undefined) return {};

    if (rawModel.sdk !== "openai") {
        throw configError(
            filePath,
            field,
            "requestOptions is only supported for sdk \"openai\"",
        );
    }

    assertObject(rawModel.requestOptions, filePath, field);
    assertNoUnknownFields(
        rawModel.requestOptions,
        new Set(["reasoning"]),
        filePath,
        field,
    );

    const reasoning = rawModel.requestOptions.reasoning;
    if (reasoning === undefined) return {};

    assertObject(reasoning, filePath, `${field}.reasoning`);
    assertNoUnknownFields(
        reasoning,
        new Set(["enabled"]),
        filePath,
        `${field}.reasoning`,
    );
    if (typeof reasoning.enabled !== "boolean") {
        throw configError(
            filePath,
            `${field}.reasoning.enabled`,
            "expected a boolean",
        );
    }

    return { reasoning: { enabled: reasoning.enabled } };
};

const validateModel = (id, rawModel, filePath) => {
    if (!MODEL_ID_PATTERN.test(id)) {
        throw configError(
            filePath,
            `models.${id}`,
            "model id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$",
        );
    }

    assertObject(rawModel, filePath, `models.${id}`);
    assertNoUnknownFields(rawModel, MODEL_FIELDS, filePath, `models.${id}`);

    if (!SUPPORTED_SDKS.has(rawModel.sdk)) {
        throw configError(
            filePath,
            `models.${id}.sdk`,
            `expected one of: ${[...SUPPORTED_SDKS].join(", ")}`,
        );
    }

    if (rawModel.sdk === "openai" && rawModel.baseURL === undefined) {
        throw configError(
            filePath,
            `models.${id}.baseURL`,
            "baseURL is required for sdk \"openai\"",
        );
    }
    if (rawModel.baseURL !== undefined) {
        assertNonEmptyString(
            rawModel.baseURL,
            filePath,
            `models.${id}.baseURL`,
        );
        validateBaseURL(rawModel.baseURL, filePath, `models.${id}.baseURL`);
    }

    assertNonEmptyString(rawModel.apiKeyEnv, filePath, `models.${id}.apiKeyEnv`);
    if (!ENV_NAME_PATTERN.test(rawModel.apiKeyEnv)) {
        throw configError(
            filePath,
            `models.${id}.apiKeyEnv`,
            "expected an environment variable name",
        );
    }

    assertNonEmptyString(rawModel.modelName, filePath, `models.${id}.modelName`);

    const concurrency = rawModel.concurrency ?? DEFAULT_CONCURRENCY;
    assertPositiveInteger(
        concurrency,
        filePath,
        `models.${id}.concurrency`,
    );

    const timeoutMs = rawModel.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertPositiveInteger(timeoutMs, filePath, `models.${id}.timeoutMs`);

    const requestOptions = validateRequestOptions(
        rawModel,
        filePath,
        `models.${id}.requestOptions`,
    );

    return {
        id,
        sdk: rawModel.sdk,
        baseURL: rawModel.baseURL ?? null,
        apiKeyEnv: rawModel.apiKeyEnv,
        modelName: rawModel.modelName,
        concurrency,
        timeoutMs,
        requestOptions,
    };
};

const validateConfig = (rawConfig, filePath) => {
    assertObject(rawConfig, filePath, "<root>");
    assertNoUnknownFields(rawConfig, TOP_LEVEL_FIELDS, filePath, "");

    if (rawConfig.version !== CONFIG_VERSION) {
        throw configError(
            filePath,
            "version",
            `expected ${CONFIG_VERSION}`,
        );
    }

    assertObject(rawConfig.models, filePath, "models");
    const models = new Map();
    for (const [id, rawModel] of Object.entries(rawConfig.models)) {
        models.set(id, validateModel(id, rawModel, filePath));
    }
    if (models.size === 0) {
        throw configError(filePath, "models", "at least one model is required");
    }

    assertObject(rawConfig.selection, filePath, "selection");
    assertNoUnknownFields(
        rawConfig.selection,
        SELECTION_FIELDS,
        filePath,
        "selection",
    );

    assertNonEmptyString(
        rawConfig.selection.primary,
        filePath,
        "selection.primary",
    );
    const primaryId = rawConfig.selection.primary;
    if (!models.has(primaryId)) {
        throw configError(
            filePath,
            "selection.primary",
            `unknown model id "${primaryId}"`,
        );
    }

    let fallback = null;
    if (rawConfig.selection.fallback !== undefined) {
        const rawFallback = rawConfig.selection.fallback;
        assertObject(rawFallback, filePath, "selection.fallback");
        assertNoUnknownFields(
            rawFallback,
            FALLBACK_FIELDS,
            filePath,
            "selection.fallback",
        );
        assertNonEmptyString(
            rawFallback.model,
            filePath,
            "selection.fallback.model",
        );
        if (!models.has(rawFallback.model)) {
            throw configError(
                filePath,
                "selection.fallback.model",
                `unknown model id "${rawFallback.model}"`,
            );
        }
        if (rawFallback.model === primaryId) {
            throw configError(
                filePath,
                "selection.fallback.model",
                "fallback model must differ from primary",
            );
        }
        if (
            rawFallback.onContentPolicy !== undefined &&
            typeof rawFallback.onContentPolicy !== "boolean"
        ) {
            throw configError(
                filePath,
                "selection.fallback.onContentPolicy",
                "expected a boolean",
            );
        }
        const onContentPolicy = rawFallback.onContentPolicy ?? true;
        fallback = onContentPolicy
            ? { model: rawFallback.model, onContentPolicy }
            : null;
    }

    const rawGlossary = rawConfig.selection.glossary;
    let glossaryDefault = primaryId;
    let glossaryBySourceLanguage = { Russian: null, Japanese: null };

    if (rawGlossary !== undefined) {
        assertObject(rawGlossary, filePath, "selection.glossary");
        assertNoUnknownFields(
            rawGlossary,
            GLOSSARY_FIELDS,
            filePath,
            "selection.glossary",
        );

        if (rawGlossary.default !== undefined) {
            assertNonEmptyString(
                rawGlossary.default,
                filePath,
                "selection.glossary.default",
            );
            if (!models.has(rawGlossary.default)) {
                throw configError(
                    filePath,
                    "selection.glossary.default",
                    `unknown model id "${rawGlossary.default}"`,
                );
            }
            glossaryDefault = rawGlossary.default;
        }

        if (rawGlossary.bySourceLanguage !== undefined) {
            assertObject(
                rawGlossary.bySourceLanguage,
                filePath,
                "selection.glossary.bySourceLanguage",
            );
            for (const [language, modelId] of Object.entries(
                rawGlossary.bySourceLanguage,
            )) {
                if (!GLOSSARY_LANGUAGES.has(language)) {
                    throw configError(
                        filePath,
                        `selection.glossary.bySourceLanguage.${language}`,
                        `expected one of: ${[...GLOSSARY_LANGUAGES].join(", ")}`,
                    );
                }
                assertNonEmptyString(
                    modelId,
                    filePath,
                    `selection.glossary.bySourceLanguage.${language}`,
                );
                if (!models.has(modelId)) {
                    throw configError(
                        filePath,
                        `selection.glossary.bySourceLanguage.${language}`,
                        `unknown model id "${modelId}"`,
                    );
                }
                glossaryBySourceLanguage[language] = modelId;
            }
        }
    }

    return {
        models,
        selection: {
            primary: primaryId,
            fallback,
            glossary: {
                default: glossaryDefault,
                bySourceLanguage: glossaryBySourceLanguage,
            },
        },
    };
};

const resolveModel = (definition, environment, filePath, requireKey) => {
    const apiKey = environment[definition.apiKeyEnv];
    if (requireKey && !apiKey) {
        throw configError(
            filePath,
            `models.${definition.id}.apiKeyEnv`,
            `environment variable ${definition.apiKeyEnv} is not set`,
        );
    }

    return {
        ...definition,
        apiKey: apiKey || null,
    };
};

const readConfig = ({ projectRoot, configPath, environment }) => {
    const configuredPath =
        configPath ||
        environment.WASABI_CONFIG ||
        path.join("config", "wasabi.local.json");
    const resolvedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(projectRoot || process.cwd(), configuredPath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(
            `Missing config file: ${resolvedPath}\n` +
                "Copy config/wasabi.example.json to config/wasabi.local.json and set your API keys in .env.",
        );
    }

    let rawConfig;
    try {
        rawConfig = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (error) {
        throw new Error(`Invalid config ${resolvedPath}: ${error.message}`);
    }

    return { rawConfig, resolvedPath };
};

export const loadRuntimeConfig = ({
    projectRoot,
    configPath = null,
    env: environment = process.env,
    config = null,
    sourceLanguage = DEFAULT_SOURCE_LANGUAGE,
    targetLanguage = DEFAULT_TARGET_LANGUAGE,
    concurrency = null,
    requireKeys = false,
} = {}) => {
    let rawConfig = config;
    let resolvedPath = configPath || "<inline config>";

    if (!rawConfig) {
        const loaded = readConfig({ projectRoot, configPath, environment });
        rawConfig = loaded.rawConfig;
        resolvedPath = loaded.resolvedPath;
    }

    const { models, selection } = validateConfig(rawConfig, resolvedPath);
    const definitions = new Map(models);
    const primary = resolveModel(
        definitions.get(selection.primary),
        environment,
        resolvedPath,
        requireKeys,
    );
    const fallback = selection.fallback
        ? resolveModel(
              definitions.get(selection.fallback.model),
              environment,
              resolvedPath,
              requireKeys,
          )
        : null;
    const glossaryDefault = resolveModel(
        definitions.get(selection.glossary.default),
        environment,
        resolvedPath,
        requireKeys,
    );

    const resolveOptionalModel = (modelId) => {
        const definition = definitions.get(modelId);
        if (!definition) {
            throw new Error(`Unknown model id: ${modelId}`);
        }
        const apiKey = environment[definition.apiKeyEnv];
        if (!apiKey) {
            return { model: null, unavailableReason: "missing_api_key" };
        }
        return {
            model: resolveModel(definition, environment, resolvedPath, false),
            unavailableReason: null,
        };
    };

    return {
        sourceLanguage,
        targetLanguage,
        concurrencyOverride: concurrency,
        configPath: resolvedPath,
        models: {
            primary,
            fallback,
            glossaryDefault,
            glossaryBySourceLanguage: {
                Russian:
                    selection.glossary.bySourceLanguage.Russian || null,
                Japanese:
                    selection.glossary.bySourceLanguage.Japanese || null,
            },
        },
        resolveOptionalModel,
    };
};
