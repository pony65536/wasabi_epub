/**
 * 翻译覆盖率审计：逐文本单元记录处理决定，任何「应翻未翻」不得 complete。
 */

// 明确属于「有意保留」的分类原因（非漏翻）
const INTENTIONAL_PRESERVE_REASONS = new Set([
    "empty",
    "caption_label",
    "caption_keep",
    "numeric_only",
    "formula_like_text",
    "quantum_notation",
    "equation_class",
    "embedded_non_text_content",
    "image_like_table",
    "table_keep",
    "table_real",
    "structural_not_selected",
]);

const stripTags = (value) => String(value ?? "").replace(/<[^>]*>/g, "");

export const countVisibleChars = (value) =>
    stripTags(value).replace(/\s+/g, "").length;

/**
 * @returns {{
 *   selectedUnits: number, preservedUnits: number,
 *   selectedChars: number, preservedChars: number,
 *   failedUnits: number, gaps: Array<{id, reason, sample, letterCount}>
 * }}
 */
export const computeCoverageAudit = ({
    selectedUnits = [],
    preservedUnits = [],
    failedNodeIds = [],
    candidateUnits = [],
    textNodeGaps = [],
} = {}) => {
    const gaps = [];
    for (const unit of preservedUnits) {
        const text = stripTags(unit?.text ?? unit?.content ?? "");
        const letterCount = (text.match(/\p{L}/gu) || []).length;
        const reason = String(unit?.reason || "unknown");
        if (letterCount >= 4 && !INTENTIONAL_PRESERVE_REASONS.has(reason)) {
            gaps.push({
                id: unit?.id || null,
                reason,
                sample: text.replace(/\s+/g, " ").trim().slice(0, 80),
                letterCount,
            });
        }
    }

    // 文本节点级漏选（按位置/身份核对，避免子串匹配掩盖）
    for (const gap of textNodeGaps) {
        gaps.push(gap);
    }

    // 未被任何已选/已保留单元覆盖的候选文本 → 漏选
    if (candidateUnits.length > 0) {
        const coveredTexts = [...selectedUnits, ...preservedUnits]
            .map((unit) => stripTags(unit?.content ?? unit?.text ?? ""))
            .filter(Boolean);
        for (const candidate of candidateUnits) {
            const text = stripTags(
                candidate?.text ?? candidate?.content ?? "",
            );
            const compact = text.replace(/\s+/g, "");
            if (compact.length < 2) continue;
            const matched = coveredTexts.some(
                (covered) =>
                    covered.includes(text) ||
                    (text.includes(covered) && covered.replace(/\s+/g, "").length >= 4),
            );
            if (matched) continue;
            const letterCount = (text.match(/\p{L}/gu) || []).length;
            if (letterCount >= 4) {
                gaps.push({
                    id: candidate?.id || null,
                    reason: "not_selected",
                    sample: text.replace(/\s+/g, " ").trim().slice(0, 80),
                    letterCount,
                });
            }
        }
    }

    return {
        selectedUnits: selectedUnits.length,
        preservedUnits: preservedUnits.length,
        candidateUnits: candidateUnits.length,
        selectedChars: selectedUnits.reduce(
            (sum, unit) =>
                sum + countVisibleChars(unit?.content ?? unit?.text),
            0,
        ),
        preservedChars: preservedUnits.reduce(
            (sum, unit) => sum + countVisibleChars(unit?.text ?? unit?.content),
            0,
        ),
        failedUnits: failedNodeIds.length,
        textNodeGaps: textNodeGaps.length,
        gaps,
    };
};
