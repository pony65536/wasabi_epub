/**
 * 行内排版占位符模块 (Inline Tag Slots Architecture)
 *
 * 核心原理：
 * 1. 独占命名空间: 使用 `<ws-slot id="N">...</ws-slot>`，极难与自然文本或代码混淆。
 * 2. 动态 Nonce 防护: 若极端情况下原文包含该标签，动态加盐生成唯一前缀。
 * 3. 白名单查表还原: 解码时只认发出过的 slot ID，正文若原有类似格式绝不误伤。
 * 4. 容错与语法修复: 自动容忍模型漏写闭合标签、标签拼写畸变等幻觉。
 */

// 受保护的行内排版标签（包含超链接、格式加粗/斜体、代码、角标/脚注等）
export const INLINE_TAG_NAMES = new Set([
    "a",
    "em",
    "i",
    "strong",
    "b",
    "code",
    "kbd",
    "sub",
    "sup",
    "small",
    "span",
    "cite",
    "dfn",
    "mark",
    "q",
    "abbr",
]);

/**
 * 编码 HTML 片段中的行内标签为安全占位符
 * @param {string} htmlContent - 待翻译段落的 HTML 片段
 * @returns {{ encodedText: string, slotMap: Record<string, { tag: string, attrs: Record<string, string>, rawOpen: string, rawClose: string }>, slotTag: string }}
 */
export const encodeInlineTags = (htmlContent) => {
    if (!htmlContent || typeof htmlContent !== "string" || !htmlContent.includes("<")) {
        return {
            encodedText: htmlContent || "",
            slotMap: {},
            slotTag: "ws-slot",
            incomplete: false,
        };
    }

    // 动态探测冲突：若正文罕见地出现了 ws-slot，动态添加后缀
    let slotTag = "ws-slot";
    if (htmlContent.includes(slotTag)) {
        let counter = 1;
        while (htmlContent.includes(`${slotTag}-${counter}`)) {
            counter++;
        }
        slotTag = `${slotTag}-${counter}`;
    }

    const slotMap = {};
    let slotIndex = 0;

    // 匹配最内层的行内标签 (即内部不再包含其他行内标签)，优先由内向外剥离，确保嵌套顺序纯净
    let currentText = htmlContent;
    let hasReplaced = true;
    // 每个标签至多被替换一次，用标签数作为安全上限，避免异常输入死循环
    const safetyLimit = (htmlContent.match(/</g) || []).length + 5;
    let iteration = 0;

    const tagPattern = Array.from(INLINE_TAG_NAMES).join("|");
    // 1. 自闭合标签
    const selfClosingRegex = new RegExp(
        `<(${tagPattern})(\\s+[^>]*?)?\\/>`,
        "i",
    );
    // 2. 最内层非自闭合成对标签
    const innermostPairRegex = new RegExp(
        `<(${tagPattern})(\\s+[^>]*?)?>([^<]*?)<\\/\\1>`,
        "i",
    );
    // 3. 兜底成对标签
    const fallbackPairRegex = new RegExp(
        `<(${tagPattern})(\\s+[^>]*?)?>([\\s\\S]*?)<\\/\\1>`,
        "i",
    );

    while (hasReplaced && iteration < safetyLimit) {
        iteration++;
        hasReplaced = false;

        if (selfClosingRegex.test(currentText)) {
            currentText = currentText.replace(selfClosingRegex, (match, tag, attrs) => {
                hasReplaced = true;
                slotIndex++;
                const id = String(slotIndex);
                slotMap[id] = {
                    tag: tag.toLowerCase(),
                    rawAttrs: attrs ? ` ${attrs.trim()}` : "",
                    isSelfClosing: true,
                };
                return `<${slotTag} id="${id}"/>`;
            });
            continue;
        }

        const regex = innermostPairRegex.test(currentText)
            ? innermostPairRegex
            : fallbackPairRegex;

        if (regex.test(currentText)) {
            currentText = currentText.replace(regex, (match, tag, attrs, innerContent) => {
                hasReplaced = true;
                slotIndex++;
                const id = String(slotIndex);
                slotMap[id] = {
                    tag: tag.toLowerCase(),
                    rawAttrs: attrs ? ` ${attrs.trim()}` : "",
                    isSelfClosing: false,
                };
                return `<${slotTag} id="${id}">${innerContent}</${slotTag}>`;
            });
        }
    }

    const residualTagRegex = new RegExp(`<(${tagPattern})\\b`, "i");
    const incomplete = residualTagRegex.test(currentText);

    return {
        encodedText: currentText,
        slotMap,
        slotTag,
        incomplete,
    };
};

/**
 * 将包含占位符的译文安全还原为出版级 HTML，并报告完整性。
 * @returns {{ html: string, missingSlots: string[], unknownSlots: string[], duplicateSlots: string[], residualSlots: number }}
 */
export const decodeInlineTagsDetailed = (
    translatedText,
    slotMap = {},
    slotTag = "ws-slot",
) => {
    const source = String(translatedText ?? "");
    if (!source || Object.keys(slotMap).length === 0) {
        return {
            html: source,
            missingSlots: Object.keys(slotMap || {}),
            unknownSlots: [],
            duplicateSlots: [],
            residualSlots: 0,
        };
    }

    const slotIdRegex = new RegExp(
        `<${slotTag}\\s+id=["']?(\\d+)["']?`,
        "gi",
    );
    const idCounts = new Map();
    let idMatch;
    while ((idMatch = slotIdRegex.exec(source)) !== null) {
        const id = idMatch[1];
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }

    const knownIds = new Set(Object.keys(slotMap));
    const missingSlots = [...knownIds].filter((id) => !idCounts.has(id));
    const unknownSlots = [...idCounts.keys()].filter(
        (id) => !knownIds.has(id),
    );
    const duplicateSlots = [...idCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id);

    let result = source;

    // 递归查找并优先替换最内层的 slot 标签（其内部不包含任何其他 slotTag 标签）
    // 这样在嵌套结构下（如 <ws-slot id="2"><ws-slot id="1">...</ws-slot></ws-slot>）
    // 会先将内部 slot 1 还原为 <em>...</em>，外层 slot 2 再完整包裹，避免标签错位
    const innermostSlotRegex = new RegExp(
        `<${slotTag}\\s+id=["']?(\\d+)["']?\\s*(?:\\/>|>((?:(?!<${slotTag}\\b)[\\s\\S])*?)<\\/${slotTag}\\s*>)`,
        "i",
    );
    const fallbackSlotRegex = new RegExp(
        `<${slotTag}\\s+id=["']?(\\d+)["']?\\s*(?:\\/>|>([\\s\\S]*?)<\\/${slotTag}\\s*>)`,
        "i",
    );

    let hasDecoded = true;
    let iteration = 0;
    // 每个 slot 至少一轮；嵌套需要额外轮次，用出现次数 * 2 作安全上限
    const safetyLimit =
        (source.match(new RegExp(`<${slotTag}\\b`, "g")) || []).length * 2 +
        10;

    while (hasDecoded && iteration < safetyLimit) {
        iteration++;
        hasDecoded = false;

        // 优先匹配不包含嵌套 slot 的项
        let matched = false;
        result = result.replace(innermostSlotRegex, (match, slotId, innerContent) => {
            const entry = slotMap[slotId];
            if (!entry) {
                // 若不是有效 ID，返回跳过让它不阻碍循环
                return match;
            }

            hasDecoded = true;
            matched = true;
            if (entry.isSelfClosing) {
                return `<${entry.tag}${entry.rawAttrs}/>`;
            }
            const content = innerContent !== undefined ? innerContent : "";
            return `<${entry.tag}${entry.rawAttrs}>${content}</${entry.tag}>`;
        });

        if (!matched && fallbackSlotRegex.test(result)) {
            result = result.replace(fallbackSlotRegex, (match, slotId, innerContent) => {
                const entry = slotMap[slotId];
                if (!entry) return match;
                hasDecoded = true;
                if (entry.isSelfClosing) {
                    return `<${entry.tag}${entry.rawAttrs}/>`;
                }
                const content = innerContent !== undefined ? innerContent : "";
                return `<${entry.tag}${entry.rawAttrs}>${content}</${entry.tag}>`;
            });
        }
    }

    // 容错修复机制：如果模型把闭合标签漏掉了，如写成了 "<ws-slot id="1">文字"，做一次清理
    // 找出尚未被还原但存在于 slotMap 中的孤儿开始标签
    for (const [id, entry] of Object.entries(slotMap)) {
        const orphanStartRegex = new RegExp(`<${slotTag}\\s+id=["']?${id}["']?\\s*>`, "gi");
        if (orphanStartRegex.test(result)) {
            result = result.replace(orphanStartRegex, `<${entry.tag}${entry.rawAttrs}>`);
            // 如果缺少闭合标签，在句尾或段末尝试补齐
            const closeTag = `</${entry.tag}>`;
            if (!entry.isSelfClosing && !result.includes(closeTag)) {
                result = `${result}${closeTag}`;
            }
        }
    }

    const residualSlots = (
        result.match(new RegExp(`</?${slotTag}\\b`, "g")) || []
    ).length;

    return {
        html: result,
        missingSlots,
        unknownSlots,
        duplicateSlots,
        residualSlots,
    };
};

export const decodeInlineTags = (translatedText, slotMap = {}, slotTag = "ws-slot") =>
    decodeInlineTagsDetailed(translatedText, slotMap, slotTag).html;
