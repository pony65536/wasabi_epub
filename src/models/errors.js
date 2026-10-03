/**
 * 模型调用错误分类：网关、批处理、辅助阶段共用。
 */

export const isContentPolicyError = (err) => {
    const message = String(err?.message || "").toLowerCase();
    if (!message) return false;

    const hasContentPolicySignal =
        message.includes("inappropriate content") ||
        message.includes("content policy") ||
        message.includes("content-filter") ||
        message.includes("content filter") ||
        message.includes("safety policy") ||
        message.includes("violates safety");

    if (!hasContentPolicySignal) return false;

    const excludedSignals = [
        "invalid json",
        "json",
        "timeout",
        "timed out",
        "rate limit",
        "429",
        "econnreset",
        "socket hang up",
    ];

    return !excludedSignals.some((token) => message.includes(token));
};

export const classifyProviderError = (error) => {
    const message = String(error?.message || "").toLowerCase();
    const status = Number(error?.status || error?.response?.status || 0);

    if (error?.code === "ETIMEDOUT" || message.includes("timed out")) {
        return { category: "timeout", retryable: true };
    }
    if (
        status === 401 ||
        status === 403 ||
        message.includes("unauthorized") ||
        message.includes("invalid api key") ||
        message.includes("api key")
    ) {
        return { category: "auth", retryable: false };
    }
    if (status === 429 || message.includes("rate limit")) {
        return { category: "rate_limit", retryable: true };
    }
    if (
        message.includes("deprecated") ||
        message.includes("decommissioned") ||
        message.includes("no longer available") ||
        message.includes("model not found") ||
        message.includes("unknown model")
    ) {
        return { category: "model_missing", retryable: false };
    }
    if (
        message.includes("econnreset") ||
        message.includes("socket hang up") ||
        message.includes("fetch failed") ||
        message.includes("network")
    ) {
        return { category: "network", retryable: true };
    }
    if (
        message.includes("invalid json") ||
        message.includes("missing or empty nodes") ||
        message.includes("slot integrity") ||
        message.includes("protected structure") ||
        message.includes("invalid html")
    ) {
        return { category: "format", retryable: true };
    }
    if (
        error?.code === "OUTPUT_TRUNCATED" ||
        message.includes("truncated") ||
        message.includes("finish_reason")
    ) {
        return { category: "output_truncated", retryable: true };
    }
    if (
        error?.code === "EMPTY_CONTENT" ||
        message.includes("reasoning only") ||
        message.includes("empty content") ||
        message.includes("no assistant content")
    ) {
        return { category: "thinking_only", retryable: true };
    }
    if (
        message.includes("could not be written back") ||
        message.includes("target missing")
    ) {
        return { category: "structure", retryable: false };
    }
    if (isContentPolicyError(error)) {
        return { category: "content_policy", retryable: true };
    }
    if (
        error?.code === "TASK_COST_LIMIT_REACHED" ||
        error?.code === "CONSECUTIVE_FAILURES"
    ) {
        return { category: "budget", retryable: false };
    }
    return { category: "unknown", retryable: true };
};
