import express from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { allQueues } from "./queues/queues.js";
import { config } from "./config.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 5555);

/** Constant-time string comparison — a naive `===` leaks the credential's length/prefix
 *  via response-timing, which matters here since the dashboard renders every queue's
 *  job.data verbatim (including, until the 2026-08-11 review, playbook secrets and the
 *  internal service key). */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** HTTP Basic Auth gate. Bug found in review, 2026-08-11: this dashboard had NO auth at
 *  all — anyone who could reach the port saw every job's data, including live secrets
 *  (fixed separately by no longer putting plaintext secrets in job data at all — see
 *  playbook.ts et al — but the dashboard itself was still a wide-open credential/PII
 *  viewer for every OTHER queue too). */
function requireBasicAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (
      timingSafeStringEqual(user ?? "", config.DASHBOARD_USERNAME) &&
      timingSafeStringEqual(pass ?? "", config.DASHBOARD_PASSWORD)
    ) {
      next();
      return;
    }
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
  res.status(401).send("Authentication required");
}

export function startDashboard(): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/");

  createBullBoard({
    queues: allQueues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  const app = express();
  const hasCredentials = config.DASHBOARD_USERNAME && config.DASHBOARD_PASSWORD;
  if (hasCredentials) {
    app.use(requireBasicAuth);
  }
  app.use("/", serverAdapter.getRouter());

  // No credentials configured → bind to localhost only rather than every interface, so
  // an unconfigured deploy fails closed (unreachable from outside the host) instead of
  // silently exposing every queue's job data to the network. Set DASHBOARD_USERNAME /
  // DASHBOARD_PASSWORD to allow non-localhost access.
  const onListening = () => {
    const authNote = hasCredentials ? "auth: Basic" : "auth: NONE (bound to localhost only)";
    console.log(`Bull Board dashboard running on http://localhost:${DASHBOARD_PORT} (${authNote})`);
  };
  if (hasCredentials) {
    app.listen(DASHBOARD_PORT, onListening);
  } else {
    app.listen(DASHBOARD_PORT, "127.0.0.1", onListening);
  }
}
