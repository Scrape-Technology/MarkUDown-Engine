import { Job, Queue } from "bullmq";
import { fetch } from "undici";
import { createRedisClient } from "../utils/redis.js";
import { connection } from "../queues/connection.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

/**
 * Playbook Engine scheduler (spec 2026-07-15, item 3) — self-rescheduling BullMQ job
 * that periodically triggers a playbook run. Deliberately mirrors `monitor.ts`'s
 * self-rescheduling + Redis kill-switch pattern (same `monitor:active:{subscription_id}`
 * key convention, safe to share since subscription_id is a globally unique uuid) — but
 * is an entirely separate file/queue, so `monitor.ts` itself (real production traffic
 * depends on it) is never touched.
 *
 * Unlike `monitor.ts`, this job does NOT do the actual work inline — it only fires an
 * HTTP trigger at the api (`POST /playbooks/by-group/{group_id}/run`, which resolves
 * the latest healthy version, opens secrets, and enqueues the real `playbook` job) and
 * reschedules. The api auto-injects its own `/ingest` webhook onto that triggered run,
 * so persistence (item 2) happens independently once the playbook job completes —
 * this scheduler job never touches Postgres or secrets, matching C2.
 *
 * Auth (fixed in review, 2026-07-15): authenticates as the trusted internal service
 * (X-Internal-Key), NOT a stored end-user API key. This job re-enqueues itself with
 * {delay: interval_ms} for the monitor's entire lifetime (months) — a raw user
 * credential would otherwise sit in Redis, re-persisted on every tick, for as long as
 * the monitor stays active. The api's by-group/run route resolves the real owner from
 * the group_id's rows, so no user credential needs to travel with this job.
 */

export interface PlaybookMonitorJobData {
  subscription_id: string;
  group_id: string;
  interval_ms: number;
}

export interface PlaybookMonitorJobResult {
  success: boolean;
  subscription_id: string;
  group_id: string;
  triggered: boolean;
  checked_at: string;
}

const activeKey = (id: string) => `monitor:active:${id}`;

let _queue: Queue | null = null;
function getPlaybookMonitorQueue(): Queue {
  if (!_queue) {
    _queue = new Queue("playbook-monitor", { connection });
  }
  return _queue;
}

export async function processPlaybookMonitorJob(
  job: Job<PlaybookMonitorJobData>,
): Promise<PlaybookMonitorJobResult> {
  const log = childLogger({ jobId: job.id, queue: "playbook-monitor" });
  const { subscription_id, group_id, interval_ms } = job.data;

  const redis = await createRedisClient();
  let triggered = false;

  try {
    const active = await redis.get(activeKey(subscription_id));
    if (active === null) {
      log.info("Playbook monitor cancelled, stopping", { subscription_id, group_id });
      return {
        success: true,
        subscription_id,
        group_id,
        triggered: false,
        checked_at: new Date().toISOString(),
      };
    }

    try {
      const resp = await fetch(
        `${config.SCRAPETECH_API_URL}/api/playbooks/by-group/${group_id}/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_SERVICE_KEY,
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15_000),
        },
      );
      triggered = resp.ok;
      if (!resp.ok) {
        log.warn("Playbook monitor trigger returned non-2xx", {
          subscription_id, group_id, status: resp.status,
        });
      }
    } catch (err) {
      // A transient api-down blip shouldn't kill the monitor — log and reschedule anyway.
      log.warn("Playbook monitor trigger failed", {
        subscription_id, group_id, error: (err as Error).message,
      });
    }

    const stillActive = await redis.get(activeKey(subscription_id));
    if (stillActive !== null) {
      await getPlaybookMonitorQueue().add("playbook-monitor", job.data, { delay: interval_ms });
      log.info("Playbook monitor re-queued", { subscription_id, group_id, delay_ms: interval_ms });
    }

    return {
      success: true,
      subscription_id,
      group_id,
      triggered,
      checked_at: new Date().toISOString(),
    };
  } finally {
    await redis.quit();
  }
}
