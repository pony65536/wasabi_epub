import * as cheerio from "cheerio";

// =================== Cheerio 基础配置 ===================
export const CHEERIO_OPTIONS = { xmlMode: true, decodeEntities: false };

export const loadHtml = (html) => cheerio.load(html, CHEERIO_OPTIONS);

// =================== AI 响应清洗 ===================
/**
 * 清洗 AI 返回内容：
 * 1. 只剥离答案最外层（开头）的推理块，避免误删正文/JSON 字符串里的字面标签
 * 2. 去掉 Markdown 代码块包裹
 * 支持带属性的推理标签，如 <think role="analysis">。
 */
const REASONING_OPEN = "<(think|thinking|reasoning)\\b[^>]*>";

const stripCodeFences = (value) =>
    String(value ?? "")
        .replace(/^```[\w]*\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

export const cleanAIResponse = (raw) => {
    let text = String(raw ?? "").trim();
    text = stripCodeFences(text);
    // 开头已闭合的推理块
    text = text.replace(
        new RegExp(`^${REASONING_OPEN}[\\s\\S]*?<\\/\\1>\\s*`, "i"),
        "",
    );
    // 开头未闭合的推理块（响应被截断，只有思考没有答案）
    text = text.replace(new RegExp(`^${REASONING_OPEN}[\\s\\S]*$`, "i"), "");
    text = stripCodeFences(text);
    return text;
};

// =================== Heading 提取工具 ===================
export const extractFirstHeading = (htmlContent) => {
    const $ = loadHtml(htmlContent);
    const heading = $("h1, h2").first();
    if (heading.length > 0) return heading.text().replace(/\s+/g, " ").trim();
    const titleTag = $("title").text();
    return titleTag ? titleTag.trim() : null;
};

// =================== Anchor 解析工具 ===================
export const resolveAnchorTitle = ($doc, anchor) => {
    const cleanText = ($el) => {
        if (!$el || !$el.length) return "";
        const $clone = $el.clone();
        $clone.find("sup, a[href]").remove();
        return $clone.text().trim().replace(/\s+/g, " ");
    };

    // hgroup 拼接：ordinal + title
    const resolveHgroup = ($hgroup) => {
        const $ordinal = $hgroup
            .find('[epub\\:type~="ordinal"], h1, h2, h3')
            .first();
        const $title = $hgroup
            .find('[epub\\:type~="title"], h4, h5, h6')
            .first();
        const ordinal = cleanText($ordinal);
        const title = cleanText($title);
        if (ordinal && title) return `${ordinal}：${title}`;
        return title || ordinal || cleanText($hgroup);
    };

    if (anchor) {
        const $el = $doc(`#${anchor}`);
        if ($el.length > 0) {
            // 优先检查自身或祖先是否在 hgroup 里
            const $hgroup = $el.closest("hgroup");
            if ($hgroup.length) return resolveHgroup($hgroup);

            let text = cleanText($el);
            if (!text) {
                const $heading = $el.find("h1, h2, h3, h4, h5, h6").first();
                if ($heading.length) {
                    const $hg = $heading.closest("hgroup");
                    if ($hg.length) return resolveHgroup($hg);
                    text = cleanText($heading);
                } else {
                    const $next = $el.nextAll("h1, h2, h3, h4").first();
                    const $hg = $next.closest("hgroup");
                    if ($hg.length) return resolveHgroup($hg);
                    text = cleanText($next);
                }
            }
            if (!text) {
                const $closest = $el.closest("h1, h2, h3, h4, h5, h6");
                const $hg = $closest.closest("hgroup");
                if ($hg.length) return resolveHgroup($hg);
                text = cleanText($closest);
            }
            if (text) return text;
        }
    }

    // fallback：页面第一个标题，也检查 hgroup
    const $firstHgroup = $doc("hgroup").first();
    if ($firstHgroup.length) return resolveHgroup($firstHgroup);
    return cleanText($doc("h1, h2, h3").first()) || null;
};

// =================== href 规范化索引 ===================
export const normalizeHref = (href) =>
    decodeURIComponent(href || "")
        .split("#")[0]
        .replace(/^\.\//, "")
        .replace(/\\/g, "/")
        .toLowerCase()
        .trim();

export const buildHrefIndex = (chapterMap) => {
    const index = new Map();
    for (const data of chapterMap.values()) {
        if (!data.href) continue;
        index.set(normalizeHref(data.href), data);
    }
    return index;
};

// =================== 带重试的 JSON AI 调用 ===================
export const callAIWithRetry = async (
    aiProvider,
    userContent,
    systemPrompt,
    maxAttempts = 3,
) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const raw = await aiProvider.callAI(
                userContent,
                systemPrompt,
                true,
            );
            return JSON.parse(cleanAIResponse(raw));
        } catch (e) {
            if (attempt >= maxAttempts) throw e;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
};
