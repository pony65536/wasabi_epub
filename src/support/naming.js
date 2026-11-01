

export const sanitizeFileToken = (value) =>
    value.replace(/['"]/g, "").replace(/[<>:"/\\|?*\s]+/g, "_");

export const createSelectionSlug = (selection) => {
    if (!selection) return "";
    const sanitized = sanitizeFileToken(selection).replace(/_+/g, "_").trim();
    return sanitized.slice(0, 60) || "selected";
};

export const getLanguageFileCode = (languageName) => {
    const fileCodes = {
        English: "en",
        Spanish: "es",
        French: "fr",
        Russian: "ru",
        "Chinese (Simplified)": "zh",
        Korean: "ko",
        Japanese: "ja",
    };
    return (
        fileCodes[languageName] ||
        sanitizeFileToken(languageName.toLowerCase()).replace(/_+/g, "_")
    );
};
