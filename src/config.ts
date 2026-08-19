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

  // Dedicated proxy for google.* — a datacenter egress IP (ECS) gets an immediate
  // "unusual traffic" CAPTCHA wall from Google regardless of target country, so the
  // general PROXY_URL/country-suffix scheme doesn't apply here. Needs a sticky
  // residential session (confirmed 2026-08-19: Geonode's rotating port 9000 changes
  // exit IP per connection and also gets blocked — port 10000 holds one IP for the
  // session and works). Falls back to no proxy (direct) when unset.
  GOOGLE_PROXY_URL: z.string().default(""),
  GOOGLE_PROXY_USERNAME: z.string().default(""),
  GOOGLE_PROXY_PASSWORD: z.string().default(""),

  // Health-check HTTP port (0 = disabled)
  HEALTH_PORT: z.coerce.number().default(3003),

  // Bull Board dashboard auth (bug found in review, 2026-08-11: the dashboard rendered
  // every queue's job.data verbatim — including, before this same review, playbook
  // secrets and the internal service key — with NO auth at all; anyone who could reach
  // the port saw live credentials). Empty = no credentials configured, in which case
  // dashboard.ts binds to localhost only rather than every interface.
  DASHBOARD_USERNAME: z.string().default(""),
  DASHBOARD_PASSWORD: z.string().default(""),

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

// Bug found in review, 2026-08-11: INTERNAL_SERVICE_KEY defaults to "" and several
// callers (playbook-heal.ts, playbook-token-refresh.ts, playbook-monitor.ts) send it
// unconditionally with no startup check — unlike llm-fetch.ts, which guards with an
// `if`. A misconfigured deploy would silently send an empty internal-auth header on
// every persist/trigger call, each rejected 401 by the api with nothing logging why.
// Loud at import time instead of silent at request time (mirrors the same fix on the
// api side, api/app/routes/playbooks.py).
if (!config.INTERNAL_SERVICE_KEY) {
  // eslint-disable-next-line no-console
  console.error(
    "INTERNAL_SERVICE_KEY is not set — every Playbook Engine self-heal persist, " +
    "token-refresh persist, and monitor trigger will be rejected 401 by the api.",
  );
}
