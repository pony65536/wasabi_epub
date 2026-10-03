/**
 * 模型响应归一化：SSE 字符串解析、正文提取、完成度判定。
 */

export const extractCompletionContent = (completion) => {
    const message = completion?.choices?.[0]?.message || {};
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                typeof part === "string"
                    ? part
                    : String(part?.text ?? part?.content ?? ""),
            )
            .join("")
            .trim();
    }
    return "";
};

/**
 * 解析被中转站以字符串形式返回的 SSE 响应，只提取 assistant 正文。
 * 返回空串表示没有可用的正文（例如只有 reasoning 增量）。
 */
export const parseSseCompletion = (raw) => {
    const chunks = [];
    for (const line of String(raw ?? "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
        try {
            const parsed = JSON.parse(trimmed.slice(5).trim());
            const content =
                parsed?.choices?.[0]?.delta?.content ||
                parsed?.choices?.[0]?.message?.content ||
                "";
            if (typeof content === "string" && content) chunks.push(content);
        } catch {
            // 忽略无法解析的行
        }
    }
    return chunks.join("").trim();
};

/**
 * 读取完成的响应正文：
 * - finish_reason=length 视为未完成，禁止写回
 * - 正文为空（含只有 reasoning）视为错误
 */
export const readCompletionContent = (completion) => {
    const choice = completion?.choices?.[0] || {};
    const finishReason = String(choice.finish_reason || "");
    if (finishReason === "length") {
        const error = new Error(
            "Provider response was truncated (finish_reason=length).",
        );
        error.code = "OUTPUT_TRUNCATED";
        throw error;
    }
    const content = extractCompletionContent(completion);
    if (!content) {
        const message = choice.message || {};
        const reasoning = message.reasoning_content || message.reasoning || "";
        const error = new Error(
            reasoning
                ? "Provider returned reasoning only with empty content."
                : "Provider returned empty content.",
        );
        error.code = "EMPTY_CONTENT";
        throw error;
    }
    return content;
};
