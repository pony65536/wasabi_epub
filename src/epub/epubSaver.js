import path from "path";
import * as cheerio from "cheerio";

const toPosix = (value) => String(value || "").replace(/\\/g, "/");

const relativeHref = (fromDir, toPath) => {
    const relative = path.posix.relative(toPosix(fromDir), toPosix(toPath));
    return relative || path.posix.basename(toPosix(toPath));
};

export const saveEpub = async (
    zip,
    chapterMap,
    ncxEntry,
    ncxContent,
    outputPath,
    logger,
    repairReport = null,
) => {
    console.log(`\n💾 Step 8: Finalizing and Saving...`);
    try {
        const opfEntry = zip
            .getEntries()
            .find((entry) => entry.entryName.endsWith(".opf"));
        const opfDir = opfEntry
            ? toPosix(opfEntry.entryName).replace(/[^/]+$/, "")
            : "";
        let $opf = null;
        let opfChanged = false;

        if (opfEntry) {
            $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
                xmlMode: true,
            });
        }

        const replaced = Array.isArray(repairReport?.replaced)
            ? repairReport.replaced
            : [];
        const replacedById = new Map(replaced.map((item) => [item.id, item]));

        for (const data of chapterMap.values()) {
            if (!data.entryName) continue;
            // 如果是内存切分产生的新章节文件，动态补充写入 zip 并注册进 content.opf
            if (data.isGeneratedSplit) {
                zip.addFile(data.entryName, Buffer.from(data.html, "utf8"));
                if ($opf && $opf(`manifest item[id="${data.id}"]`).length === 0) {
                    const href = relativeHref(opfDir, data.entryName);
                    $opf("manifest").append(
                        `<item id="${data.id}" href="${href}" media-type="application/xhtml+xml"/>\n`,
                    );
                    opfChanged = true;
                }
            } else {
                zip.updateFile(data.entryName, Buffer.from(data.html, "utf8"));
            }
        }

        if ($opf && replaced.length > 0) {
            for (const item of replaced) {
                if (item.entryName) {
                    try {
                        zip.deleteFile(item.entryName);
                    } catch {
                        // 原文件可能已被移除，忽略
                    }
                }
                const $item = $opf(`manifest item[id="${item.id}"]`);
                if ($item.length) {
                    $item.remove();
                    opfChanged = true;
                }
            }

            const spineNodes = $opf("spine itemref").toArray();
            let spineChanged = false;
            const rebuilt = [];
            for (const node of spineNodes) {
                const $node = $opf(node);
                const idref = $node.attr("idref");
                const item = replacedById.get(idref);
                if (item) {
                    spineChanged = true;
                    // 语义属性（linear/properties）继承到替换出的分片；
                    // 原 id 不继承，避免重复标识。
                    const inherited = {};
                    for (const key of ["linear", "properties"]) {
                        const value = $node.attr(key);
                        if (value != null) inherited[key] = value;
                    }
                    const inheritedText = Object.entries(inherited)
                        .map(
                            ([key, value]) =>
                                ` ${key}="${String(value).replace(/"/g, "&quot;")}"`,
                        )
                        .join("");
                    for (const partId of item.partIds) {
                        rebuilt.push(
                            `<itemref idref="${partId}"${inheritedText}/>`,
                        );
                    }
                    continue;
                }
                const attrs = $node.attr() || {};
                const attrText = Object.entries(attrs)
                    .map(
                        ([key, value]) =>
                            ` ${key}="${String(value).replace(/"/g, "&quot;")}"`,
                    )
                    .join("");
                rebuilt.push(`<itemref${attrText}/>`);
            }
            if (spineChanged) {
                $opf("spine").empty();
                for (const itemref of rebuilt) {
                    $opf("spine").append(`${itemref}\n`);
                }
                opfChanged = true;
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
