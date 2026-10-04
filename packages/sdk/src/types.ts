import type { Address, Hex } from "viem";

export interface SessionParams {
  /** Discount at the start, in basis points. */
  startBps: number;
  /** Discount added every `stepInterval` seconds. */
  stepBps: number;
  stepInterval: number;
  /** Maximum discount the session ever reaches. */
  capBps: number;
  /** Session length in seconds. */
  duration: number;
  /** Bit i set = payment token i accepted. */
  payMask: number;
}

export interface SessionView {
  id: bigint;
  seller: Address;
  startedAt: number;
  endsAt: number;
  startBps: number;
  stepBps: number;
  capBps: number;
  stepInterval: number;
  payMask: number;
  units: bigint;
  discountBps: number;
  remainingAssets: bigint;
  open: boolean;
  acceptedPayTokens: Address[];
}

export interface BidView {
  id: bigint;
  bidder: Address;
  minDiscountBps: number;
  payIdx: number;
  payToken: Address;
  maxAssets: bigint;
  escrow: bigint;
  /** Receipt value this bid can still buy at its own limit discount. */
  capacityAssets: bigint;
}

export interface CapacityView {
  withdrawable: bigint;
  supplied: bigint;
  utilizationBps: number;
  debtorCapacity: bigint;
  sessionAssets: bigint;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** A transaction ready to be signed by the user's wallet. Exeunt tooling never signs on its own. */
export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
}

export interface SellPlan {
  bidIds: bigint[];
  fills: { bidId: bigint; assets: bigint; pay: bigint; payToken: Address; discountBps: number }[];
  filledAssets: bigint;
  /** Proceeds per payment token. */
  proceeds: Record<Address, bigint>;
  averageDiscountBps: number;
}

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface BorrowerPosition {
  debt: bigint;
  /** Aave health factor (1e18) or Morpho max-borrow over debt (1e18); max uint when no debt. */
  health: bigint;
  /** Morpho only: the market the borrower owes in. */
  market?: MorphoMarketParams;
  marketId?: Hex;
  collateral?: bigint;
}
