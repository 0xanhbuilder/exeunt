import { createHmac } from "node:crypto";
import { AppError, ErrorCode } from "../../../shared/errors/AppError.js";
import type { WebhookPayload, WebhookSender } from "../alerts.types.js";

export const SIGNATURE_HEADER = "X-Exeunt-Signature";

export interface WebhookAdapterOptions {
  /** HMAC-SHA256 key; without it the signature header is omitted. */
  secret?: string;
  /** Waits between attempts; its length + 1 is the number of attempts. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** `sha256=<hex HMAC-SHA256 of the exact request body>`. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

class PermanentFailure extends Error {}

/** POSTs signed JSON to a webhook, retrying network errors, timeouts, 408, 429 and 5xx with backoff. */
export class WebhookAdapter implements WebhookSender {
  private readonly delays: number[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WebhookAdapterOptions = {}) {
    this.delays = options.retryDelaysMs ?? [1_000, 3_000];
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async deliver(url: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "exeunt-webhook/0.1" };
    if (this.options.secret) headers[SIGNATURE_HEADER] = signWebhookBody(this.options.secret, body);

    const attempts = this.delays.length + 1;
    let lastError = "no attempt made";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status >= 200 && res.status < 300) return;
        lastError = `HTTP ${res.status}`;
        if (res.status !== 408 && res.status !== 429 && res.status < 500) throw new PermanentFailure(lastError);
      } catch (err) {
        if (err instanceof PermanentFailure) {
          throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `Webhook rejected the delivery (${err.message})`);
        }
        lastError = err instanceof Error ? err.message : String(err);
      }
      const delay = this.delays[attempt - 1];
      if (delay !== undefined) await this.sleep(delay);
    }
    throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `Webhook delivery failed after ${attempts} attempts (${lastError})`);
  }
}
