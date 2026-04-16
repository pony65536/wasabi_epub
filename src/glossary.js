import pkg from "natural";
import { cut as jiebaCut } from "jieba-wasm";
import kuromoji from "kuromoji";
import {
    init as oktInit,
    tokenize as oktTokenize,
} from "oktjs";
import path from "path";
import { fileURLToPath } from "url";
import { callAIWithRetry } from "./utils.js";
import { loadHtml } from "./utils.js";

const { NGrams, WordTokenizer } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUSSIAN_WORD_REGEX = /^[\p{Script=Cyrillic}\-]+$/u;
const CHINESE_WORD_REGEX = /^[\p{Script=Han}A-Za-z0-9\-]+$/u;
const JAPANESE_WORD_REGEX =
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9\-]+$/u;
const KOREAN_WORD_REGEX =
    /^[\p{Script=Hangul}A-Za-z0-9\-]+$/u;
const STOP_WORDS_BY_LANGUAGE = {
    english: /^(the|and|a|of|to|in|is|it|that|with|as|for|was)$/i,
    spanish:
        /^(el|la|los|las|un|una|unos|unas|de|del|al|y|o|en|a|con|por|para|es|son|que|se|su|sus)$/i,
    french:
        /^(le|la|les|un|une|des|du|de|et|ou|en|a|à|dans|sur|pour|par|avec|est|sont|que|qui|se|son|sa|ses)$/i,
    "chinese (simplified)":
        /^(的|了|着|呢|啊|吧|吗|嘛|呀|哦|我|你|他|她|它|我们|你们|他们|她们|它们|这|那|这些|那些|一个|一种|一些|没有|不是|可以|自己|什么|怎么|为什么|因为|所以|如果|但是|然后|就是|还是|已经|还有|非常|很多|不会|不是|不是说|这个|那个|时候|东西|出来|进去|一下|一样|这里|那里)$/i,
    japanese:
        /^(これ|それ|あれ|この|その|あの|ここ|そこ|あそこ|こと|もの|ところ|ため|よう|さん|ちゃん|くん|そう|どう|そして|しかし|また|すでに|かなり|とても)$/i,
    korean:
        /^(이것|그것|저것|여기|거기|저기|것|수|등|때|좀|더|또|그리고|하지만|그러나|그래서|이미|매우|정말|너무|우리|저희|당신|그녀|그들|이런|그런|저런)$/i,
    russian:
        /^(и|в|во|на|с|со|к|ко|по|о|об|от|до|из|у|за|для|не|но|а|что|как|это|то|же|ли|да|ну|он|она|оно|они|мы|вы|я|ты|его|ее|её|их|мне|меня|тебе|тебя|себя|нам|нас|вам|вас|был|была|были|быть|есть|нет|все|всё|весь|вся|всех|только|уже|даже|или|если|когда|потом|здесь|там|кто|чем|чтобы)$/i,
};

const getStopWordsPattern = (sourceLanguage) =>
    STOP_WORDS_BY_LANGUAGE[sourceLanguage.toLowerCase()] ??
    STOP_WORDS_BY_LANGUAGE.english;

const isRussianSource = (sourceLanguage) =>
    sourceLanguage.toLowerCase() === "russian";
const isChineseSource = (sourceLanguage) =>
    sourceLanguage.toLowerCase() === "chinese (simplified)";
const isJapaneseSource = (sourceLanguage) =>
    sourceLanguage.toLowerCase() === "japanese";
const isKoreanSource = (sourceLanguage) =>
    sourceLanguage.toLowerCase() === "korean";

let japaneseTokenizerPromise = null;
let koreanTokenizerInitialized = false;

const getJapaneseTokenizer = async () => {
    if (japaneseTokenizerPromise) return japaneseTokenizerPromise;

    console.log("    - Initializing Japanese tokenizer...");

    japaneseTokenizerPromise = new Promise((resolve, reject) => {
        kuromoji
            .builder({ dicPath: path.resolve(__dirname, "../node_modules/kuromoji/dict") })
            .build((err, tokenizer) => {
                if (err) reject(err);
                else resolve(tokenizer);
            });
    });

    return japaneseTokenizerPromise;
};

const initKoreanTokenizer = () => {
    if (koreanTokenizerInitialized) return;
    console.log("    - Initializing Korean tokenizer...");
    oktInit();
    koreanTokenizerInitialized = true;
};

const MARKUP_NOISE_WORDS = new Set([
    "class",
    "href",
    "src",
    "alt",
    "div",
    "span",
    "img",
    "css",
    "html",
    "body",
    "head",
    "link",
    "stylesheet",
    "type",
    "text",
    "rel",
    "image",
    "title",
    "subtitle",
    "empty",
    "line",
    "cite",
    "poem",
    "stanza",
    "author",
    "jpg",
    "png",
]);

// =================== 纯文本提取 ===================
const cleanText = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    $("script, style").remove();
    return $.text().replace(/\s+/g, " ").trim();
};

const cleanRussianText = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    $("script, style, head").remove();
    const text = $.text().toLowerCase();
    return text
        .replace(
            /\b(?:class|href|src|alt|div|span|img|css|html|body|head|link|stylesheet|type|text|rel|image|title|subtitle|empty|line|cite|poem|stanza|author|jpg|png)\b/gi,
            " ",
        )
        .replace(/[^\p{Script=Cyrillic}\s\-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const cleanChineseText = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    $("script, style, head").remove();
    const text = $.text();
    return text
        .replace(
            /\b(?:class|href|src|alt|div|span|img|css|html|body|head|link|stylesheet|type|text|rel|image|title|subtitle|empty|line|cite|poem|stanza|author|jpg|png)\b/gi,
            " ",
        )
        .replace(/[^\p{Script=Han}A-Za-z0-9\s\-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const cleanJapaneseText = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    $("script, style, head").remove();
    const text = $.text();
    return text
        .replace(
            /\b(?:class|href|src|alt|div|span|img|css|html|body|head|link|stylesheet|type|text|rel|image|title|subtitle|empty|line|cite|poem|stanza|author|jpg|png)\b/gi,
            " ",
        )
        .replace(
            /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9\s\-]/gu,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
};

const cleanKoreanText = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    $("script, style, head").remove();
    const text = $.text();
    return text
        .replace(
            /\b(?:class|href|src|alt|div|span|img|css|html|body|head|link|stylesheet|type|text|rel|image|title|subtitle|empty|line|cite|poem|stanza|author|jpg|png)\b/gi,
            " ",
        )
        .replace(/[^\p{Script=Hangul}A-Za-z0-9\s\-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const getContext = (text, term, window = 40) => {
    try {
        const index = text.toLowerCase().indexOf(term.toLowerCase());
        if (index === -1) return "";
        const start = Math.max(0, index - window);
        const end = Math.min(text.length, index + term.length + window);
        return `...${text.slice(start, end).replace(/\s+/g, " ").trim()}...`;
    } catch {
        return "";
    }
};

const getMostCommonNGrams = (words, n, topK) => {
    const counts = NGrams.ngrams(words, n)
        .map((g) => g.join(" "))
        .reduce((acc, val) => {
            acc[val] = (acc[val] || 0) + 1;
            return acc;
        }, {});
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK);
};

const tokenizeRussianWords = (text, stopWords) =>
    (text.match(/[\p{Script=Cyrillic}]+(?:-[\p{Script=Cyrillic}]+)*/gu) || [])
        .map((w) => w.toLowerCase())
        .filter(
            (w) =>
                w.length > 1 &&
                RUSSIAN_WORD_REGEX.test(w) &&
                !stopWords.test(w) &&
                !MARKUP_NOISE_WORDS.has(w),
        );

const tokenizeChineseWords = (text, stopWords) =>
    jiebaCut(text, true).filter(
        (w) =>
            w.length > 1 &&
            CHINESE_WORD_REGEX.test(w) &&
            !stopWords.test(w) &&
            !MARKUP_NOISE_WORDS.has(w.toLowerCase()),
    );

const tokenizeJapaneseWords = async (text, stopWords) => {
    const tokenizer = await getJapaneseTokenizer();
    return tokenizer
        .tokenize(text)
        .filter(
            (token) =>
                token.pos === "名詞" &&
                !["非自立", "代名詞", "数", "接尾"].includes(
                    token.pos_detail_1,
                ),
        )
        .map((token) =>
            token.basic_form && token.basic_form !== "*"
                ? token.basic_form
                : token.surface_form,
        )
        .filter(
            (w) =>
                w.length > 1 &&
                JAPANESE_WORD_REGEX.test(w) &&
                !stopWords.test(w) &&
                !MARKUP_NOISE_WORDS.has(w.toLowerCase()),
        );
};

const tokenizeKoreanWords = (text, stopWords) => {
    initKoreanTokenizer();
    return oktTokenize(text)
        .filter((token) =>
            [
                "Noun",
                "Foreign",
                "Alpha",
            ].includes(token.pos),
        )
        .map((token) => token.stem || token.text)
        .filter(
            (w) =>
                w.length > 1 &&
                KOREAN_WORD_REGEX.test(w) &&
                !stopWords.test(w) &&
                !MARKUP_NOISE_WORDS.has(w.toLowerCase()),
        );
};

const isMarkupGarbagePhrase = (term) => {
    const words = term.split(/\s+/).filter(Boolean);
    return (
        words.length === 0 ||
        words.some(
            (word) =>
                MARKUP_NOISE_WORDS.has(word) || !RUSSIAN_WORD_REGEX.test(word),
        )
    );
};

const tokenizeWordsByLanguage = async (
    text,
    stopWords,
    languageFlags,
    tokenizer,
) => {
    const { russianMode, chineseMode, japaneseMode } = languageFlags;
    const { koreanMode } = languageFlags;
    if (russianMode) return tokenizeRussianWords(text, stopWords);
    if (chineseMode) return tokenizeChineseWords(text, stopWords);
    if (japaneseMode) return tokenizeJapaneseWords(text, stopWords);
    if (koreanMode) return tokenizeKoreanWords(text, stopWords);
    return tokenizer
        .tokenize(text.toLowerCase())
        .filter((w) => w.length > 1 && !stopWords.test(w));
};

// =================== 候选词收集 ===================
const collectCandidates = async (chapterMap, translationConfig) => {
    const tokenizer = new WordTokenizer();
    const STOP_WORDS = getStopWordsPattern(translationConfig.sourceLanguage);
    const russianMode = isRussianSource(translationConfig.sourceLanguage);
    const chineseMode = isChineseSource(translationConfig.sourceLanguage);
    const japaneseMode = isJapaneseSource(translationConfig.sourceLanguage);
    const koreanMode = isKoreanSource(translationConfig.sourceLanguage);
    const languageFlags = { russianMode, chineseMode, japaneseMode, koreanMode };

    let fullText = "";
    const allWords = [];
    const chapterCandidates = {};
    const chapters = [...chapterMap.values()];

    if (japaneseMode) {
        await getJapaneseTokenizer();
    }
    if (koreanMode) {
        initKoreanTokenizer();
    }

    for (let index = 0; index < chapters.length; index++) {
        const chapter = chapters[index];
        const chapterText = russianMode
            ? cleanRussianText(chapter.html)
            : chineseMode
              ? cleanChineseText(chapter.html)
              : japaneseMode
                ? cleanJapaneseText(chapter.html)
                : koreanMode
                  ? cleanKoreanText(chapter.html)
              : cleanText(chapter.html);
        fullText += chapterText + " ";

        const chapterWords = await tokenizeWordsByLanguage(
            chapterText,
            STOP_WORDS,
            languageFlags,
            tokenizer,
        );
        allWords.push(...chapterWords);

        if (
            (japaneseMode || koreanMode) &&
            (index === 0 || (index + 1) % 5 === 0 || index === chapters.length - 1)
        ) {
            console.log(
                `    - Tokenized ${index + 1}/${chapters.length} chapter(s)...`,
            );
        }

        if (chapterWords.length < 50) continue;

        const chapterNGrams = [
            ...getMostCommonNGrams(chapterWords, 2, 50),
            ...getMostCommonNGrams(chapterWords, 3, 50),
            ...(!russianMode && !chineseMode && !japaneseMode && !koreanMode
                ? getMostCommonNGrams(chapterWords, 4, 30)
                : []),
        ].filter(([, count]) => count >= 3);

        for (const [term, count] of chapterNGrams) {
            chapterCandidates[term] = (chapterCandidates[term] || 0) + count;
        }
    }

    const words = allWords;

    const unigramCounts = words.reduce((acc, w) => {
        acc[w] = (acc[w] || 0) + 1;
        return acc;
    }, {});

    const formatList = (entries) =>
        entries
            .filter(([, count]) => count >= 3)
            .filter(([term]) =>
                russianMode
                    ? !isMarkupGarbagePhrase(term)
                    : true,
            )
            .map(([term, count]) => ({
                term,
                context: getContext(fullText, term),
                count,
            }));

    return {
        fullText,
        candidates: [
            // unigrams
            ...formatList(
                Object.entries(unigramCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 100),
            ),
            // full-book ngrams
            ...formatList(getMostCommonNGrams(words, 2, 100)),
            ...formatList(getMostCommonNGrams(words, 3, 100)),
            ...(!russianMode && !chineseMode && !japaneseMode && !koreanMode
                ? formatList(getMostCommonNGrams(words, 4, 50))
                : []),
            // chapter-merged ngrams
            ...Object.entries(chapterCandidates)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 150)
                .map(([term, count]) => ({
                    term,
                    context: getContext(fullText, term),
                    count,
                })),
        ].filter(
            // 去重，保留 count 最高的
            (item, _, arr) =>
                arr.findIndex((x) => x.term === item.term) ===
                arr.indexOf(item),
        ),
    };
};

// =================== 分批请求 AI ===================
const CANDIDATE_BATCH_SIZE = 100;

const buildPrompt = (candidateBatch, translationConfig) => `\
I am translating an ebook from ${translationConfig.sourceLanguage} into ${translationConfig.targetLanguage}. \
The following is a list of candidate phrases pre-filtered using an n-gram algorithm.

Please select phrases that are most likely to cause translation inconsistencies across \
chapters.

Prioritize:
- proper nouns
- personal names
- place names
- titles, honorifics, ranks, and forms of address
- organizations, factions, and institutions
- recurring worldbuilding terms, special concepts, and book-specific expressions
- technical or domain-specific terms when the book is non-fiction

Usually exclude:
- ordinary narrative filler phrases
- common dialogue scaffolding such as "he said", "she asked", and similar everyday reporting phrases
- common connective phrases unless they function as a fixed book-specific expression
- obvious markup, formatting, HTML/CSS, or file-structure fragments

Keep a phrase only if preserving a stable translation across the book is genuinely useful.

Return ONLY a pure JSON object with no extra explanation or markdown formatting:
{
  "glossary": [
    {
      "term": "original phrase",
      "suggested": "translation (translation only, no original text or explanatory notes)"
    }
  ]
}

If a candidate phrase cannot be given a reasonable translation, exclude it entirely.

Here are the candidates:
${JSON.stringify(candidateBatch)}`;

const queryGlossaryBatch = async (
    candidates,
    aiProvider,
    logger,
    translationConfig,
) => {
    const results = [];

    for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH_SIZE) {
        const batchIndex = Math.floor(i / CANDIDATE_BATCH_SIZE) + 1;

        const batch = candidates.slice(i, i + CANDIDATE_BATCH_SIZE);
        try {
            const parsed = await callAIWithRetry(
                aiProvider,
                buildPrompt(batch, translationConfig),
                "You are a helpful assistant that outputs only JSON.",
            );
            const terms = parsed.glossary || [];
            results.push(...terms);
        } catch (e) {
            logger.write(
                "ERROR",
                `Glossary batch ${batchIndex} failed: ${e.stack || e.message}`,
            );
        }
    }
    return results;
};

// =================== 术语表生成 ===================
export const generateInitialGlossary = async (
    chapterMap,
    aiProvider,
    logger,
    translationConfig,
) => {
    console.log("\n📊 Step 3: Generating Initial Glossary...");
    const glossary = {};

    try {
        console.log("    - Reading and cleaning book content...");
        const { candidates } = await collectCandidates(
            chapterMap,
            translationConfig,
        );
        console.log(`    - Collected ${candidates.length} candidate terms.`);

        console.log("    - Sending candidates to AI in batches...");
        const newTerms = await queryGlossaryBatch(
            candidates,
            aiProvider,
            logger,
            translationConfig,
        );

        // 去重合并：同一 term 出现多次时保留第一个
        const seen = new Set();
        const dedupedTerms = newTerms.filter(({ term }) => {
            if (!term || seen.has(term)) return false;
            seen.add(term);
            return true;
        });

        for (const { term, suggested } of dedupedTerms) {
            if (term && suggested) glossary[term] = suggested;
        }

        console.log(
            `    - ✅ Glossary generated with ${dedupedTerms.length} terms.`,
        );
        logger.write("GLOSSARY", JSON.stringify(dedupedTerms, null, 2));
    } catch (error) {
        console.error("    - ❌ Failed to generate glossary:", error.message);
        logger.write(
            "ERROR",
            `Glossary Generation Failed: ${error.stack || error.message}`,
        );
    }

    console.log("    - Glossary generation step completed.\n");
    return glossary;
};
