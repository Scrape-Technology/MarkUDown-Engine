import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { allQueues } from "./queues/queues.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 5555);

export function startDashboard(): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/");

  createBullBoard({
    queues: allQueues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  const app = express();
  app.use("/", serverAdapter.getRouter());

  app.listen(DASHBOARD_PORT, () => {
    console.log(`Bull Board dashboard running on http://localhost:${DASHBOARD_PORT}`);
  });
}
