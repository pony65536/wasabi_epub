import fs from "fs";
import path from "path";

export interface Logger {
  write: (type: string, content: string) => void;
  logFile: string;
}

export function createLogger(logDir: string = "./logs"): Logger {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = path.join(logDir, `translation_${runId}.log`);

  const write = (type: string, content: string): void => {
    const timestamp = new Date().toLocaleString();
    const entry = `\n[${timestamp}] [${type}]\n${content}\n${"=".repeat(50)}\n`;
    fs.appendFileSync(logFile, entry, "utf8");
  };

  console.log(`📝 Log file: ${path.basename(logFile)}`);
  return { write, logFile };
}
