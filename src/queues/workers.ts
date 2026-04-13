import { Worker } from "bullmq";
import { connection } from "./connection.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { sendWebhook, type WebhookConfig } from "../utils/webhooks.js";

import { processScrapeJob } from "../jobs/scrape.js";
import { processCrawlJob } from "../jobs/crawl.js";
import { processMapJob } from "../jobs/map.js";
import { processBatchScrapeJob } from "../jobs/batch-scrape.js";
import { processScreenshotJob } from "../jobs/screenshot.js";
import { processRssJob } from "../jobs/rss.js";
import { processSearchJob } from "../jobs/search.js";
import { processChangeDetectionJob } from "../jobs/change-detection.js";
import { processExtractJob } from "../jobs/extract.js";
import { processDeepResearchJob } from "../jobs/deep-research.js";
import { processAgentJob } from "../jobs/agent.js";
import { processSmartExtractJob } from "../jobs/smart-extract.js";

const workerOpts = { connection, concurrency: config.MAX_CONCURRENT_PAGES };

export function startWorkers() {
  const scrapeWorker = new Worker("scrape", processScrapeJob, workerOpts);
  const crawlWorker = new Worker("crawl", processCrawlJob, { connection, concurrency: 2 });
  const mapWorker = new Worker("map", processMapJob, { connection, concurrency: 3 });
  const batchScrapeWorker = new Worker("batch-scrape", processBatchScrapeJob, { connection, concurrency: 2 });
  const screenshotWorker = new Worker("screenshot", processScreenshotJob, { connection, concurrency: 5 });
  const rssWorker = new Worker("rss", processRssJob, { connection, concurrency: 3 });
  const searchWorker = new Worker("search", processSearchJob, { connection, concurrency: 3 });
  const changeDetectionWorker = new Worker("change-detection", processChangeDetectionJob, { connection, concurrency: 5 });
  const extractWorker = new Worker("extract", processExtractJob, { connection, concurrency: 3 });
  const deepResearchWorker = new Worker("deep-research", processDeepResearchJob, { connection, concurrency: 2 });
  const agentWorker = new Worker("agent", processAgentJob, { connection, concurrency: 2 });
  const smartExtractWorker = new Worker("smart-extract", processSmartExtractJob, { connection, concurrency: 2 });

  const workers = [
    scrapeWorker, crawlWorker, mapWorker, batchScrapeWorker,
    screenshotWorker, rssWorker, searchWorker, changeDetectionWorker,
    extractWorker, deepResearchWorker, agentWorker,
    smartExtractWorker,
  ];

  for (const w of workers) {
    w.on("completed", (job) => {
      logger.info(`Job completed`, { queue: w.name, jobId: job.id });

      // Fire webhook if configured in job data
      const webhook = (job.data as any)?.webhook as WebhookConfig | undefined;
      if (webhook?.url) {
        sendWebhook(webhook, {
          event: "completed",
          queue: w.name,
          jobId: job.id!,
          data: job.returnvalue,
        });
      }
    });
    w.on("failed", (job, err) => {
      logger.error(`Job failed`, { queue: w.name, jobId: job?.id, error: err.message });

      const webhook = (job?.data as any)?.webhook as WebhookConfig | undefined;
      if (webhook?.url) {
        sendWebhook(webhook, {
          event: "failed",
          queue: w.name,
          jobId: job?.id ?? "unknown",
          error: err.message,
        });
      }
    });
  }

  logger.info("All workers started", {
    queues: workers.map((w) => w.name),
    concurrency: workerOpts.concurrency,
  });

  return workers;
}
