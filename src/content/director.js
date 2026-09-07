import { callAIWithRetry, loadHtml } from "../utils.js";
import { normalizeText } from "./content-classifier.js";

/**
 * 从章节列表中高效抽样出骨架文本：
 * 1. 书籍目录/元数据、前言（Preface/Intro/Foreword）
 * 2. 核心正文前 2 章、中间 1 章、尾部 1 章
 * 3. 每章采样前若干段与后若干段，避免 token 爆炸同时保留关键角色与风格
 */
export const extractBookSkeleton = (chapters, maxTotalChars = 12000) => {
    // 过滤掉 TOC，并优先过滤掉只有封面/版权等极短页（低于 500 字符的 HTML）
    const validChapters = (chapters || []).filter(
        (ch) => ch && ch.html && !ch.isTOC,
    );
    if (validChapters.length === 0) {
        return [];
    }

    // 区分实质内容章节与扉页/超短附录/索引/版权页
    const isExcludedChapter = (ch) => {
        const id = (ch.id || "").toLowerCase();
        const title = (ch.title || "").toLowerCase();
        return (
            /^(cover|halftitle|title|copyright|dedication|index|contents?|toc)/i.test(
                id,
            ) ||
            /^(cover|title page|copyright|dedication|index|contents?|table of contents)/i.test(
                title,
            )
        );
    };

    const substantiveChapters = validChapters.filter(
        (ch) => ch.html.length >= 2000 && !isExcludedChapter(ch),
    );
    const pool =
        substantiveChapters.length >= 2 ? substantiveChapters : validChapters;

    // 选出骨架章节：前2章、中位章、尾章
    const selectedIndices = new Set();
    selectedIndices.add(0);
    if (pool.length > 1) selectedIndices.add(1);
    if (pool.length > 3) {
        selectedIndices.add(Math.floor(pool.length / 2));
    }
    if (pool.length > 2) {
        selectedIndices.add(pool.length - 1);
    }

    const skeletonEntries = [];
    let accumulatedChars = 0;

    for (const index of selectedIndices) {
        if (accumulatedChars >= maxTotalChars) break;

        const ch = pool[index];
        const $ = loadHtml(ch.html);
        const title = ch.title || `Chapter ${index + 1}`;

        const paragraphs = [];
        $("p, li, h1, h2, h3").each((_, el) => {
            const text = normalizeText($(el).text());
            // 排除纯版权/元数据/CSS 残留
            if (
                text.length >= 35 &&
                !/^(copyright|all rights reserved|isbn|library of congress|reprint|for information about permission|permissions,)/i.test(
                    text,
                ) &&
                !/@page\s*\{/i.test(text)
            ) {
                paragraphs.push(text);
            }
        });

        if (paragraphs.length === 0) continue;

        // 采样：开头 4 段，中段 2 段，结尾 2 段
        const sampleParas = [];
        const headCount = Math.min(4, paragraphs.length);
        for (let i = 0; i < headCount; i++) {
            sampleParas.push(paragraphs[i]);
        }
        if (paragraphs.length > 8) {
            const mid = Math.floor(paragraphs.length / 2);
            sampleParas.push("...");
            sampleParas.push(paragraphs[mid]);
            sampleParas.push(paragraphs[mid + 1]);
            sampleParas.push("...");
            sampleParas.push(paragraphs[paragraphs.length - 2]);
            sampleParas.push(paragraphs[paragraphs.length - 1]);
        } else if (paragraphs.length > 4) {
            sampleParas.push("...");
            sampleParas.push(paragraphs[paragraphs.length - 1]);
        }

        const sampledText = sampleParas.join("\n\n");
        skeletonEntries.push({
            chapterId: ch.id,
            title,
            sample: sampledText.slice(0, 3000),
        });

        accumulatedChars += sampledText.length;
    }

    return skeletonEntries;
};

const buildDirectorPrompt = (sourceLanguage, targetLanguage) => `
You are the "Master Translation Director" (全书翻译总编导) for a book publication.

Your responsibility is NOT to translate the book line-by-line, but to inspect the book skeleton, understand its genre, narrative tone, main characters, and worldview, and then establish a comprehensive "Book Bible" (全书翻译设定集).
All subsequent chapter translations will strictly conform to your established Book Bible to guarantee narrative tone consistency, character gender/pronoun stability, and unified terminology.

Target Language: ${targetLanguage}
Source Language: ${sourceLanguage}

Analyze the provided chapter samples and generate a JSON response strictly adhering to this schema:
{
  "genre": "Genre of the book (e.g. Hard Sci-Fi, Academic/Technical, Fantasy Novel, Business Non-fiction, etc.)",
  "stylisticTone": {
    "overallTone": "Brief description of the translation voice and cadence for ${targetLanguage}",
    "toneKeywords": ["keyword1", "keyword2", "keyword3"],
    "narrativeVoice": "e.g. Third-person omniscient, first-person subjective, rigorous academic, etc.",
    "rhetoricalRules": "Guidelines on sentence breaking, rhythm, idiom usage, or modern vs classical wording"
  },
  "characterBible": [
    {
      "name": "Original Name",
      "targetName": "Translated Name in ${targetLanguage}",
      "gender": "male | female | non-binary | unknown",
      "pronoun": "Preferred pronoun in ${targetLanguage} (e.g. 他, 她, 它, TA)",
      "role": "Brief role/identity (e.g. Protagonist, Chief Scientist, Antagonist, Narrator)",
      "speechStyle": "Tone of voice or dialogue quirk (if applicable)"
    }
  ],
  "worldviewAndGlossary": {
    "Source Term / Entity": "Standard translation in ${targetLanguage} (with usage notes if needed)"
  },
  "syntaxConventions": {
    "dialogueQuotes": "Rules for dialogue quotes (e.g. 使用“ ”或「 」)",
    "italicsHandling": "How to translate italicized thoughts/emphasis (e.g. 心理独白保留或加方头括号)",
    "codeAndFormulaNotes": "Rules for code, variables, or technical symbols if applicable"
  }
}

Strict Rules:
1. Output valid JSON only. No explanation or code fences outside the JSON.
2. In "characterBible", carefully determine gender and pronouns from context clues (e.g., "she said", mother, father, titles) to prevent gender misidentification.
3. In "worldviewAndGlossary", record only key recurring entities, fictional concepts, institutions, or specialized jargon discovered in the samples.
4. "stylisticTone" must be actionable and directly guide the final translation in ${targetLanguage}.
`.trim();

/**
 * 格式化 Book Bible 为可注入 Translation Prompt 的结构化提示文本
 */
export const formatBookBibleForPrompt = (bookBible) => {
    if (!bookBible) return "";

    const sections = [];

    // 1. 风格与基调
    if (bookBible.stylisticTone) {
        const tone = bookBible.stylisticTone;
        const keywords = Array.isArray(tone.toneKeywords)
            ? ` (${tone.toneKeywords.join(", ")})`
            : "";
        sections.push(
            `[BOOK BIBLE: TONE & STYLE]\n- Genre: ${bookBible.genre || "General"}\n- Tone: ${tone.overallTone || "Clear, natural"}${keywords}\n- Narrative Voice: ${tone.narrativeVoice || "Standard"}\n- Sentence & Rhythm: ${tone.rhetoricalRules || "Flow naturally"}`,
        );
    }

    // 2. 核心人物设定
    if (
        Array.isArray(bookBible.characterBible) &&
        bookBible.characterBible.length > 0
    ) {
        const charLines = bookBible.characterBible
            .filter((c) => c && c.name && c.targetName)
            .map(
                (c) =>
                    `- ${c.name} -> ${c.targetName} [Pronoun: ${c.pronoun || "他/她"} | Gender: ${c.gender || "unknown"}]${c.role ? ` (${c.role})` : ""}${c.speechStyle ? ` [Voice: ${c.speechStyle}]` : ""}`,
            );
        if (charLines.length > 0) {
            sections.push(
                `[BOOK BIBLE: CHARACTERS & PRONOUNS (Strictly adhere to pronouns and names)]\n${charLines.join("\n")}`,
            );
        }
    }

    // 3. 排版与标点规范
    if (bookBible.syntaxConventions) {
        const syntax = bookBible.syntaxConventions;
        const rules = [];
        if (syntax.dialogueQuotes)
            rules.push(`- Quotes: ${syntax.dialogueQuotes}`);
        if (syntax.italicsHandling)
            rules.push(`- Italics: ${syntax.italicsHandling}`);
        if (syntax.codeAndFormulaNotes)
            rules.push(`- Technical/Code: ${syntax.codeAndFormulaNotes}`);
        if (rules.length > 0) {
            sections.push(`[BOOK BIBLE: CONVENTIONS]\n${rules.join("\n")}`);
        }
    }

    return sections.length > 0 ? `\n${sections.join("\n\n")}\n` : "";
};

/**
 * 运行 Director Agent
 */
export const runDirectorAgent = async (
    chapters,
    aiProvider,
    logger,
    runtimeConfig,
) => {
    console.log(
        "\n🎬 Step 0: Director Agent is analyzing book skeleton & establishing Book Bible...",
    );

    const skeleton = extractBookSkeleton(chapters);
    if (!skeleton || skeleton.length === 0) {
        logger?.write?.(
            "WARN",
            "Director Agent: No chapters available to extract skeleton.",
        );
        return null;
    }

    const payload = {
        sourceLanguage: runtimeConfig.sourceLanguage,
        targetLanguage: runtimeConfig.targetLanguage,
        sampledChapters: skeleton,
    };

    const prompt = buildDirectorPrompt(
        runtimeConfig.sourceLanguage,
        runtimeConfig.targetLanguage,
    );

    try {
        const bookBible = await callAIWithRetry(
            aiProvider,
            JSON.stringify(payload, null, 2),
            prompt,
            3,
        );

        const charCount = Array.isArray(bookBible?.characterBible)
            ? bookBible.characterBible.length
            : 0;
        const termCount = bookBible?.worldviewAndGlossary
            ? Object.keys(bookBible.worldviewAndGlossary).length
            : 0;

        console.log(
            `🎬 Book Bible established: Genre="${bookBible?.genre || "Unknown"}", Characters=${charCount}, Worldview Terms=${termCount}`,
        );

        logger?.write?.(
            "INFO",
            `Director Agent completed: ${JSON.stringify({ genre: bookBible?.genre, charCount, termCount })}`,
        );

        return bookBible;
    } catch (error) {
        console.warn(
            `⚠️ Director Agent failed (${error.message}); continuing without Book Bible.`,
        );
        logger?.write?.(
            "ERROR",
            `Director Agent Failed: ${error.stack || error.message}`,
        );
        return null;
    }
};
