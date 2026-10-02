import AdmZip from "adm-zip";

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

export const buildChapterHtml = ({
    htmlAttrs = {},
    bodyAttrs = {},
    head = "<title>Fixture</title>",
    bodyContent = "",
} = {}) => {
    const htmlAttrText = Object.entries(htmlAttrs)
        .map(([key, value]) => ` ${key}="${value}"`)
        .join("");
    const bodyAttrText = Object.entries(bodyAttrs)
        .map(([key, value]) => ` ${key}="${value}"`)
        .join("");
    return `<?xml version="1.0" encoding="utf-8"?>
<html${htmlAttrText}>
<head>${head}</head>
<body${bodyAttrText}>${bodyContent}</body>
</html>`;
};

export const buildSyntheticEpub = ({
    chapters,
    spineOrder = null,
    itemrefs = null,
    ncxContent = null,
} = {}) => {
    const zip = new AdmZip();
    zip.addFile("mimetype", Buffer.from("application/epub+zip", "utf8"));
    zip.addFile("META-INF/container.xml", Buffer.from(CONTAINER_XML, "utf8"));

    const manifest = chapters
        .map(
            (chapter) =>
                `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`,
        )
        .join("\n");
    const order = spineOrder || chapters.map((chapter) => chapter.id);
    const spine = order
        .map((id) =>
            itemrefs?.[id] ? itemrefs[id] : `<itemref idref="${id}"/>`,
        )
        .join("\n");
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title></metadata>
  <manifest>
${manifest}
${ncxContent ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>`;
    zip.addFile("OEBPS/content.opf", Buffer.from(opf, "utf8"));

    for (const chapter of chapters) {
        zip.addFile(
            `OEBPS/${chapter.href}`,
            Buffer.from(chapter.html, "utf8"),
        );
    }
    if (ncxContent) {
        zip.addFile("OEBPS/toc.ncx", Buffer.from(ncxContent, "utf8"));
    }
    return zip;
};

export const buildBigChapterHtml = ({
    htmlAttrs = {},
    bodyAttrs = {},
    headingText = "CHAPTER 1 Big Chapter",
    paragraphs = 80,
    filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ",
} = {}) => {
    const body = [
        `<p>${headingText}</p>`,
        ...Array.from(
            { length: paragraphs },
            (_, index) => `<p>Paragraph ${index + 1}. ${filler.repeat(3)}</p>`,
        ),
    ].join("\n");
    return buildChapterHtml({ htmlAttrs, bodyAttrs, bodyContent: body });
};

export const DIRECT_BODY_TEXT_HTML = buildChapterHtml({
    htmlAttrs: { lang: "en", "xmlns:epub": "http://www.idpf.org/2007/ops" },
    bodyAttrs: { class: "book", id: "main-body", "xml:lang": "en" },
    bodyContent:
        "Direct body text before paragraphs.\n<p>First paragraph.</p>\n<p>Second paragraph.</p>\nDirect body text after paragraphs.",
});

export const MIXED_LANGUAGE_HTML = buildChapterHtml({
    bodyContent: [
        "<p>This is an English paragraph that must be translated.</p>",
        "<p>这是一段中文正文，也必须被翻译，不能被丢弃。</p>",
        "<p>Это русский текст, который тоже должен переводиться.</p>",
        "<p>これは日本語の文章で、翻訳対象です。</p>",
    ].join("\n"),
});

export const SRT_FIXTURES = {
    invalidTime:
        "1\n99:99:99,999 --> 00:00:00,000\nHello\n",
    identifierRoundTrip:
        "Scene-A\n00:00:01,000 --> 00:00:02,000\nHello\n\nScene-B\n00:00:03,000 --> 00:00:04,000\nWorld\n",
    numericThenIdentifier:
        "1\nScene-A\n00:00:01,000 --> 00:00:02,000\nHello\n",
    valid: "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n",
};

export const SLOT_FIXTURES = {
    thirtyFiveEms: Array.from(
        { length: 35 },
        (_, index) => `<em>word${index}</em>`,
    ).join(" "),
    nested:
        '<span class="outer">A <em class="inner">B</em> C</span>',
    protectedAnchor:
        'A<span id="anchor" class="meaningful">word</span> tail',
};
