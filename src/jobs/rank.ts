import { Job } from "bullmq";
import { googleSearch, bingSearch } from "./search.js";
import { childLogger } from "../utils/logger.js";

export interface RankJobData {
  keyword: string;
  domain: string;
  options?: {
    engine?: "google" | "bing";
    lang?: string;
    country?: string;
    depth?: number;
    timeout?: number;
  };
}

export interface RankJobResult {
  success: boolean;
  keyword: string;
  domain: string;
  engine: string;
  position: number | null;
  url: string | null;
  title: string | null;
  snippet: string | null;
  checked_results: number;
  processing_time_ms: number;
}

function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
}

export async function processRankJob(job: Job<RankJobData>): Promise<RankJobResult> {
  const log = childLogger({ jobId: job.id, queue: "rank" });
  const start = Date.now();
  const { keyword, domain, options = {} } = job.data;
  const engine = options.engine ?? "google";
  const lang = options.lang ?? "en";
  const country = options.country ?? "us";
  const depth = Math.min(options.depth ?? 100, 100);
  const timeout = options.timeout ? options.timeout * 1000 : 30_000;

  log.info("Rank check started", { keyword, domain, engine, depth });

  const normalizedTarget = normalizeDomain(domain);

  const results =
    engine === "bing"
      ? await bingSearch(keyword, depth, lang, country, timeout)
      : await googleSearch(keyword, depth, lang, country, timeout);

  let position: number | null = null;
  let matchedUrl: string | null = null;
  let matchedTitle: string | null = null;
  let matchedSnippet: string | null = null;

  for (let i = 0; i < results.length; i++) {
    const resultDomain = normalizeDomain(results[i].url);
    if (
      resultDomain === normalizedTarget ||
      resultDomain.endsWith(`.${normalizedTarget}`)
    ) {
      position = i + 1;
      matchedUrl = results[i].url;
      matchedTitle = results[i].title;
      matchedSnippet = results[i].snippet;
      break;
    }
  }

  await job.updateProgress(100);
  log.info("Rank check completed", {
    keyword,
    domain,
    position,
    checked: results.length,
    ms: Date.now() - start,
  });

  return {
    success: true,
    keyword,
    domain,
    engine,
    position,
    url: matchedUrl,
    title: matchedTitle,
    snippet: matchedSnippet,
    checked_results: results.length,
    processing_time_ms: Date.now() - start,
  };
}
