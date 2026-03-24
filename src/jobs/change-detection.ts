import { Job } from "bullmq";
import { createHash } from "crypto";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";
import { createRedisClient } from "../utils/redis.js";

export interface ChangeDetectionJobData {
  url: string;
  options?: {
    timeout?: number;
    main_content?: boolean;
    include_diff?: boolean;
  };
}

export interface ChangeDetectionJobResult {
  success: boolean;
  data: {
    url: string;
    changed: boolean;
    current_hash: string;
    previous_hash: string | null;
    current_markdown?: string;
    previous_markdown?: string;
    first_check: boolean;
    checked_at: string;
  };
  processing_time_ms: number;
}

const REDIS_PREFIX = "markudown:change-detection:";

export async function processChangeDetectionJob(
  job: Job<ChangeDetectionJobData>,
): Promise<ChangeDetectionJobResult> {
  const log = childLogger({ jobId: job.id, queue: "change-detection" });
  const start = Date.now();
  const { url, options = {} } = job.data;

  log.info("Change detection started", { url });

  // 1. Scrape current content
  const result = await extract(url, {
    timeout: options.timeout ? options.timeout * 1000 : undefined,
  });
  const cleaned = cleanHtml(result.html, url, { mainContent: options.main_content });
  const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));
  const currentHash = createHash("sha256").update(markdown).digest("hex");

  // 2. Compare with stored hash
  const redis = await createRedisClient();
  const hashKey = `${REDIS_PREFIX}hash:${url}`;
  const contentKey = `${REDIS_PREFIX}content:${url}`;

  let previousHash: string | null = null;
  let previousMarkdown: string | undefined;
  let firstCheck = false;

  try {
    previousHash = await redis.get(hashKey);

    if (previousHash === null) {
      firstCheck = true;
    }

    if (options.include_diff && previousHash && previousHash !== currentHash) {
      previousMarkdown = (await redis.get(contentKey)) ?? undefined;
    }

    // 3. Store current state
    await redis.set(hashKey, currentHash);
    if (options.include_diff) {
      await redis.set(contentKey, markdown, "EX", 86400 * 30); // 30 days TTL
    }
  } finally {
    await redis.quit();
  }

  const changed = previousHash !== null && previousHash !== currentHash;

  log.info("Change detection completed", {
    url,
    changed,
    firstCheck,
    ms: Date.now() - start,
  });

  return {
    success: true,
    data: {
      url,
      changed,
      current_hash: currentHash,
      previous_hash: previousHash,
      current_markdown: options.include_diff ? markdown : undefined,
      previous_markdown: options.include_diff && changed ? previousMarkdown : undefined,
      first_check: firstCheck,
      checked_at: new Date().toISOString(),
    },
    processing_time_ms: Date.now() - start,
  };
}
