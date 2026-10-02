import {
    parseSrt,
    serializeSrt,
    parseSrtTimeToMs,
} from "../src/subtitle/srt.js";
import {
    isSubtitleCodecSupported,
    selectSubtitleStream,
} from "../src/subtitle/video.js";
import { SRT_FIXTURES } from "./helpers/fixtures.mjs";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const run = () => {
    console.log("=== 2.6 SRT time validation ===");
    let invalidThrown = false;
    try {
        parseSrt(SRT_FIXTURES.invalidTime);
    } catch (error) {
        invalidThrown = /Invalid SRT time components/.test(error.message);
    }
    assert(invalidThrown, "99:99:99 must be rejected");

    let reversedThrown = false;
    try {
        parseSrt("1\n00:00:05,000 --> 00:00:01,000\nHello\n");
    } catch (error) {
        reversedThrown = /start is after end/.test(error.message);
    }
    assert(reversedThrown, "start>end must be rejected");

    assert(
        parseSrtTimeToMs("01:02:03,004") === 3723004,
        "time conversion must be exact",
    );
    console.log("✅ invalid times rejected, valid time converted");

    console.log("\n=== 2.6 identifier round-trip ===");
    const parsed = parseSrt(SRT_FIXTURES.identifierRoundTrip);
    assert(parsed.length === 2, "two cues expected");
    assert(
        parsed[0].cueIdentifier === "Scene-A" &&
            parsed[1].cueIdentifier === "Scene-B",
        "identifiers must be preserved",
    );
    const serialized = serializeSrt(parsed);
    const reparsed = parseSrt(serialized);
    assert(reparsed.length === 2, "serialized SRT must parse back");
    assert(
        reparsed[0].cueIdentifier === "Scene-A" &&
            reparsed[1].cueIdentifier === "Scene-B",
        `round-trip identifiers failed: ${JSON.stringify(reparsed.map((c) => c.cueIdentifier))}`,
    );
    assert(
        reparsed[0].start === "00:00:01,000" &&
            reparsed[1].end === "00:00:04,000" &&
            reparsed[0].sourceText === "Hello",
        "round-trip times and text must be stable",
    );

    const numericThenIdentifier = parseSrt(
        SRT_FIXTURES.numericThenIdentifier,
    );
    assert(
        numericThenIdentifier.length === 1 &&
            numericThenIdentifier[0].cueIdentifier === "Scene-A",
        "numeric index followed by identifier must parse",
    );
    const numericRoundTrip = parseSrt(
        serializeSrt(numericThenIdentifier),
    );
    assert(
        numericRoundTrip[0].cueIdentifier === "Scene-A",
        "numeric+identifier form must round-trip",
    );
    console.log("✅ identifiers round-trip in both forms");

    console.log("\n=== 2.6 track capability filtering ===");
    assert(
        isSubtitleCodecSupported({ kind: "embedded", codec_name: "subrip" }),
        "subrip must be supported",
    );
    assert(
        !isSubtitleCodecSupported({ kind: "embedded", codec_name: "hdmv_pgs_subtitle" }),
        "PGS must be unsupported",
    );
    assert(
        isSubtitleCodecSupported({
            kind: "external",
            path: "movie.en.srt",
        }),
        ".srt external must be supported",
    );
    const streams = [
        { kind: "embedded", index: 0, codec_name: "hdmv_pgs_subtitle", resolvedLanguage: "English" },
        { kind: "embedded", index: 1, codec_name: "subrip", resolvedLanguage: "English" },
    ];
    const supported = streams.filter(isSubtitleCodecSupported);
    const selected = selectSubtitleStream({
        streams: supported.length > 0 ? supported : streams,
        preferredLanguage: "English",
        fallbackLanguage: "English",
    });
    assert(
        selected.codec_name === "subrip",
        `selection must pick the supported track, got ${selected.codec_name}`,
    );
    console.log("✅ unsupported tracks filtered before selection");

    console.log("\nAll SRT audits passed.");
};

try {
    run();
} catch (error) {
    console.error(`\n❌ SRT AUDIT FAILED: ${error.message}`);
    process.exit(1);
}
