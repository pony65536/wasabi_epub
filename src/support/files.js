import fs from "node:fs";
import path from "node:path";

export const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

export { moveFileIfNeeded } from "./archive.js";

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
