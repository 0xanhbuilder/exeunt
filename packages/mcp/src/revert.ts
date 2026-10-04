import { decodeErrorResult, type Abi, type Hex } from "viem";
import { formatAbiItem } from "viem/utils";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  exeuntVaultAbi,
  morphoVaultExitMarketAbi,
} from "@exeunt/sdk";

function errorItems(): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  const all: Abi = [...aaveExitMarketAbi, ...morphoVaultExitMarketAbi, ...exeuntVaultAbi, ...aaveCollateralRouteAbi];
  for (const err of all) {
    if (err.type !== "error") continue;
    const sig = formatAbiItem(err);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(err);
  }
  return out;
}

/** Custom errors of every Exeunt contract; Error(string) and Panic(uint256) are decoded by viem itself. */
export const EXEUNT_ERRORS_ABI: Abi = errorItems();

export interface DecodedRevert {
  name: string;
  signature: string;
  args: string[];
}

function stringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** Decodes revert data with Exeunt's error ABI; returns null for unknown selectors. */
export function decodeRevert(data: Hex | undefined): DecodedRevert | null {
  if (!data || data.length < 10) return null;
  try {
    const res = decodeErrorResult({ abi: EXEUNT_ERRORS_ABI, data });
    const args = (res.args ?? []) as readonly unknown[];
    return {
      name: res.errorName,
      signature: res.abiItem ? formatAbiItem(res.abiItem, { includeName: true }) : res.errorName,
      args: args.map(stringify),
    };
  } catch {
    return null;
  }
}
