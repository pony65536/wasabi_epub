import { callAIWithRetry } from "../utils.js";

/**
 * 门控反思审校模块 (Gated Critic & Self-Correction Agent)
 * 
 * 核心考量：
 * 1. 成本控制 (Gating 门禁): 绝不对每一句话调用审校，否则成本和时间暴增 300%。
 * 2. 触发门禁条件：
 *    - 含有初译阶段生成的 <ws-note> 译者注（审校其准确性与必要性，剔除多余加注）
 *    - 初译文本与原文长度比例失常（疑似严重漏译）
 *    - 段落包含重点专有名词但译文出现生硬直译迹象
 */

/**
 * 门控判定：是否需要激活 Critic 审校
 */
export const shouldTriggerCritic = (sourceText, translatedText) => {
    if (!sourceText || !translatedText) return false;

    // 1. 若含有 <ws-note>，必须触发 Critic 审校，以保证“译者注”客观克制、不自作多情
    if (translatedText.includes("<ws-note")) {
        return true;
    }

    const srcLen = sourceText.trim().length;
    const tgtLen = translatedText.trim().length;

    // 2. 原文较长（超过 80 字符），但译文短得出奇（长度比例严重失衡，疑似大模型漏译半句）
    if (srcLen > 80 && tgtLen < srcLen * 0.25) {
        return true;
    }

    // 3. 原文很短（如一行标题或短句），但译文异常冗长（疑似模型出现幻觉自言自语）
    if (srcLen < 40 && tgtLen > srcLen * 3.5) {
        return true;
    }

    return false;
};

const buildCriticPrompt = (targetLanguage) => `
You are the "Master Translation Critic & Reviewer" (资深审校总监).

Your task is to review and polish the candidate translation against the source text.

Rules:
1. Return valid JSON only:
{
  "improved": "Refined and corrected translation in ${targetLanguage}",
  "hasSevereIssue": true | false,
  "changesSummary": "Brief explanation of what was fixed or why note was kept/removed"
}
2. Strictly check:
   - Completeness: Ensure no sentences or phrases were dropped/omitted.
   - Tag Preservation: Strictly preserve any <ws-slot id="..."> tags intact.
   - Translator Notes (<ws-note>): 
     Review any <ws-note term="...">note content</ws-note>.
     KEEP IT only if it provides genuine cultural/historical/metaphor context necessary for Chinese readers.
     REMOVE THE <ws-note> if it is trivial, pedantic, or obvious (e.g. explaining common knowledge like "London" or "Computer").
3. Fluency & Cadence: Ensure natural phrasing avoiding mechanical translationese.
`.trim();

/**
 * 运行 Critic 审校修正
 */
export const reviewAndCorrectNode = async (
    sourceText,
    candidateTranslation,
    aiProvider,
    logger,
    targetLanguage = "Chinese (Simplified)",
) => {
    try {
        const payload = {
            source: sourceText,
            candidateTranslation,
        };

        const prompt = buildCriticPrompt(targetLanguage);
        const result = await callAIWithRetry(
            aiProvider,
            JSON.stringify(payload, null, 2),
            prompt,
            2,
        );

        if (result?.improved) {
            logger?.write?.(
                "INFO",
                `Critic corrected node:\nFrom: ${candidateTranslation}\nTo: ${result.improved}\nReason: ${result.changesSummary || "Polish"}`,
            );
            return result.improved;
        }
    } catch (e) {
        logger?.write?.("WARN", `Critic Review failed (${e.message}), keeping candidate translation.`);
    }

    return candidateTranslation;
};
