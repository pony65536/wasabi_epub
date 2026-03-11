import fs from "fs";
import path from "path";

// =================== 6. 断点续传缓存模块 ===================
export const createProgressCache = (cacheDir) => {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const _cacheFile = (chapterId) =>
        path.join(cacheDir, `${chapterId.replace(/[/\\:*?"<>|]/g, "_")}.html`);

    const load = (chapterId) => {
        const file = _cacheFile(chapterId);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, "utf8");
        }
        return null;
    };

    const save = (chapterId, html) => {
        fs.writeFileSync(_cacheFile(chapterId), html, "utf8");
    };

    const clear = () => {
        for (const f of fs.readdirSync(cacheDir)) {
            fs.unlinkSync(path.join(cacheDir, f));
        }
        console.log("🗑️  Cache cleared.");
    };

    const count = () =>
        fs.readdirSync(cacheDir).filter((f) => f.endsWith(".html")).length;

    return { load, save, clear };
};
