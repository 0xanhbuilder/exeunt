import { NETWORKS, type NetworkKey } from "@exeunt/sdk";
import { z } from "zod";

export const NETWORK_KEYS = Object.keys(NETWORKS) as [NetworkKey, ...NetworkKey[]];

export const networkKeySchema = z.enum(NETWORK_KEYS);

/** Narrows a stored network string back to a NetworkKey. */
export function toNetworkKey(value: string): NetworkKey {
  return networkKeySchema.parse(value);
}

/** 0x address, normalized to lowercase so it can be used as a lookup key. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((a) => a.toLowerCase() as `0x${string}`);
