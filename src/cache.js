import fs from "fs";
import path from "path";

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

    // ===== 新增：保存/加载翻译计划、术语表、标题规则 =====
    const savePlan = (plan) => {
        const file = path.join(cacheDir, "translation_plan.json");
        fs.writeFileSync(file, JSON.stringify(plan, null, 2), "utf8");
    };

    const loadPlan = () => {
        const file = path.join(cacheDir, "translation_plan.json");
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
        return null;
    };

    const saveGlossary = (glossary) => {
        const file = path.join(cacheDir, "glossary.json");
        fs.writeFileSync(file, JSON.stringify(glossary, null, 2), "utf8");
    };

    const loadGlossary = () => {
        const file = path.join(cacheDir, "glossary.json");
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
        return null;
    };

    const saveHeadingRules = (rules) => {
        const file = path.join(cacheDir, "heading_rules.json");
        fs.writeFileSync(file, JSON.stringify(rules, null, 2), "utf8");
    };

    const loadHeadingRules = () => {
        const file = path.join(cacheDir, "heading_rules.json");
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
        return null;
    };

    // 检查是否有任何缓存数据存在
    const hasAnyCache = () => {
        return (
            fs.readdirSync(cacheDir).filter((f) => !f.startsWith(".")).length > 0
        );
    };

    return {
        load,
        save,
        clear,
        count,
        savePlan,
        loadPlan,
        saveGlossary,
        loadGlossary,
        saveHeadingRules,
        loadHeadingRules,
        hasAnyCache,
    };
};
