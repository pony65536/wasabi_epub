const CANONICAL_LANGUAGES = {
    English: {
        aliases: ["en", "eng", "english"],
        subtitleCode: "eng",
    },
    Spanish: {
        aliases: ["es", "spa", "spanish", "espanol", "español"],
        subtitleCode: "spa",
    },
    French: {
        aliases: ["fr", "fra", "fre", "french", "francais", "français"],
        subtitleCode: "fra",
    },
    Russian: {
        aliases: ["ru", "rus", "russian"],
        subtitleCode: "rus",
    },
    "Chinese (Simplified)": {
        aliases: [
            "zh",
            "zho",
            "chi",
            "zh-cn",
            "zh-hans",
            "chinese",
            "chinese simplified",
            "simplified chinese",
        ],
        subtitleCode: "zho",
    },
    Korean: {
        aliases: ["ko", "kor", "korean"],
        subtitleCode: "kor",
    },
    Japanese: {
        aliases: ["ja", "jpn", "jp", "japanese"],
        subtitleCode: "jpn",
    },
};

const ALIAS_TO_LANGUAGE = new Map(
    Object.entries(CANONICAL_LANGUAGES).flatMap(([languageName, config]) =>
        config.aliases.map((alias) => [alias, languageName]),
    ),
);

const normalizeToken = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-");

export const normalizeLanguageName = (value, fallback = null) => {
    if (!value) return fallback;
    const normalized = normalizeToken(value);
    if (ALIAS_TO_LANGUAGE.has(normalized)) {
        return ALIAS_TO_LANGUAGE.get(normalized);
    }
    return fallback;
};

export const getSubtitleLanguageCode = (languageName) =>
    CANONICAL_LANGUAGES[languageName]?.subtitleCode || "und";

export const languageMatches = (languageValue, expectedLanguageName) => {
    if (!languageValue || !expectedLanguageName) return false;
    return (
        normalizeLanguageName(languageValue, null) ===
        normalizeLanguageName(expectedLanguageName, null)
    );
};

const countMatches = (text, pattern) => (text.match(pattern) || []).length;

export const inferLanguageFromText = (text) => {
    const sample = String(text || "").trim();
    if (!sample) return null;

    if (countMatches(sample, /[\u3040-\u30ff]/g) > 0) return "Japanese";
    if (countMatches(sample, /[\uac00-\ud7af]/g) > 0) return "Korean";
    if (countMatches(sample, /[\u0400-\u04ff]/g) > 0) return "Russian";
    if (countMatches(sample, /[\u4e00-\u9fff]/g) > 0) {
        return "Chinese (Simplified)";
    }

    const spanishScore = countMatches(sample, /[ñáéíóúü¿¡]/gi);
    const frenchScore = countMatches(sample, /[àâæçéèêëîïôœùûüÿ]/gi);
    if (spanishScore > frenchScore && spanishScore >= 2) return "Spanish";
    if (frenchScore > spanishScore && frenchScore >= 2) return "French";

    const latinLetters = countMatches(sample, /[a-z]/gi);
    if (latinLetters > 0) return "English";

    return null;
};
