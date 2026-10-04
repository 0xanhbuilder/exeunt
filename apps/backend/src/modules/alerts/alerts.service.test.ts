import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../shared/errors/AppError.js";
import { directTransaction, OTHER_OWNER, OWNER, silentLogger } from "../../testing/fakes.js";
import type { CapacitySnapshot } from "../capacity/index.js";
import type { AlertRow, NewAlertEvent } from "./alerts.model.js";
import { AlertService, shouldFire, type AlertRepositoryPort } from "./alerts.service.js";
import type { WebhookSender } from "./alerts.types.js";

/** In-memory stand-in for the repository, so the service is tested without SQLite. */
function memoryRepo(initial: AlertRow[] = []) {
  const alerts = new Map(initial.map((a) => [a.id, { ...a }]));
  const events: (NewAlertEvent & { id: number })[] = [];
  const repo: AlertRepositoryPort = {
    insert: vi.fn((a: AlertRow) => void alerts.set(a.id, { ...a })),
    findById: vi.fn((id: string) => alerts.get(id) ?? null),
    listByOwner: vi.fn((owner: string) => [...alerts.values()].filter((a) => a.owner === owner)),
    listByNetwork: vi.fn((network: string) => [...alerts.values()].filter((a) => a.network === network)),
    delete: vi.fn((id: string) => void alerts.delete(id)),
    setLastUtilization: vi.fn((network: string, bps: number) => {
      for (const a of alerts.values()) if (a.network === network) a.lastUtilizationBps = bps;
    }),
    insertEvents: vi.fn((list: NewAlertEvent[]) =>
      list.map((e) => {
        const row = { ...e, id: events.length + 1 };
        events.push(row);
        return row;
      }),
    ),
    listEventsByOwner: vi.fn((owner: string, limit: number) => events.filter((e) => e.owner === owner).reverse().slice(0, limit)),
  };
  return { repo, alerts, events };
}

function alert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner: OWNER,
    network: "kelp-replay",
    thresholdBps: 9_000,
    webhookUrl: null,
    lastUtilizationBps: null,
    createdAt: 1,
    ...overrides,
  };
}

function snap(utilizationBps: number, at = 1_000): CapacitySnapshot {
  return { network: "kelp-replay", at, utilizationBps, withdrawable: 5n, supplied: 100n };
}

describe("shouldFire", () => {
  it("fires only when crossing up through the threshold", () => {
    expect(shouldFire(8_999, 9_000, 9_000)).toBe(true);
    expect(shouldFire(9_000, 9_500, 9_000)).toBe(false);
    expect(shouldFire(9_500, 8_000, 9_000)).toBe(false);
    expect(shouldFire(8_000, 8_500, 9_000)).toBe(false);
  });

  it("fires on the first evaluation when already at or above", () => {
    expect(shouldFire(null, 9_999, 9_000)).toBe(true);
    expect(shouldFire(null, 8_000, 9_000)).toBe(false);
  });
});

describe("AlertService.evaluateSnapshots", () => {
  let webhook: WebhookSender & { deliver: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    webhook = { deliver: vi.fn().mockResolvedValue(undefined) };
  });

  it("is edge-triggered across consecutive polls", async () => {
    const { repo, events } = memoryRepo([alert({ lastUtilizationBps: 8_000 })]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    await service.evaluateSnapshots([snap(9_100, 1)]);
    await service.evaluateSnapshots([snap(9_900, 2)]);
    await service.evaluateSnapshots([snap(8_500, 3)]);
    await service.evaluateSnapshots([snap(9_000, 4)]);
    expect(events.map((e) => e.at)).toEqual([1, 4]);
    expect(events[0]).toMatchObject({ utilizationBps: 9_100, thresholdBps: 9_000, owner: OWNER });
  });

  it("fires once on the first snapshot when already above", async () => {
    const { repo, events } = memoryRepo([alert()]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    await service.evaluateSnapshots([snap(9_999, 1)]);
    await service.evaluateSnapshots([snap(9_999, 2)]);
    expect(events).toHaveLength(1);
  });

  it("only evaluates alerts of the snapshot's network", async () => {
    const { repo, events } = memoryRepo([alert({ network: "earn-bank-run" })]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    await service.evaluateSnapshots([snap(10_000)]);
    expect(events).toHaveLength(0);
  });

  it("posts the webhook payload for fired alerts with a URL", async () => {
    const { repo } = memoryRepo([alert({ webhookUrl: "https://hooks.example.com/x" }), alert({ id: "22222222-2222-4222-8222-222222222222" })]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    await service.evaluateSnapshots([snap(9_500, 42)]);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(webhook.deliver).toHaveBeenCalledWith("https://hooks.example.com/x", {
      type: "exeunt.capacity.alert",
      network: "kelp-replay",
      utilizationBps: 9_500,
      thresholdBps: 9_000,
      withdrawable: "5",
      supplied: "100",
      at: 42,
    });
  });

  it("keeps the event when webhook delivery fails", async () => {
    webhook.deliver.mockRejectedValue(new AppError(502, "UPSTREAM_ERROR", "down"));
    const { repo, events } = memoryRepo([alert({ webhookUrl: "https://hooks.example.com/x" })]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    await expect(service.evaluateSnapshots([snap(9_500)])).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });
});

describe("AlertService CRUD", () => {
  const webhook: WebhookSender = { deliver: vi.fn() };

  it("creates alerts with a generated id and no evaluation yet", () => {
    const { repo, alerts } = memoryRepo();
    const service = new AlertService(repo, webhook, directTransaction, silentLogger, () => 77, () => "id-1");
    const dto = service.createAlert({ network: "kelp-replay", thresholdBps: 9_500, owner: OWNER });
    expect(dto).toEqual({ id: "id-1", owner: OWNER, network: "kelp-replay", thresholdBps: 9_500, webhookUrl: null, createdAt: 77 });
    expect(alerts.get("id-1")?.lastUtilizationBps).toBeNull();
  });

  it("deletes only for the owner", () => {
    const { repo, alerts } = memoryRepo([alert()]);
    const service = new AlertService(repo, webhook, directTransaction, silentLogger);
    const id = alert().id;
    expect(() => service.deleteAlert(id, OTHER_OWNER)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => service.deleteAlert("33333333-3333-4333-8333-333333333333", OWNER)).toThrow(expect.objectContaining({ statusCode: 404 }));
    service.deleteAlert(id, OWNER);
    expect(alerts.size).toBe(0);
  });
});
