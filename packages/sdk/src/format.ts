import { formatUnits } from "viem";

/** 250 -> "2.50%". */
export function formatBps(bps: number | bigint, digits = 2): string {
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

/** Human amount with at most `maxDecimals` decimals and thousands separators. */
export function formatUnitsShort(value: bigint, decimals: number, maxDecimals = 4): string {
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}
