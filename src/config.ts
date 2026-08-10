import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GO_MD_SERVICE_URL: z.string().default("http://localhost:3001"),
  PYTHON_LLM_URL: z.string().default("http://localhost:3002"),

  // The Scrape Technology FastAPI service (CLAUDE.md: api/, port 8000) — used by the
  // playbook-monitor scheduler (spec 2026-07-15, item 3) to trigger runs via
  // POST /api/playbooks/by-group/{group_id}/run, authenticated with INTERNAL_SERVICE_KEY.
  SCRAPETECH_API_URL: z.string().default("http://localhost:8000"),

  // Abrasio (proprietary stealth engine) — empty = disabled
  ABRASIO_API_URL: z.string().default(""),
  ABRASIO_API_KEY: z.string().default(""),

  // LLM
  GENAI_API_KEY: z.string().default(""),

  // Internal auth key sent to the python-llm service — must match INTERNAL_SERVICE_KEY there
  INTERNAL_SERVICE_KEY: z.string().default(""),

  PROXY_URL: z.string().default(""),
  PROXY_USERNAME: z.string().default(""),
  PROXY_PASSWORD: z.string().default(""),

  // Health-check HTTP port (0 = disabled)
  HEALTH_PORT: z.coerce.number().default(3003),

  // Browser mode — set HEADLESS=false to open a visible window (local dev only)
  HEADLESS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // Scraping defaults
  DEFAULT_TIMEOUT: z.coerce.number().default(60),
  MAX_CONCURRENT_PAGES: z.coerce.number().default(10),
  MAX_CRAWL_DEPTH: z.coerce.number().default(5),
  MAX_CRAWL_URLS: z.coerce.number().default(1000),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
