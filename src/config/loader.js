import fs from "node:fs";
import path from "node:path";
import { loadModelConfig, MODEL_STAGES, MODEL_CAPABILITIES } from "../models/config.js";
import { FALLBACK_ERRORS, fromLegacyConfig, toGatewayConfig } from "./gateway.js";

import {
    DEFAULT_SOURCE_LANGUAGE,
    DEFAULT_TARGET_LANGUAGE,
} from "./defaults.js";

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
    "jsonMode",
    "maxOutputTokens",
    "connection",
]);
const SELECTION_FIELDS = new Set(["primary", "fallback", "glossary", "stages", "stageFallback", "stageRequirements"]);
const FALLBACK_FIELDS = new Set(["model", "onContentPolicy", "onErrors"]);
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
    if (rawModel.jsonMode !== undefined && typeof rawModel.jsonMode !== "boolean") {
        throw configError(filePath, `models.${id}.jsonMode`, "expected a boolean");
    }
    if (rawModel.maxOutputTokens !== undefined) {
        assertPositiveInteger(rawModel.maxOutputTokens, filePath, `models.${id}.maxOutputTokens`);
    }
    if (rawModel.connection !== undefined) {
        assertNonEmptyString(rawModel.connection, filePath, `models.${id}.connection`);
        if (!MODEL_ID_PATTERN.test(rawModel.connection)) {
            throw configError(filePath, `models.${id}.connection`, "expected a connection id");
        }
    }

    return {
        id,
        sdk: rawModel.sdk,
        baseURL: rawModel.baseURL ?? null,
        apiKeyEnv: rawModel.apiKeyEnv,
        modelName: rawModel.modelName,
        concurrency,
        timeoutMs,
        requestOptions,
        jsonMode: rawModel.jsonMode ?? rawModel.sdk === "openai",
        maxOutputTokens: rawModel.maxOutputTokens ?? null,
        connection: rawModel.connection ?? null,
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
        const onErrors = rawFallback.onErrors ?? (onContentPolicy ? ["content_policy"] : []);
        if (!Array.isArray(onErrors) || onErrors.some((category) => !FALLBACK_ERRORS.includes(category))) {
            throw configError(filePath, "selection.fallback.onErrors", "expected supported error categories");
        }
        const effectiveErrors = onErrors.filter((category) => category !== "content_policy" || onContentPolicy);
        fallback = effectiveErrors.length > 0
            ? { model: rawFallback.model, onContentPolicy, onErrors: effectiveErrors }
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

    const stageFields = {};
    for (const field of ["stages", "stageFallback", "stageRequirements"]) {
        const values = rawConfig.selection[field] ?? {};
        assertObject(values, filePath, `selection.${field}`);
        assertNoUnknownFields(values, new Set(MODEL_STAGES), filePath, `selection.${field}`);
        for (const [stage, value] of Object.entries(values)) {
            if (field === "stageRequirements") {
                if (!Array.isArray(value) || value.some((capability) => !MODEL_CAPABILITIES.includes(capability))) {
                    throw configError(filePath, `selection.${field}.${stage}`, "expected supported capabilities");
                }
            } else if (!(field === "stageFallback" && value === null) && !models.has(value)) {
                throw configError(filePath, `selection.${field}.${stage}`, `unknown model id "${value}"`);
            }
        }
        stageFields[field] = values;
    }

    return {
        models,
        selection: {
            ...stageFields,
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

const readConfig = ({ projectRoot, configPath, environment, sourceLanguage }) => {
    if (environment.WASABI_MODELS_FILE) {
        if (configPath || environment.WASABI_CONFIG) {
            throw new Error("Both WASABI_CONFIG/configPath and WASABI_MODELS_FILE are set; choose one model configuration.");
        }
        const legacy = loadModelConfig({ projectRoot, env: environment, sourceLanguage });
        return { rawConfig: fromLegacyConfig(legacy, environment), resolvedPath: legacy.source,
            warnings: ["Legacy model configuration loaded; migrate to config/wasabi.local.json."] };
    }
    const configuredPath =
        configPath ||
        environment.WASABI_CONFIG ||
        path.join("config", "wasabi.local.json");
    const resolvedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(projectRoot || process.cwd(), configuredPath);

    if (!fs.existsSync(resolvedPath)) {
        const legacyRequested = !configPath && !environment.WASABI_CONFIG && (
            environment.WASABI_MODELS_FILE || environment.PRIMARY_PROVIDER || environment.PROVIDER ||
            fs.existsSync(path.resolve(projectRoot || process.cwd(), "models.json"))
        );
        if (legacyRequested) {
            const legacy = loadModelConfig({ projectRoot, env: environment, sourceLanguage });
            return { rawConfig: fromLegacyConfig(legacy, environment), resolvedPath: legacy.source,
                warnings: ["Legacy model configuration loaded; migrate to config/wasabi.local.json.", ...(legacy.legacyWarnings || [])] };
        }
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
    modelName = null,
} = {}) => {
    environment = { ...environment };
    let rawConfig = config;
    let resolvedPath = configPath || "<inline config>";
    let warnings = [];

    if (!rawConfig) {
        const loaded = readConfig({ projectRoot, configPath, environment, sourceLanguage });
        rawConfig = loaded.rawConfig;
        resolvedPath = loaded.resolvedPath;
        warnings = loaded.warnings || [];
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
        modelOverride: modelName,
        configPath: resolvedPath,
        modelConfig: toGatewayConfig(definitions, selection, resolvedPath),
        modelSelection: selection,
        warnings,
        getModelEnvironment: () => environment,
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
