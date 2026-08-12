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
import { processRankJob } from "../jobs/rank.js";
import { processDatasetJob } from "../jobs/dataset.js";
import { processMonitorJob } from "../jobs/monitor.js";
import { processInstagramJob } from "../jobs/instagram.js";
import { processXJob } from "../jobs/x.js";
import { processPlaybookJob } from "../jobs/playbook.js";
import { processPlaybookMonitorJob } from "../jobs/playbook-monitor.js";
import { processPlaybookHealJob } from "../jobs/playbook-heal.js";
import { processPlaybookTokenRefreshJob } from "../jobs/playbook-token-refresh.js";

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
  const rankWorker = new Worker("rank", processRankJob, { connection, concurrency: 5 });
  const datasetWorker = new Worker("dataset", processDatasetJob, { connection, concurrency: 2 });
  const monitorWorker = new Worker("monitor", processMonitorJob, { connection, concurrency: 10 });
  const instagramWorker = new Worker("instagram", processInstagramJob, { connection, concurrency: 3 });
  const xWorker = new Worker("x", processXJob, { connection, concurrency: 3 });
  // Playbook Engine (spec 2026-07-10, Milestone 1).
  const playbookWorker = new Worker("playbook", processPlaybookJob, { connection, concurrency: 5 });
  // Scheduler (item 3) — cheap trigger-and-reschedule job, higher concurrency is fine.
  const playbookMonitorWorker = new Worker("playbook-monitor", processPlaybookMonitorJob, { connection, concurrency: 10 });
  // Self-heal (Milestone 2) — an LLM call plus (for T2) a full browser session per job;
  // low concurrency, same as deep-research/agent.
  const playbookHealWorker = new Worker("playbook-heal", processPlaybookHealJob, { connection, concurrency: 2 });
  // Token/session refresh (Milestone 2) — HTTP-only, no browser, no LLM; cheap like the
  // main playbook worker, same concurrency.
  const playbookTokenRefreshWorker = new Worker("playbook-token-refresh", processPlaybookTokenRefreshJob, { connection, concurrency: 5 });

  const workers = [
    scrapeWorker, crawlWorker, mapWorker, batchScrapeWorker,
    screenshotWorker, rssWorker, searchWorker, changeDetectionWorker,
    extractWorker, deepResearchWorker, agentWorker,
    smartExtractWorker, rankWorker, datasetWorker, monitorWorker,
    instagramWorker, xWorker, playbookWorker, playbookMonitorWorker,
    playbookHealWorker, playbookTokenRefreshWorker,
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
