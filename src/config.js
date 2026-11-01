export {
    DEFAULT_SOURCE_LANGUAGE,
    DEFAULT_TARGET_LANGUAGE,
} from "./config/defaults.js";

export { loadRuntimeConfig } from "./config/loader.js";

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
