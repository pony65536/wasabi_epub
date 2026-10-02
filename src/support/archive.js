import fs from "fs";
import path from "path";

export const resolveAvailableArchivePath = (targetPath) => {
    if (!fs.existsSync(targetPath)) return targetPath;
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);
    let index = 1;
    let candidate = path.join(dir, `${base}.${index}${ext}`);
    while (fs.existsSync(candidate)) {
        index += 1;
        candidate = path.join(dir, `${base}.${index}${ext}`);
    }
    return candidate;
};

/**
 * 安全归档：源文件移动到目标位置；若目标已存在，追加序号保留两份，绝不覆盖。
 */
export const moveFileIfNeeded = (sourcePath, targetPath) => {
    const resolvedSource = path.resolve(sourcePath);
    let resolvedTarget = path.resolve(targetPath);
    if (resolvedSource === resolvedTarget) return resolvedTarget;

    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    if (fs.existsSync(resolvedTarget)) {
        const available = resolveAvailableArchivePath(resolvedTarget);
        console.warn(
            `⚠️  Target already exists: "${path.basename(resolvedTarget)}"; archiving as "${path.basename(available)}" instead.`,
        );
        resolvedTarget = available;
    }

    try {
        fs.renameSync(resolvedSource, resolvedTarget);
        return resolvedTarget;
    } catch (error) {
        if (!["EPERM", "EXDEV", "EBUSY"].includes(error?.code)) {
            throw error;
        }
    }

    fs.copyFileSync(resolvedSource, resolvedTarget);
    try {
        fs.unlinkSync(resolvedSource);
    } catch {
        console.warn(
            `⚠️  Source file could not be removed after copying to input: ${path.basename(resolvedSource)}`,
        );
    }
    return resolvedTarget;
};
