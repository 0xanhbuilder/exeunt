import type { NetworkKey } from "@exeunt/sdk";

/** Discount levels reported for escrowed bid capacity: 1, 3, 5, 10 and 20%. */
export const BID_CAPACITY_LEVELS_BPS = [100, 300, 500, 1_000, 2_000] as const;

/** History is kept and served for at most this many hours. */
export const MAX_HISTORY_HOURS = 168;

/** Live capacity as served over HTTP; amounts are decimal strings in the underlying's base units. */
export interface CapacityDto {
  network: NetworkKey;
  at: number;
  underlying: { address: string; symbol: string; decimals: number };
  withdrawable: string;
  supplied: string;
  utilizationBps: number;
  debtorCapacity: string;
  sessionAssets: string;
  bidCapacity: { discountBps: number; assets: string }[];
}

export interface CapacityPoint {
  t: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
}

/** One poll result, handed to snapshot listeners such as alerts. */
export interface CapacitySnapshot {
  network: NetworkKey;
  at: number;
  utilizationBps: number;
  withdrawable: bigint;
  supplied: bigint;
}

export type SnapshotListener = (snapshots: CapacitySnapshot[]) => Promise<void>;
