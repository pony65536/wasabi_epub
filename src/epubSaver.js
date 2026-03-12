import path from "path";

export const saveEpub = async (
    zip,
    chapterMap,
    ncxEntry,
    ncxContent,
    outputPath,
    logger,
) => {
    console.log(`\n💾 Step 8: Finalizing and Saving...`);
    try {
        for (const data of chapterMap.values()) {
            zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
        }
        if (ncxEntry && ncxContent) {
            zip.updateFile(ncxEntry.entryName, Buffer.from(ncxContent, "utf8"));
        }
        zip.writeZip(outputPath);
        console.log(`🎉 Done! Output: ${path.basename(outputPath)}`);
    } catch (e) {
        logger.write("ERROR", `Save EPUB Failed: ${e.stack || e.message}`);
        throw e;
    }
};
