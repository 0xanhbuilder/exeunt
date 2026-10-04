/** Row of `capacity_snapshots` (see shared/db/migrations.ts). Big amounts are stored as decimal text. */
export interface CapacitySnapshotRow {
  network: string;
  at: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
  debtorCapacity: string;
  sessionAssets: string;
}
