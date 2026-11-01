import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(path.join(testsDir, "js"))
    .filter((file) => file.endsWith(".test.js"))
    .sort().map((file) => path.join(testsDir, "js", file));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
