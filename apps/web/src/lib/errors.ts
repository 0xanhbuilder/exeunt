import { decodeErrorResult, type Abi, type Hex } from "viem";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  exeuntVaultAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  testTokenAbi,
} from "@exeunt/sdk";

/** Every custom error the Exeunt contracts can raise; viem adds Error(string) and Panic(uint256) itself. */
const ERROR_ABI = [
  ...aaveExitMarketAbi,
  ...morphoVaultExitMarketAbi,
  ...exeuntVaultAbi,
  ...aaveCollateralRouteAbi,
  ...priceRouterAbi,
  ...testTokenAbi,
].filter((item) => item.type === "error") as Abi;

const MESSAGES: Record<string, string> = {
  ZeroAmount: "The amount is zero.",
  BadParams: "Some parameters are out of range.",
  NotSeller: "Only the seller of this auction can do that.",
  NotBidder: "Only the bidder can cancel this bid.",
  SessionClosed: "This auction has ended or sold out.",
  PayTokenNotAccepted: "The seller does not accept this payment asset.",
  PriceTooHigh: "The price is above your limit. Refresh and try again.",
  DebtTooSmall: "Your same-asset debt is smaller than the amount you are buying.",
  NotEnoughUnits: "The auction has less left than that amount.",
  DiscountBelowBid: "The auction's discount has not reached this bid's minimum yet.",
  UnknownBid: "That bid no longer exists.",
  InsufficientFill: "The bids changed since the preview, so less would sell than shown. Refresh and try again.",
  HealthDecreased: "Your health factor would go down, so the market refused.",
  SamePaymentAsset: "Flash mode cannot pay in the receipt's own asset.",
  EscrowTouched: "That would touch receipts escrowed in auctions.",
  NoFlashLiquidity: "No flash liquidity is available to repay on your behalf right now.",
  FlashLiquidityTooLow: "Flash liquidity is too low for this size. Try a smaller amount.",
  UnexpectedCallback: "Unexpected flash-loan callback.",
  NoCollateralToken: "This payment asset cannot be paid from Aave collateral.",
  WrongMarket: "Your debt or collateral is not in a market this vault supplies.",
  BadAuthorization: "The Morpho permission signatures are missing or invalid.",
  AuthorizationNotRevoked: "The Morpho permission was not revoked.",
  ProceedsTooLow: "The sale would not raise enough. Sell more collateral or ask for less.",
  ZeroShares: "That amount is too small to mint or redeem a vault share.",
  FeedMissing: "There is no price feed for this asset.",
  BadPrice: "The price feed returned an invalid price.",
  StalePrice: "The price feed is stale, so pricing is paused.",
  ERC20InsufficientBalance: "Your token balance is too low.",
  ERC20InsufficientAllowance: "The token allowance is too low.",
  SafeERC20FailedOperation: "A token transfer failed.",
  ReentrancyGuardReentrantCall: "Reentrant call blocked.",
  MintLimit: "The test token mint limit is reached.",
};

const PANICS: Record<string, string> = {
  "1": "assertion failed",
  "17": "arithmetic overflow or underflow",
  "18": "division by zero",
  "50": "array index out of bounds",
};

interface ErrorLike {
  cause?: unknown;
  data?: unknown;
  code?: unknown;
  name?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  message?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === "object" && value !== null ? (value as ErrorLike) : null;
}

function isRevertData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value);
}

/** Finds revert data anywhere in an error's cause chain (viem nests it a few levels deep). */
export function extractRevertData(err: unknown): Hex | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    const e = asErrorLike(current);
    if (!e) return undefined;
    if (isRevertData(e.data)) return e.data;
    const nested = asErrorLike(e.data);
    if (nested && isRevertData(nested.data)) return nested.data;
    current = e.cause;
  }
  return undefined;
}

function isUserRejection(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    const e = asErrorLike(current);
    if (!e) return false;
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
    current = e.cause;
  }
  return false;
}

/** Decodes revert data into a readable sentence, or null when it matches nothing known. */
export function describeRevertData(data: Hex): string | null {
  try {
    const decoded = decodeErrorResult({ abi: ERROR_ABI, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    if (decoded.errorName === "Error") {
      const reason = String(args[0] ?? "");
      return /^\d+$/.test(reason) ? `Aave rejected the call (Aave error code ${reason}).` : reason;
    }
    if (decoded.errorName === "Panic") {
      const code = String(args[0] ?? "");
      return `The contract panicked: ${PANICS[code] ?? `code ${code}`}.`;
    }
    return MESSAGES[decoded.errorName] ?? `The contract reverted with ${decoded.errorName}.`;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    const e = asErrorLike(current);
    if (!e) break;
    for (const v of [e.details, e.shortMessage, e.message]) if (typeof v === "string") parts.push(v);
    current = e.cause;
  }
  return parts.join(" ");
}

/** A local fork whose upstream RPC pruned the fork-block state cannot read accounts it has not touched yet. */
export function isForkStateError(err: unknown): boolean {
  return /historical state .* is not available|failed to get (storage|account|block) for/i.test(errorText(err));
}

/** Turns any wallet, RPC or contract error into one readable line. */
export function describeError(err: unknown): string {
  if (isUserRejection(err)) return "You rejected the request in your wallet.";
  if (isForkStateError(err)) {
    return "This fork cannot load state it has not touched yet, because its upstream RPC no longer serves the fork block or is offline. Demo funds from the faucet make your address readable; otherwise restart the fork from an archive RPC.";
  }
  const data = extractRevertData(err);
  if (data) {
    const text = describeRevertData(data);
    if (text) return text;
  }
  const e = asErrorLike(err);
  if (!e) return String(err);
  const short = typeof e.shortMessage === "string" ? e.shortMessage : null;
  const details = typeof e.details === "string" ? e.details : null;
  if (short) return details && !short.includes(details) ? `${short} ${details}` : short;
  const message = typeof e.message === "string" ? e.message : String(err);
  return message.split("\n")[0] ?? message;
}
