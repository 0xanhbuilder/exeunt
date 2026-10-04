const BPS = 10_000n;
const WAD = 10n ** 18n;

export interface AaveRepayEstimate {
  ok: boolean;
  reason: string | null;
  /** Debt actually repaid: the purchase minus the Aave flash premium when Aave is the flash source. */
  debtRepaid: bigint;
  flashFee: bigint;
  usesExternalFlash: boolean;
}

/**
 * Mirrors AaveExitMarket._repayFor: the free external flash source wins when it can lend at least as much as
 * the Aave pool; otherwise Aave flashLoanSimple charges its premium, which comes off the debt repaid.
 */
export function estimateAaveRepay(p: {
  assets: bigint;
  aaveChunk: bigint;
  externalChunk: bigint;
  premiumBps: bigint;
  maxLoops: bigint;
}): AaveRepayEstimate {
  const a = p.aaveChunk > p.assets ? p.assets : p.aaveChunk;
  const e = p.externalChunk > p.assets ? p.assets : p.externalChunk;
  const usesExternalFlash = e > 0n && e >= a;
  const chunk = usesExternalFlash ? e : a;
  const fail = (reason: string): AaveRepayEstimate => ({
    ok: false,
    reason,
    debtRepaid: 0n,
    flashFee: 0n,
    usesExternalFlash,
  });
  if (p.assets === 0n) return fail("Enter an amount");
  if (chunk === 0n) return fail("No flash liquidity is available to repay on your behalf right now");
  if ((p.assets + chunk - 1n) / chunk > p.maxLoops) {
    return fail("The pool has too little flash liquidity for this size; try a smaller amount");
  }
  // Aave percentMul rounds half up.
  const flashFee = usesExternalFlash ? 0n : (chunk * p.premiumBps + BPS / 2n) / BPS;
  if (flashFee >= p.assets) return fail("The flash fee would exceed the purchase");
  return { ok: true, reason: null, debtRepaid: p.assets - flashFee, flashFee, usesExternalFlash };
}

/** Value of `amount` (token units) in a USD base with 8 decimals, using an 8-decimal price. */
export function valueInBase(amount: bigint, decimals: number, price8: bigint): bigint {
  return (amount * price8) / 10n ** BigInt(decimals);
}

/**
 * Aave health factor after removing/adding collateral and repaying debt, all in the base currency.
 * Uses the account's average liquidation threshold, so it is an estimate.
 */
export function estimateAaveHealthAfter(p: {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  collateralRemovedBase: bigint;
  collateralAddedBase?: bigint;
  debtRepaidBase: bigint;
}): bigint | null {
  const debt = p.totalDebtBase - p.debtRepaidBase;
  const collateral = p.totalCollateralBase - p.collateralRemovedBase + (p.collateralAddedBase ?? 0n);
  if (collateral < 0n) return null;
  if (debt <= 0n) return 2n ** 256n - 1n;
  return (collateral * p.liquidationThresholdBps * WAD) / BPS / debt;
}

/** Morpho health (max borrow over debt, WAD) after removing collateral units and repaying debt. */
export function estimateMorphoHealthAfter(p: {
  health: bigint;
  debt: bigint;
  collateral: bigint;
  collateralRemoved: bigint;
  debtRepaid: bigint;
}): bigint | null {
  if (p.collateral === 0n || p.debt === 0n) return null;
  if (p.collateralRemoved > p.collateral) return null;
  const debtAfter = p.debt - p.debtRepaid;
  if (debtAfter <= 0n) return 2n ** 256n - 1n;
  const maxBorrow = (p.health * p.debt) / WAD;
  const maxBorrowAfter = (maxBorrow * (p.collateral - p.collateralRemoved)) / p.collateral;
  return (maxBorrowAfter * WAD) / debtAfter;
}

/** Face value minus the discount, in underlying units. */
export function discountedValue(assets: bigint, discountBps: number): bigint {
  return (assets * (BPS - BigInt(discountBps))) / BPS;
}
