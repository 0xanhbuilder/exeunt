import type { NetworkKey } from "@exeunt/sdk";
import type { Address } from "viem";
import type { KIT_TYPES } from "./faucet.schema.js";

export type KitType = (typeof KIT_TYPES)[number];

/** Gives a fork wallet a demo position; returns human-readable descriptions of what it did. */
export interface KitRunner {
  runKit(network: NetworkKey, kit: KitType, address: Address): Promise<string[]>;
}

export interface FaucetResult {
  ok: true;
  actions: string[];
}

/** One kit of each type per address and network within this window. */
export const FAUCET_WINDOW_MS = 10 * 60_000;
/** A per-network lock left by a crashed run expires after this long (well above a slow fork's kit time, ~1 min). */
export const FAUCET_LOCK_TTL_MS = 10 * 60_000;
/** How long a request waits for another kit on the same fork to finish. */
export const FAUCET_LOCK_WAIT_MS = 60_000;
