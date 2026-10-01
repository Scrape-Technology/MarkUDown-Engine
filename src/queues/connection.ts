import { config } from "../config.js";

export function parseRedisUrl(url: string) {
  const u = new URL(url);
  // The db index (redis://host:6379/<db>) used to be dropped here, so a worker pointed at
  // db 1 silently consumed db 0's queues — i.e. another environment's jobs.
  const db = parseInt(u.pathname.replace(/^\//, "") || "0", 10);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(db > 0 ? { db } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username && u.username !== "default" ? { username: decodeURIComponent(u.username) } : {}),
  };
}

// BullMQ expects a plain options object — passing an IORedis instance causes
// type conflicts when BullMQ bundles its own ioredis version internally.
export const connection = {
  ...parseRedisUrl(config.REDIS_URL),
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};
