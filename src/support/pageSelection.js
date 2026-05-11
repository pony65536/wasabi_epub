const parsePositiveInteger = (value, token) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid page selector segment: "${token}". Use positive integers like 1,3,5 or ranges like 2-4.`,
        );
    }
    return parsed;
};

export const parsePageSelector = (rawSpec) => {
    if (!rawSpec) return null;

    const spec = rawSpec.trim();
    if (!spec) {
        throw new Error("No page selector was provided after --page.");
    }

    const selectedPages = new Set();
    for (const part of spec.split(",")) {
        const token = part.trim();
        if (!token) {
            throw new Error("Empty page selector segment.");
        }

        const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
            const start = parsePositiveInteger(rangeMatch[1], token);
            const end = parsePositiveInteger(rangeMatch[2], token);
            if (start > end) {
                throw new Error(
                    `Invalid page range: "${token}". Start page must be less than or equal to end page.`,
                );
            }
            for (let page = start; page <= end; page++) {
                selectedPages.add(page);
            }
            continue;
        }

        selectedPages.add(parsePositiveInteger(token, token));
    }

    return [...selectedPages].sort((a, b) => a - b);
};
