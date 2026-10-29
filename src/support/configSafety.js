import { spawnSync } from "node:child_process";
import path from "node:path";

const gitCheckIgnore = (relativePath, cwd) => {
    const result = spawnSync(
        "git",
        ["check-ignore", "-q", "--", relativePath],
        { cwd, stdio: "ignore" },
    );

    if (result.error) return "unknown";
    if (result.status === 0) return "ignored";
    if (result.status === 1) return "not-ignored";
    return "unknown";
};

export const checkConfigIgnored = ({
    projectRoot,
    configPath,
    runGitCheckIgnore = gitCheckIgnore,
}) => {
    if (!configPath || !path.isAbsolute(configPath)) return null;

    const root = path.resolve(projectRoot);
    const relativePath = path.relative(root, configPath);
    if (
        !relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        return null;
    }

    if (relativePath.endsWith(".example.json")) {
        return null;
    }

    if (runGitCheckIgnore(relativePath, root) !== "not-ignored") {
        return null;
    }

    return `Config file ${relativePath} is inside the repository but not ignored. Add it to .gitignore before committing.`;
};
