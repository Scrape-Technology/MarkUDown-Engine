import { config } from "../config.js";

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
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
