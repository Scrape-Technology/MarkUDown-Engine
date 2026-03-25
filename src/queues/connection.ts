import IORedis from "ioredis";
import { config } from "../config.js";

// BullMQ requires an IORedis instance — passing a raw URL string is ignored.
export const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
