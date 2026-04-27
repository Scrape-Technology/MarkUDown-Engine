import { Job, Queue } from "bullmq";
import { createHash } from "crypto";
import { fetch } from "undici";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { createRedisClient } from "../utils/redis.js";
import { connection } from "../queues/connection.js";
import { childLogger } from "../utils/logger.js";

export interface MonitorJobData {
  subscription_id: string;
  url: string;
  interval_ms: number;
  callback_url: string;
  options?: {
    main_content?: boolean;
    timeout?: number;
  };
}

export interface MonitorJobResult {
  success: boolean;
  subscription_id: string;
  url: string;
  changed: boolean;
  current_hash: string;
  previous_hash: string | null;
  checked_at: string;
  processing_time_ms: number;
}

const activeKey = (id: string) => `monitor:active:${id}`;
const hashKey = (id: string) => `monitor:hash:${id}`;

let _queue: Queue | null = null;
function getMonitorQueue(): Queue {
  if (!_queue) {
    _queue = new Queue("monitor", { connection });
  }
  return _queue;
}

export async function processMonitorJob(job: Job<MonitorJobData>): Promise<MonitorJobResult> {
  const log = childLogger({ jobId: job.id, queue: "monitor" });
  const start = Date.now();
  const { subscription_id, url, interval_ms, callback_url, options = {} } = job.data;

  log.info("Monitor check started", { subscription_id, url });

  const redis = await createRedisClient();

  try {
    // Stop if subscription was deactivated
    const active = await redis.get(activeKey(subscription_id));
    if (active === null) {
      log.info("Monitor subscription cancelled, stopping", { subscription_id });
      return {
        success: true,
        subscription_id,
        url,
        changed: false,
        current_hash: "",
        previous_hash: null,
        checked_at: new Date().toISOString(),
        processing_time_ms: Date.now() - start,
      };
    }

    // Fetch and hash current content
    const result = await extract(url, {
      timeout: options.timeout ? options.timeout * 1000 : undefined,
    });
    const cleaned = cleanHtml(result.html, url, { mainContent: options.main_content ?? true });
    const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));
    const currentHash = createHash("sha256").update(markdown).digest("hex");

    const previousHash = await redis.get(hashKey(subscription_id));
    const changed = previousHash !== null && previousHash !== currentHash;

    // Update stored hash (90-day TTL — auto-cleans abandoned subscriptions)
    await redis.set(hashKey(subscription_id), currentHash, "EX", 60 * 60 * 24 * 90);

    // Notify webhook on change
    if (changed) {
      log.info("Content changed, notifying webhook", { subscription_id, url });
      try {
        await fetch(callback_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "change_detected",
            subscription_id,
            url,
            changed: true,
            current_hash: currentHash,
            previous_hash: previousHash,
            checked_at: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        log.warn("Webhook delivery failed", {
          subscription_id,
          error: (err as Error).message,
        });
      }
    }

    // Re-queue for next check if still active
    const stillActive = await redis.get(activeKey(subscription_id));
    if (stillActive !== null) {
      await getMonitorQueue().add("monitor", job.data, { delay: interval_ms });
      log.info("Monitor re-queued", { subscription_id, delay_ms: interval_ms });
    }

    log.info("Monitor check completed", {
      subscription_id,
      url,
      changed,
      ms: Date.now() - start,
    });

    return {
      success: true,
      subscription_id,
      url,
      changed,
      current_hash: currentHash,
      previous_hash: previousHash,
      checked_at: new Date().toISOString(),
      processing_time_ms: Date.now() - start,
    };
  } finally {
    await redis.quit();
  }
}
