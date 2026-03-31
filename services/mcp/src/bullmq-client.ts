import { Queue } from "bullmq";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username && u.username !== "default"
      ? { username: decodeURIComponent(u.username) }
      : {}),
  };
}

// BullMQ connection options — plain object (not IORedis instance) to avoid type conflicts.
const bullConnection = {
  ...parseRedisUrl(REDIS_URL),
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

// Separate IORedis client used only for polling job state hashes.
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

// Queue registry — created on demand and reused across calls.
const queueCache = new Map<string, Queue>();

function getQueue(queueName: string): Queue {
  let q = queueCache.get(queueName);
  if (!q) {
    q = new Queue(queueName, {
      connection: bullConnection,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queueCache.set(queueName, q);
  }
  return q;
}

/**
 * Add a job to the named BullMQ queue and return its ID.
 */
export async function addJob(queueName: string, data: object): Promise<string> {
  const queue = getQueue(queueName);
  const job = await queue.add(queueName, data);
  if (!job.id) {
    throw new Error(
      `BullMQ did not return a job ID for queue "${queueName}"`,
    );
  }
  return job.id;
}

/**
 * Poll Redis every 500 ms until the job finishes (success or failure) or times out.
 *
 * BullMQ stores job state in a Redis hash at key `bull:{queueName}:{jobId}`.
 * Relevant fields:
 *   - `finishedOn`   — timestamp (ms) set when the job completes
 *   - `failedReason` — error message set when the job fails
 *   - `returnvalue`  — JSON-serialised return value on success
 */
export async function waitForJob(
  queueName: string,
  jobId: string,
  timeoutMs: number = 120_000,
): Promise<unknown> {
  // Connect lazily — if already connected ioredis is a no-op.
  await redisClient.connect().catch(() => undefined);

  const hashKey = `bull:${queueName}:${jobId}`;
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    const fields = await redisClient.hgetall(hashKey);

    if (fields && Object.keys(fields).length > 0) {
      if (fields.failedReason) {
        throw new Error(`Job ${jobId} failed: ${fields.failedReason}`);
      }

      if (fields.finishedOn && fields.returnvalue !== undefined) {
        try {
          return JSON.parse(fields.returnvalue);
        } catch {
          return fields.returnvalue;
        }
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Job ${jobId} in queue "${queueName}" timed out after ${timeoutMs}ms`,
  );
}

/**
 * Gracefully close all queues and the Redis polling client.
 * Call this on SIGTERM/SIGINT.
 */
export async function closeAll(): Promise<void> {
  const promises: Promise<unknown>[] = [];

  for (const q of queueCache.values()) {
    promises.push(q.close());
  }

  promises.push(redisClient.quit());

  await Promise.allSettled(promises);
}
