import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../shared/errors/AppError.js";
import { directTransaction, reading, silentLogger } from "../../testing/fakes.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";
import { CapacityPoller } from "./capacity.poller.js";
import type { CapacityRepository } from "./capacity.repository.js";
import { CapacityService, toHistoryPoints, type CapacityChainPort } from "./capacity.service.js";

const HOUR = 3_600_000;

function row(at: number, utilizationBps: number): CapacitySnapshotRow {
  return { network: "kelp-replay", at, utilizationBps, withdrawable: `${at}`, supplied: "1000", debtorCapacity: "900", sessionAssets: "0" };
}

function repoMock() {
  return {
    insertMany: vi.fn<CapacityRepository["insertMany"]>(),
    listSince: vi.fn<CapacityRepository["listSince"]>().mockReturnValue([]),
    deleteOlderThan: vi.fn<CapacityRepository["deleteOlderThan"]>().mockReturnValue(0),
  };
}

describe("toHistoryPoints", () => {
  it("returns chart points oldest first with amounts as strings", () => {
    expect(toHistoryPoints([row(30, 9_900), row(10, 9_000), row(20, 9_500)])).toEqual([
      { t: 10, utilizationBps: 9_000, withdrawable: "10", supplied: "1000" },
      { t: 20, utilizationBps: 9_500, withdrawable: "20", supplied: "1000" },
      { t: 30, utilizationBps: 9_900, withdrawable: "30", supplied: "1000" },
    ]);
  });
});

describe("CapacityService", () => {
  const chain = (impl: CapacityChainPort["readCapacity"], networks = ["kelp-replay", "earn-bank-run"] as const): CapacityChainPort => ({
    deployedNetworks: () => [...networks],
    readCapacity: vi.fn(impl),
  });

  it("serves live capacity with bigints as decimal strings", async () => {
    const service = new CapacityService(
      repoMock(),
      chain(async (_n, levels) => reading(9_999, { bidCapacity: levels.map((d) => ({ discountBps: d, assets: 10n ** 30n })) })),
      directTransaction,
      silentLogger,
      () => 5,
    );
    const dto = await service.getCapacity("kelp-replay");
    expect(dto).toMatchObject({ network: "kelp-replay", at: 5, utilizationBps: 9_999, withdrawable: "100000000000000000", sessionAssets: "0" });
    expect(dto.bidCapacity.map((b) => b.discountBps)).toEqual([100, 300, 500, 1_000, 2_000]);
    expect(dto.bidCapacity[0]?.assets).toBe("1000000000000000000000000000000");
  });

  it("reads history inside the requested window", () => {
    const repo = repoMock();
    repo.listSince.mockReturnValue([row(2 * HOUR, 9_000)]);
    const service = new CapacityService(repo, chain(async () => reading(0)), directTransaction, silentLogger, () => 10 * HOUR);
    expect(service.getHistory("kelp-replay", 6)).toEqual({ points: [{ t: 2 * HOUR, utilizationBps: 9_000, withdrawable: String(2 * HOUR), supplied: "1000" }] });
    expect(repo.listSince).toHaveBeenCalledWith("kelp-replay", 4 * HOUR);
  });

  it("snapshots every deployed network, skips failing RPCs and prunes old history", async () => {
    const repo = repoMock();
    const service = new CapacityService(
      repo,
      chain(async (n) => {
        if (n === "earn-bank-run") throw new AppError(502, "UPSTREAM_ERROR", "rpc down");
        return reading(9_999);
      }),
      directTransaction,
      silentLogger,
      () => 200 * HOUR,
    );
    const snaps = await service.snapshotAll();
    expect(snaps).toEqual([{ network: "kelp-replay", at: 200 * HOUR, utilizationBps: 9_999, withdrawable: 10n ** 17n, supplied: reading(0).supplied }]);
    expect(repo.insertMany.mock.calls[0]?.[0]).toHaveLength(1);
    expect(repo.insertMany.mock.calls[0]?.[0][0]).toMatchObject({ network: "kelp-replay", utilizationBps: 9_999, withdrawable: "100000000000000000" });
    expect(repo.deleteOlderThan).toHaveBeenCalledWith(32 * HOUR, undefined);
  });
});

describe("CapacityPoller", () => {
  it("passes each round to every listener and survives listener errors", async () => {
    const snapshot = vi.fn().mockResolvedValue([{ network: "kelp-replay", at: 1, utilizationBps: 1, withdrawable: 0n, supplied: 0n }]);
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const listener = vi.fn().mockResolvedValue(undefined);
    const poller = new CapacityPoller(snapshot, [failing, listener], 60_000, silentLogger);
    await poller.runOnce();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(await snapshot.mock.results[0]?.value);
  });

  it("starts immediately and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = vi.fn().mockResolvedValue([]);
      const poller = new CapacityPoller(snapshot, [], 1_000, silentLogger);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenCalledTimes(2);
      await poller.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(snapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
