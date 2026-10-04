import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AAVE_DEPLOYMENT, fakeChain, fakeNetwork } from "./testing/fakes.js";
import { createExeuntMcpServer } from "./server.js";

const TOOLS = [
  "list_networks",
  "get_exit_capacity",
  "list_sessions",
  "list_bids",
  "quote_purchase",
  "get_borrower_position",
  "plan_sell_now",
  "build_open_session",
  "build_withdraw_unsold",
  "build_buy_and_repay",
  "build_buy_with_collateral",
  "build_place_bid",
  "build_cancel_bid",
  "build_sell_now",
  "build_vault_deposit",
  "build_vault_redeem",
  "build_route_repay_with_frozen_collateral",
  "simulate_transaction",
];

let client: Client;

beforeEach(async () => {
  const net = fakeNetwork(AAVE_DEPLOYMENT);
  vi.spyOn(net.sdk, "capacity").mockResolvedValue({
    withdrawable: 0n,
    supplied: 10n ** 18n,
    utilizationBps: 10_000,
    debtorCapacity: 10n ** 18n,
    sessionAssets: 0n,
  });
  vi.spyOn(net.sdk, "bidCapacityAt").mockResolvedValue(0n);
  const server = createExeuntMcpServer({ chain: fakeChain({ "kelp-replay": net.handle }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("");
}

describe("MCP server", () => {
  it("registers every tool with a description and a network argument", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      if (tool.name !== "list_networks") expect(tool.inputSchema.required).toContain("network");
    }
  });

  it("never asks for keys or seeds", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const name of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(name).not.toMatch(/private|mnemonic|seed|secret|password/i);
      }
    }
  });

  it("answers a read tool over the protocol with JSON text", async () => {
    const res = await client.callTool({ name: "get_exit_capacity", arguments: { network: "kelp-replay" } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res)) as { utilization: { percent: string } };
    expect(body.utilization.percent).toBe("100.00%");
  });

  it("returns tool errors for invalid input and undeployed networks", async () => {
    const invalid = await client.callTool({ name: "get_exit_capacity", arguments: { network: "ethereum" } });
    expect(invalid.isError).toBe(true);
    const missing = await client.callTool({ name: "get_exit_capacity", arguments: { network: "arbitrum-sepolia" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No Exeunt deployment found for arbitrum-sepolia/);
  });
});
