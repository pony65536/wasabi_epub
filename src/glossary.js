import * as cheerio from "cheerio";
import pkg from "natural";
import { callAIWithRetry } from "./utils.js";
import { CONFIG } from "./config.js";

const { NGrams, WordTokenizer } = pkg;

// =================== 纯文本提取 ===================
const cleanText = (htmlContent) => {
    const $ = cheerio.load(htmlContent);
    return $.text().replace(/\s+/g, " ").trim();
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

// =================== 候选词收集 ===================
const collectCandidates = (chapterMap) => {
    const tokenizer = new WordTokenizer();
    const STOP_WORDS = /^(the|and|a|of|to|in|is|it|that|with|as|for|was)$/;

    let fullText = "";
    const chapterCandidates = {};

    for (const chapter of chapterMap.values()) {
        const chapterText = cleanText(chapter.html);
        fullText += chapterText + " ";

        const chapterWords = tokenizer
            .tokenize(chapterText.toLowerCase())
            .filter((w) => w.length > 1 && !STOP_WORDS.test(w));

        if (chapterWords.length < 50) continue;

        const chapterNGrams = [
            ...getMostCommonNGrams(chapterWords, 2, 50),
            ...getMostCommonNGrams(chapterWords, 3, 50),
            ...getMostCommonNGrams(chapterWords, 4, 30),
        ].filter(([, count]) => count >= 3);

        for (const [term, count] of chapterNGrams) {
            chapterCandidates[term] = (chapterCandidates[term] || 0) + count;
        }
    }

    const words = tokenizer
        .tokenize(fullText.toLowerCase())
        .filter((w) => w.length > 1 && !STOP_WORDS.test(w));

    const unigramCounts = words.reduce((acc, w) => {
        acc[w] = (acc[w] || 0) + 1;
        return acc;
    }, {});

    const formatList = (entries) =>
        entries
            .filter(([, count]) => count >= 3)
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
            ...formatList(getMostCommonNGrams(words, 4, 50)),
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

const buildPrompt = (candidateBatch) => `\
I am translating an ebook into ${CONFIG.targetLanguage}. \
The following is a list of candidate phrases pre-filtered using an n-gram algorithm.

Please select phrases that are likely to cause translation inconsistencies across \
chapters — especially those with uncommon usage in everyday language but appear \
frequently in this book.

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

const queryGlossaryBatch = async (candidates, aiProvider, logger) => {
    const results = [];
    const totalBatches = Math.ceil(candidates.length / CANDIDATE_BATCH_SIZE);

    for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH_SIZE) {
        const batchIndex = Math.floor(i / CANDIDATE_BATCH_SIZE) + 1;

        const batch = candidates.slice(i, i + CANDIDATE_BATCH_SIZE);
        try {
            const parsed = await callAIWithRetry(
                aiProvider,
                buildPrompt(batch),
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
) => {
    console.log("\n📊 Step 3: Generating Initial Glossary...");
    const glossary = {};

    try {
        console.log("    - Reading and cleaning book content...");
        const { candidates } = collectCandidates(chapterMap);
        console.log(`    - Collected ${candidates.length} candidate terms.`);

        console.log("    - Sending candidates to AI in batches...");
        const newTerms = await queryGlossaryBatch(
            candidates,
            aiProvider,
            logger,
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
