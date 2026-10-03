import { loadHtml } from "../utils.js";
import { INLINE_TAG_NAMES } from "../content/inlineSlots.js";

/**
 * 受保护结构校验：批量写回、单节点回退、Critic 改写三条路径共用。
 *
 * 保护对象：
 * - 带 id/href/class/name/src/epub:type 的元素
 * - 所有行内格式标签（em/strong/span/a/sup/sub/code 等，即使没有属性）
 *
 * 校验内容：
 * - 元素身份（标签 + 全部属性键值，排序后）多重集一致
 * - 父子嵌套关系（以父元素身份为键）多重集一致
 *
 * 允许翻译导致的元素顺序变化，但禁止属性值、数量、嵌套关系变化。
 */

const PROTECTED_ATTRIBUTES = ["id", "href", "class", "name", "src", "epub:type"];

// 正文块结构：容器被整段翻译时，模型不得删除/扁平化这些结构
const BODY_BLOCK_TAGS = new Set([
    "ul",
    "ol",
    "li",
    "p",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "figure",
    "figcaption",
    "dl",
    "dt",
    "dd",
    "pre",
]);

const tagOf = (el) => String(el?.tagName || el?.name || "").toLowerCase();

const hasProtectedAttribute = ($el) =>
    PROTECTED_ATTRIBUTES.some((name) => $el.attr(name) != null);

const isProtectedElement = (el, $el) =>
    INLINE_TAG_NAMES.has(tagOf(el)) || hasProtectedAttribute($el);

const fullAttributeSignature = ($el) => {
    const attrs = $el.attr() || {};
    return Object.entries(attrs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
};

const identityOf = (el, $el) => `${tagOf(el)}|${fullAttributeSignature($el)}`;

export const collectProtectedStructure = (html) => {
    const $ = loadHtml(`<ws-root>${String(html ?? "")}</ws-root>`);
    const signatures = [];
    const nesting = [];
    const identities = new Map();
    const bodySignatures = [];
    const bodyNesting = [];

    $("ws-root *").each((_, el) => {
        const tag = tagOf(el);
        const $el = $(el);
        if (BODY_BLOCK_TAGS.has(tag)) {
            bodySignatures.push(tag);
            let ancestor = el.parent;
            let parentTag = "root";
            while (ancestor) {
                const ancestorTag = tagOf(ancestor);
                if (BODY_BLOCK_TAGS.has(ancestorTag)) {
                    parentTag = ancestorTag;
                    break;
                }
                ancestor = ancestor.parent;
            }
            bodyNesting.push(`${parentTag}>${tag}`);
        }
        if (!isProtectedElement(el, $el)) return;
        const identity = identityOf(el, $el);
        identities.set(el, identity);
        signatures.push(identity);
    });

    for (const [el, identity] of identities.entries()) {
        let ancestor = el.parent;
        let parentIdentity = "root";
        while (ancestor) {
            if (identities.has(ancestor)) {
                parentIdentity = identities.get(ancestor);
                break;
            }
            ancestor = ancestor.parent;
        }
        nesting.push(`${parentIdentity}>${identity}`);
    }

    signatures.sort();
    nesting.sort();
    bodySignatures.sort();
    bodyNesting.sort();
    return { signatures, nesting, bodySignatures, bodyNesting };
};

const diffMultiset = (before, after) => {
    const remaining = [...before];
    const missing = [];
    for (const item of after) {
        const index = remaining.indexOf(item);
        if (index >= 0) remaining.splice(index, 1);
    }
    missing.push(...remaining);

    const remainingAfter = [...after];
    const unexpected = [];
    for (const item of before) {
        const index = remainingAfter.indexOf(item);
        if (index >= 0) remainingAfter.splice(index, 1);
    }
    unexpected.push(...remainingAfter);
    return { missing, unexpected };
};

export const validateProtectedStructure = (beforeHtml, afterHtml) => {
    const before = collectProtectedStructure(beforeHtml);
    const after = collectProtectedStructure(afterHtml);
    const signatureDiff = diffMultiset(before.signatures, after.signatures);
    const nestingDiff = diffMultiset(before.nesting, after.nesting);
    const bodyDiff = diffMultiset(
        before.bodySignatures,
        after.bodySignatures,
    );
    const bodyNestingDiff = diffMultiset(
        before.bodyNesting,
        after.bodyNesting,
    );
    const ok =
        signatureDiff.missing.length === 0 &&
        signatureDiff.unexpected.length === 0 &&
        nestingDiff.missing.length === 0 &&
        nestingDiff.unexpected.length === 0 &&
        bodyDiff.missing.length === 0 &&
        bodyDiff.unexpected.length === 0 &&
        bodyNestingDiff.missing.length === 0 &&
        bodyNestingDiff.unexpected.length === 0;

    return {
        ok,
        missingAttributes: signatureDiff.missing,
        unexpectedAttributes: signatureDiff.unexpected,
        missingNesting: nestingDiff.missing,
        unexpectedNesting: nestingDiff.unexpected,
        missingBodyBlocks: bodyDiff.missing,
        unexpectedBodyBlocks: bodyDiff.unexpected,
        missingBodyNesting: bodyNestingDiff.missing,
        unexpectedBodyNesting: bodyNestingDiff.unexpected,
    };
};
