# Test report

Generated on 4 October 2026 from the commands below. Every number here comes from a recorded run.

## Summary

| Layer | What runs | Result |
|---|---|---|
| Contracts | `forge test`: unit, fuzz (256 runs), invariant (64 runs × depth 64), Arbitrum Sepolia fork | 104 / 104 passed |
| Contract coverage | `forge coverage --ir-minimum` over `src/` | 98.2% lines, 95.2% statements, 72.5% branches, 98.9% functions |
| SDK | `npm run test -w @exeunt/sdk` | 5 / 5 passed |
| MCP server | `npm run test -w @exeunt/mcp` | 49 / 49 passed |
| Backend | `npm run test -w @exeunt/backend` | 43 / 43 passed |
| Web app | `npm run test -w @exeunt/web`, plus typecheck and production build | 63 / 63 passed, build ok |
| End-to-end, forks | `npm run e2e -w @exeunt/e2e -- --network=all` | 72 / 72 steps passed on 4 networks |
| End-to-end, live | `npm run e2e -w @exeunt/e2e -- --network=arbitrum-sepolia --live` | 15 / 15 steps passed with real testnet transactions |
| End-to-end, live rehearsal | `--network=robinhood-testnet --rehearse` (real accounts and balances on a fork) | 13 / 13 steps passed; live run waits for testnet gas |

## Contract tests

| Suite | Tests | Focus |
|---|---|---|
| `MorphoExitMarket.t.sol` | 33 | Sessions, buy-and-repay (wallet, flash mode, forced deallocation, flash loops), bids, matching, recovery |
| `Guards.t.sol` | 14 | Every revert path: parameters, permissions, spoofed flash callbacks, vault guards |
| `AaveExitMarket.fork.t.sol` | 11 | Live Aave V3: partial and zero liquidity, external flash, USDC collateral payment, bids, recovery |
| `ExeuntVaultMorpho.t.sol` | 9 | Rule-based bids, cap, in-kind redemption, permissionless recovery, deposit/redeem fuzz |
| `Pricing.t.sol` | 7 | Cross-asset quotes; fuzz: quotes never undercharge, bid capacity never overspends escrow |
| `MarketInvariants.t.sol` | 6 + 6 | Escrow backing, bid escrow backing, unchanged withdrawable liquidity on buys, bid limits, rising discounts, no stray funds |
| `Feeds.t.sol`, `PriceRouter.t.sol` | 6 + 5 | Chained and fixed feeds, staleness and bad-price checks |
| `RouteAndVault.fork.t.sol` | 5 | Frozen-collateral route (repay and swap), WETH vault buying and recovery |
| `Impact.fork.t.sol` | 2 | A purchase moves only the traded amount; bystanders, other sessions and bids are untouched; a sale into a bid leaves the pool's supply, debt and liquidity alone |

Invariant handler call counts in the last run were 478 to 535 per action (buy, sell-now, match, place/cancel bid, open session, withdraw unsold, time travel) with no reverts.

### Coverage by contract

| Contract | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| ExitMarket | 100% | 96.5% | 78.0% | 100% |
| AaveExitMarket | 97.9% | 93.3% | 63.2% | 94.7% |
| MorphoVaultExitMarket | 98.9% | 97.0% | 75.0% | 100% |
| ExeuntVault | 92.2% | 93.5% | 88.9% | 100% |
| AaveCollateralRoute | 100% | 93.7% | 44.4% | 100% |
| PriceRouter, feeds, testnet helpers | 100% | 89.7–100% | 0–100% | 100% |

## Bugs found by testing, all fixed

| Found by | Problem | Fix |
|---|---|---|
| Fork tests at the latest Arbitrum Sepolia block | Aave checks withdrawals against the rounded balance, which can be a few wei below a transfer of the same amount, so `redeemReceipt` and flash-mode collateral payment could revert | Withdraw the rounded-down value of units received; pull an index-based margin for collateral and refund the dust |
| Live Arbitrum Sepolia run | A gas estimate was too tight when Aave flipped a collateral flag at execution | Clients send with a 30% gas buffer |
| Live Robinhood rehearsal | The SDK asked the RPC node to sign Morpho authorizations instead of the wallet's own account | Sign with the wallet's account |
| Security review | A Morpho buyer could name a market the Earn vault does not supply | Venue rejects markets without a vault allocation |
| Robinhood fork run | SDK debt reading ignored interest accrued since the market's last update | SDK computes expected debt with the market's rate model |

## End-to-end on forks

The runner starts its own anvil forks, deploys with `script/Deploy.s.sol`, creates positions with `forkkit`, and sends every action as a signed transaction built by the SDK, after simulating it. Each step checks balances, debt, health and the pool's withdrawable liquidity.

Started 2026-10-04T09:06:35.102Z. 72/72 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| arbitrum-sepolia | fork | 315624235 | 18/18 | 75.2 s |
| kelp-replay | fork | 453918025 | 18/18 | 113.9 s |
| robinhood-testnet | fork | 128619146 | 18/18 | 40.7 s |
| earn-bank-run | fork | 79818629 | 18/18 | 187.6 s |

#### arbitrum-sepolia

| # | Step | Result | Details |
|---|---|---|---|
| 1 | deploy Exeunt contracts to the fork with the Foundry script | pass | market: 0x073d27b748C946B841599aE1e1A0FF4D37b9C24e<br>exeuntVault: 0x31D0Acb215ae30c92Ed0A59745de4f3356439CaF |
| 2 | setup: seller holds 100 aWETH in the frozen pool | pass | aWETH: 100.000048 |
| 3 | setup: buyer owes 60 WETH against USDC collateral | pass | debt: 60<br>healthFactor: 4.749118 |
| 4 | setup: bidder and vault depositor funded; borrower posts aWETH and borrows USDC | pass |  |
| 5 | pool is frozen: utilization ~100%, nothing (or almost nothing) withdrawable | pass | utilization: 99.95%<br>withdrawable: 2<br>debtorCapacity: 5,632.697771 |
| 6 | seller opens a Dutch auction for 50 aWETH (1% rising 0.5%/h, cap 15%) | pass | sessionId: 1<br>discount: 1% |
| 7 | buyer buys 20 WETH of receipts with USDG; debt repaid in the same tx; liquidity unchanged | pass | paidUSDG: 53,419.806<br>debtRepaidWETH: 19.998996<br>discount: 1%<br>withdrawableBefore: 2<br>withdrawableAfter: 2<br>gasUsed: 1319430 |
| 8 | buyer buys 10 WETH in flash mode: seller paid in USDC from freed collateral, no cash used | pass | paidUSDC: 26,710.64342<br>healthBefore: 7.123496<br>healthAfter: 9.233615 |
| 9 | guards: no debt, no purchase; price above the buyer's limit reverts | pass | noDebt: DebtTooSmall(0, 1000000000000000000)<br>tooCheap: PriceTooHigh(2670990300, 1) |
| 10 | bidder escrows a 5% USDG limit bid for up to 10 WETH | pass | bidId: 1<br>escrowUSDG: 25,630.715<br>capacityWETH: 10 |
| 11 | seller sells 4 aWETH now into the best bid and is paid immediately | pass | proceedsUSDG: 10,252.286<br>averageDiscount: 5% |
| 12 | auction discount climbs to the bid's 5% and a keeper matches them | pass | discount: 5.5%<br>filledWETH: 6 |
| 13 | depositor puts 50 WETH in the Exeunt Vault; it bids 3% for up to 20% of capital | pass | vaultTotal: 50<br>bidEscrowWETH: 10 |
| 14 | seller sells 8 aWETH into the vault's bid and receives WETH at once | pass | receivedWETH: 7.76<br>vaultHeldAWETH: 8 |
| 15 | borrower with frozen aWETH collateral repays 20,000 USDC by selling it into a USDC bid | pass | healthBefore: 2.807903<br>healthAfter: 6.318849 |
| 16 | seller withdraws the unsold rest of the session immediately | pass | returnedAWETH: 14.014535 |
| 17 | pool recovers; anyone triggers the vault's recovery; depositor exits with the discount as profit | pass | withdrawableNow: 150.444971<br>depositorOutWETH: 50.240001<br>profitWETH: 0.240001 |
| 18 | market holds only escrow: no stray WETH, receipts back every open session | pass | marketWETH: 0 |

#### kelp-replay

| # | Step | Result | Details |
|---|---|---|---|
| 1 | deploy Exeunt contracts to the fork with the Foundry script | pass | market: 0x7003D9Ee9B557645f650f4Fb3eFfA02D7C9792DC<br>exeuntVault: 0x6b6A8dD28B49353DbABb3789456E0bf5d37C4cbF |
| 2 | setup: seller holds 100 aWETH in the frozen pool | pass | aWETH: 100.000007 |
| 3 | setup: buyer owes 60 WETH against USDC collateral | pass | debt: 60<br>healthFactor: 5.305896 |
| 4 | setup: bidder and vault depositor funded; borrower posts aWETH and borrows USDC | pass |  |
| 5 | pool is frozen: utilization ~100%, nothing (or almost nothing) withdrawable | pass | utilization: 100%<br>withdrawable: 0<br>debtorCapacity: 148,395.47723 |
| 6 | seller opens a Dutch auction for 50 aWETH (1% rising 0.5%/h, cap 15%) | pass | sessionId: 1<br>discount: 1% |
| 7 | buyer buys 20 WETH of receipts with USDG; debt repaid in the same tx; liquidity unchanged | pass | paidUSDG: 46,607.022<br>debtRepaidWETH: 19.999999<br>discount: 1%<br>withdrawableBefore: 0<br>withdrawableAfter: 0<br>gasUsed: 394375 |
| 8 | buyer buys 10 WETH in flash mode: seller paid in USDC from freed collateral, no cash used | pass | paidUSDC: 23,307.706388<br>healthBefore: 7.958843<br>healthAfter: 10.354416 |
| 9 | guards: no debt, no purchase; price above the buyer's limit reverts | pass | noDebt: DebtTooSmall(0, 1000000000000000000)<br>tooCheap: PriceTooHigh(2330351100, 1) |
| 10 | bidder escrows a 5% USDG limit bid for up to 10 WETH | pass | bidId: 1<br>escrowUSDG: 22,361.955<br>capacityWETH: 10 |
| 11 | seller sells 4 aWETH now into the best bid and is paid immediately | pass | proceedsUSDG: 8,944.782<br>averageDiscount: 5% |
| 12 | auction discount climbs to the bid's 5% and a keeper matches them | pass | discount: 5.5%<br>filledWETH: 6 |
| 13 | depositor puts 50 WETH in the Exeunt Vault; it bids 3% for up to 20% of capital | pass | vaultTotal: 50<br>bidEscrowWETH: 10 |
| 14 | seller sells 8 aWETH into the vault's bid and receives WETH at once | pass | receivedWETH: 7.76<br>vaultHeldAWETH: 8 |
| 15 | borrower with frozen aWETH collateral repays 20,000 USDC by selling it into a USDC bid | pass | healthBefore: 2.63726<br>healthAfter: 5.933665 |
| 16 | seller withdraws the unsold rest of the session immediately | pass | returnedAWETH: 14.001835 |
| 17 | pool recovers; anyone triggers the vault's recovery; depositor exits with the discount as profit | pass | withdrawableNow: 140.015219<br>depositorOutWETH: 50.24<br>profitWETH: 0.24 |
| 18 | market holds only escrow: no stray WETH, receipts back every open session | pass | marketWETH: 0 |

#### robinhood-testnet

| # | Step | Result | Details |
|---|---|---|---|
| 1 | deploy Exeunt contracts to the fork with the Foundry script | pass | market: 0xf16a1c564566Dd4f9D1ac96e2C2CC04777EACEE2<br>exeuntVault: 0x85fffd36c0781C35e4d204ED5690446eB8874b88 |
| 2 | setup: a separate Morpho market holds idle USDG (flash-loan liquidity) | pass | flashLiquidityUSDG: 50,000 |
| 3 | setup: seller holds 100,000 USDG of Earn vault shares | pass | positionUSDG: 100,000 |
| 4 | setup: buyer borrows 60,000 USDG against collateral in the vault's market | pass | debtUSDG: 60,000<br>health: 2 |
| 5 | setup: bidder and vault depositor funded; remaining liquidity borrowed out | pass |  |
| 6 | vault is frozen: utilization ~100%, nothing withdrawable | pass | utilization: 100%<br>supplied: 160,000.0025<br>morphoFlashUSDG: 50,000 |
| 7 | seller opens a Dutch auction for 50,000 USDG of shares (accepts USDG and the collateral) | pass | sessionId: 1<br>sizeUSDG: 50,000.0013 |
| 8 | buyer buys 20,000 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged | pass | paidUSDG: 19,800<br>debtRepaidUSDG: 20,000<br>gasUsed: 466559 |
| 9 | buyer buys 10,000 USDG in flash mode: two signatures, collateral to seller, authorization revoked | pass | paidCollateral: 9,900 sUSDe-sim<br>healthBefore: 3<br>healthAfter: 3.7162 |
| 10 | guard: a buyer without debt cannot buy | pass | noDebt: DebtTooSmall(0, 1000000000) |
| 11 | bidder escrows a 5% USDG limit bid for up to 10,000 USDG of shares | pass | bidId: 1<br>escrowUSDG: 9,500 |
| 12 | seller sells 4,000 USDG of shares now into the best bid | pass | proceedsUSDG: 3,800 |
| 13 | auction climbs to 5% and a keeper matches it with the bid | pass | discount: 5.5%<br>filledUSDG: 6,000 |
| 14 | depositor puts 100,000 USDG in the Exeunt Vault; it bids 3% for up to 20% | pass | escrowUSDG: 20,000 |
| 15 | seller sells 15,000 USDG of shares into the vault's bid | pass | receivedUSDG: 14,550<br>vaultHeldUSDG: 15,000 |
| 16 | seller withdraws the unsold rest of the session immediately | pass | returnedUSDG: 14,003.3755 |
| 17 | vault recovers; anyone triggers the vault's redemption; depositor exits with profit | pass | depositorOutUSDG: 100,450<br>profitUSDG: 450 |
| 18 | market holds only escrow; no USDG left behind by flash loans | pass | marketUSDG: 0 |

#### earn-bank-run

| # | Step | Result | Details |
|---|---|---|---|
| 1 | deploy Exeunt contracts to the fork with the Foundry script | pass | market: 0x4A0a7843BbC7d33e4824cb5bdb531f0E195B64E1<br>exeuntVault: 0x6699A372477f62caA0B0e3465CDA30E789a8F815 |
| 2 | setup: seller holds 100,000 USDG of Earn vault shares | pass | positionUSDG: 100,000.0516 |
| 3 | setup: buyer borrows 60,000 USDG against collateral in the vault's market | pass | debtUSDG: 60,000<br>health: 2 |
| 4 | bank run: the largest Steakhouse holders withdraw until withdrawals stop | pass | withdrawnUSDG: 4,138,106.8681<br>holders: 1<br>withdrawableBefore: 4,138,106.8681 |
| 5 | setup: bidder and vault depositor funded; remaining liquidity borrowed out | pass |  |
| 6 | vault is frozen: utilization ~100%, nothing withdrawable | pass | utilization: 99.99%<br>supplied: 527,645,989.1209<br>morphoFlashUSDG: 410,758.1032 |
| 7 | seller opens a Dutch auction for 50,000 USDG of shares (accepts USDG and the collateral) | pass | sessionId: 1<br>sizeUSDG: 50,000.0015 |
| 8 | buyer buys 20,000 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged | pass | paidUSDG: 19,800<br>debtRepaidUSDG: 19,999.9997<br>gasUsed: 546747 |
| 9 | buyer buys 10,000 USDG in flash mode: two signatures, collateral to seller, authorization revoked | pass | paidCollateral: 9,900 USDe<br>healthBefore: 3<br>healthAfter: 3.698 |
| 10 | guard: a buyer without debt cannot buy | pass | noDebt: DebtTooSmall(0, 1000000000) |
| 11 | bidder escrows a 5% USDG limit bid for up to 10,000 USDG of shares | pass | bidId: 1<br>escrowUSDG: 9,500 |
| 12 | seller sells 4,000 USDG of shares now into the best bid | pass | proceedsUSDG: 3,800 |
| 13 | auction climbs to 5% and a keeper matches it with the bid | pass | discount: 5.5%<br>filledUSDG: 6,000 |
| 14 | depositor puts 100,000 USDG in the Exeunt Vault; it bids 3% for up to 20% | pass | escrowUSDG: 20,000 |
| 15 | seller sells 15,000 USDG of shares into the vault's bid | pass | receivedUSDG: 14,550<br>vaultHeldUSDG: 15,000 |
| 16 | seller withdraws the unsold rest of the session immediately | pass | returnedUSDG: 14,003.402 |
| 17 | vault recovers; anyone triggers the vault's redemption; depositor exits with profit | pass | depositorOutUSDG: 100,450.0001<br>profitUSDG: 450.0001 |
| 18 | market holds only escrow; no USDG left behind by flash loans | pass | marketUSDG: 0 |

## End-to-end live on Arbitrum Sepolia

Real transactions from two funded accounts against the deployed contracts and the live Aave V3 testnet pool (about 99.8% utilized).

Started 2026-10-04T08:58:15.446Z. 15/15 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| arbitrum-sepolia | live | 315622210 | 15/15 | 73.7 s |

#### arbitrum-sepolia

| # | Step | Result | Details |
|---|---|---|---|
| 1 | live pool state read from chain | pass | utilization: 99.77%<br>withdrawableWETH: 10.31669327<br>suppliedWETH: 4,495.4807166 |
| 2 | fund the buyer account with gas, wrapping money and USDG | pass | buyerETH: 0.0196393<br>buyerUSDG: 29.841574 |
| 3 | seller is topped up with WETH from the buyer when its ETH runs low | pass | sellerWETH: 0.006 |
| 4 | seller takes back unsold receipts from earlier runs | pass | reclaimedSessions: 1 |
| 5 | seller tops up to 0.0045 aWETH (wrapping only what is missing) | pass | sellerAWETH: 0.0045 |
| 6 | buyer holds WETH collateral, 0.004 WETH of debt and USDC collateral (tops up what is missing) | pass | debtWETH: 0.004<br>healthFactor: 1.31631784<br>aUSDC: 6.651125 |
| 7 | seller opens a Dutch auction for 0.003 aWETH | pass | sessionId: 3<br>sizeWETH: 0.003 |
| 8 | buyer buys 0.001 WETH of receipts paying USDG; debt repaid in the same tx | pass | tx: 0xe78f16f01fa8a2b32fe93c919feb454c35323995fb81276b31d49eed478fbad5<br>paidUSDG: 2.672921<br>debtRepaidWETH: 0.0009995<br>withdrawableBefore: 10.31809402<br>withdrawableAfter: 10.31809402 |
| 9 | buyer buys 0.0005 WETH in flash mode, paying the seller USDC from freed collateral | pass | tx: 0xef044a2d52c25014788431677c268c1ba669835441f43b92e3e415356e01324c<br>paidUSDC: 1.336498<br>healthBefore: 1.47008686<br>healthAfter: 1.51220364 |
| 10 | buyer places a 5% USDG limit bid for up to 0.001 WETH | pass | bidId: 3<br>escrowUSDG: 2.564924 |
| 11 | seller sells 0.0005 aWETH now into that bid | pass | tx: 0xa486016e6de67e3db2fad44d7fe7ed9d3c234b7affbfc8ca96ebf7168ad47324<br>proceedsUSDG: 1.282463 |
| 12 | a session already at 6% is matched with the 5% bid by anyone | pass | tx: 0x44193a946f146a25b002c7d23a6e30b77fa52f809ed75b2e286abd85465469bd<br>sessionId: 4 |
| 13 | seller deposits 0.001 WETH into the Exeunt Vault, then sells into the vault's 3% bid | pass | tx: 0x80bca530d308bdabf752b2678e43aaf08c54e91be08c3d09569c9817cf806342<br>vaultTotalWETH: 0.002006<br>vaultHeldAWETH: 0.0002<br>bidBefore: 4 |
| 14 | seller withdraws the unsold rest of the first session | pass | tx: 0x4febc68e7653da59b30e39b3fb4f346568184d4c1f00915777b3ad3607a2bf94 |
| 15 | buyer cancels leftover bids and gets escrow back immediately | pass | cancelled: 1 |

## Live rehearsal for Robinhood Testnet

The same live scenario on a fork of Robinhood Testnet, with the real deployer and test accounts and their real Paxos USDG balances (only gas topped up). The live run will be repeated on the testnet once the deployer has testnet ETH.

Started 2026-10-04T09:15:37.413Z. 13/13 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| robinhood-testnet | fork | 128621871 | 13/13 | 23.0 s |

#### robinhood-testnet

| # | Step | Result | Details |
|---|---|---|---|
| 1 | fund the buyer with gas | pass | buyerETH: 0.1 |
| 2 | seed: 15 USDG of flash liquidity in a separate Morpho market | pass | flashLiquidityUSDG: 15 |
| 3 | seed: seller deposits 50 USDG into the Earn vault | pass | sellerPositionUSDG: 50 |
| 4 | seed: buyer borrows 20 USDG; the seller borrows what is left so the vault is frozen | pass | utilization: 100%<br>withdrawableUSDG: 0<br>buyerDebtUSDG: 20 |
| 5 | seller takes back unsold shares from earlier runs | pass | reclaimed: 0 |
| 6 | seller opens a Dutch auction for 10 USDG of Earn shares | pass | sessionId: 1 |
| 7 | buyer buys 3 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged | pass | tx: 0xe31b1ad5176bc0f96949191309113d56093b31d24d84ae97fe1d2009b3cf6deb<br>paidUSDG: 2.97<br>debtRepaidUSDG: 3<br>withdrawableBefore: 0<br>withdrawableAfter: 0 |
| 8 | buyer buys 2 USDG in flash mode with two signatures; collateral to seller; authorization revoked | pass | tx: 0x606077471b6536759572cb0ded7c5e7e98561300f4c18703ab310be6dace90af<br>paidSimUSDe: 1.98 |
| 9 | buyer places a 5% USDG limit bid for up to 3 USDG | pass | bidId: 1<br>escrowUSDG: 2.85 |
| 10 | seller sells 1 USDG of shares now into the bid | pass | tx: 0x3fb302537ec5d546f6479a753a414627ca058c13d6c95c907770bd44e99c0881<br>proceedsUSDG: 0.95 |
| 11 | a session already at 6% is matched with the 5% bid | pass | tx: 0xba4b61fead521a8fcb27d119b9a6b7e9e53beb2bf83716e30e8faece8302cb0a |
| 12 | seller deposits 10 USDG into the Exeunt Vault and sells 1 USDG of shares into its 3% bid | pass | tx: 0xb8bafe599ec4140c2603b3911185e03adf698f21858027c39efcf06b9de94a21<br>vaultHeldUSDG: 1<br>vaultTotalUSDG: 10.03 |
| 13 | seller withdraws unsold shares; buyer cancels leftover bids | pass | sellerUSDG: 60.83 |

## Not covered

- Web app Morpho write flows were not clicked through in a browser; the same SDK calls are exercised by the Morpho end-to-end runs above.
- Robinhood Testnet live deployment and live run are pending testnet ETH for the deployer.
- Long-running forks of Robinhood Chain and Arbitrum Sepolia depend on the upstream RPC still serving the fork block; their public RPCs are not archive nodes. The Kelp replay fork uses an archive RPC.
