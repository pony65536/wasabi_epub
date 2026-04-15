const normalizeWhitespace = (value) => value.trim().replace(/\s+/g, " ");

const normalizeTitle = (value) => normalizeWhitespace(value).toLowerCase();

const splitOutsideQuotes = (value, separator) => {
    const parts = [];
    let current = "";
    let quote = null;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if ((char === "'" || char === '"') && value[i - 1] !== "\\") {
            if (quote === char) {
                quote = null;
            } else if (!quote) {
                quote = char;
            }
            current += char;
            continue;
        }

        if (!quote && char === separator) {
            parts.push(current.trim());
            current = "";
            continue;
        }

        current += char;
    }

    if (quote) {
        throw new Error(`Unclosed quote in chapter selector: ${value}`);
    }

    if (current.trim()) {
        parts.push(current.trim());
    }

    return parts;
};

const stripWrappingQuotes = (value) => {
    const trimmed = value.trim();
    if (
        trimmed.length >= 2 &&
        ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
            (trimmed.startsWith('"') && trimmed.endsWith('"')))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
};

const findRangeSeparator = (value) => {
    let quote = null;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if ((char === "'" || char === '"') && value[i - 1] !== "\\") {
            if (quote === char) {
                quote = null;
            } else if (!quote) {
                quote = char;
            }
            continue;
        }

        if (!quote && char === "-") {
            return i;
        }
    }

    return -1;
};

const parseSelector = (token) => {
    const trimmed = token.trim();
    if (!trimmed) {
        throw new Error("Empty chapter selector segment.");
    }

    if (/^\d+$/.test(trimmed)) {
        const index = Number.parseInt(trimmed, 10);
        return { type: "index", start: index, end: index };
    }

    if (/^\d+\s*-\s*\d+$/.test(trimmed)) {
        const [startText, endText] = trimmed.split("-");
        return {
            type: "index",
            start: Number.parseInt(startText.trim(), 10),
            end: Number.parseInt(endText.trim(), 10),
        };
    }

    const rangeSeparatorIndex = findRangeSeparator(trimmed);
    if (rangeSeparatorIndex >= 0) {
        const left = trimmed.slice(0, rangeSeparatorIndex).trim();
        const right = trimmed.slice(rangeSeparatorIndex + 1).trim();

        if (left && right) {
            const leftUnquoted = stripWrappingQuotes(left);
            const rightUnquoted = stripWrappingQuotes(right);
            const leftWasQuoted = leftUnquoted !== left;
            const rightWasQuoted = rightUnquoted !== right;

            if (leftWasQuoted && rightWasQuoted) {
                return {
                    type: "title-range",
                    startTitle: leftUnquoted,
                    endTitle: rightUnquoted,
                };
            }
        }
    }

    return { type: "title", title: stripWrappingQuotes(trimmed) };
};

const resolveTitleIndex = (chapters, title) => {
    const normalizedTarget = normalizeTitle(title);
    const matches = chapters
        .map((chapter, index) => ({ chapter, index }))
        .filter(
            ({ chapter }) => normalizeTitle(chapter.title) === normalizedTarget,
        );

    if (matches.length === 0) {
        throw new Error(`Chapter title not found: "${title}"`);
    }

    if (matches.length > 1) {
        throw new Error(`Chapter title is ambiguous: "${title}"`);
    }

    return matches[0].index;
};

export const selectChaptersBySpec = (chapters, rawSpec) => {
    if (!rawSpec) return chapters;

    const tokens = splitOutsideQuotes(rawSpec, ",");
    if (tokens.length === 0) {
        throw new Error("No chapter selector was provided after --chap.");
    }

    const selectedIndexes = new Set();

    for (const token of tokens) {
        const selector = parseSelector(token);

        if (selector.type === "index") {
            const start = selector.start;
            const end = selector.end;

            if (start < 1 || end < 1) {
                throw new Error(
                    `Chapter indexes must start from 1: "${token}"`,
                );
            }

            if (start > chapters.length || end > chapters.length) {
                throw new Error(
                    `Chapter index out of range: "${token}" (available: 1-${chapters.length})`,
                );
            }

            const lower = Math.min(start, end);
            const upper = Math.max(start, end);
            for (let i = lower; i <= upper; i++) {
                selectedIndexes.add(i - 1);
            }
            continue;
        }

        if (selector.type === "title") {
            selectedIndexes.add(resolveTitleIndex(chapters, selector.title));
            continue;
        }

        const startIndex = resolveTitleIndex(chapters, selector.startTitle);
        const endIndex = resolveTitleIndex(chapters, selector.endTitle);
        const lower = Math.min(startIndex, endIndex);
        const upper = Math.max(startIndex, endIndex);
        for (let i = lower; i <= upper; i++) {
            selectedIndexes.add(i);
        }
    }

    return chapters.filter((_, index) => selectedIndexes.has(index));
};
