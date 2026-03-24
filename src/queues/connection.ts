import { config } from "../config.js";

// BullMQ accepts a Redis URL string as connection.
export const connection = config.REDIS_URL as any;
