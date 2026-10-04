import { z } from "zod";
import { NETWORK_KEYS } from "./config.js";
import { DECIMAL_RE } from "./amounts.js";

/** Contract limit on any discount (ExitMarket.MAX_DISCOUNT_BPS). */
export const MAX_DISCOUNT_BPS = 5_000;
/** Contract limit on a session's length (ExitMarket.MAX_SESSION_DURATION). */
export const MAX_SESSION_SECONDS = 30 * 24 * 3600;

export const networkSchema = z
  .enum(NETWORK_KEYS)
  .describe(
    "Exeunt network: arbitrum-sepolia and kelp-replay are Aave V3 (aWETH receipts); robinhood-testnet and earn-bank-run are Morpho (USDG Earn vault shares). kelp-replay and earn-bank-run are scenario forks.",
  );

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

export const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex bytes");

export const amountSchema = z.string().regex(DECIMAL_RE, 'must be a decimal string such as "1.5"');

export const idSchema = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]);

export const discountBpsSchema = z.number().int().min(0).max(MAX_DISCOUNT_BPS);

export const payTokenSchema = z
  .string()
  .min(1)
  .describe("Payment token symbol (for example USDG, USDC, wstETH) or its address; must be one of the market's pay tokens.");

export const payTokensSchema = z
  .array(payTokenSchema)
  .min(1)
  .optional()
  .describe("Payment tokens accepted, by symbol or address. Defaults to every payment token of the market.");
