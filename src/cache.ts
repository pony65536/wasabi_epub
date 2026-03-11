import fs from "fs";
import path from "path";

export interface ProgressCache {
  load: (chapterId: string) => string | null;
  save: (chapterId: string, html: string) => void;
  clear: () => void;
  count: () => number;
}

export function createProgressCache(cacheDir: string = "./cache"): ProgressCache {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const cacheFile = (chapterId: string): string =>
    path.join(cacheDir, `${chapterId.replace(/[/\\:*?"<>|]/g, "_")}.html`);

  return {
    load: (chapterId: string): string | null => {
      const file = cacheFile(chapterId);
      if (fs.existsSync(file)) {
        return fs.readFileSync(file, "utf8");
      }
      return null;
    },

    save: (chapterId: string, html: string): void => {
      fs.writeFileSync(cacheFile(chapterId), html, "utf8");
    },

    clear: (): void => {
      for (const f of fs.readdirSync(cacheDir)) {
        fs.unlinkSync(path.join(cacheDir, f));
      }
      console.log("🗑️  Cache cleared.");
    },

    count: (): number =>
      fs.readdirSync(cacheDir).filter((f) => f.endsWith(".html")).length,
  };
}
