import * as cheerio from "cheerio";

// =================== Cheerio 基础配置 ===================
export const CHEERIO_OPTIONS = { xmlMode: true, decodeEntities: false };

export const loadHtml = (html) => cheerio.load(html, CHEERIO_OPTIONS);

// =================== AI 响应清洗 ===================
/**
 * 清洗 AI 返回内容中的 Markdown 代码块包裹。
 * AI 有时会将结果包在 ```xml 或 ``` 中，导致后续 cheerio 解析失败。
 */
export const cleanAIResponse = (raw) => {
    return raw
        .replace(/```[\w]*\n?/g, "") // 去掉 ```xml、```html 等开头
        .replace(/```/g, "")         // 去掉尾部 ```
        .trim();
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

    if (anchor) {
        const $el = $doc(`#${anchor}`);
        if ($el.length > 0) {
            let text = cleanText($el);
            if (!text) {
                const heading = $el.find("h1, h2, h3, h4, h5, h6").first();
                text =
                    heading.length > 0
                        ? cleanText(heading)
                        : cleanText($el.nextAll("h1, h2, h3, h4").first());
            }
            if (!text) text = cleanText($el.closest("h1, h2, h3, h4, h5, h6"));
            if (text) return text;
        }
    }
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
            return JSON.parse(raw.replace(/```json|```/g, "").trim());
        } catch (e) {
            if (attempt >= maxAttempts) throw e;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
};
