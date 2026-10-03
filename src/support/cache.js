import crypto from "crypto";
import fs from "fs";
import path from "path";

const atomicWrite = (file, content) => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
};

const quarantineCorrupt = (file) => {
    try {
        const target = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, target);
        return target;
    } catch {
        return null;
    }
};

const safeReadJson = (file) => {
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        quarantineCorrupt(file);
        return null;
    }
};

const isProcessAlive = (pid) => {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM 表示进程存在但无权限发信号
        return error?.code === "EPERM";
    }
};

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
        atomicWrite(_cacheFile(chapterId), html);
    };

    const clear = () => {
        if (!fs.existsSync(cacheDir)) return;
        for (const f of fs.readdirSync(cacheDir)) {
            if (f === "task.lock") continue; // 锁由当前进程持有，最后统一释放
            fs.unlinkSync(path.join(cacheDir, f));
        }
        console.log("🗑️  Cache cleared.");
    };

    const removeDir = () => {
        if (!fs.existsSync(cacheDir)) return;
        fs.rmSync(cacheDir, { recursive: true, force: true });
        console.log(`🗑️  Cache directory removed: ${path.basename(cacheDir)}`);
    };

    const count = () =>
        fs.readdirSync(cacheDir).filter((f) => f.endsWith(".html")).length;

    // ===== 任务锁：独占创建 + 唯一 token，同一进程也不可重入 =====
    let lockToken = null;

    const acquireTaskLock = () => {
        const file = path.join(cacheDir, "task.lock");
        const token = crypto.randomUUID();
        const payload = JSON.stringify({
            pid: process.pid,
            token,
            startedAt: Date.now(),
        });

        const tryExclusiveCreate = () => {
            fs.writeFileSync(file, payload, { flag: "wx" });
            lockToken = token;
            return { acquired: true, holder: { pid: process.pid, token } };
        };

        try {
            return tryExclusiveCreate();
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
        }

        const info = safeReadJson(file);
        // 持有进程已退出 → 立即回收；进程存活 → 无论锁龄多长都不抢。
        const holderAlive = isProcessAlive(info?.pid);
        const stale = !holderAlive;
        if (stale) {
            try {
                fs.unlinkSync(file);
            } catch {
                // 其他进程可能已清理
            }
            try {
                return tryExclusiveCreate();
            } catch {
                // 竞争失败，按未获取处理
            }
        }
        return { acquired: false, holder: info };
    };

    const releaseTaskLock = () => {
        const file = path.join(cacheDir, "task.lock");
        if (!fs.existsSync(file)) {
            lockToken = null;
            return;
        }
        const info = safeReadJson(file);
        // 只释放自己持有的 token，避免误删他人的锁
        if (lockToken) {
            if (info?.token !== lockToken) return;
        } else if (info?.pid !== process.pid) {
            return;
        }
        try {
            fs.unlinkSync(file);
        } catch {
            // 忽略
        }
        lockToken = null;
    };

    // ===== 保存/加载翻译计划、术语表、标题规则、Book Bible =====
    const saveBookBible = (bible) => {
        atomicWrite(
            path.join(cacheDir, "book_bible.json"),
            JSON.stringify(bible, null, 2),
        );
    };

    const loadBookBible = () =>
        safeReadJson(path.join(cacheDir, "book_bible.json"));

    const savePlan = (plan) => {
        atomicWrite(
            path.join(cacheDir, "translation_plan.json"),
            JSON.stringify(plan, null, 2),
        );
    };

    const loadPlan = () => safeReadJson(path.join(cacheDir, "translation_plan.json"));

    const saveGlossary = (glossary) => {
        atomicWrite(
            path.join(cacheDir, "glossary.json"),
            JSON.stringify(glossary, null, 2),
        );
    };

    const loadGlossary = () => safeReadJson(path.join(cacheDir, "glossary.json"));

    const saveRepairFingerprint = (fingerprint) => {
        atomicWrite(
            path.join(cacheDir, "repair_meta.json"),
            JSON.stringify({ fingerprint }, null, 2),
        );
    };

    const loadRepairFingerprint = () =>
        safeReadJson(path.join(cacheDir, "repair_meta.json"))?.fingerprint ?? null;

    const saveTaskMeta = (meta) => {
        atomicWrite(
            path.join(cacheDir, "task_meta.json"),
            JSON.stringify(meta, null, 2),
        );
    };

    const loadTaskMeta = () => safeReadJson(path.join(cacheDir, "task_meta.json"));

    const saveChapterStatus = (statusMap) => {
        atomicWrite(
            path.join(cacheDir, "chapter_status.json"),
            JSON.stringify(statusMap, null, 2),
        );
    };

    const loadChapterStatus = () =>
        safeReadJson(path.join(cacheDir, "chapter_status.json")) || {};

    const saveHeadingRules = (rules) => {
        atomicWrite(
            path.join(cacheDir, "heading_rules.json"),
            JSON.stringify(rules, null, 2),
        );
    };

    const loadHeadingRules = () =>
        safeReadJson(path.join(cacheDir, "heading_rules.json"));

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
        saveRepairFingerprint,
        loadRepairFingerprint,
        saveTaskMeta,
        loadTaskMeta,
        saveChapterStatus,
        loadChapterStatus,
        saveBookBible,
        loadBookBible,
        acquireTaskLock,
        releaseTaskLock,
        hasAnyCache,
        removeDir,
    };
};
