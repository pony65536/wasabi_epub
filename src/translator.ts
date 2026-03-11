import { EPub } from "epub2";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import Queue from "better-queue";
import { Logger } from "./logger.js";
import { AIProvider } from "./ai-providers.js";
import { ProgressCache } from "./cache.js";

const BATCH_SIZE_LIMIT = 5000;

interface BatchTask {
  batch: Array<{ id: string; content: string }>;
  $parent: cheerio.CheerioAPI;
  processor: {
    prompt: string;
    attrName: string;
  };
}

/**
 * Clean AI response by removing Markdown code block wrappers.
 */
function cleanAIResponse(raw: string): string {
  return raw
    .replace(/```[\w]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function createBatchQueue(aiProvider: AIProvider, logger: Logger) {
  const queue = new Queue(
    async (task: BatchTask, cb: (err?: Error) => void) => {
      const { batch, $parent, processor } = task;
      const MAX_ATTEMPTS = 3;
      let attempts = 0;
      let success = false;

      while (!success && attempts < MAX_ATTEMPTS) {
        try {
          attempts++;

          const mergeRegex =
            /([A-Za-z])<(small|span|strong|em)[^>]*>([\s\S]*?)<\/\2>/gi;

          const batchInput = batch
            .map((n) => {
              const preProcessedContent = n.content.replace(
                mergeRegex,
                (match, p1, p2, p3) =>
                  !p3.includes("<") ? p1 + p3 : match,
              );
              return `<node id="${n.id}">${preProcessedContent}</node>`;
            })
            .join("\n");

          const rawResponse = cleanAIResponse(
            await aiProvider.callAI(batchInput, processor.prompt, false),
          );

          const $response = cheerio.load(`<root>${rawResponse}</root>`, {
            xmlMode: true,
            decodeEntities: false,
          });

          for (const node of batch) {
            const $node = $response(`node[id="${node.id}"]`);

            if ($node.length === 0) {
              logger.write(
                "WARN",
                `Node ${node.id} missing from AI response, will retry.`,
              );
              continue;
            }

            const processedContent = $node.html()?.trim();
            if (!processedContent) continue;

            try {
              cheerio.load(processedContent, { xmlMode: true });
              $parent(`[${processor.attrName}="${node.id}"]`)
                .html(processedContent)
                .removeAttr(processor.attrName);
            } catch (xmlError) {
              const errorMsg = xmlError instanceof Error ? xmlError.message : String(xmlError);
              logger.write("ERROR", `Node ${node.id} invalid HTML: ${errorMsg}`);
            }
          }

          success = true;
          cb();
        } catch (e) {
          const errorMsg = e instanceof Error ? e.stack ?? e.message : String(e);
          logger.write("ERROR", `Batch Queue Attempt ${attempts} Failed: ${errorMsg}`);
          if (attempts >= MAX_ATTEMPTS) {
            cb(e instanceof Error ? e : new Error(errorMsg));
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    },
    { concurrent: aiProvider.concurrency, maxRetries: 0 },
  );

  const drainQueue = (): Promise<void> =>
    new Promise((resolve) => {
      const isIdle = () =>
        queue._running === 0 && queue._queue.length === 0;
      if (isIdle()) return resolve();
      queue.once("drain", resolve);
    });

  return { queue, drainQueue };
}

function splitIntoBatches(
  nodeList: Array<{ id: string; content: string }>,
): Array<Array<{ id: string; content: string }>> {
  const batches: Array<Array<{ id: string; content: string }>> = [];
  let currentBatch: Array<{ id: string; content: string }> = [];
  let currentLength = 0;

  for (const node of nodeList) {
    if (
      currentLength + node.content.length > BATCH_SIZE_LIMIT &&
      currentBatch.length > 0
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = 0;
    }
    currentBatch.push(node);
    currentLength += node.content.length;
  }

  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

function dispatchBatches(
  batches: Array<Array<{ id: string; content: string }>>,
  $: cheerio.CheerioAPI,
  processor: { prompt: string; attrName: string },
  batchQueue: Queue,
  logger: Logger,
): Array<Promise<void>> {
  return batches.map(
    (batch) =>
      new Promise((resolve) => {
        batchQueue
          .push({ batch, $parent: $, processor })
          .on("finish", () => resolve())
          .on("failed", (err: Error) => {
            logger.write("ERROR", `Batch Task Failed: ${err?.message}`);
            resolve();
          });
      }),
  );
}

function collectFailedNodes(
  $: cheerio.CheerioAPI,
  attrName: string,
): Array<{ id: string; content: string }> {
  const failed: Array<{ id: string; content: string }> = [];
  $(`[${attrName}]`).each((_, el) => {
    failed.push({ id: $(el).attr(attrName)!, content: $(el).html()! });
  });
  return failed;
}

async function processHtmlBatch(
  $: cheerio.CheerioAPI,
  nodeList: Array<{ id: string; content: string }>,
  processor: { prompt: string; attrName: string },
  batchQueue: Queue,
  logger: Logger,
): Promise<void> {
  if (nodeList.length === 0) return;

  const batches = splitIntoBatches(nodeList);
  await Promise.all(
    dispatchBatches(batches, $, processor, batchQueue, logger),
  );

  const MAX_RETRY_ROUNDS = 3;
  for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
    const failedNodes = collectFailedNodes($, processor.attrName);
    if (failedNodes.length === 0) break;

    console.log(
      `    - ⚠️ Retrying ${failedNodes.length} failed nodes (Round ${round}/${MAX_RETRY_ROUNDS})...`,
    );

    const retryBatches = splitIntoBatches(failedNodes);
    await Promise.all(
      dispatchBatches(retryBatches, $, processor, batchQueue, logger),
    );
  }
}

const CHEERIO_OPTIONS = { xmlMode: true, decodeEntities: false };

function loadHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html, CHEERIO_OPTIONS);
}

function extractFirstHeading(htmlContent: string): string | null {
  const $ = loadHtml(htmlContent);
  const heading = $("h1, h2").first();
  if (heading.length > 0)
    return heading.text().replace(/\s+/g, " ").trim();
  const titleTag = $("title").text();
  return titleTag ? titleTag.trim() : null;
}

function resolveAnchorTitle(
  $doc: cheerio.CheerioAPI,
  anchor: string,
): string | null {
  const cleanText = ($el: cheerio.Cheerio<cheerio.Element>): string => {
    if (!$el || !$el.length) return "";
    const $clone = $el.clone();
    $clone.find("sup, a[href]").remove();
    return $clone.text().trim().replace(/\s+/g, " ");
  };

  if (anchor) {
    const $el = $doc(`#${anchor}`);
    if ($el.length > 0) {
      let text = cleanText($el);
      if (!text) {
        const heading = $el.find("h1, h2, h3, h4, h5, h6").first();
        text = heading.length > 0 ? cleanText(heading) : cleanText($el.nextAll("h1, h2, h3, h4").first());
      }
      return text;
    }
  }
  return null;
}

export interface EpubChapter {
  id: string;
  href: string;
  title: string;
  content: string;
}

export async function translateEpub(
  inputPath: string,
  outputPath: string,
  provider: AIProvider,
  styleGuide: string,
  logger: Logger,
  cache: ProgressCache,
  testModeLimit: number | null,
): Promise<void> {
  console.log(`📖 Loading EPUB: ${inputPath}`);
  const book = await EPub.create(inputPath);

  const chapters: EpubChapter[] = [];

  for (const chapter of book.flow) {
    if (testModeLimit && chapters.length >= testModeLimit) break;

    try {
      const html = await book.getChapter(chapter.id);
      const title = extractFirstHeading(html) ?? chapter.title ?? chapter.id;
      chapters.push({
        id: chapter.id,
        href: chapter.href,
        title,
        content: html,
      });
    } catch (error) {
      logger.write("ERROR", `Failed to load chapter ${chapter.id}: ${error}`);
    }
  }

  console.log(`📑 Found ${chapters.length} chapters`);

  const { queue, drainQueue } = createBatchQueue(provider, logger);

  for (const chapter of chapters) {
    console.log(`  📄 Translating: ${chapter.title}`);

    const cached = cache.load(chapter.id);
    let $ = cached ? loadHtml(cached) : loadHtml(chapter.content);

    // Mark all p, li, td, th, h1-h6 for translation
    $("p, li, td, th, h1, h2, h3, h4, h5, h6").each((_, el) => {
      const $el = $(el);
      const id = `t-${Math.random().toString(36).slice(2, 11)}`;
      $el.attr("data-translate-id", id);
    });

    const nodeList: Array<{ id: string; content: string }> = [];
    $("[data-translate-id]").each((_, el) => {
      const $el = $(el);
      nodeList.push({
        id: $el.attr("data-translate-id")!,
        content: $el.html() ?? "",
      });
    });

    console.log(`    - ${nodeList.length} nodes to translate`);

    const processor = {
      prompt: `You are a professional translator. Translate the following content to ${"Chinese (Simplified)"}. ${styleGuide} 

IMPORTANT: Return ONLY the translated XML content. Wrap each translated paragraph in a <node> tag with the original ID:
<node id="ORIGINAL_ID">translated content</node>

Do NOT include any explanations, comments, or markdown formatting.`,
      attrName: "data-translate-id",
    };

    await processHtmlBatch($, nodeList, processor, queue, logger);
    await drainQueue();

    const translatedHtml = $.html();
    cache.save(chapter.id, translatedHtml);

    // Save chapter
    try {
      const zip = new AdmZip(inputPath);
      const entry = zip.getEntry(chapter.href);
      if (entry) {
        entry.setData(Buffer.from(translatedHtml, "utf8"));
        zip.writeZip(outputPath);
      }
    } catch (error) {
      logger.write("ERROR", `Failed to save chapter ${chapter.id}: ${error}`);
    }
  }

  console.log("✅ Translation complete!");
}
