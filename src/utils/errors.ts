/**
 * Base error for flow-control errors that should NOT be sent to Sentry.
 * Used for expected failures (timeouts, blocks, captchas).
 */
export class TransportableError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "TransportableError";
    this.statusCode = statusCode;
  }
}

export class ScrapeTimeoutError extends TransportableError {
  constructor(url: string, timeout: number) {
    super(`Scrape timed out after ${timeout}ms for ${url}`, 504);
    this.name = "ScrapeTimeoutError";
  }
}

export class CaptchaDetectedError extends TransportableError {
  constructor(url: string) {
    super(`CAPTCHA detected on ${url}`, 403);
    this.name = "CaptchaDetectedError";
  }
}

export class BlockedError extends TransportableError {
  constructor(url: string, statusCode: number) {
    super(`Request blocked (${statusCode}) for ${url}`, statusCode);
    this.name = "BlockedError";
  }
}

export class AllLayersFailedError extends TransportableError {
  constructor(url: string, errors: string[]) {
    super(`All extraction layers failed for ${url}: ${errors.join(" | ")}`, 500);
    this.name = "AllLayersFailedError";
  }
}
