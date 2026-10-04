import { describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, DEFAULT_DEPLOYMENTS_DIR, loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8787, pollIntervalMs: 60_000, corsOrigin: "*", dbPath: DEFAULT_DB_PATH, deploymentsDir: DEFAULT_DEPLOYMENTS_DIR });
    expect(c.webhookSecret).toBeUndefined();
    expect(c.rpcUrls).toEqual({});
    expect(DEFAULT_DEPLOYMENTS_DIR.replace(/\\/g, "/")).toMatch(/contracts\/deployments$/);
    expect(DEFAULT_DB_PATH.replace(/\\/g, "/")).toMatch(/apps\/backend\/data\/exeunt\.db$/);
  });

  it("reads overrides, treating blank values as unset", () => {
    const c = loadConfig({
      PORT: "9000",
      POLL_INTERVAL_MS: "",
      WEBHOOK_SECRET: "abc",
      RPC_KELP_REPLAY: "http://127.0.0.1:8602",
      RPC_ARBITRUM_SEPOLIA: "",
    });
    expect(c.port).toBe(9000);
    expect(c.pollIntervalMs).toBe(60_000);
    expect(c.webhookSecret).toBe("abc");
    expect(c.rpcUrls).toEqual({ "kelp-replay": "http://127.0.0.1:8602" });
  });

  it("fails fast listing every invalid value", () => {
    expect(() => loadConfig({ PORT: "http", POLL_INTERVAL_MS: "10", RPC_EARN_BANK_RUN: "not a url" })).toThrow(
      /PORT.*POLL_INTERVAL_MS.*RPC_EARN_BANK_RUN/,
    );
  });
});
