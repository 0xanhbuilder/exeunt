import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../shared/errors/AppError.js";
import type { WebhookPayload } from "../alerts.types.js";
import { signWebhookBody, WebhookAdapter } from "./webhook.adapter.js";

const payload: WebhookPayload = {
  type: "exeunt.capacity.alert",
  network: "kelp-replay",
  utilizationBps: 9_999,
  thresholdBps: 9_000,
  withdrawable: "100000000000000000",
  supplied: "148193896256465612948440",
  at: 1_700_000_000_000,
};

function fetchReturning(...statuses: (number | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...statuses];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("WebhookAdapter", () => {
  it("signs the exact body with HMAC-SHA256 when a secret is set", async () => {
    const { fetchImpl, calls } = fetchReturning(204);
    await new WebhookAdapter({ secret: "s3cret", fetchImpl }).deliver("https://hooks.example.com/a", payload);
    const body = String(calls[0]?.init.body);
    expect(JSON.parse(body)).toEqual(payload);
    const expected = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(headersOf(calls[0]!.init)["X-Exeunt-Signature"]).toBe(expected);
    expect(signWebhookBody("s3cret", body)).toBe(expected);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0]!.init)["Content-Type"]).toBe("application/json");
  });

  it("omits the signature header without a secret", async () => {
    const { fetchImpl, calls } = fetchReturning(200);
    await new WebhookAdapter({ fetchImpl }).deliver("https://hooks.example.com/a", payload);
    expect(headersOf(calls[0]!.init)).not.toHaveProperty("X-Exeunt-Signature");
  });

  it("retries 5xx and network errors with backoff, up to 3 attempts", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { fetchImpl, calls } = fetchReturning(503, new Error("ECONNRESET"), 200);
    await new WebhookAdapter({ fetchImpl, sleep, retryDelaysMs: [10, 30] }).deliver("https://h.example.com", payload);
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 30]);
  });

  it("gives up after the third failed attempt with an AppError", async () => {
    const { fetchImpl, calls } = fetchReturning(500, 502, 429, 200);
    const adapter = new WebhookAdapter({ fetchImpl, sleep: async () => {} });
    const err = await adapter.deliver("https://h.example.com", payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 502, code: "UPSTREAM_ERROR" });
    expect(String((err as AppError).message)).toMatch(/after 3 attempts \(HTTP 429\)/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 4xx rejection or follow redirects", async () => {
    const { fetchImpl, calls } = fetchReturning(400);
    await expect(new WebhookAdapter({ fetchImpl, sleep: async () => {} }).deliver("https://h.example.com", payload)).rejects.toThrow(
      /rejected the delivery \(HTTP 400\)/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });
});
