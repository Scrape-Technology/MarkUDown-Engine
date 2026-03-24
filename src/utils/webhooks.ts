import { fetch } from "undici";
import { logger } from "./logger.js";

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  events?: ("completed" | "failed")[];
}

/**
 * Send a webhook notification for a job event.
 * Fire-and-forget: never throws, logs errors.
 */
export async function sendWebhook(
  webhook: WebhookConfig,
  payload: {
    event: "completed" | "failed";
    queue: string;
    jobId: string;
    data?: unknown;
    error?: string;
  },
): Promise<void> {
  // Check if this event type is wanted
  if (webhook.events && !webhook.events.includes(payload.event)) {
    return;
  }

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...webhook.headers,
      },
      body: JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    logger.debug("Webhook sent", {
      url: webhook.url,
      event: payload.event,
      jobId: payload.jobId,
      status: response.status,
    });
  } catch (err) {
    logger.warn("Webhook delivery failed", {
      url: webhook.url,
      event: payload.event,
      jobId: payload.jobId,
      error: (err as Error).message,
    });
  }
}
