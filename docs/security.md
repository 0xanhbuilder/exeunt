# Security model

This document describes what Exeunt's contracts trust, what they guarantee, and where the known limits are. The contracts are not audited.

## Trust assumptions

| Component | Trusted for | Notes |
|---|---|---|
| Aave V3 pool and aTokens | Correct accounting of supply, debt, flash loans | Exeunt only calls `repay(onBehalfOf)`, `withdraw`, `flashLoanSimple`, `supply`. |
| Morpho Blue and Vault V2 | Correct accounting of markets, shares, flash loans | Exeunt calls `repay(onBehalf)`, `flashLoan`, `withdrawCollateral` (only with the buyer's signature), `forceDeallocate`, vault `withdraw`. |
| Price feeds | USD prices when the buyer pays in an asset other than the receipt's underlying | Chainlink on Arbitrum. Fixed $1 feeds for USDG on Arbitrum Sepolia and for USDG/USDe on Robinhood Chain, where no Chainlink feed exists. Same-asset payments never touch an oracle. |
| Deployer | Nothing after deployment | No owner, no admin function, no upgradeability, no pause. All parameters are constructor immutables. |

## Guarantees and how they are enforced

| Guarantee | Enforcement | Tested by |
|---|---|---|
| A purchase never reduces the pool's withdrawable liquidity | The market flash-borrows the underlying, repays the buyer's debt, withdraws the same amount from the seller's escrowed receipts and returns the flash in one transaction | `invariant_buysNeverChangeWithdrawableLiquidity`, fork tests, every e2e buy step (before/after withdrawable) |
| Buying and repaying are atomic | Single transaction; any failed step reverts all | e2e flash-mode and wallet-mode steps |
| Escrowed receipts back every open session | Session units are debited by the exact balance change of each operation; `redeemReceipt` reverts if escrow would be touched | `invariant_escrowedReceiptsAreBacked`, `test_redeemReceipt_onlyWhenLiquid_neverTouchesEscrow` |
| Bid escrow is fully backed | Per-token escrow totals; fills clamp payment to remaining escrow | `invariant_bidEscrowIsBacked`, pricing fuzz tests |
| A bid never fills below its minimum discount | `matchBid` requires session discount ≥ bid minimum; `sellNow` fills at the bid's own limit | `invariant_bidsNeverFillBelowTheirDiscount`, `test_bid_neverFillsBelowItsDiscount` |
| A session's discount never decreases | Discount is a monotone function of elapsed time, capped | `invariant_discountNeverDecreases` |
| Flash mode never lowers the buyer's health | Health is read before and after; the call reverts if it fell | `HealthDecreased` check; fork and e2e flash-mode steps |
| Collateral authorization does not outlive the transaction (Morpho) | The market requires a signed grant and a signed revoke, applies both, and reverts if still authorized | `test_buyWithCollateral_*`, e2e "authorization revoked" check |
| Seller can always take back unsold receipts, at once | `withdrawUnsold` has no delay and no dependency on pool liquidity | unit and e2e steps |
| Bidder can always cancel, at once | `cancelBid` refunds remaining escrow in the same call | unit and e2e steps |
| Vault capital never enters the protected pool | The Exeunt Vault only holds its asset, bid escrow in the market, and receipts it bought | `test_vaultCapitalNeverEntersProtectedPool` |
| Vault depositors can always exit | Redemption pays idle capital in the asset and held receipts in kind | `test_redeem_inKind_beforeRecovery`, fuzz `testFuzz_depositRedeem_noValueCreated` |

## Threats considered

**Spoofed flash-loan callbacks.** `executeOperation` accepts calls only from the Aave pool, with `initiator == address(this)`, the expected asset, and an active operation flag in transient storage. `onMorphoFlashLoan` accepts calls only from the configured Morpho singleton while that flag is set.

**Reentrancy.** All state-changing entry points use OpenZeppelin's transient-storage reentrancy guard. Callbacks are not entry points; they are gated by the operation flag.

**Repaying into a market the vault cannot reach (Morpho).** A buyer could name any USDG market in `venueData`. The venue rejects markets where the Earn vault's adapter has no allocation, so repaid liquidity is always liquidity the vault can withdraw.

**Price manipulation.** Cross-asset quotes use Chainlink-style feeds with a staleness bound (`maxAge`) and reject non-positive answers. There is no spot-price or AMM dependency. Buyers pass `maxPay`, so a price move between quote and execution cannot overcharge them.

**Rounding.** Quotes round up (in favour of the seller) and bid capacity rounds down (in favour of the bidder's escrow). aToken transfers of escrowed units are rounded down so the market never sends more scaled units than a session owns; a few wei of dust can remain in the market.

**Griefing and denial of service.** Matching is permissionless: anyone can call `matchBid`, but it only executes trades both sides already agreed to. On-chain loops over all bids exist only in view functions (`bidCapacityAt`); state-changing functions take explicit bid ids. Opening dust sessions or dust bids does not block anyone else.

**Health-factor checks on aToken transfers (Aave).** Moving aToken collateral is checked by Aave itself. The frozen-collateral route repays debt first (with an Aave flash loan of the debt asset) before pulling collateral, so a borrower close to liquidation can still deleverage.

## Known limitations

- **Fixed-price feeds on testnets and Robinhood Chain.** USDG and USDe are priced at $1 where no on-chain feed exists. A depeg would not be reflected in cross-asset quotes on those deployments.
- **Flash liquidity is required.** If the pool is at exactly 100% and no external flash source holds the underlying, buy-and-repay reverts (`NoFlashLiquidity`). Bids and the Exeunt Vault still work. The Aave venue processes at most 64 repay/withdraw rounds per purchase, so very small flash liquidity limits purchase size (`FlashLiquidityTooLow`).
- **Receipts carry pool risk.** Buyers, bidders and Exeunt Vault depositors hold receipts until the pool is liquid again; if the pool takes bad debt, receipts are worth less than face value. The Exeunt Vault values receipts at face value.
- **Gas estimates.** Aave can take a costlier code path at execution than at estimation (for example when a collateral flag flips). Clients should add a gas buffer; the SDK-based tools add 30%.
- **No fees.** The market and the vault charge nothing; there is no protocol revenue logic to attack, and none to fund operations.
- **Unaudited.** Built during a hackathon. Do not use with real funds.
