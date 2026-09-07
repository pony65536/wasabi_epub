import path from "path";
import * as cheerio from "cheerio";

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
        const opfEntry = zip.getEntries().find((entry) => entry.entryName.endsWith(".opf"));
        let $opf = null;
        let opfChanged = false;

        if (opfEntry) {
            $opf = cheerio.load(opfEntry.getData().toString("utf8"), { xmlMode: true });
        }

        for (const data of chapterMap.values()) {
            // 如果是内存切分产生的新章节文件，动态补充写入 zip 并注册进 content.opf
            if (data.isGeneratedSplit) {
                zip.addFile(data.entryName, Buffer.from(data.html, "utf8"));
                if ($opf) {
                    const relativeHref = path.basename(data.entryName);
                    if ($opf(`manifest item[id="${data.id}"]`).length === 0) {
                        $opf("manifest").append(
                            `<item id="${data.id}" href="${relativeHref}" media-type="application/xhtml+xml"/>\n`,
                        );
                        $opf("spine").append(`<itemref idref="${data.id}"/>\n`);
                        opfChanged = true;
                    }
                }
            } else {
                zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
            }
        }

        if (opfChanged && opfEntry && $opf) {
            zip.updateFile(opfEntry.entryName, Buffer.from($opf.xml(), "utf8"));
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
