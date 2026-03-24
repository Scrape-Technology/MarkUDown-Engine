import { createServer, type Server } from "node:http";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { startWorkers } from "./queues/workers.js";
import { initPlaywright, closePlaywright } from "./engine/playwright-engine.js";

async function main() {
  logger.info("MarkUDown Engine starting", {
    redis: config.REDIS_URL,
    goMdService: config.GO_MD_SERVICE_URL,
    abrasioEnabled: !!config.ABRASIO_API_URL,
    maxConcurrentPages: config.MAX_CONCURRENT_PAGES,
  });

  // Pre-launch Playwright browser (shared singleton)
  await initPlaywright();

  // Start BullMQ workers
  const workers = startWorkers();

  // Health-check HTTP server (for K8s liveness/readiness probes)
  const healthPort = config.HEALTH_PORT;
  let healthServer: Server | undefined;

  if (healthPort > 0) {
    healthServer = createServer((req, res) => {
      if (req.url === "/health" && req.method === "GET") {
        const body = JSON.stringify({
          status: "healthy",
          service: "markudown-engine",
          workers: workers.map((w) => w.name),
          uptime: Math.round(process.uptime()),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    healthServer.listen(healthPort, () => {
      logger.info(`Health endpoint listening on :${healthPort}/health`);
    });
  }

  // Bull Board dashboard (queue monitoring UI)
  if (process.env.ENABLE_DASHBOARD !== "false") {
    const { startDashboard } = await import("./dashboard.js");
    startDashboard();
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down...`);
    if (healthServer) healthServer.close();
    await Promise.all(workers.map((w) => w.close()));
    await closePlaywright();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message });
  process.exit(1);
});
