import { Job } from "bullmq";
import { extract } from "../engine/orchestrator.js";
import { AbrasioSession, isAbrasioAvailable } from "../engine/abrasio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { normalizeUrl, isSameDomain, filterUrl } from "../utils/url-utils.js";
import { childLogger } from "../utils/logger.js";
import { config } from "../config.js";

export interface CrawlJobData {
  url: string;
  options?: {
    max_depth?: number;
    limit?: number;
    timeout?: number;
    include_link?: boolean;
    include_html?: boolean;
    exclude_tags?: string[];
    blocked_words?: string[];
    include_only?: string[];
    allowed_patterns?: string[];
    blocked_patterns?: string[];
    main_content?: boolean;
    concurrency?: number;
  };
}

interface CrawlPage {
  url: string;
  markdown: string;
  html?: string;
  metadata: { title: string; description: string; source: string; statusCode: number };
}

export interface CrawlJobResult {
  success: boolean;
  status: string;
  total: number;
  data: CrawlPage[];
  processing_time_ms: number;
}

/**
 * Semaphore for concurrent crawl pages.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private current = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.current < this.max) { this.current++; return; }
    return new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) { this.current++; next(); }
  }
}

export async function processCrawlJob(job: Job<CrawlJobData>): Promise<CrawlJobResult> {
  const log = childLogger({ jobId: job.id, queue: "crawl" });
  const start = Date.now();
  const { url, options = {} } = job.data;

  const maxDepth = options.max_depth ?? config.MAX_CRAWL_DEPTH;
  const limit = options.limit ?? config.MAX_CRAWL_URLS;
  const concurrency = Math.min(options.concurrency ?? 5, 10);
  const timeout = options.timeout ? options.timeout * 1000 : 60_000;

  log.info("Crawl started", { url, maxDepth, limit, concurrency });

  const visited = new Set<string>();
  const results: CrawlPage[] = [];
  const sem = new Semaphore(concurrency);

  // Shared Abrasio session for the entire crawl.
  // Created lazily — the browser only starts when the first URL actually needs Layer 3.
  // All subsequent URLs that reach Layer 3 open a new tab in this same browser
  // instead of launching a new instance.
  const abrasioSession: AbrasioSession | null = isAbrasioAvailable()
    ? new AbrasioSession(url, {}, timeout)
    : null;

  // BFS crawl
  type QueueItem = { url: string; depth: number };
  let queue: QueueItem[] = [{ url: normalizeUrl(url), depth: 0 }];

  try {
    while (queue.length > 0 && results.length < limit) {
      const batch = queue.splice(0, concurrency);
      const nextUrls: QueueItem[] = [];

      await Promise.all(
        batch.map(async (item) => {
          if (visited.has(item.url) || results.length >= limit) return;
          visited.add(item.url);

          await sem.acquire();
          try {
            // Every page always tries all 3 layers in order:
            // Cheerio → Patchright → Abrasio (via shared session)
            const result = await extract(item.url, { timeout, abrasioSession: abrasioSession ?? undefined });

            const cleaned = cleanHtml(result.html, item.url, {
              excludeTags: options.exclude_tags,
              mainContent: options.main_content,
              includeLinks: true,
            });
            const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));

            results.push({
              url: item.url,
              markdown,
              html: options.include_html ? cleaned.html : undefined,
              metadata: {
                title: result.metadata?.title as string ?? cleaned.title,
                description: cleaned.description,
                source: result.source,
                statusCode: result.statusCode,
              },
            });

            // Queue child links
            if (item.depth < maxDepth) {
              for (const link of cleaned.links) {
                const norm = normalizeUrl(link);
                if (
                  !visited.has(norm) &&
                  isSameDomain(norm, url) &&
                  filterUrl(norm, {
                    blockedWords: options.blocked_words,
                    allowedPatterns: options.allowed_patterns,
                    blockedPatterns: options.blocked_patterns,
                  })
                ) {
                  nextUrls.push({ url: norm, depth: item.depth + 1 });
                }
              }
            }

            await job.updateProgress(Math.round((results.length / limit) * 100));
          } catch (err: any) {
            log.warn("Crawl page failed", { url: item.url, error: err.message });
          } finally {
            sem.release();
          }
        }),
      );

      queue.push(...nextUrls);
    }
  } finally {
    // Close the shared Abrasio browser when the crawl ends (success or error)
    if (abrasioSession) await abrasioSession.close();
  }

  log.info("Crawl completed", { url, pagesScraped: results.length, ms: Date.now() - start });

  return {
    success: true,
    status: "completed",
    total: results.length,
    data: results,
    processing_time_ms: Date.now() - start,
  };
}
