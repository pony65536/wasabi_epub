import fs from "fs";
import os from "os";
import path from "path";
import { planTranslationOrder } from "../src/agent.js";
import {
    EXCLUDED_ROLES,
    classifyChapterRole,
} from "../src/content/chapterRoles.js";
import { selectChaptersBySpec } from "../src/support/chapterSelection.js";
import { mergeTranslationReports } from "../src/translation/translator.js";
import { ContextRetriever } from "../src/content/retriever.js";
import { formatBookBibleForPrompt } from "../src/content/director.js";
import {
    buildLinkContext,
    rewriteInternalLinks,
    validateInternalLinks,
    validateNcxLinks,
} from "../src/epub/linkRewriter.js";
import { moveFileIfNeeded } from "../src/support/archive.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-plan-audit-"));
const logger = { write: () => {} };

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const mk = (id, title, html = "<html><body><p>text</p></body></html>") => ({
    id,
    title,
    html,
    entryName: `${id}.html`,
    href: `${id}.html`,
});

const run = async () => {
    console.log("=== Issue 4: chapter roles ===");
    assert(classifyChapterRole(mk("a", "Cover")) === "front", "Cover should be front");
    assert(classifyChapterRole(mk("b", "Table of Contents")) === "toc", "TOC role");
    assert(classifyChapterRole(mk("c", "Chapter 1 Beginning")) === "content", "content role");
    assert(classifyChapterRole(mk("d", "Index")) === "index", "index role");
    assert(
        classifyChapterRole(mk("e", "Bibliography")) === "bibliography",
        "bibliography role",
    );
    assert(classifyChapterRole(mk("f", "Preface")) === "front", "Preface front");
    assert(classifyChapterRole(mk("g", "目录")) === "toc", "中文目录 role");
    assert(classifyChapterRole(mk("h", "索引")) === "index", "中文索引 role");
    assert(
        classifyChapterRole(mk("i", "参考文献")) === "bibliography",
        "中文参考文献 role",
    );
    console.log("✅ role classification (incl. CJK titles)");

    console.log("\n=== Issue 4: planner exclusion + role-based backfill ===");
    const chapters = [
        mk("cover", "Cover"),
        mk("toc", "Table of Contents"),
        mk("ch1", "Chapter 1 One"),
        mk("ch2", "Chapter 2 Two"),
        mk("index", "Index"),
        mk("bib", "Bibliography"),
        mk("preface", "Preface"),
    ];
    const aiProvider = {
        callAI: async () =>
            JSON.stringify({
                tocId: "toc",
                order: ["ch1", "preface", "index", "toc", "bib"],
            }),
    };
    const plan = await planTranslationOrder(chapters, aiProvider, logger);
    const sortedIds = plan.sorted.map((c) => c.id);
    assert(
        !sortedIds.includes("toc") &&
            !sortedIds.includes("index") &&
            !sortedIds.includes("bib"),
        `excluded roles must not be translated: ${sortedIds.join(",")}`,
    );
    assert(
        sortedIds.indexOf("ch2") > sortedIds.indexOf("ch1"),
        "missing content must be backfilled",
    );
    assert(
        sortedIds.indexOf("ch2") < sortedIds.indexOf("cover"),
        "content must come before backfilled front matter",
    );
    assert(
        plan.excluded.includes("toc") &&
            plan.excluded.includes("index") &&
            plan.excluded.includes("bib"),
        "excluded list must be reported",
    );
    assert(
        chapters.find((c) => c.id === "toc").isTOC === true,
        "toc chapter must be flagged even when absent from order",
    );
    assert(
        plan.roles.index === "index" && plan.roles.ch1 === "content",
        "roles must be persisted in plan",
    );
    console.log(`✅ planner sorted: [${sortedIds.join(", ")}]`);

    console.log("\n=== Issue 5: --chap numbering follows reading order ===");
    const readingOrder = chapters.filter((chapter) => {
        const role = plan.roles[chapter.id] || classifyChapterRole(chapter);
        return !chapter.isTOC && !EXCLUDED_ROLES.has(role);
    });
    const readingIds = readingOrder.map((c) => c.id);
    assert(
        readingIds.join(",") === "cover,ch1,ch2,preface",
        `reading order must follow spine: ${readingIds.join(",")}`,
    );
    const selected = selectChaptersBySpec(readingOrder, "2");
    assert(selected.length === 1 && selected[0].id === "ch1", "--chap 2 => ch1");
    const selectedIds = new Set(selected.map((c) => c.id));
    const selectedInTranslationOrder = plan.sorted.filter((c) =>
        selectedIds.has(c.id),
    );
    assert(
        selectedInTranslationOrder.map((c) => c.id).join(",") === "ch1",
        "selection must map back to translation order",
    );
    console.log("✅ --chap numbering independent of AI reorder");

    console.log("\n=== Issue 5: phase report merge ===");
    const merged = mergeTranslationReports([
        {
            status: "complete",
            failedChapters: [],
            partialChapters: [],
            chapters: [{ id: "ch1", status: "complete" }],
        },
        {
            status: "partial",
            failedChapters: [],
            partialChapters: [{ id: "preface", status: "partial" }],
            chapters: [{ id: "preface", status: "partial" }],
        },
    ]);
    assert(merged.status === "partial", "merged status must be worst-case");
    assert(merged.chapters.length === 2, "merged chapters must be combined");
    console.log("✅ phase reports merged");

    console.log("\n=== Issue 6: retriever + glossary in Book Bible prompt ===");
    const retriever = new ContextRetriever();
    retriever.indexChapter(
        "ch1",
        "The quick brown fox jumps over the lazy dog.\n\nAnother sentence about the fox and its habits.",
    );
    const hits = retriever.queryContext(["fox"], 2);
    assert(
        hits.length >= 1 && hits[0].chapterId === "ch1",
        "retriever must find indexed chapter",
    );
    const biblePrompt = formatBookBibleForPrompt({
        genre: "Finance",
        worldviewAndGlossary: { "triple barrier": "三重障碍" },
    });
    assert(
        biblePrompt.includes("GLOSSARY") &&
            biblePrompt.includes("- triple barrier: 三重障碍"),
        "Book Bible prompt must include dynamic glossary terms",
    );
    console.log("✅ retriever wired + dynamic glossary reaches prompt");

    console.log("\n=== Issue 7: link validation gate ===");
    const linkMap = new Map([
        [
            "a",
            mk(
                "a",
                "A",
                '<html><body><p><a href="b.html">ok</a> <a href="missing.html">bad</a></p></body></html>',
            ),
        ],
        ["b", mk("b", "B")],
    ]);
    const context = buildLinkContext(linkMap);
    rewriteInternalLinks(linkMap, context);
    const validation = validateInternalLinks(linkMap, context);
    assert(validation.total === 2, `expected 2 links, got ${validation.total}`);
    assert(
        validation.dangling === 1,
        `expected 1 dangling link, got ${validation.dangling}`,
    );
    console.log("✅ validation detects dangling internal links");

    console.log("\n=== Fix 3: resource links (images) are valid ===");
    const resourceMap = new Map([
        [
            "r",
            mk(
                "r",
                "R",
                '<html><body><p><a href="images/plate.jpg">plate</a></p></body></html>',
            ),
        ],
    ]);
    const resourceContext = buildLinkContext(resourceMap, [
        { entryName: "images/plate.jpg" },
    ]);
    const resourceStats = rewriteInternalLinks(resourceMap, resourceContext);
    assert(
        resourceStats.unresolved === 0,
        `resource link must not be unresolved (${resourceStats.unresolved})`,
    );
    assert(
        resourceMap.get("r").html.includes('href="images/plate.jpg"'),
        "resource link must stay unchanged",
    );
    const resourceValidation = validateInternalLinks(resourceMap, resourceContext);
    assert(
        resourceValidation.dangling === 0,
        `resource link must not be dangling (${resourceValidation.dangling})`,
    );
    console.log("✅ ZIP resource links recognized and untouched");

    console.log("\n=== Fix 4: NCX validation ===");
    const ncxMap = new Map([
        [
            "dest",
            mk("dest", "Dest", '<html><body><p id="real">x</p></body></html>'),
        ],
    ]);
    const ncxContext = buildLinkContext(ncxMap);
    const goodNcx =
        '<ncx><navMap><navPoint><navLabel><text>t</text></navLabel><content src="dest.html#real"/></navPoint></navMap></ncx>';
    const badNcx =
        '<ncx><navMap><navPoint><navLabel><text>t</text></navLabel><content src="dest.html#missing"/></navPoint></navMap></ncx>';
    assert(
        validateNcxLinks(goodNcx, "toc.ncx", ncxContext).dangling === 0,
        "valid NCX must pass",
    );
    assert(
        validateNcxLinks(badNcx, "toc.ncx", ncxContext).dangling === 1,
        "NCX missing anchor must be reported dangling",
    );
    console.log("✅ NCX file+anchor validation");

    console.log("\n=== Issue 7: safe archive (no overwrite) ===");
    const archiveDir = path.join(tmpDir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const target = path.join(archiveDir, "book.epub");
    const source = path.join(archiveDir, "incoming.epub");
    fs.writeFileSync(target, "ORIGINAL", "utf8");
    fs.writeFileSync(source, "NEW", "utf8");
    const archivedPath = moveFileIfNeeded(source, target);
    assert(
        fs.readFileSync(target, "utf8") === "ORIGINAL",
        "existing archive must not be overwritten",
    );
    assert(
        archivedPath === path.join(archiveDir, "book.1.epub") &&
            fs.readFileSync(archivedPath, "utf8") === "NEW",
        "new file must be archived with a numeric suffix",
    );
    assert(!fs.existsSync(source), "source must be moved");
    console.log("✅ archive keeps both files");

    console.log(`\nAll planning/phase audits passed. Temp: ${tmpDir}`);
};

run().catch((error) => {
    console.error(`\n❌ PLANNING AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
