// =================== 核心设置 ===================
export const INPUT_FILE_NAME =
    "Treasure Island The Master Edition (Robert Louis Stevenson, Kent David Kelly) (z-library.sk, 1lib.sk, z-lib.sk).epub";

export const CURRENT_PROVIDER = "mimo";

// 测试模式：null 表示翻译全部章节，数字表示只翻译前 N 章
export const TEST_MODE_LIMIT = null;

export const OPENROUTER_MODEL =
    // "google/gemini-2.5-pro-preview";
    // "anthropic/claude-sonnet-4-5";
    // "deepseek/deepseek-r1";
    // "meta-llama/llama-4-maverick";
    // "mistralai/mistral-medium-3";
    // "qwen/qwen3-235b-a22b";
    "xiaomi/mimo-v2-pro";

export const CONFIG = {
    targetLanguage: "Chinese (Simplified)",
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
        modelName: "gemini-2.5-pro",
        concurrency: 1,
    },
    qwen: {
        apiKey: process.env.QWEN_API_KEY,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: "qwen3-max",
        concurrency: 5,
    },
    mimo: {
        apiKey: process.env.MIMO_API_KEY,
        baseURL: "https://api.xiaomimimo.com/v1",
        modelName: "mimo-v2-pro",
        concurrency: 5,
    },
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        modelName: OPENROUTER_MODEL,
        concurrency: 5,
    },
};

// =================== 翻译风格指南 ===================
export const STYLE_GUIDE = `
TRANSLATION STYLE GUIDE (Target: Chinese Simplified):
1. **Rephrase**: Natural Chinese (Easy to read).
2. **Split Long Sentences**: Break down long English clauses.
3. **Tone**: Professional, insightful.
4. **Vocabulary**: Use appropriate idioms (Chengyu) where natural.
5. **No Translationese**: Avoid passive voice (e.g., limit usage of "被").

HEADING FORMATTING RULES:
1. **Consistency**: Table of Contents must match Main Body.
2. **Preserve Prefix**: Keep numeric/alphabetic numbering prefix (e.g. "1.2 ", "A. ") as-is; only translate the title text after it.
`;
