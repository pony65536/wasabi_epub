import "dotenv/config";
import { loadConfig, validateConfig, CliArgs } from "./config.js";
import { createLogger } from "./logger.js";
import { createProgressCache } from "./cache.js";
import { createAIProvider } from "./ai-providers.js";
import { translateEpub } from "./translator.js";

const HELP_TEXT = `
Usage: npm start -- [options]

Options:
  -i, --input <file>     Input EPUB file (required)
  -p, --provider        AI provider: gemini, qwen, mimo (default: qwen)
  -t, --test-mode <N>   Test mode: translate only first N chapters
  -o, --output <file>   Output EPUB file (default: input_translated.epub)
  -h, --help            Show this help message

Environment variables:
  GEMINI_API_KEY    API key for Google Gemini
  QWEN_API_KEY      API key for Alibaba Qwen
  MIMO_API_KEY      API key for Mimo

Example:
  npm start -- -i book.epub -p qwen
  npm start -- -i book.epub -t 1 -o book_translated.epub
`;

async function main() {
  try {
    const { config, args } = loadConfig();

    if (args.help) {
      console.log(HELP_TEXT);
      return;
    }

    validateConfig(config, args);

    const inputPath = args.input;
    const outputPath =
      args.output ?? inputPath.replace(".epub", "_translated.epub");

    const logger = createLogger();
    const cache = createProgressCache();
    const provider = createAIProvider(args.provider, config, logger);

    console.log(`🚀 Starting translation`);
    console.log(`   Input: ${inputPath}`);
    console.log(`   Output: ${outputPath}`);
    console.log(`   Provider: ${args.provider} (${provider.modelName})`);
    console.log(`   Test mode: ${args.testMode ?? "disabled"}`);
    console.log("");

    await translateEpub(
      inputPath,
      outputPath,
      provider,
      config.styleGuide,
      logger,
      cache,
      args.testMode,
    );

    console.log(`\n📦 Output saved to: ${outputPath}`);
    console.log(`📝 Log saved to: ${logger.logFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    if (message.includes("required")) {
      console.log("\nUse -h or --help for usage information.");
    }
    process.exit(1);
  }
}

main();
