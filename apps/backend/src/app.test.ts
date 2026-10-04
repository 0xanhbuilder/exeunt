import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "./app.js";
import type { Db } from "./shared/db/database.js";
import type { KitRunner } from "./modules/faucet/index.js";
import type { WebhookSender } from "./modules/alerts/index.js";
import { emptyMcpChain, fakeChain, OTHER_OWNER, OWNER, silentLogger, testDb } from "./testing/fakes.js";

const HOUR = 3_600_000;

let db: Db;
let app: Express;
let clock: { now: number };
let chainState: { utilizationBps: number };
let webhook: WebhookSender & { deliver: ReturnType<typeof vi.fn> };
let kits: KitRunner & { runKit: ReturnType<typeof vi.fn> };
let built: ReturnType<typeof createApp>;

beforeEach(() => {
  db = testDb();
  clock = { now: 100 * HOUR };
  chainState = { utilizationBps: 9_999 };
  webhook = { deliver: vi.fn().mockResolvedValue(undefined) };
  kits = { runKit: vi.fn().mockResolvedValue(["Funded 0x… with 10 ETH for gas"]) };
  built = createApp({
    db,
    logger: silentLogger,
    chain: fakeChain(chainState),
    mcpChain: emptyMcpChain,
    corsOrigin: "*",
    webhook,
    kits,
    rpcUpstream: { send: vi.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "0xa4b1" }) },
    now: () => clock.now,
  });
  app = built.app;
});

afterEach(() => {
  if (db.isOpen) db.close();
});

describe("health", () => {
  it("reports liveness and DB readiness", async () => {
    await request(app).get("/healthz").expect(200, { status: "ok" });
    await request(app).get("/readyz").expect(200, { status: "ready" });
    db.close();
    const res = await request(app).get("/readyz").expect(503);
    expect(res.body).toEqual({ code: "NOT_READY", message: "Database unavailable" });
  });
});

describe("cross-cutting HTTP behaviour", () => {
  it("echoes or creates a request id and answers CORS preflights", async () => {
    const res = await request(app).get("/healthz").set("x-request-id", "abc-123").expect(200);
    expect(res.headers["x-request-id"]).toBe("abc-123");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const generated = await request(app).get("/healthz");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const pre = await request(app).options("/api/alerts").set("Origin", "http://localhost:5173").expect(204);
    expect(pre.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("formats unknown routes and bad JSON as { code, message }", async () => {
    const missing = await request(app).get("/api/nope").expect(404);
    expect(missing.body.code).toBe("NOT_FOUND");
    const bad = await request(app).post("/api/alerts").set("Content-Type", "application/json").send("{oops").expect(400);
    expect(bad.body.code).toBe("INVALID_JSON");
  });
});

describe("GET /api/networks", () => {
  it("lists every network with deployment and RPC status", async () => {
    const res = await request(app).get("/api/networks").expect(200);
    const byKey = Object.fromEntries((res.body.networks as { key: string }[]).map((n) => [n.key, n]));
    expect(Object.keys(byKey).sort()).toEqual(["arbitrum-sepolia", "earn-bank-run", "kelp-replay", "robinhood-testnet"]);
    expect(byKey["kelp-replay"]).toMatchObject({ deploymentLoaded: true, rpcReachable: true, isFork: true, venue: "aave", market: "0x0000000000000000000000000000000000001001" });
    expect(byKey["arbitrum-sepolia"]).toMatchObject({ deploymentLoaded: false, rpcReachable: false, market: null });
  });
});

describe("capacity", () => {
  it("serves live capacity with amounts as strings", async () => {
    const res = await request(app).get("/api/capacity/kelp-replay").expect(200);
    expect(res.body).toMatchObject({
      network: "kelp-replay",
      utilizationBps: 9_999,
      withdrawable: "100000000000000000",
      supplied: "148193896256465612948440",
      underlying: { symbol: "WETH", decimals: 18 },
    });
    expect(res.body.bidCapacity).toEqual([
      { discountBps: 100, assets: "100000000000000000000" },
      { discountBps: 300, assets: "300000000000000000000" },
      { discountBps: 500, assets: "500000000000000000000" },
      { discountBps: 1_000, assets: "1000000000000000000000" },
      { discountBps: 2_000, assets: "2000000000000000000000" },
    ]);
  });

  it("validates the network and reports missing deployments", async () => {
    const invalid = await request(app).get("/api/capacity/mainnet").expect(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");
    const missing = await request(app).get("/api/capacity/arbitrum-sepolia").expect(404);
    expect(missing.body.code).toBe("DEPLOYMENT_NOT_FOUND");
  });

  it("returns the polled history inside the window", async () => {
    clock.now = 90 * HOUR;
    await built.capacity.service.snapshotAll();
    chainState.utilizationBps = 9_000;
    clock.now = 99 * HOUR;
    await built.capacity.service.snapshotAll();
    clock.now = 100 * HOUR;

    const res = await request(app).get("/api/capacity/kelp-replay/history?hours=2").expect(200);
    expect(res.body).toEqual({ points: [{ t: 99 * HOUR, utilizationBps: 9_000, withdrawable: "100000000000000000", supplied: "148193896256465612948440" }] });
    const all = await request(app).get("/api/capacity/kelp-replay/history").expect(200);
    expect(all.body.points.map((p: { t: number }) => p.t)).toEqual([90 * HOUR, 99 * HOUR]);
    await request(app).get("/api/capacity/kelp-replay/history?hours=0").expect(400);
    await request(app).get("/api/capacity/kelp-replay/history?hours=1000").expect(400);
  });
});

describe("alerts", () => {
  const create = (body: object) => request(app).post("/api/alerts").send(body);

  it("creates, lists and deletes alerts for their owner", async () => {
    const created = await create({ network: "kelp-replay", thresholdBps: 9_000, owner: OWNER.toUpperCase().replace("0X", "0x") }).expect(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await request(app).get(`/api/alerts?owner=${OWNER}`).expect(200);
    expect(list.body.alerts).toEqual([
      { id, owner: OWNER, network: "kelp-replay", thresholdBps: 9_000, webhookUrl: null, createdAt: 100 * HOUR },
    ]);

    const forbidden = await request(app).delete(`/api/alerts/${id}?owner=${OTHER_OWNER}`).expect(403);
    expect(forbidden.body.code).toBe("FORBIDDEN");
    await request(app).delete(`/api/alerts/${id}`).send({ owner: OWNER }).expect(204);
    await request(app).delete(`/api/alerts/${id}?owner=${OWNER}`).expect(404);
    const after = await request(app).get(`/api/alerts?owner=${OWNER}`).expect(200);
    expect(after.body.alerts).toEqual([]);
  });

  it("validates threshold, owner and webhook URL", async () => {
    await create({ network: "kelp-replay", thresholdBps: 0, owner: OWNER }).expect(400);
    await create({ network: "kelp-replay", thresholdBps: 10_001, owner: OWNER }).expect(400);
    await create({ network: "kelp-replay", thresholdBps: 9_000, owner: "0x123" }).expect(400);
    await create({ network: "kelp-replay", thresholdBps: 9_000, owner: OWNER, webhookUrl: "http://example.com/hook" }).expect(400);
    await create({ network: "kelp-replay", thresholdBps: 9_000, owner: OWNER, webhookUrl: "ftp://example.com" }).expect(400);
    await create({ network: "kelp-replay", thresholdBps: 9_000, owner: OWNER, webhookUrl: "http://127.0.0.1:9999/hook" }).expect(201);
    await create({ network: "kelp-replay", thresholdBps: 9_000, owner: OWNER, webhookUrl: "https://hooks.example.com/x" }).expect(201);
    await request(app).get("/api/alerts").expect(400);
  });

  it("records in-app events and posts webhooks when a poll crosses the threshold", async () => {
    await create({ network: "kelp-replay", thresholdBps: 9_500, owner: OWNER, webhookUrl: "https://hooks.example.com/x" }).expect(201);
    chainState.utilizationBps = 9_000;
    await built.capacity.service.snapshotAll().then((s) => built.alerts.service.evaluateSnapshots(s));
    chainState.utilizationBps = 9_700;
    clock.now += 60_000;
    await built.capacity.service.snapshotAll().then((s) => built.alerts.service.evaluateSnapshots(s));
    clock.now += 60_000;
    await built.capacity.service.snapshotAll().then((s) => built.alerts.service.evaluateSnapshots(s));

    const res = await request(app).get(`/api/alerts/events?owner=${OWNER}`).expect(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ network: "kelp-replay", utilizationBps: 9_700, thresholdBps: 9_500, at: 100 * HOUR + 60_000 });
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(webhook.deliver.mock.calls[0]?.[1]).toMatchObject({ type: "exeunt.capacity.alert", utilizationBps: 9_700, supplied: "148193896256465612948440" });
    const other = await request(app).get(`/api/alerts/events?owner=${OTHER_OWNER}`).expect(200);
    expect(other.body.events).toEqual([]);
  });
});

describe("POST /api/faucet", () => {
  it("serves fork networks only, once per kit per window", async () => {
    const live = await request(app).post("/api/faucet").send({ network: "arbitrum-sepolia", address: OWNER, kit: "seller" }).expect(403);
    expect(live.body.code).toBe("FAUCET_FORK_ONLY");

    const ok = await request(app).post("/api/faucet").send({ network: "kelp-replay", address: OWNER, kit: "seller" }).expect(200);
    expect(ok.body).toEqual({ ok: true, actions: ["Funded 0x… with 10 ETH for gas"] });
    expect(kits.runKit).toHaveBeenCalledWith("kelp-replay", "seller", OWNER);

    const again = await request(app).post("/api/faucet").send({ network: "kelp-replay", address: OWNER, kit: "seller" }).expect(429);
    expect(again.body).toMatchObject({ code: "FAUCET_RATE_LIMITED", details: { retryAfterSeconds: 600 } });
    await request(app).post("/api/faucet").send({ network: "kelp-replay", address: OWNER, kit: "bidder" }).expect(200);

    clock.now += 10 * 60_000;
    await request(app).post("/api/faucet").send({ network: "kelp-replay", address: OWNER, kit: "seller" }).expect(200);
  });

  it("validates the kit and address", async () => {
    await request(app).post("/api/faucet").send({ network: "kelp-replay", address: OWNER, kit: "whale" }).expect(400);
    await request(app).post("/api/faucet").send({ network: "kelp-replay", address: "nope", kit: "seller" }).expect(400);
  });
});

describe("MCP over Streamable HTTP", () => {
  const mcp = (body: object) =>
    request(app).post("/mcp").set("Accept", "application/json, text/event-stream").set("Content-Type", "application/json").send(body);

  it("initializes and lists tools statelessly", async () => {
    const init = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }).expect(200);
    expect(init.body.result.serverInfo.name).toBe("exeunt");

    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).expect(200);
    const names = (tools.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("build_buy_and_repay");
    expect(names).toContain("simulate_transaction");
  });

  it("rejects GET and DELETE in stateless mode", async () => {
    const res = await request(app).get("/mcp").expect(405);
    expect(res.headers.allow).toBe("POST");
    await request(app).delete("/mcp").expect(405);
  });
});

describe("fork RPC proxy", () => {
  const body = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

  it("forwards allowed methods on fork networks", async () => {
    const res = await request(app).post("/rpc/kelp-replay").send(body("eth_chainId")).expect(200);
    expect(res.body.result).toBe("0xa4b1");
  });

  it("blocks anvil cheat methods and node-signed transactions", async () => {
    for (const method of ["anvil_setBalance", "eth_sendTransaction"]) {
      const res = await request(app).post("/rpc/kelp-replay").send(body(method)).expect(200);
      expect(res.body.error.code).toBe(-32601);
    }
  });

  it("is not offered for live networks or unknown ones", async () => {
    await request(app).post("/rpc/arbitrum-sepolia").send(body("eth_chainId")).expect(404);
    await request(app).post("/rpc/mainnet").send(body("eth_chainId")).expect(400);
  });
});
