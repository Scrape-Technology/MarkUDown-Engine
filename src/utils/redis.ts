import IORedis from "ioredis";
import { config } from "../config.js";

/**
 * Create a Redis client for auxiliary storage (change detection, etc.)
 */
export async function createRedisClient() {
  return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
