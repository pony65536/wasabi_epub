import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
    diagnoseChapterMap,
    repairChapterMapInPlace,
    isIndexChapter,
} from "../src/epub/epubDoctor.js";
import {
    buildLinkContext,
    resolveLinkTarget,
    rewriteInternalLinks,
    validateNcxLinks,
} from "../src/epub/linkRewriter.js";
import { synchronizeNcx } from "../src/epub/tocSync.js";
import { saveEpub } from "../src/epub/epubSaver.js";
import { createProgressCache } from "../src/support/cache.js";
import { extractFirstHeading, loadHtml, normalizeHref } from "../src/utils.js";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const silentLogger = { write: () => {} };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-epub-audit-"));

const toPosix = (value) => String(value || "").replace(/\\/g, "/");

const findEpub = (predicate) =>
    fs
        .readdirSync(projectRoot)
        .filter((name) => name.endsWith(".epub"))
        .find(predicate);

const loadChapterMap = (zipEntries) => {
    const chapterMap = new Map();
    const opfEntry = zipEntries.find((entry) =>
        entry.entryName.endsWith(".opf"),
    );
    if (!opfEntry) throw new Error("OPF not found");
    const opfBasePath = toPosix(opfEntry.entryName).replace(/[^/]+$/, "");
    const $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
        xmlMode: true,
    });
    $opf("[media-type='application/xhtml+xml']").each((_, el) => {
        const item = {
            id: $opf(el).attr("id"),
            href: $opf(el).attr("href"),
            mediaType: $opf(el).attr("media-type"),
        };
        const fullHref = opfBasePath + item.href;
        const zipEntry = zipEntries.find(
            (entry) => decodeURIComponent(entry.entryName) === fullHref,
        );
        const html = zipEntry ? zipEntry.getData().toString("utf8") : "";
        const chapter = {
            ...item,
            html,
            entryName: zipEntry?.entryName,
            title: extractFirstHeading(html) || item.id || "Untitled",
        };
        if (chapter.entryName) chapterMap.set(chapter.id, chapter);
    });
    return chapterMap;
};

const leafTextHash = (zip) => {
    const items = [];
    for (const entry of zip.getEntries()) {
        if (!/\.x?html$/i.test(entry.entryName)) continue;
        const $ = loadHtml(entry.getData().toString("utf8"));
        const root = $("body").length ? $("body") : $.root();
        root.find("*").each((_, el) => {
            const $el = $(el);
            if ($el.children().length > 0) return;
            const text = $el.text().replace(/\s+/g, " ").trim();
            if (text) items.push(text);
        });
    }
    items.sort();
    return crypto.createHash("sha1").update(items.join("\u0001")).digest("hex");
};

const spineLeafSequence = (zip) => {
    const entries = zip.getEntries();
    const opfEntry = entries.find((entry) => entry.entryName.endsWith(".opf"));
    const $opf = cheerio.load(opfEntry.getData().toString("utf8"), {
        xmlMode: true,
    });
    const opfBasePath = toPosix(opfEntry.entryName).replace(/[^/]+$/, "");
    const idToEntry = new Map();
    $opf("manifest item").each((_, el) => {
        const id = $opf(el).attr("id");
        const href = $opf(el).attr("href");
        if (id && href) {
            idToEntry.set(
                id,
                path.posix.normalize(opfBasePath + decodeURIComponent(href)),
            );
        }
    });
    const sequence = [];
    $opf("spine itemref").each((_, el) => {
        const entryName = idToEntry.get($opf(el).attr("idref"));
        const entry = entries.find((e) => e.entryName === entryName);
        if (!entry) return;
        const $ = loadHtml(entry.getData().toString("utf8"));
        const root = $("body").length ? $("body") : $.root();
        root.find("*").each((__, node) => {
            const $node = $(node);
            if ($node.children().length > 0) return;
            const text = $node.text().replace(/\s+/g, " ").trim();
            if (text) sequence.push(text);
        });
    });
    return sequence;
};

const auditInternalLinks = (zip) => {
    const htmlByEntry = new Map();
    const resourceKeys = new Set();
    for (const entry of zip.getEntries()) {
        resourceKeys.add(normalizeHref(entry.entryName));
        if (/\.x?html$/i.test(entry.entryName)) {
            htmlByEntry.set(
                normalizeHref(entry.entryName),
                entry.getData().toString("utf8"),
            );
        }
    }
    let total = 0;
    let dangling = 0;
    const samples = [];
    for (const [key, html] of htmlByEntry.entries()) {
        const $ = loadHtml(html);
        $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
                return;
            }
            total++;
            const hashIndex = href.indexOf("#");
            const rawFile = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
            const anchor = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
            const targetKey = rawFile
                ? normalizeHref(
                      path.posix.normalize(
                          path.posix.join(path.posix.dirname(key), rawFile),
                      ),
                  )
                : key;
            const targetHtml = htmlByEntry.get(targetKey);
            if (!targetHtml) {
                if (resourceKeys.has(targetKey)) return;
                dangling++;
                if (samples.length < 5) {
                    samples.push(`${key} -> ${href} (missing file)`);
                }
                return;
            }
            if (anchor && !loadHtml(targetHtml)(`#${anchor}`).length) {
                dangling++;
                if (samples.length < 5) {
                    samples.push(`${key} -> ${href} (missing anchor)`);
                }
            }
        });
    }
    return { total, dangling, samples };
};

const auditNcx = (zip, context) => {
    const ncxEntry = zip
        .getEntries()
        .find((entry) => entry.entryName.endsWith(".ncx"));
    if (!ncxEntry) return { total: 0, dangling: 0, samples: [] };
    const $ncx = loadHtml(ncxEntry.getData().toString("utf8"));
    let total = 0;
    let dangling = 0;
    const samples = [];
    $ncx("navPoint").each((_, el) => {
        const src = $ncx(el)
            .children("content")
            .attr("src");
        if (!src) return;
        total++;
        const target = resolveLinkTarget(context, {
            sourceEntry: ncxEntry.entryName,
            href: src,
        });
        if (!target) {
            dangling++;
            if (samples.length < 5) samples.push(`NCX -> ${src} (unresolved)`);
        }
    });
    return { total, dangling, samples };
};

const auditAnchorOwnership = (zip, labels) => {
    const problems = [];
    const htmlEntries = zip
        .getEntries()
        .filter((entry) => /\.x?html$/i.test(entry.entryName));
    const normalize = (value) =>
        String(value || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
    for (const { label, anchor } of labels) {
        const entry = htmlEntries.find((candidate) =>
            candidate.getData().toString("utf8").includes(`id="${anchor}"`),
        );
        if (!entry) {
            problems.push(`anchor #${anchor} ("${label}") missing from output`);
            continue;
        }
        const $ = loadHtml(entry.getData().toString("utf8"));
        const $anchor = $(`#${anchor}`);
        let $heading = $anchor.next();
        while ($heading.length && !$heading.text().trim()) {
            $heading = $heading.next();
        }
        const headingText = ($heading.text() || "")
            .replace(/\s+/g, " ")
            .trim();
        const isChapterLabel = /^(?:chapter|part)\s+/i.test(label);
        if (!headingText) {
            problems.push(
                `${entry.entryName}#${anchor}: no heading follows anchor ("${label}")`,
            );
            continue;
        }
        if (
            isChapterLabel &&
            !normalize(headingText).startsWith(normalize(label).slice(0, 12))
        ) {
            problems.push(
                `${entry.entryName}#${anchor}: expected "${label}" got "${headingText}"`,
            );
        }
    }
    return problems;
};

const runBook = async (epubName, expectRepair) => {
    console.log(`\n================ ${epubName} ================`);
    const inputPath = path.join(projectRoot, epubName);
    const zip = new AdmZip(inputPath);
    const zipEntries = zip.getEntries();
    const chapterMap = loadChapterMap(zipEntries);
    const diagnosis = diagnoseChapterMap(chapterMap);
    console.log(
        `chapters=${chapterMap.size} diagnosis=${JSON.stringify(diagnosis)} indexChapters=${[...chapterMap.values()].filter(isIndexChapter).map((c) => c.id).join(",") || "-"}`,
    );

    const sourceLeafHash = leafTextHash(zip);
    const sourceSpine = spineLeafSequence(zip);

    const report = repairChapterMapInPlace(chapterMap, silentLogger, {
        zipEntries,
    });
    console.log(
        `repaired=${report.repaired} chapters=${report.newCount} fingerprint=${report.fingerprint.slice(0, 10)}`,
    );
    if (report.repaired !== expectRepair) {
        throw new Error(
            `expected repaired=${expectRepair}, got ${report.repaired}`,
        );
    }

    const context = buildLinkContext(chapterMap, zipEntries);
    const linkStats = rewriteInternalLinks(chapterMap, context);
    console.log(
        `links rewritten=${linkStats.rewritten}/${linkStats.scanned} unresolved=${linkStats.unresolved}`,
    );

    // 在 saveEpub 修改输入 zip 之前，从原始 NCX 提取强边界标签用于锚点归属审计
    const ownershipLabels = [];
    const sourceNcxEntry = zipEntries.find((entry) =>
        entry.entryName.endsWith(".ncx"),
    );
    if (sourceNcxEntry) {
        const $ncx = loadHtml(sourceNcxEntry.getData().toString("utf8"));
        $ncx("navPoint").each((_, el) => {
            const label = $ncx(el)
                .children("navLabel")
                .children("text")
                .first()
                .text()
                .trim();
            const src = $ncx(el).children("content").attr("src");
            if (!label || !src) return;
            if (
                /^(?:chapter|part)\s+/i.test(label) ||
                /^(?:about the author|preamble|index|eula)$/i.test(label)
            ) {
                const [, anchor] = src.split("#");
                if (anchor) ownershipLabels.push({ label, anchor });
            }
        });
    }

    const ncxResult = await synchronizeNcx(chapterMap, zipEntries, context);
    const outputPath = path.join(tmpDir, `${path.parse(epubName).name}_audit.epub`);
    await saveEpub(
        zip,
        chapterMap,
        ncxResult.ncxEntry ?? null,
        ncxResult.ncxContent ?? null,
        outputPath,
        silentLogger,
        report,
    );

    const outZip = new AdmZip(outputPath);
    const outEntries = outZip.getEntries();

    // 1. text preserved
    const outLeafHash = leafTextHash(outZip);
    if (sourceLeafHash !== outLeafHash) {
        throw new Error("leaf text multiset changed (content loss)");
    }
    console.log("✅ text preserved");

    // 2. replaced originals removed
    for (const item of report.replaced) {
        const stillThere = outEntries.some(
            (entry) => entry.entryName === item.entryName,
        );
        if (stillThere) {
            throw new Error(`original entry not removed: ${item.entryName}`);
        }
    }
    console.log(
        `✅ removed ${report.replaced.length} replaced original file(s)`,
    );

    // 3. spine order
    const outSpine = spineLeafSequence(outZip);
    if (
        sourceSpine.length !== outSpine.length ||
        sourceSpine.some((text, index) => text !== outSpine[index])
    ) {
        const mismatchIndex = sourceSpine.findIndex(
            (text, index) => text !== outSpine[index],
        );
        console.log(
            `spine mismatch at ${mismatchIndex}: source="${sourceSpine[mismatchIndex]}" out="${outSpine[mismatchIndex]}" (lengths ${sourceSpine.length}/${outSpine.length})`,
        );
        throw new Error("spine text order changed");
    }
    console.log("✅ spine order preserved");

    // 4. internal links
    const linkAudit = auditInternalLinks(outZip);
    console.log(
        `links total=${linkAudit.total} dangling=${linkAudit.dangling}`,
    );
    if (linkAudit.dangling > 0) {
        console.log(linkAudit.samples.join("\n"));
        throw new Error("dangling internal links found");
    }

    // 5. NCX
    const outContext = buildLinkContext(chapterMap, outEntries);
    const ncxAudit = auditNcx(outZip, outContext);
    console.log(`ncx total=${ncxAudit.total} dangling=${ncxAudit.dangling}`);
    if (ncxAudit.dangling > 0) {
        console.log(ncxAudit.samples.join("\n"));
        throw new Error("unresolved NCX entries");
    }
    const outNcxEntry = outEntries.find((entry) =>
        entry.entryName.endsWith(".ncx"),
    );
    if (outNcxEntry) {
        const ncxValidation = validateNcxLinks(
            outNcxEntry.getData().toString("utf8"),
            outNcxEntry.entryName,
            outContext,
        );
        if (ncxValidation.dangling > 0) {
            console.log(ncxValidation.samples.join("\n"));
            throw new Error("NCX validation failed on output");
        }
        console.log(
            `✅ NCX file+anchor validation (${ncxValidation.total} entries)`,
        );
    }

    // 6. anchor ownership (NCX strong labels follow their headings)
    const ownershipProblems = auditAnchorOwnership(outZip, ownershipLabels);
    if (ownershipProblems.length > 0) {
        console.log(ownershipProblems.slice(0, 10).join("\n"));
        throw new Error("anchor ownership problems found");
    }
    console.log("✅ anchor ownership correct");

    console.log(`🎉 ${epubName} audit passed`);
    return { outputPath, report };
};

const runFingerprintChecks = () => {
    console.log("\n================ fingerprint checks ================");
    const makeMap = () => {
        const map = new Map();
        map.set("a", {
            id: "a",
            entryName: "OEBPS/a.html",
            html: "<html><body><p>x</p></body></html>",
        });
        map.set("b", {
            id: "b",
            entryName: "OEBPS/b.html",
            html: "<html><body><p>y</p></body></html>",
        });
        return map;
    };

    const fp1 = repairChapterMapInPlace(makeMap(), silentLogger, {
        hints: new Map(),
    }).fingerprint;
    const fp2 = repairChapterMapInPlace(makeMap(), silentLogger, {
        hints: new Map(),
    }).fingerprint;
    if (fp1 !== fp2) throw new Error("fingerprint is not stable");
    console.log("✅ fingerprint stable for identical content");

    const mutated = makeMap();
    mutated.get("a").html = "<html><body><p>x changed</p></body></html>";
    const fp3 = repairChapterMapInPlace(mutated, silentLogger, {
        hints: new Map(),
    }).fingerprint;
    if (fp3 === fp1) {
        throw new Error("fingerprint did not change when content changed");
    }
    console.log("✅ fingerprint changes with source content");

    const cache = createProgressCache(path.join(tmpDir, "cache-test"));
    cache.saveRepairFingerprint(fp1);
    if (cache.loadRepairFingerprint() !== fp1) {
        throw new Error("fingerprint cache round-trip failed");
    }
    console.log("✅ fingerprint cache round-trip");
};

const main = async () => {
    runFingerprintChecks();

    const advances = findEpub((name) => name.startsWith("Advances"));
    const visa = findEpub((name) => name.startsWith("visa"));
    const chrys = findEpub((name) => name.startsWith("The_Chrysanthemum"));

    if (advances) await runBook(advances, true);
    if (chrys) await runBook(chrys, false);

    if (visa) {
        console.log(`\n================ ${visa} (no-repair regression) ================`);
        const zip = new AdmZip(path.join(projectRoot, visa));
        const chapterMap = loadChapterMap(zip.getEntries());
        const diagnosis = diagnoseChapterMap(chapterMap);
        console.log(`chapters=${chapterMap.size} diagnosis=${JSON.stringify(diagnosis)}`);
        if (diagnosis.needsSplitting) {
            throw new Error("visa should not trigger splitting");
        }
        console.log("✅ visa not repaired as expected");
    }

    console.log(`\nAll audits passed. Outputs in: ${tmpDir}`);
};

main().catch((error) => {
    console.error(`\n❌ AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
