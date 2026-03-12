import * as cheerio from "cheerio";
import pkg from "natural";
import { callAIWithRetry } from "./utils.js";

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

// =================== 术语表生成 ===================
export const generateInitialGlossary = async (chapterMap, aiProvider, logger) => {
    console.log("\n📊 Step 3: Generating Initial Glossary...");
    let glossary = {};
    try {
        console.log("    - Reading and cleaning book content...");
        let fullText = "";
        for (const chapter of chapterMap.values()) {
            fullText += cleanText(chapter.html) + " ";
        }

        console.log("    - Tokenizing and calculating N-Grams...");
        const tokenizer = new WordTokenizer();
        const words = tokenizer
            .tokenize(fullText.toLowerCase())
            .filter(
                (w) =>
                    w.length > 1 &&
                    !/^(the|and|a|of|to|in|is|it|that|with|as|for|was)$/.test(w),
            );

        const formatList = (list) =>
            list.map(([term, count]) => ({
                term,
                context: getContext(fullText, term),
                count,
            }));

        const payload = JSON.stringify({
            bigrams: formatList(getMostCommonNGrams(words, 2, 25)),
            trigrams: formatList(getMostCommonNGrams(words, 3, 25)),
        });

        console.log("    - Sending candidate terms to AI for selection...");
        const userPrompt = `我想翻译一本电子书，现在使用 n-gram 算法初步筛选了候选词列表。
请你挑选其中容易导致翻译上下文翻译不一致的词组，尤其挑选日常生活中不常见的用法，但是高频出现在书中的部分，并以 JSON 格式输出。
输出格式如下，且不要包含任何多余说明文字，只返回纯 JSON 列表：
{
  "glossary": [
    {
        "term": "术语名称",
        "suggested": "建议翻译",
        "reason": "入选理由",
        "category": "类别"
    }
  ]
}
下面是我整理的候选项：\n${payload}`;

        const parsedResponse = await callAIWithRetry(
            aiProvider,
            userPrompt,
            "You are a helpful assistant that outputs only JSON.",
        );
        const newTerms = parsedResponse.glossary || [];

        if (Array.isArray(newTerms) && newTerms.length > 0) {
            for (const item of newTerms) {
                if (item.term && item.suggested)
                    glossary[item.term] = item.suggested;
            }
            console.log(
                `    - ✅ Glossary generated with ${newTerms.length} terms.`,
            );
            logger.write("GLOSSARY", JSON.stringify(newTerms, null, 2));
        } else {
            console.log("    - ⚠️ No terms were suggested by the AI.");
        }
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
