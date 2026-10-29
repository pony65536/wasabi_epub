import fs from "node:fs";
import path from "node:path";

export const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

export const moveFileIfNeeded = (sourcePath, targetPath) => {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedSource === resolvedTarget) return;
    ensureDir(path.dirname(resolvedTarget));
    if (fs.existsSync(resolvedTarget)) {
        fs.unlinkSync(resolvedTarget);
    }
    try {
        fs.renameSync(resolvedSource, resolvedTarget);
        return;
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
};

export const saveHtmlDocument = async (outputPath, html, logger) => {
    console.log(`\n💾 Step 5: Finalizing and Saving...`);
    try {
        fs.writeFileSync(outputPath, html, "utf8");
        console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
    } catch (error) {
        logger.write("ERROR", `Save HTML Failed: ${error.stack || error.message}`);
        throw error;
    }
};
