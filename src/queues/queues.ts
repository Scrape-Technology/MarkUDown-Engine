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
];
