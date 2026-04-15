// =================== 核心设置 ===================
const env = process.env;

const normalizeProvider = (value, fallback) =>
    (value || fallback || "").trim().toLowerCase();

const envFlag = (value, fallback = false) => {
    if (value == null || value === "") return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
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
    },
    qwen: {
        apiKey: process.env.QWEN_API_KEY,
        baseURL:
            process.env.QWEN_BASE_URL ||
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: getProviderModel("qwen", "qwen-plus"),
        concurrency: 5,
    },
    mimo: {
        apiKey: process.env.MIMO_API_KEY,
        baseURL: process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1",
        modelName: getProviderModel("mimo", "mimo-v2-pro"),
        concurrency: 5,
    },
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        modelName: getProviderModel("openrouter", "x-ai/grok-4.1-fast"),
        concurrency: 5,
        requestOptions: {
            reasoning: {
                enabled: envFlag(process.env.OPENROUTER_REASONING_ENABLED, true),
            },
        },
    },
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
