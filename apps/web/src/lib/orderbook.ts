import { isAddressEqual, type Address } from "viem";
import type { BidView } from "@exeunt/sdk";

export interface BidLevel {
  discountBps: number;
  /** Receipt value bids at this discount can buy. */
  size: bigint;
  /** Receipt value all bids at or below this discount can buy (what a seller accepting it could sell). */
  cumulative: bigint;
}

/** Groups escrowed bids by limit discount, best price for sellers first. */
export function bidLevels(bids: readonly Pick<BidView, "minDiscountBps" | "capacityAssets">[]): BidLevel[] {
  const sizes = new Map<number, bigint>();
  for (const b of bids) {
    if (b.capacityAssets === 0n) continue;
    sizes.set(b.minDiscountBps, (sizes.get(b.minDiscountBps) ?? 0n) + b.capacityAssets);
  }
  let running = 0n;
  return [...sizes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([discountBps, size]) => {
      running += size;
      return { discountBps, size, cumulative: running };
    });
}

export type BidOwner = "vault" | "mine" | "other";

export function bidOwner(bidder: Address, vault: Address, me: Address | null): BidOwner {
  if (isAddressEqual(bidder, vault)) return "vault";
  if (me && isAddressEqual(bidder, me)) return "mine";
  return "other";
}

export const BID_OWNER_LABEL: Record<BidOwner, string> = {
  vault: "Exeunt Vault",
  mine: "Your bid",
  other: "Limit bid",
};
