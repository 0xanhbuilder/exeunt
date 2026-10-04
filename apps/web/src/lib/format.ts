import { formatUnits, maxUint256, parseUnits } from "viem";
import { formatBps, formatUnitsShort } from "@exeunt/sdk";

export { formatBps };

/** Display decimals by token precision: 4 for 18-decimal tokens, 2 for 6-decimal stablecoins. */
export function displayDecimals(decimals: number): number {
  return decimals >= 9 ? 4 : 2;
}

/** Human amount with thousands separators; tiny non-zero values show as "< 0.0001". */
export function formatAmount(value: bigint, decimals: number, maxDecimals = displayDecimals(decimals)): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = formatUnitsShort(abs, decimals, maxDecimals);
  const out = text === "0" ? `< ${(10 ** -maxDecimals).toFixed(maxDecimals)}` : text;
  return negative ? `-${out}` : out;
}

export function formatToken(value: bigint, token: { decimals: number; symbol: string }, maxDecimals?: number): string {
  return `${formatAmount(value, token.decimals, maxDecimals)} ${token.symbol}`;
}

/** Exact decimal string for an input field (no separators). */
export function toInputString(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

export interface ParsedInput {
  value: bigint | null;
  error: string | null;
}

/** Parses a user-typed token amount. Empty input is neither a value nor an error. */
export function parseAmountInput(input: string, decimals: number): ParsedInput {
  const s = input.trim().replace(/[,_\s]/g, "");
  if (s === "") return { value: null, error: null };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { value: null, error: "Enter a number, like 1.5" };
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) return { value: null, error: `At most ${decimals} decimals` };
  return { value: parseUnits(s, decimals), error: null };
}

/** "2.5" -> 250 basis points. Returns null for invalid input or more than two decimals. */
export function parsePercentToBps(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** 250 -> "2.50" for prefilling percent inputs. */
export function bpsToPercentInput(bps: number): string {
  return (bps / 100).toFixed(2);
}

/** Aave health factor or Morpho max-borrow/debt, both 1e18-scaled; "No debt" when unbounded. */
export function formatHealth(health: bigint): string {
  if (health >= maxUint256 / 2n) return "No debt";
  if (health > 1_000n * 10n ** 18n) return "> 1,000";
  return (Number(health / 10n ** 14n) / 10_000).toFixed(2);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} m`;
  if (m > 0) return `${m} m`;
  return `${s} s`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export type PoolTone = "open" | "tight" | "frozen";

/** Status bands assumed by the mockup (BRD TODO): frozen from 99%, tight from 90%. */
export function utilizationTone(utilizationBps: number): PoolTone {
  if (utilizationBps >= 9_900) return "frozen";
  if (utilizationBps >= 9_000) return "tight";
  return "open";
}

export const TONE_LABEL: Record<PoolTone, string> = { open: "Open", tight: "Tight", frozen: "Frozen" };

/** Share of `part` in `whole` as a percentage string with two decimals. */
export function formatShare(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0.00%";
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(2)}%`;
}
