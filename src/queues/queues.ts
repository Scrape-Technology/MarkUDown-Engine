import { Queue } from "bullmq";
import { connection } from "./connection.js";

const defaultOpts = { connection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 } };

export const scrapeQueue = new Queue("scrape", defaultOpts);
export const crawlQueue = new Queue("crawl", defaultOpts);
export const mapQueue = new Queue("map", defaultOpts);
export const batchScrapeQueue = new Queue("batch-scrape", defaultOpts);
export const searchQueue = new Queue("search", defaultOpts);
export const rssQueue = new Queue("rss", defaultOpts);
export const screenshotQueue = new Queue("screenshot", defaultOpts);
export const changeDetectionQueue = new Queue("change-detection", defaultOpts);
export const extractQueue = new Queue("extract", defaultOpts);
export const deepResearchQueue = new Queue("deep-research", defaultOpts);
export const agentQueue = new Queue("agent", defaultOpts);
export const smartExtractQueue = new Queue("smart-extract", defaultOpts);
export const rankQueue = new Queue("rank", defaultOpts);
export const datasetQueue = new Queue("dataset", defaultOpts);
export const monitorQueue = new Queue("monitor", defaultOpts);

// Playbook Engine (spec 2026-07-10). `playbook` is the M1 replay queue; `playbook-heal`
// and `playbook-token-refresh` (M2) both have workers now (jobs/playbook-heal.ts,
// jobs/playbook-token-refresh.ts). Token-refresh is HTTP-only (no login/browser) — see
// that job's module docstring.
export const playbookQueue = new Queue("playbook", defaultOpts);
export const playbookHealQueue = new Queue("playbook-heal", defaultOpts); // M2
export const playbookTokenRefreshQueue = new Queue("playbook-token-refresh", defaultOpts); // M2

// Scheduler (spec 2026-07-15, item 3) — self-rescheduling trigger job, mirrors `monitor`
// but never touches Postgres; see src/jobs/playbook-monitor.ts.
export const playbookMonitorQueue = new Queue("playbook-monitor", defaultOpts);

export const allQueues = [
  scrapeQueue,
  crawlQueue,
  mapQueue,
  batchScrapeQueue,
  searchQueue,
  rssQueue,
  screenshotQueue,
  changeDetectionQueue,
  extractQueue,
  deepResearchQueue,
  agentQueue,
  smartExtractQueue,
  rankQueue,
  datasetQueue,
  monitorQueue,
  playbookQueue,
  playbookHealQueue,
  playbookTokenRefreshQueue,
  playbookMonitorQueue,
];
