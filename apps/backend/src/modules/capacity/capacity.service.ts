import type { NetworkKey } from "@exeunt/sdk";
import type { Transactional } from "../../shared/db/database.js";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";
import type { CapacityRepository } from "./capacity.repository.js";
import {
  BID_CAPACITY_LEVELS_BPS,
  MAX_HISTORY_HOURS,
  type CapacityDto,
  type CapacityPoint,
  type CapacitySnapshot,
} from "./capacity.types.js";

export type CapacityChainPort = Pick<ChainGateway, "readCapacity" | "deployedNetworks">;

const HOUR_MS = 3_600_000;

/** Shapes stored snapshots into chart points, oldest first. */
export function toHistoryPoints(rows: CapacitySnapshotRow[]): CapacityPoint[] {
  return [...rows]
    .sort((a, b) => a.at - b.at)
    .map((r) => ({ t: r.at, utilizationBps: r.utilizationBps, withdrawable: r.withdrawable, supplied: r.supplied }));
}

export class CapacityService {
  constructor(
    private readonly repo: Pick<CapacityRepository, "insertMany" | "listSince" | "deleteOlderThan">,
    private readonly chain: CapacityChainPort,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Live exit capacity computed from on-chain data. */
  async getCapacity(network: NetworkKey): Promise<CapacityDto> {
    const r = await this.chain.readCapacity(network, BID_CAPACITY_LEVELS_BPS);
    return {
      network,
      at: this.now(),
      underlying: { address: r.underlying.address, symbol: r.underlying.symbol, decimals: r.underlying.decimals },
      withdrawable: r.withdrawable.toString(),
      supplied: r.supplied.toString(),
      utilizationBps: r.utilizationBps,
      debtorCapacity: r.debtorCapacity.toString(),
      sessionAssets: r.sessionAssets.toString(),
      bidCapacity: r.bidCapacity.map((b) => ({ discountBps: b.discountBps, assets: b.assets.toString() })),
    };
  }

  getHistory(network: NetworkKey, hours: number): { points: CapacityPoint[] } {
    return { points: toHistoryPoints(this.repo.listSince(network, this.now() - hours * HOUR_MS)) };
  }

  /**
   * Reads capacity of every deployed network, stores the snapshots and prunes history older than the
   * retention window. A network whose RPC fails is skipped for this round.
   */
  async snapshotAll(): Promise<CapacitySnapshot[]> {
    const networks = this.chain.deployedNetworks();
    const results = await Promise.allSettled(networks.map((n) => this.chain.readCapacity(n, [])));
    const at = this.now();
    const snapshots: CapacitySnapshot[] = [];
    const rows: CapacitySnapshotRow[] = [];
    results.forEach((res, i) => {
      const network = networks[i];
      if (!network) return;
      if (res.status === "rejected") {
        this.logger.warn({ network, err: res.reason }, "capacity snapshot skipped");
        return;
      }
      const r = res.value;
      snapshots.push({ network, at, utilizationBps: r.utilizationBps, withdrawable: r.withdrawable, supplied: r.supplied });
      rows.push({
        network,
        at,
        utilizationBps: r.utilizationBps,
        withdrawable: r.withdrawable.toString(),
        supplied: r.supplied.toString(),
        debtorCapacity: r.debtorCapacity.toString(),
        sessionAssets: r.sessionAssets.toString(),
      });
    });
    this.inTransaction((tx) => {
      this.repo.insertMany(rows, tx);
      this.repo.deleteOlderThan(at - MAX_HISTORY_HOURS * HOUR_MS, tx);
    });
    return snapshots;
  }
}
