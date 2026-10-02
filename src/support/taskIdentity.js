import crypto from "crypto";
import fs from "fs";
import path from "path";

// 翻译规则/流程版本：提示词、批处理或后处理规则变化时递增
export const TRANSLATION_PIPELINE_VERSION = 2;

const FULL_HASH_MAX_BYTES = 64 * 1024 * 1024;
const SAMPLE_BYTES = 1024 * 1024;

/**
 * 计算源文件内容摘要（不含 mtime，内容不变则摘要稳定）。
 * 大文件（>64MB）使用 大小+首尾采样，属于快速指纹而非完整内容证明。
 */
export const computeFileDigest = (filePath) => {
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash("sha1");

    if (stat.size <= FULL_HASH_MAX_BYTES) {
        hash.update(fs.readFileSync(filePath));
        return hash.digest("hex");
    }

    hash.update(`${stat.size}`);
    const fd = fs.openSync(filePath, "r");
    try {
        const head = Buffer.alloc(SAMPLE_BYTES);
        const tail = Buffer.alloc(SAMPLE_BYTES);
        fs.readSync(fd, head, 0, SAMPLE_BYTES, 0);
        fs.readSync(
            fd,
            tail,
            0,
            SAMPLE_BYTES,
            Math.max(0, stat.size - SAMPLE_BYTES),
        );
        hash.update(head).update(tail);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
};

/**
 * 快速指纹：大小 + mtime，仅用于迁移提示/诊断，不作为内容证明。
 */
export const computeFastFingerprint = (filePath) => {
    const stat = fs.statSync(filePath);
    return crypto
        .createHash("sha1")
        .update(`${stat.size}|${Math.round(stat.mtimeMs)}`)
        .digest("hex");
};

export const computeTextDigest = (text) =>
    crypto.createHash("sha1").update(String(text ?? "")).digest("hex");

export const computePromptDigest = (projectRoot, promptFileName) => {
    const file = path.join(projectRoot, "prompts", promptFileName);
    if (!fs.existsSync(file)) return "missing";
    return crypto
        .createHash("sha1")
        .update(fs.readFileSync(file))
        .digest("hex");
};

/**
 * 任务签名 = 流程版本 + 源内容摘要 + 源/目标语言 + 额外维度（提示词、修复指纹、页选等）。
 */
export const buildTaskSignature = ({
    kind,
    sourceDigest,
    sourceLanguage,
    targetLanguage,
    extras = {},
}) =>
    crypto
        .createHash("sha1")
        .update(
            JSON.stringify({
                version: TRANSLATION_PIPELINE_VERSION,
                kind,
                sourceDigest,
                sourceLanguage: String(sourceLanguage || "").toLowerCase(),
                targetLanguage: String(targetLanguage || "").toLowerCase(),
                ...extras,
            }),
        )
        .digest("hex");
