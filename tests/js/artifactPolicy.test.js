import test from "node:test";
import assert from "node:assert/strict";

import { shouldRetainArtifacts } from "../../src/pipeline/artifactPolicy.js";

const cases = [
    {
        format: "EPUB/HTML",
        retainOnFailure: false,
        expected: [
            { completed: true, debugMode: false, retain: false },
            { completed: true, debugMode: true, retain: true },
            { completed: false, debugMode: false, retain: false },
            { completed: false, debugMode: true, retain: true },
        ],
    },
    {
        format: "PDF/Subtitle",
        retainOnFailure: true,
        expected: [
            { completed: true, debugMode: false, retain: false },
            { completed: true, debugMode: true, retain: true },
            { completed: false, debugMode: false, retain: true },
            { completed: false, debugMode: true, retain: true },
        ],
    },
];

for (const { format, retainOnFailure, expected } of cases) {
    test(`${format} retention matrix`, () => {
        for (const { completed, debugMode, retain } of expected) {
            assert.equal(
                shouldRetainArtifacts({ completed, debugMode, retainOnFailure }),
                retain,
                `completed=${completed} debugMode=${debugMode}`,
            );
        }
    });
}
