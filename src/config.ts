import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GO_MD_SERVICE_URL: z.string().default("http://localhost:3001"),
  PYTHON_LLM_URL: z.string().default("http://localhost:3002"),

  // Abrasio (proprietary stealth engine) — empty = disabled
  ABRASIO_API_URL: z.string().default(""),
  ABRASIO_API_KEY: z.string().default(""),

  // LLM
  GENAI_API_KEY: z.string().default(""),

  PROXY_URL: z.string().default(""),
  PROXY_USERNAME: z.string().default(""),
  PROXY_PASSWORD: z.string().default(""),

  // Health-check HTTP port (0 = disabled)
  HEALTH_PORT: z.coerce.number().default(3003),

  // Scraping defaults
  DEFAULT_TIMEOUT: z.coerce.number().default(60),
  MAX_CONCURRENT_PAGES: z.coerce.number().default(10),
  MAX_CRAWL_DEPTH: z.coerce.number().default(5),
  MAX_CRAWL_URLS: z.coerce.number().default(1000),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
