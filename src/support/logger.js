import fs from "fs";
import path from "path";

export const createLogger = (logDir) => {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFile = path.join(logDir, `translation_${runId}.log`);

    const write = (type, content) => {
        const timestamp = new Date().toLocaleString();
        const entry = `\n[${timestamp}] [${type}]\n${content}\n${"=".repeat(50)}\n`;
        fs.appendFileSync(logFile, entry, "utf8");
    };

    console.log(`📝 Log file: ${path.basename(logFile)}`);
    const remove = () => {
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }
    };

    return { write, logFile, remove };
};
