import { Job } from "bullmq";
import { takeScreenshot } from "../engine/playwright-engine.js";
import { childLogger } from "../utils/logger.js";

export interface ScreenshotJobData {
  url: string;
  options?: {
    full_page?: boolean;
    type?: "png" | "jpeg";
    timeout?: number;
  };
}

export interface ScreenshotJobResult {
  success: boolean;
  data: {
    url: string;
    screenshot: string; // base64
    type: string;
  };
  processing_time_ms: number;
}

export async function processScreenshotJob(job: Job<ScreenshotJobData>): Promise<ScreenshotJobResult> {
  const log = childLogger({ jobId: job.id, queue: "screenshot" });
  const start = Date.now();
  const { url, options = {} } = job.data;

  log.info("Screenshot started", { url });

  const buffer = await takeScreenshot(url, {
    fullPage: options.full_page ?? true,
    type: options.type ?? "png",
    timeout: options.timeout ? options.timeout * 1000 : undefined,
  });

  const base64 = buffer.toString("base64");
  const type = options.type ?? "png";

  log.info("Screenshot completed", { url, size: buffer.length, ms: Date.now() - start });

  return {
    success: true,
    data: {
      url,
      screenshot: base64,
      type: `image/${type}`,
    },
    processing_time_ms: Date.now() - start,
  };
}
