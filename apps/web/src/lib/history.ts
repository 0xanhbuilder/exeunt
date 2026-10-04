import type { Address, Hex, PublicClient } from "viem";
import { aaveExitMarketAbi, type ExeuntClient } from "@exeunt/sdk";

/*
 * Event history straight from the market contract. The deployment file's deployBlock is an L1 block
 * number on Arbitrum chains, so the market's first L2 block is found by searching for its code instead.
 */

const deployBlocks = new Map<string, Promise<bigint>>();

async function hasCode(pc: PublicClient, address: Address, blockNumber: bigint): Promise<boolean> {
  try {
    const code = await pc.getCode({ address, blockNumber });
    return !!code && code !== "0x";
  } catch {
    // Forks and pruned nodes cannot serve old state; the contract did not exist there anyway.
    return false;
  }
}

async function searchDeployBlock(pc: PublicClient, address: Address): Promise<bigint> {
  let hi = await pc.getBlockNumber();
  let lo = 0n;
  const probes = 7n;
  while (hi - lo > 1n) {
    const step = (hi - lo) / (probes + 1n) || 1n;
    const points: bigint[] = [];
    for (let i = 1n; i <= probes; i++) {
      const p = lo + step * i;
      if (p < hi) points.push(p);
    }
    if (points.length === 0) break;
    const found = await Promise.all(points.map((p) => hasCode(pc, address, p)));
    const first = found.indexOf(true);
    if (first === -1) {
      lo = points[points.length - 1] ?? lo;
    } else {
      hi = points[first] ?? hi;
      lo = first > 0 ? (points[first - 1] ?? lo) : lo;
    }
  }
  return (await hasCode(pc, address, lo)) ? lo : hi;
}

export function findDeployBlock(pc: PublicClient, address: Address): Promise<bigint> {
  const key = `${pc.uid}:${address}`;
  let pending = deployBlocks.get(key);
  if (!pending) {
    pending = searchDeployBlock(pc, address);
    deployBlocks.set(key, pending);
    pending.catch(() => deployBlocks.delete(key));
  }
  return pending;
}

export interface SellerFill {
  /** 0 for a sell-now fill outside any auction. */
  sessionId: bigint;
  assets: bigint;
  paid: bigint;
  payToken: Address | null;
  discountBps: number;
  txHash: Hex | null;
  via: "borrower" | "bid";
}

export interface SellerHistory {
  /** Receipt value escrowed when each of the seller's auctions opened. */
  opened: Map<bigint, bigint>;
  fills: SellerFill[];
}

export async function loadSellerHistory(exeunt: ExeuntClient, seller: Address): Promise<SellerHistory> {
  const pc = exeunt.client;
  const address = exeunt.market;
  const abi = aaveExitMarketAbi;
  const fromBlock = await findDeployBlock(pc, address);
  const [opened, bidFills] = await Promise.all([
    pc.getContractEvents({ address, abi, eventName: "SessionOpened", args: { seller }, fromBlock, strict: true }),
    pc.getContractEvents({ address, abi, eventName: "BidFilled", args: { seller }, fromBlock, strict: true }),
  ]);
  const sessionIds = opened.map((l) => l.args.sessionId);
  const bidIds = [...new Set(bidFills.map((l) => l.args.bidId))];
  const [bought, placed] = await Promise.all([
    sessionIds.length > 0
      ? pc.getContractEvents({ address, abi, eventName: "Bought", args: { sessionId: sessionIds }, fromBlock, strict: true })
      : Promise.resolve([]),
    bidIds.length > 0
      ? pc.getContractEvents({ address, abi, eventName: "BidPlaced", args: { bidId: bidIds }, fromBlock, strict: true })
      : Promise.resolve([]),
  ]);
  const payOfBid = new Map<bigint, Address>(placed.map((l) => [l.args.bidId, l.args.payToken]));
  const fills: SellerFill[] = [
    ...bought.map((l) => ({
      sessionId: l.args.sessionId,
      assets: l.args.assets,
      paid: l.args.paid,
      payToken: l.args.payToken,
      discountBps: l.args.discountBps,
      txHash: l.transactionHash ?? null,
      via: "borrower" as const,
    })),
    ...bidFills.map((l) => ({
      sessionId: l.args.sessionId,
      assets: l.args.assets,
      paid: l.args.paid,
      payToken: payOfBid.get(l.args.bidId) ?? null,
      discountBps: l.args.discountBps,
      txHash: l.transactionHash ?? null,
      via: "bid" as const,
    })),
  ];
  return { opened: new Map(opened.map((l) => [l.args.sessionId, l.args.assets])), fills };
}

/** Original size (maxAssets) of each bid the account placed, to show how much of it has filled. */
export async function loadBidOrigins(exeunt: ExeuntClient, bidder: Address): Promise<Map<bigint, bigint>> {
  const pc = exeunt.client;
  const fromBlock = await findDeployBlock(pc, exeunt.market);
  const placed = await pc.getContractEvents({
    address: exeunt.market,
    abi: aaveExitMarketAbi,
    eventName: "BidPlaced",
    args: { bidder },
    fromBlock,
    strict: true,
  });
  return new Map(placed.map((l) => [l.args.bidId, l.args.maxAssets]));
}

export interface FillSummary {
  assets: bigint;
  received: { token: Address; amount: bigint }[];
  avgDiscountBps: number | null;
}

/** Totals for a group of fills: receipt value sold, proceeds per payment token, value-weighted discount. */
export function summarizeFills(fills: readonly SellerFill[]): FillSummary {
  let assets = 0n;
  let weighted = 0n;
  const received = new Map<Address, bigint>();
  for (const f of fills) {
    assets += f.assets;
    weighted += f.assets * BigInt(f.discountBps);
    if (f.payToken) received.set(f.payToken, (received.get(f.payToken) ?? 0n) + f.paid);
  }
  return {
    assets,
    received: [...received.entries()].map(([token, amount]) => ({ token, amount })),
    avgDiscountBps: assets === 0n ? null : Number(weighted / assets),
  };
}
