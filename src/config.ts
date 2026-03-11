import { parseArgs } from "util";

export interface ProviderConfig {
  apiKey: string;
  modelName: string;
  concurrency: number;
  baseURL?: string;
}

export interface Config {
  targetLanguage: string;
  providers: {
    gemini?: ProviderConfig;
    qwen?: ProviderConfig;
    mimo?: ProviderConfig;
  };
  styleGuide: string;
}

export interface CliArgs {
  input: string;
  provider: "gemini" | "qwen" | "mimo";
  testMode: number | null;
  output?: string;
  help?: boolean;
}

const DEFAULT_STYLE_GUIDE = `
TRANSLATION STYLE GUIDE (Target: Chinese Simplified):
1. **Rephrase**: Natural Chinese (Xin Da Ya / 信达雅).
2. **Split Long Sentences**: Break down long English clauses.
3. **Tone**: Professional, insightful.
4. **Vocabulary**: Use appropriate idioms (Chengyu) where natural.
5. **No Translationese**: Avoid passive voice (e.g., limit usage of "被").

HEADING FORMATTING RULES:
1. **Consistency**: Table of Contents must match Main Body.
2. **Preserve Prefix**: Keep numeric/alphabetic numbering prefix (e.g. "1.2 ", "A. ") as-is; only translate the title text after it.
`;

export function loadConfig(): { config: Config; args: CliArgs } {
  const { values, positionals } = parseArgs({
    options: {
      input: {
        type: "string",
        short: "i",
        description: "Input EPUB file path",
      },
      provider: {
        type: "string",
        short: "p",
        default: "qwen",
        description: "AI provider (gemini, qwen, mimo)",
      },
      "test-mode": {
        type: "string",
        short: "t",
        description: "Test mode: number of chapters to translate (omit for full translation)",
      },
      output: {
        type: "string",
        short: "o",
        description: "Output EPUB file path (default: input filename with _translated suffix)",
      },
      help: {
        type: "boolean",
        short: "h",
        description: "Show this help message",
      },
    },
    allowPositionals: false,
  });

  const args: CliArgs = {
    input: values.input ?? "",
    provider: (values.provider as "gemini" | "qwen" | "mimo") ?? "qwen",
    testMode: values["test-mode"] ? parseInt(values["test-mode"], 10) : null,
    output: values.output,
    help: values.help,
  };

  const config: Config = {
    targetLanguage: "Chinese (Simplified)",
    providers: {
      gemini: {
        apiKey: process.env.GEMINI_API_KEY ?? "",
        modelName: "gemini-2.5-pro",
        concurrency: 1,
      },
      qwen: {
        apiKey: process.env.QWEN_API_KEY ?? "",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: "qwen3-max",
        concurrency: 5,
      },
      mimo: {
        apiKey: process.env.MIMO_API_KEY ?? "",
        baseURL: "https://api.xiaomimimo.com/v1",
        modelName: "mimo-v2-flash",
        concurrency: 5,
      },
    },
    styleGuide: DEFAULT_STYLE_GUIDE,
  };

  return { config, args };
}

export function validateConfig(config: Config, args: CliArgs): void {
  if (!args.input) {
    throw new Error("Input file is required. Use -i <file.epub>");
  }

  const providerConfig = config.providers[args.provider];
  if (!providerConfig?.apiKey) {
    throw new Error(
      `API key not found for provider "${args.provider}". Set ${args.provider.toUpperCase()}_API_KEY in .env`,
    );
  }
}
