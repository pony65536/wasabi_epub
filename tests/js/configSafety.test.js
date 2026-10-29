import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { checkConfigIgnored } from "../../src/support/configSafety.js";

const projectRoot = path.resolve("/repo");

test("warns when an in-repo config is not ignored", () => {
    const warning = checkConfigIgnored({
        projectRoot,
        configPath: path.join(projectRoot, "config", "wasabi.local.json"),
        runGitCheckIgnore: () => "not-ignored",
    });

    assert.match(warning, /config[\\/]wasabi\.local\.json/);
    assert.match(warning, /not ignored/);
});

test("does not warn when the config is ignored or git is unavailable", () => {
    assert.equal(
        checkConfigIgnored({
            projectRoot,
            configPath: path.join(projectRoot, "config", "wasabi.local.json"),
            runGitCheckIgnore: () => "ignored",
        }),
        null,
    );
    assert.equal(
        checkConfigIgnored({
            projectRoot,
            configPath: path.join(projectRoot, "config", "wasabi.local.json"),
            runGitCheckIgnore: () => "unknown",
        }),
        null,
    );
});

test("does not warn for tracked example configs", () => {
    assert.equal(
        checkConfigIgnored({
            projectRoot,
            configPath: path.join(
                projectRoot,
                "config",
                "wasabi.example.json",
            ),
            runGitCheckIgnore: () => "not-ignored",
        }),
        null,
    );
});

test("does not check configs outside the project or non-absolute paths", () => {
    assert.equal(
        checkConfigIgnored({
            projectRoot,
            configPath: path.resolve("/elsewhere/wasabi.local.json"),
            runGitCheckIgnore: () => "not-ignored",
        }),
        null,
    );
    assert.equal(
        checkConfigIgnored({
            projectRoot,
            configPath: "config/wasabi.local.json",
            runGitCheckIgnore: () => "not-ignored",
        }),
        null,
    );
});
