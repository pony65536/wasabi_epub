import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testsDir, "..");
const hasBookSamples = fs
    .readdirSync(projectRoot)
    .some((name) => name.endsWith(".epub"));

const suites = [
    { name: "content classifier", file: "test_content_classifier.mjs" },
    { name: "structure fidelity", file: "test_structure_fidelity.mjs" },
    { name: "recovery contracts", file: "test_recovery_contracts.mjs" },
    { name: "model routing", file: "test_model_routing.mjs" },
    { name: "model gateway", file: "test_model_gateway.mjs" },
    { name: "srt", file: "test_srt.mjs" },
    { name: "translation status", file: "test_translation_status.mjs" },
    { name: "planning phases", file: "test_planning_phases.mjs" },
    {
        name: "epub doctor (book samples)",
        file: "test_epub_doctor.mjs",
        skipReason: hasBookSamples
            ? null
            : "no .epub book samples in project root",
    },
];

let failed = 0;
for (const suite of suites) {
    const filePath = path.join(testsDir, suite.file);
    if (!fs.existsSync(filePath)) {
        console.log(`\n===== SKIP ${suite.name} (missing ${suite.file}) =====`);
        continue;
    }
    if (suite.skipReason) {
        console.log(`\n===== SKIP ${suite.name}: ${suite.skipReason} =====`);
        continue;
    }
    console.log(`\n===== RUN ${suite.name} (${suite.file}) =====`);
    const result = spawnSync(process.execPath, [filePath], {
        cwd: projectRoot,
        stdio: "inherit",
    });
    if (result.status !== 0) {
        failed += 1;
        console.error(`\n❌ ${suite.name} FAILED`);
    }
}

if (failed > 0) {
    console.error(`\n${failed} test suite(s) failed.`);
    process.exit(1);
}
console.log("\nAll test suites passed.");
