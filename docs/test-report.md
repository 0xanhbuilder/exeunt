# Test report

Generated on 4 October 2026 from the commands below. Every number here comes from a recorded run.

## Summary

| Layer | What runs | Result |
|---|---|---|
| Contracts | `forge test`: unit, fuzz (256 runs), invariant (64 runs × depth 64), Arbitrum Sepolia fork | 104 / 104 passed |
| Contract coverage | `forge coverage --ir-minimum` over `src/` | 98.2% lines, 95.2% statements, 72.5% branches, 98.9% functions |
| SDK | `npm run test -w @exeunt/sdk` | 5 / 5 passed |
| MCP server | `npm run test -w @exeunt/mcp` | 49 / 49 passed |
| Backend | `npm run test -w @exeunt/backend` | 57 / 57 passed |
| Web app | `npm run test -w @exeunt/web`, plus typecheck and production build | 63 / 63 passed, build ok |
| End-to-end, forks | `npm run e2e -w @exeunt/e2e -- --network=all` | 72 / 72 steps passed on 4 networks; Earn bank-run re-run 18 / 18 after moving to the dRPC archive |
| End-to-end, live | `npm run e2e -w @exeunt/e2e -- --network=arbitrum-sepolia,robinhood-testnet --live` | 28 / 28 steps passed with real testnet transactions |
| Web app, hosted | `npm run ui -w @exeunt/e2e -- --url=https://exeunt.space` (headless Chrome, all 4 networks) | 32 / 32 steps passed, every action confirmed on-chain |

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
| Robinhood Testnet deployment | Forge's local gas estimate omits the Orbit chain's L1 data fee, so a small transaction ran out of gas | Deploy with `--gas-estimate-multiplier 300` (documented in the README) |
| Hosted demo | A fork of Robinhood Chain's official, non-archive RPC eventually could not read state for new accounts | Earn bank-run forks the dRPC archive at a pinned block |

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

## End-to-end live on Arbitrum Sepolia and Robinhood Testnet

Real transactions from two funded accounts against the deployed contracts: the live Aave V3 testnet pool on Arbitrum Sepolia (about 99.8% utilized) and the Morpho Earn stack on Robinhood Testnet with Paxos testnet USDG.

Started 2026-10-04T11:55:51.336Z. 28/28 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| arbitrum-sepolia | live | 315664857 | 15/15 | 69.1 s |
| robinhood-testnet | live | 128695341 | 13/13 | 47.6 s |

#### arbitrum-sepolia

| # | Step | Result | Details |
|---|---|---|---|
| 1 | live pool state read from chain | pass | utilization: 99.77%<br>withdrawableWETH: 10.31809402<br>suppliedWETH: 4,496.54528569 |
| 2 | fund the buyer account with gas, wrapping money and USDG | pass | buyerETH: 0.01940119<br>buyerUSDG: 22.46705 |
| 3 | seller is topped up with WETH from the buyer when its ETH runs low | pass | sellerWETH: 0.00229401 |
| 4 | seller takes back unsold receipts from earlier runs | pass | reclaimedSessions: 0 |
| 5 | seller tops up to 0.0045 aWETH (wrapping only what is missing) | pass | sellerAWETH: 0.0045 |
| 6 | buyer holds WETH collateral, 0.004 WETH of debt and USDC collateral (tops up what is missing) | pass | debtWETH: 0.004<br>healthFactor: 1.3487265<br>aUSDC: 5.314704 |
| 7 | seller opens a Dutch auction for 0.003 aWETH | pass | sessionId: 8<br>sizeWETH: 0.003 |
| 8 | buyer buys 0.001 WETH of receipts paying USDG; debt repaid in the same tx | pass | tx: 0xda9b00e9380d5504cd5e19d46271e612393f97c4825cbedcc326e228bbe9bbfa<br>paidUSDG: 2.673233<br>debtRepaidWETH: 0.0009995<br>withdrawableBefore: 10.31919532<br>withdrawableAfter: 10.31919532 |
| 9 | buyer buys 0.0005 WETH in flash mode, paying the seller USDC from freed collateral | pass | tx: 0xc3220ec9159fe325aa31769b9e8ab0faf3d905fb7ef8e6ce91b0473864f373f1<br>paidUSDC: 1.336663<br>healthBefore: 1.50619847<br>healthAfter: 1.55057617 |
| 10 | buyer places a 5% USDG limit bid for up to 0.001 WETH | pass | bidId: 8<br>escrowUSDG: 2.565224 |
| 11 | seller sells 0.0005 aWETH now into that bid | pass | tx: 0xc7c95255b4d1e63f3ef12d7b46487f8e82aaad82fc5e2fdd9da01b414080a1cc<br>proceedsUSDG: 1.315017 |
| 12 | a session already at 6% is matched with the 5% bid by anyone | pass | tx: 0x26314a0d898504c9de621bf5181c43ca09708af6bec3f4619778e3d24579278e<br>sessionId: 9 |
| 13 | seller deposits 0.001 WETH into the Exeunt Vault, then sells into the vault's 3% bid | pass | tx: 0x60e66fb2aa8817b73bd396e52cbb18b89798c546637815f8362ec79aab079a2f<br>vaultTotalWETH: 0.00301205<br>vaultHeldAWETH: 0.00040005<br>bidBefore: 9 |
| 14 | seller withdraws the unsold rest of the first session | pass | tx: 0x978a726c0e3627624bb3170b26fbe2dc11ceba29254fbc73d0befc292ed00e0a |
| 15 | buyer cancels leftover bids and gets escrow back immediately | pass | cancelled: 1 |

#### robinhood-testnet

| # | Step | Result | Details |
|---|---|---|---|
| 1 | fund the buyer with gas | pass | buyerETH: 0.002961 |
| 2 | seed: 15 USDG of flash liquidity in a separate Morpho market | pass | flashLiquidityUSDG: 15 |
| 3 | seed: seller deposits 50 USDG into the Earn vault | pass | sellerPositionUSDG: 40.500932 |
| 4 | seed: buyer borrows 20 USDG; the seller borrows what is left so the vault is frozen | pass | utilization: 100%<br>withdrawableUSDG: 0<br>buyerDebtUSDG: 13.500328 |
| 5 | seller takes back unsold shares from earlier runs | pass | reclaimed: 0 |
| 6 | seller opens a Dutch auction for 10 USDG of Earn shares | pass | sessionId: 6 |
| 7 | buyer buys 3 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged | pass | tx: 0x9288af3d55edf3b50018f2cd7f546127f448ba587f9d61a26d97e74fc2bc6db2<br>paidUSDG: 2.97<br>debtRepaidUSDG: 3<br>withdrawableBefore: 0<br>withdrawableAfter: 0 |
| 8 | buyer buys 2 USDG in flash mode with two signatures; collateral to seller; authorization revoked | pass | tx: 0x8e811766e16be9e245a2c1f6b5bd5901defc973a7d3d49cf02c15e4e1e55a742<br>paidSimUSDe: 1.98 |
| 9 | buyer places a 5% USDG limit bid for up to 3 USDG | pass | bidId: 6<br>escrowUSDG: 2.85 |
| 10 | seller sells 1 USDG of shares now into the bid | pass | tx: 0x4f7d9b606f22e1d762f530fd021861a74ea09e3f3310068b44ba9f81d86ca8f9<br>proceedsUSDG: 0.98 |
| 11 | a session already at 6% is matched with the 5% bid | pass | tx: 0xc0339a1278511ceff7f8333ee298b000f9f014d444be5d921d5e7a88755ec08d |
| 12 | seller deposits 10 USDG into the Exeunt Vault and sells 1 USDG of shares into its 3% bid | pass | tx: 0xf9859788196c325838815d29784fc4d9f61e3c8870696742a6a1b3839ceaac75<br>vaultHeldUSDG: 2.000022<br>vaultTotalUSDG: 20.060022 |
| 13 | seller withdraws unsold shares; buyer cancels leftover bids | pass | sellerUSDG: 58.1825 |

## Web app on exeunt.space

Headless Chrome drives the hosted web app through the DevTools protocol, using the same buttons and fields a person would. On the live testnets the deployer opens an auction and the second account buys and repays, places and cancels a bid; on the scenario forks a fresh demo wallet gets demo funds from the faucet and runs every flow. Each step waits for the transaction panel to report the new transactions confirmed.

Started 2026-10-04T11:53:44.644Z. 32/32 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| arbitrum-sepolia | live | - | 6/6 | 32.7 s |
| robinhood-testnet | live | - | 6/6 | 31.9 s |
| kelp-replay | live | - | 10/10 | 33.0 s |
| earn-bank-run | live | - | 10/10 | 23.4 s |

#### arbitrum-sepolia

| # | Step | Result | Details |
|---|---|---|---|
| 1 | arbitrum-sepolia: select the network and connect the demo wallet | pass | address: 0x1641ad2Fe2eb6f5b001E8f21C2B655E0132272a4 |
| 2 | arbitrum-sepolia: every page renders with live chain data | pass | capacity:  |
| 3 | arbitrum-sepolia: seller opens a Dutch auction in the web app | pass | txs: 0xc87c3da2e01183378293cedb8bc0e50e0ebcadbedd37067f5a1c9a04120c1b5a |
| 4 | arbitrum-sepolia: buyer buys and repays in the web app | pass | session: buy-select-7<br>txs: 0x164aec220e8ac5e14df37202efef985308c55d4dbd54afa0ebd4ebf419696277 |
| 5 | arbitrum-sepolia: buyer places and cancels a limit bid | pass | cancelled: bid-cancel-5<br>txs: 0xf13c152b0cd4f79e78868f01675e55580139009d5e324ac1528e086e8c1d579f,0xaf248c8730d064ad0674a876c657c4c4d0592960a114affcc728c1e438fca232 |
| 6 | arbitrum-sepolia: seller withdraws the unsold rest | pass | session: session-withdraw-7<br>txs: 0xe076ff66baa703c2e513e30366904c28a3566c4509dc37c11c7923ca379c54f9 |

#### robinhood-testnet

| # | Step | Result | Details |
|---|---|---|---|
| 1 | robinhood-testnet: select the network and connect the demo wallet | pass | address: 0x1641ad2Fe2eb6f5b001E8f21C2B655E0132272a4 |
| 2 | robinhood-testnet: every page renders with live chain data | pass | capacity:  |
| 3 | robinhood-testnet: seller opens a Dutch auction in the web app | pass | txs: 0x60b49b3a0780d9862f595856ae2050423fa9680862526c1262395aceb0b3190b |
| 4 | robinhood-testnet: buyer buys and repays in the web app | pass | session: buy-select-5<br>txs: 0xcdbee192a874b3bbeacf472b31272e6e18e3f68ce0a5a720e3baac2ec35ea160 |
| 5 | robinhood-testnet: buyer places and cancels a limit bid | pass | cancelled: bid-cancel-3<br>txs: 0xdfe7bba77c5192aefa3f2c2c397192a45a95bf07ca718a00f862c3867fded16f,0xd25faf5e304f4b853dc2a388ddfbbd0e7b677eb1bc31fe16df46bf3d564f90d3 |
| 6 | robinhood-testnet: seller withdraws the unsold rest | pass | session: session-withdraw-5<br>txs: 0x50e7a874aff5a9ff26ed683748886891741c3065d402c97bf8ac3e059809d5fc |

#### kelp-replay

| # | Step | Result | Details |
|---|---|---|---|
| 1 | kelp-replay: select the network and connect the demo wallet | pass | address: 0x82079b868eb6FeDE6677fB9DB1a14aaADeA7C316 |
| 2 | kelp-replay: every page renders with live chain data | pass | capacity:  |
| 3 | kelp-replay: get the seller demo kit from the faucet | pass | result: Seller kit sent. |
| 4 | kelp-replay: get the borrower demo kit from the faucet | pass | result: Borrower kit sent. |
| 5 | kelp-replay: get the bidder demo kit from the faucet | pass | result: Bidder kit sent. |
| 6 | kelp-replay: open a Dutch auction from the Sell page | pass | txs: 0x48f82aa16b29804a389fadfdce3ba04f24cb288202a235471c38ee14163850ea,0x17b496b0cb069e60561f0b230be8fa57304465878bdc080eac758722fd0942d8 |
| 7 | kelp-replay: buy and repay from the wallet on the Buy page | pass | session: buy-select-12<br>txs: 0xe5412f4ef16e5ff9b8046aa91045f0e6d47763a2d409cacd59ff2c6d37bec2ae,0x2e4283f9ff82962b274597a9332fb5620bdcdda1ad4155628f99eac702d42810 |
| 8 | kelp-replay: deposit into the Exeunt Vault | pass | txs: 0xf703e5c8d3c70c40063b108a07803a0593da17a754e1a3251468d50aaa80ff69,0xa47e5c8594331ae69854fa20618416463ddc0bdac10bfa970c42191da3773253 |
| 9 | kelp-replay: place a limit bid, then cancel it | pass | cancelled: bid-cancel-24<br>txs: 0x4d9ef305cabeab25e510d25f205643866404e65e63e560156538c1326b8763bb,0xa67411f4537478e32be294a10eae45840c6a8f13a2200179320850e5f63b77fb,0xe80bce45bc6d3b2586a8d0b50f090a279a99bf97cb953fbb72697d3ffb36fa6c |
| 10 | kelp-replay: withdraw the unsold auction at once | pass | session: session-withdraw-12<br>txs: 0x48430c82abe206a75fa8eb3440bf926e35366d3149ac5816facc38e0542f3392 |

#### earn-bank-run

| # | Step | Result | Details |
|---|---|---|---|
| 1 | earn-bank-run: select the network and connect the demo wallet | pass | address: 0x68eF1E75c4c2f0B52640e6fB19b84670068e8b59 |
| 2 | earn-bank-run: every page renders with live chain data | pass | capacity:  |
| 3 | earn-bank-run: get the seller demo kit from the faucet | pass | result: Seller kit sent. |
| 4 | earn-bank-run: get the borrower demo kit from the faucet | pass | result: Borrower kit sent. |
| 5 | earn-bank-run: get the bidder demo kit from the faucet | pass | result: Bidder kit sent. |
| 6 | earn-bank-run: open a Dutch auction from the Sell page | pass | txs: 0xff4726787f1c9005bedc50f789bfac3fd62c4aa059ff73dac9c1c459c215e774,0x11658a7adc889991b797d2be869ac7f4f60f6d15012c2054f2aaf2172b7c93b6 |
| 7 | earn-bank-run: buy and repay from the wallet on the Buy page | pass | session: buy-select-4<br>txs: 0x845bab741d411b693df91814dd60cdc6e65e9f7c8f294764b8fde1639faa249a,0x4835e740babedc24dfbe587d74562bce1af9a2cc1c695a962c5404e0dc172cd8 |
| 8 | earn-bank-run: deposit into the Exeunt Vault | pass | txs: 0x5637cddf83c08e2262b6f6eef281edb10768837d143b5a381fb9e2e2f1b118a7,0xd1108ece9b1c5beececc73df9a1c6d5b3da20f6b7dc2758c002325967093014d |
| 9 | earn-bank-run: place a limit bid, then cancel it | pass | cancelled: bid-cancel-8<br>txs: 0x9d52cb859ed348903184d065ac949322770473ce8216281c19bd60b78a54890e,0x602a63bb8cb2ed329fbde821a00834883d73b983af2564acdbca38d5d094e869,0xf612fe14fe56063a579b21b1405616337f6c721b1caa0d65d2f4bd20c7068528 |
| 10 | earn-bank-run: withdraw the unsold auction at once | pass | session: session-withdraw-4<br>txs: 0x9b828e3ced9a49d1a2128fb1751a361d09f5f3697e21e01fd8748e9c3f7de4f9 |

## Earn bank-run on the dRPC archive

Started 2026-10-04T10:51:18.804Z. 18/18 steps passed.

| Network | Mode | Fork block | Passed | Duration |
|---|---|---|---|---|
| earn-bank-run | fork | 79876918 | 18/18 | 70.0 s |

#### earn-bank-run

| # | Step | Result | Details |
|---|---|---|---|
| 1 | deploy Exeunt contracts to the fork with the Foundry script | pass | market: 0x4A0a7843BbC7d33e4824cb5bdb531f0E195B64E1<br>exeuntVault: 0x6699A372477f62caA0B0e3465CDA30E789a8F815 |
| 2 | setup: seller holds 100,000 USDG of Earn vault shares | pass | positionUSDG: 100,000.0162 |
| 3 | setup: buyer borrows 60,000 USDG against collateral in the vault's market | pass | debtUSDG: 60,000<br>health: 2 |
| 4 | bank run: the largest Steakhouse holders withdraw until withdrawals stop | pass | withdrawnUSDG: 4,025,888.6451<br>holders: 1<br>withdrawableBefore: 4,025,888.6451 |
| 5 | setup: bidder and vault depositor funded; remaining liquidity borrowed out | pass |  |
| 6 | vault is frozen: utilization ~100%, nothing withdrawable | pass | utilization: 99.99%<br>supplied: 527,745,347.5612<br>morphoFlashUSDG: 394,631.1868 |
| 7 | seller opens a Dutch auction for 50,000 USDG of shares (accepts USDG and the collateral) | pass | sessionId: 1<br>sizeUSDG: 50,000.0013 |
| 8 | buyer buys 20,000 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged | pass | paidUSDG: 19,800<br>debtRepaidUSDG: 20,000<br>gasUsed: 546747 |
| 9 | buyer buys 10,000 USDG in flash mode: two signatures, collateral to seller, authorization revoked | pass | paidCollateral: 9,900 USDe<br>healthBefore: 3<br>healthAfter: 3.698 |
| 10 | guard: a buyer without debt cannot buy | pass | noDebt: DebtTooSmall(0, 1000000000) |
| 11 | bidder escrows a 5% USDG limit bid for up to 10,000 USDG of shares | pass | bidId: 1<br>escrowUSDG: 9,500 |
| 12 | seller sells 4,000 USDG of shares now into the best bid | pass | proceedsUSDG: 3,800 |
| 13 | auction climbs to 5% and a keeper matches it with the bid | pass | discount: 5.5%<br>filledUSDG: 6,000 |
| 14 | depositor puts 100,000 USDG in the Exeunt Vault; it bids 3% for up to 20% | pass | escrowUSDG: 20,000 |
| 15 | seller sells 15,000 USDG of shares into the vault's bid | pass | receivedUSDG: 14,550<br>vaultHeldUSDG: 15,000 |
| 16 | seller withdraws the unsold rest of the session immediately | pass | returnedUSDG: 14,003.4008 |
| 17 | vault recovers; anyone triggers the vault's redemption; depositor exits with profit | pass | depositorOutUSDG: 100,450<br>profitUSDG: 450 |
| 18 | market holds only escrow; no USDG left behind by flash loans | pass | marketUSDG: 0 |

## Not covered

- The injected browser-wallet path (MetaMask) was not automated; the hosted tests use the demo wallet, which signs the same transactions locally.
- The frozen-collateral route was tested through the SDK end-to-end runs and fork tests, not through the web app.
