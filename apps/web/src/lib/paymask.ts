import { isAddressEqual, zeroAddress, type Address } from "viem";
import type { Deployment } from "@exeunt/sdk";

/** Session payMask: bit i set means payment token i is accepted. Fits a uint8 (at most 8 tokens). */
export function buildPayMask(indices: readonly number[]): number {
  let mask = 0;
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i > 7) throw new Error(`pay token index out of range: ${i}`);
    mask |= 1 << i;
  }
  return mask;
}

export function maskIncludes(mask: number, index: number): boolean {
  return ((mask >> index) & 1) === 1;
}

export function maskIndices(mask: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (maskIncludes(mask, i)) out.push(i);
  return out;
}

export function allPayMask(count: number): number {
  return buildPayMask(Array.from({ length: count }, (_, i) => i));
}

/**
 * Aave: payment tokens a borrower can pay with from freed collateral. The market needs the token's aToken
 * (`payATokens[i]`) and refuses to pay in the receipt's own underlying.
 */
export function aaveFlashPayIndices(d: Pick<Deployment, "payTokens" | "payATokens" | "underlying">): number[] {
  const out: number[] = [];
  d.payTokens.forEach((token, i) => {
    const aToken = d.payATokens?.[i];
    if (aToken && !isAddressEqual(aToken, zeroAddress) && !isAddressEqual(token, d.underlying)) out.push(i);
  });
  return out;
}

/** Morpho: the buyer pays with the collateral token of the market they borrow in, if the market accepts it. */
export function morphoFlashPayIndex(payTokens: readonly Address[], collateralToken: Address | undefined): number | null {
  if (!collateralToken) return null;
  const i = payTokens.findIndex((t) => isAddressEqual(t, collateralToken));
  return i >= 0 ? i : null;
}
