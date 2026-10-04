import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../shared/errors/AppError.js";
import { directTransaction, OWNER, silentLogger } from "../../testing/fakes.js";
import { FaucetService, type FaucetRepositoryPort } from "./faucet.service.js";
import type { KitRunner } from "./faucet.types.js";

const WINDOW = 10 * 60_000;

function mocks() {
  const repo = {
    lastGrantAt: vi.fn<FaucetRepositoryPort["lastGrantAt"]>().mockReturnValue(null),
    insertGrant: vi.fn<FaucetRepositoryPort["insertGrant"]>().mockReturnValue(7),
    deleteGrant: vi.fn<FaucetRepositoryPort["deleteGrant"]>(),
    tryAcquireLock: vi.fn<FaucetRepositoryPort["tryAcquireLock"]>().mockReturnValue(true),
    releaseLock: vi.fn<FaucetRepositoryPort["releaseLock"]>(),
  };
  const kits = { runKit: vi.fn<KitRunner["runKit"]>().mockResolvedValue(["did a thing"]) };
  return { repo, kits };
}

describe("FaucetService", () => {
  let now: number;
  let m: ReturnType<typeof mocks>;
  let service: FaucetService;

  beforeEach(() => {
    now = 1_000_000;
    m = mocks();
    service = new FaucetService(m.repo, m.kits, directTransaction, silentLogger, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      newHolderId: () => "holder-1",
      lockWaitMs: 1_000,
      lockPollMs: 250,
    });
  });

  it("only serves fork networks", async () => {
    const err = await service.requestKit({ network: "arbitrum-sepolia", address: OWNER, kit: "seller" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 403, code: "FAUCET_FORK_ONLY" });
    await expect(service.requestKit({ network: "robinhood-testnet", address: OWNER, kit: "bidder" })).rejects.toMatchObject({ statusCode: 403 });
    expect(m.repo.insertGrant).not.toHaveBeenCalled();
    expect(m.kits.runKit).not.toHaveBeenCalled();
  });

  it("runs the kit, records the grant and releases the lock", async () => {
    const out = await service.requestKit({ network: "kelp-replay", address: OWNER, kit: "borrower" });
    expect(out).toEqual({ ok: true, actions: ["did a thing"] });
    expect(m.repo.insertGrant).toHaveBeenCalledWith({ network: "kelp-replay", address: OWNER, kit: "borrower", at: now }, undefined);
    expect(m.kits.runKit).toHaveBeenCalledWith("kelp-replay", "borrower", OWNER);
    expect(m.repo.releaseLock).toHaveBeenCalledWith("kelp-replay", "holder-1");
    expect(m.repo.deleteGrant).not.toHaveBeenCalled();
  });

  it("rate-limits one kit of each type per address and network per 10 minutes", async () => {
    m.repo.lastGrantAt.mockReturnValue(now - WINDOW + 30_000);
    const err = await service.requestKit({ network: "earn-bank-run", address: OWNER, kit: "seller" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 429, code: "FAUCET_RATE_LIMITED", details: { retryAfterSeconds: 30 } });
    expect(m.kits.runKit).not.toHaveBeenCalled();
    expect(m.repo.lastGrantAt).toHaveBeenCalledWith("earn-bank-run", OWNER, "seller", undefined);

    m.repo.lastGrantAt.mockReturnValue(now - WINDOW);
    await expect(service.requestKit({ network: "earn-bank-run", address: OWNER, kit: "seller" })).resolves.toMatchObject({ ok: true });
  });

  it("does not count a failed kit against the limit", async () => {
    m.kits.runKit.mockRejectedValue(new AppError(502, "UPSTREAM_ERROR", "anvil down"));
    await expect(service.requestKit({ network: "kelp-replay", address: OWNER, kit: "seller" })).rejects.toMatchObject({ statusCode: 502 });
    expect(m.repo.deleteGrant).toHaveBeenCalledWith(7);
    expect(m.repo.releaseLock).toHaveBeenCalledWith("kelp-replay", "holder-1");
  });

  it("waits for another kit on the same fork, then gives up with 503", async () => {
    m.repo.tryAcquireLock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(service.requestKit({ network: "kelp-replay", address: OWNER, kit: "bidder" })).resolves.toMatchObject({ ok: true });
    expect(m.repo.tryAcquireLock).toHaveBeenCalledTimes(2);

    m.repo.tryAcquireLock.mockReturnValue(false);
    await expect(service.requestKit({ network: "kelp-replay", address: OWNER, kit: "seller" })).rejects.toMatchObject({
      statusCode: 503,
      code: "FAUCET_BUSY",
    });
    expect(m.repo.deleteGrant).toHaveBeenCalledWith(7);
  });
});
