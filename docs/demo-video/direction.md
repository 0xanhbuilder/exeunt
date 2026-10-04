# Exeunt demo video: director's script

Built from [demo-script.md](../demo-script.md). Final cut: `out/exeunt-demo.mp4`, 7:11, 1920×1080 at 30 fps, voiceover in the cloned voice, burned-in captions, a quiet music bed.

Pipeline: `voice.mjs` (voiceover) → `record.mjs` (pre-production checks and live footage) → `build.mjs` (motion graphics, captions, mix, render) → `qc.mjs` (quality checks) → `direction.mjs` (this file).

## Pre-production plan

Everything below is done by `record.mjs` before the first frame is recorded, and the recording stops if a check fails.

| Item | Plan | Check before recording |
|---|---|---|
| Site | https://exeunt.space, hosted, network **Kelp replay** (Arbitrum One fork, 18 Apr 2026) for steps 3–11; **Earn bank-run** (Robinhood Chain fork) for steps 12–13 | Both forks answer `eth_getBalance` for a fresh address through `api.exeunt.space/rpc/<network>` |
| Timing | Not within 45 minutes before, or 20 minutes after, a daily fork reset (03:00 UTC Kelp replay, 03:30 UTC Earn bank-run): a reset wipes the positions | Clock check against both reset times |
| Browser profile 1 | **Alice**, the depositor: her own Chrome profile (separate user-data directory), window 1568×882, built-in demo wallet with a new burner key | Wallet connected on Kelp replay |
| Browser profile 2 | **Bob**, the borrower and bidder: a second Chrome profile, same size, his own demo wallet and burner key | Wallet connected on Kelp replay |
| Alice's account | Faucet **Seller kit**: 10 WETH deposited into the Aave pool for her (aArbWETH receipts), pool re-frozen | Sell page shows exactly "10 WETH" |
| Bob's account | Faucet **Borrower kit** (USDC collateral, 5 WETH borrowed) and **Bidder kit** (stablecoins and WETH/wstETH for bids and the vault) | Buy page shows a debt of exactly "5 WETH" |
| Stills | Alice's Sell page, Bob's Buy page, Bob's wallet menu with the faucet kits, each with the position of the card the camera zooms into | Saved before recording |
| MCP call | `tools/call get_exit_capacity {"network": "kelp-replay"}` against https://api.exeunt.space/mcp; the real answer is what the terminal insert shows | Response parsed |
| Tabs per step | Each live step starts from a freshly loaded page in the right profile (table below), scrolled to the top, cursor parked | The step's first control is on the page |
| State between steps | Alice's auction id is read when it opens and reused by Bob's Buy steps and Alice's withdraw step; Bob's new bid id is read when it is placed | Ids found on the page |

Last recording: 2026-10-04T15:23:39.580Z, 11 live steps, 2 warnings.

## Shot list

| # | Step | Starts | Length | Type | Profile and page |
|---|---|---|---|---|---|
| 1 | Introduction | 0:00 | 33 s | Motion graphics | — |
| 2 | Preparation | 0:33 | 48 s | Motion graphics | — |
| 3 | Exit capacity | 1:20 | 34 s | Live footage | Alice (depositor), `#/` |
| 4 | Open an auction | 1:54 | 43 s | Live footage | Alice (depositor), `#/sell` |
| 5 | Buy and repay | 2:37 | 40 s | Live footage + motion-graphics insert | Bob (borrower and bidder), `#/buy` |
| 6 | Flash mode | 3:17 | 33 s | Live footage | Bob (borrower and bidder), `#/buy` |
| 7 | Limit bids | 3:50 | 21 s | Live footage | Bob (borrower and bidder), `#/earn` |
| 8 | Exeunt Vault | 4:11 | 40 s | Live footage | Bob (borrower and bidder), `#/earn` |
| 9 | Sell now | 4:51 | 23 s | Live footage | Alice (depositor), `#/sell` |
| 10 | Take back the unsold rest | 5:15 | 14 s | Live footage | Alice (depositor), `#/sell` |
| 11 | Frozen collateral | 5:29 | 28 s | Live footage | Alice (depositor), `#/frozen-collateral` |
| 12 | Robinhood Chain | 5:57 | 31 s | Live footage + motion-graphics insert | Alice (depositor), `#/` |
| 13 | Developers and AI agents | 6:28 | 30 s | Live footage + motion-graphics insert | Alice (depositor), `#/developers` |
| 14 | Outro | 6:58 | 14 s | Motion graphics | — |

### 1. Introduction (0:00–0:33)

**Visuals**

- Title card: the Exeunt logo, "Exeunt", "Product demo".
- Tagline "The exit market for frozen lending pools" with chips for Arbitrum (Aave V3) and Robinhood Chain (Morpho).
- A lending-pool card: utilization counts up to 100% as the bar fills; the Withdraw button is greyed out and a red "Blocked, sometimes for days" tag pops in on the word "withdraw".
- Three buyer cards slide in on their words: Borrowers, Limit bids, The Exeunt Vault; then "Paid right away".
- Closing pill: "No liquidity leaves the pool".

| Time | Voiceover | On screen |
|---|---|---|
| 0:01 | Hello everyone, welcome to the Exeunt demo. | see Visuals |
| 0:05 | Exeunt is an exit market for frozen lending pools, on Arbitrum and Robinhood Chain. | see Visuals |
| 0:11 | When borrowers take all of a pool's liquidity, depositors cannot withdraw, sometimes for days. | see Visuals |
| 0:19 | Exeunt lets them sell their stuck deposit to borrowers, bidders or a shared vault, and get paid right away. | see Visuals |
| 0:27 | And it does that without taking any liquidity out of the pool. | see Visuals |

### 2. Preparation (0:33–1:20)

**Visuals**

- Network card "Kelp replay" with the exeunt.space chip; three facts appear on their words (fork of Arbitrum One, 18 April 2026, Aave WETH pool at 100%), then "Aave's real contracts, real state".
- Two browser windows with stills captured during pre-production: Alice (amber badge, Sell page) and Bob (blue badge, Buy page).
- On Alice's line her window lights up and zooms into her 10 WETH position; on Bob's line his window zooms into his 5 WETH debt.
- On the faucet line, Bob's wallet menu pops over and zooms into the three faucet kits.

| Time | Voiceover | On screen |
|---|---|---|
| 0:33 | For this demo, we use the web app at exeunt.space, on the Kelp replay network. | see Visuals |
| 0:40 | It is a fork of Arbitrum One on 18 April 2026, the day the Aave WETH pool hit 100% utilization. | see Visuals |
| 0:51 | It runs against Aave's real contracts and real state. | see Visuals |
| 0:55 | I have prepared two browser profiles, both using the built-in demo wallet. | see Visuals |
| 1:01 | Alice is a depositor, with 10 WETH stuck in the pool. | see Visuals |
| 1:05 | Bob borrowed 5 WETH against USDC, and also holds spare WETH and stablecoins to bid with. | see Visuals |
| 1:13 | Their positions come from the faucet on this fork, and anyone can get the same with one click. | see Visuals |

### 3. Exit capacity (1:20–1:54)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 1:21 | This is the Overview. | scroll to `capacity-row-kelp-replay` |
| 1:23 | Every pool shows its exit capacity, read straight from the chain. | point at `capacity-row-kelp-replay` with the label "Read on-chain, no permission" |
| 1:28 | Utilization is at 100%, and nothing is withdrawable. | point at `[data-testid="capacity-row-kelp-replay"] [data-testid="capacity-utilization"]` with the label "100% utilized"; point at `[data-testid="capacity-row-kelp-replay"] [data-testid="capacity-withdrawable"]` with the label "Nothing withdrawable" |
| 1:34 | But borrowers of the same asset owe nearly 150,000 WETH, far more than what is stuck. | point at `[data-testid="capacity-row-kelp-replay"] [data-testid="capacity-borrowers"]` with the label "Same-asset debt" |
| 1:42 | And that debt is where the exit comes from. | hold on the current view |
| 1:45 | Curators can also set an alert here, and get a signed webhook when utilization crosses their threshold. | scroll to `alert-threshold`; point at `alert-threshold` with the label "Alert threshold" |

### 4. Open an auction (1:54–2:37)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/sell); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 1:55 | Alice wants out. | point at `sell-position` with the label "10 WETH stuck" |
| 1:57 | She could sell into standing bids right away, but first she runs a Dutch auction, so she gives away only as much discount as she must. | point at `sell-mode-now`; on the word "auction": click `sell-mode-auction` |
| 2:07 | It starts at 0.5%, rises by 0.25% every 15 minutes up to 5%, and it never goes back down. | scroll to `auction-path`; point at `auction-path` with the label "Discount only rises" |
| 2:17 | By default she accepts any of the market's payment assets: USDG, USDC, WETH and wstETH. | point at `div:has(> [data-testid="sell-pay-USDG"])` with the label "Accepted assets" |
| 2:24 | She enters 4 WETH, and opens the auction. | clear the highlights; type "4" into `sell-amount`; on the word "opens": click `sell-submit`; wait for the transaction to confirm |
| 2:30 | Her receipts are held in escrow, and she can take back the unsold part at any time. | scroll to `session-row-{sid}`; point at `session-row-{sid}` with the label "Live auction" |

### 5. Buy and repay (2:37–3:17)

**Visuals**: live footage of Bob (borrower and bidder)'s browser window (profile badge, exeunt.space#/buy); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 2:38 | Bob owes 5 WETH. | point at `buy-debt` with the label "Bob's debt" |
| 2:40 | On the Buy page he sees Alice's auction, and buys 1 WETH of her receipts, paying in USDG. | clear the highlights; click `buy-select-{sid}`; type "1" into `buy-amount`; point at `buy-pay-token-USDG` |
| 2:47 | Before anything is sent, the panel shows what he pays, and what he saves. | scroll to `buy-you-pay`; point at `buy-you-pay` with the label "He pays"; point at `buy-savings` with the label "He saves" |
| 2:52 | In one transaction, Exeunt flash-borrows WETH, repays 1 WETH of Bob's debt, uses that new liquidity to redeem Alice's receipts, and returns the loan. | Motion-graphics insert over the dimmed footage: "One transaction, four moves" (flash-borrow, repay Bob's debt, redeem Alice's receipts, return the loan), each step on its word, then "Withdrawable liquidity unchanged". The real transaction confirms underneath.; clear the highlights; click `buy-submit`; wait for the transaction to confirm |
| 3:04 | Bob's debt drops by 1 WETH, and he pays half a percent less. | scroll to `buy-debt`; point at `buy-debt` with the label "5 → 4 WETH" |
| 3:09 | Alice is paid at once, and the pool's withdrawable liquidity is exactly what it was before. | hold on the current view |

### 6. Flash mode (3:17–3:50)

**Visuals**: live footage of Bob (borrower and bidder)'s browser window (profile badge, exeunt.space#/buy); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 3:18 | What if a borrower has no cash? | click `buy-select-{sid}`; type "1" into `buy-amount` |
| 3:21 | With flash mode, Bob pays with his collateral instead. | on the word "flash": click `buy-pay-flash`; point at `buy-flash-token-USDC` with the label "USDC collateral" |
| 3:25 | The market repays his debt first, which frees part of his USDC collateral, and that collateral pays Alice. | scroll to `buy-flash-collateral`; point at `buy-flash-collateral` with the label "Collateral that pays Alice" |
| 3:33 | Bob needs nothing up front, and his health factor can only go up: if it would go down, the transaction reverts. | point at `buy-flash-cash` with the label "No cash"; on the word "health": point at `buy-flash-health` with the label "Health factor up" |
| 3:42 | One click runs the one-time approval, then the purchase. | clear the highlights; click `buy-submit`; wait for the transaction to confirm |
| 3:46 | His debt goes from 4 to 3 WETH. | scroll to `buy-debt`; point at `buy-debt` with the label "4 → 3 WETH" |

### 7. Limit bids (3:50–4:11)

**Visuals**: live footage of Bob (borrower and bidder)'s browser window (profile badge, exeunt.space#/earn); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 3:51 | Not every buyer borrows. | click `earn-tab-bids` |
| 3:54 | Treasuries and market makers can post limit bids before any freeze: they escrow the funds, and set the minimum discount they accept. | type "2" into `bid-amount`; type "2" into `bid-discount`; click `bid-escrow-WETH`; point at `bid-escrow-needed` with the label "Escrowed up front" |
| 4:04 | Only escrowed funds count, every bid is public, and a bid can be cancelled at any time. | clear the highlights; click `bid-submit`; wait for the transaction to confirm; point at `bid-cancel-{bid}` with the label "Cancel any time" |

### 8. Exeunt Vault (4:11–4:51)

**Visuals**: live footage of Bob (borrower and bidder)'s browser window (profile badge, exeunt.space#/earn); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 4:12 | For passive capital, there is the Exeunt Vault. | click `earn-tab-vault`; point at `vault-section` |
| 4:16 | You deposit once, and the vault bids by rules fixed at deployment. | clear the highlights; click `vault-mode-deposit`; type "5" into `vault-deposit-amount` |
| 4:22 | At least a 3% discount, and at most 20% of its capital per receipt. | point at `vault-bid` with the label "Standing bid" |
| 4:29 | Its capital stays out of the pool it protects. | clear the highlights; click `vault-deposit-submit`; wait for the transaction to confirm |
| 4:33 | When the pool refills, anyone can trigger its recovery, and the discount becomes the depositors' profit. | point at `vault-recover` with the label "Anyone can trigger" |
| 4:48 | Depositors can leave at any time. | clear the highlights; click `vault-mode-withdraw`; point at `vault-out-now` with the label "Paid out now" |

### 9. Sell now (4:51–5:15)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/sell); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 4:52 | Back to Alice. | point at `sell-position` |
| 4:54 | She does not want to wait for the auction any more, so she sells 3 WETH now. | clear the highlights; click `sell-mode-now`; type "3" into `sell-amount` |
| 5:00 | The preview fills the smallest discounts first, across limit bids and the vault. | scroll to `sell-preview`; point at `sell-preview` with the label "Best price first" |
| 5:07 | Each bid pays from its own escrow, in its own asset, and she is paid in the same transaction. | clear the highlights; click `sell-submit`; wait for the transaction to confirm; point at `tx-status` with the label "Paid" |

### 10. Take back the unsold rest (5:15–5:29)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/sell); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 5:15 | Bob bought 2 of the 4 WETH in Alice's auction. | scroll to `session-row-{sid}`; point at `session-sold-{sid}` with the label "2 of 4 sold" |
| 5:20 | She can take back the other two whenever she wants, with no waiting period; what already sold stays sold. | clear the highlights; click `session-withdraw-{sid}`; wait for the transaction to confirm |

### 11. Frozen collateral (5:29–5:57)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/frozen-collateral); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 5:29 | One more case: Aave borrowers whose collateral is the frozen asset. | point at `frozen-collateral` with the label "Frozen aWETH collateral" |
| 5:35 | They cannot withdraw it, so they cannot use it to repay debt, or move it. | hold on the current view |
| 5:40 | This page first checks whether a direct withdrawal works. | point at `frozen-direct` with the label "Blocked" |
| 5:45 | When it is blocked, Exeunt sells the collateral into escrowed bids to repay debt, or swaps it for new collateral, in a single transaction. | point at `frozen-repay` with the label "Repay debt"; on the word "swaps": point at `frozen-swap` with the label "Swap collateral" |

### 12. Robinhood Chain (5:57–6:28)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 5:58 | The same exit works on Robinhood Chain, an Arbitrum Orbit chain, for Morpho Earn vaults, with Paxos USDG as the main payment asset. | click `network-selector`; point at `network-option-earn-bank-run`; on the word "Paxos": click `network-option-earn-bank-run` |
| 6:08 | This is the Earn bank-run network: a fork of Robinhood Chain where the Steakhouse USDG vault was drained. | scroll to `capacity-row-earn-bank-run`; point at `capacity-row-earn-bank-run` with the label "Drained: 100% utilized" |
| 6:16 | Same pages, same flows. | clear the highlights; click `nav-sell` |
| 6:18 | On Morpho, flash mode uses a signed authorization instead of an approval, and revokes it in the same transaction. | Motion-graphics insert: "Flash mode with signatures, not approvals" (signed grant, withdraw the freed collateral, signed revoke), then "Reverts if any authorization remains". |

### 13. Developers and AI agents (6:28–6:58)

**Visuals**: live footage of Alice (depositor)'s browser window (profile badge, exeunt.space#/developers); a cursor moves to each control, green rings and labels mark what the voice describes.

| Time | Voiceover | On screen |
|---|---|---|
| 6:29 | Everything you saw is also open to other apps, and to AI agents. | hold on the current view |
| 6:34 | On-chain reads, a TypeScript SDK, webhooks, and an MCP server with 18 tools. | point at `#h-reads`; on the word "TypeScript": point at `#h-sdk`; on the word "webhooks": point at `#h-hook`; on the word "server": scroll to `dev-mcp`; point at `#h-mcp` |
| 6:40 | The MCP server never holds keys: it returns unsigned transactions, and the user's or the agent's wallet signs them. | point at `dev-mcp` with the label "Never holds keys" |
| 6:49 | Here, an MCP client asks for the exit capacity of the Kelp replay pool, and gets it straight from the chain. | Motion-graphics insert: a terminal panel types the real `get_exit_capacity` call to api.exeunt.space/mcp, then prints the real result captured during pre-production (utilization, withdrawable, supplied, debtor capacity, bids by discount). |

### 14. Outro (6:58–7:11)

**Visuals**

- Recap grid of the nine features shown, staggered in.
- Closing line: "A frozen pool no longer means a locked exit."
- "Thanks for watching" with exeunt.space and api.exeunt.space/mcp.

| Time | Voiceover | On screen |
|---|---|---|
| 6:58 | That's all for our demo. | see Visuals |
| 7:01 | With Exeunt, a frozen pool no longer means a locked exit. | see Visuals |
| 7:05 | Thanks for watching! | see Visuals |
