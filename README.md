# 1. Introduction

Exeunt is an exit market for frozen lending pools on Arbitrum and Robinhood Chain. When a pool hits 100% utilization and depositors cannot withdraw, Exeunt lets them sell their deposit receipt (aWETH on Aave V3, Earn vault shares on Morpho) at a discount and get paid immediately, without taking a single unit of liquidity out of the pool.

The natural buyer of a stuck receipt is a borrower of the same asset. Exeunt repays that borrower's debt with a flash loan, uses the liquidity the repayment creates to redeem the seller's receipt, and settles the trade in one transaction. Sellers can also sell into escrowed limit bids or to the Exeunt Vault, a pooled buyer that bids by fixed rules from the first minute of a freeze. Every pool's exit capacity is published on-chain, and an SDK and an MCP server open all of it to apps and AI agents.

The full pitch, with every feature and its flow: [`docs/pitch.md`](docs/pitch.md).

# 2. Demo material

| | |
|---|---|
| HackQuest | [link to be added] |
| Demo video | [link to be added] |
| Pitch video | [link to be added] |
| Website | <https://exeunt.space> |
| API | <https://api.exeunt.space> |
| MCP server (Streamable HTTP) | <https://api.exeunt.space/mcp> |
| GitHub | [link to be added] |
| Test report | [`docs/test-report.md`](docs/test-report.md) |

The website has four networks: two live testnets, and two hosted forks that replay real freezes. On the forks, the demo wallet and the "Get demo funds" button give anyone a seller, borrower or bidder position in one click.

| Network | What it shows |
|---|---|
| Arbitrum Sepolia | Live Aave V3 testnet market; its WETH pool is already about 99.8% utilized |
| Robinhood Testnet | Live Morpho Blue + Vault V2 stack shaped like Robinhood Earn, on Paxos testnet USDG |
| Kelp replay | Arbitrum One forked at block 453,918,025 (18 Apr 2026), when Aave's WETH pool sat at 100% |
| Earn bank-run | Robinhood Chain forked at block 79,876,918 against the live Steakhouse USDG vault, after a bank run drains it |

Contracts on Arbitrum Sepolia:

| Contract | Address | Source |
|---|---|---|
| Exit market (aWETH) | [`0xD62db8A8eED08d2f81D9b838a37f3b54CF6df947`](https://sepolia.arbiscan.io/address/0xD62db8A8eED08d2f81D9b838a37f3b54CF6df947) | [`venues/aave`](contracts/src/venues/aave/AaveExitMarket.sol) |
| Exeunt Vault (WETH) | [`0x4E78CF9E2672d9f218d9Fd7cd9AeB06f5F027028`](https://sepolia.arbiscan.io/address/0x4E78CF9E2672d9f218d9Fd7cd9AeB06f5F027028) | [`vault`](contracts/src/vault/ExeuntVault.sol) |
| Frozen-collateral route | [`0x425fd6d6b23Da6ed8D915Bd7EFF405E64751bf3E`](https://sepolia.arbiscan.io/address/0x425fd6d6b23Da6ed8D915Bd7EFF405E64751bf3E) | [`route`](contracts/src/route/AaveCollateralRoute.sol) |
| Price router | [`0xECFdc42919334Ad7423C78dcF0CD9EDace258BE0`](https://sepolia.arbiscan.io/address/0xECFdc42919334Ad7423C78dcF0CD9EDace258BE0) | [`shared/oracle`](contracts/src/shared/oracle/PriceRouter.sol) |

Contracts on Robinhood Testnet (it has no Morpho deployment, so the deployment script brings up Morpho Blue, the AdaptiveCurveIrm and a Vault V2 shaped like Robinhood Earn):

| Contract | Address | Source |
|---|---|---|
| Exit market (Earn USDG shares) | [`0x8307e39e03619f9454c146EDdbD2C544A4499116`](https://explorer.testnet.chain.robinhood.com/address/0x8307e39e03619f9454c146EDdbD2C544A4499116) | [`venues/morpho`](contracts/src/venues/morpho/MorphoVaultExitMarket.sol) |
| Exeunt Vault (USDG) | [`0xaD5F6c0b898699bBcf3De4F64FfFa58Dc29D81d8`](https://explorer.testnet.chain.robinhood.com/address/0xaD5F6c0b898699bBcf3De4F64FfFa58Dc29D81d8) | [`vault`](contracts/src/vault/ExeuntVault.sol) |
| Earn USDG vault (Vault V2) | [`0x06FCA6bc7D8086afa2DCf8B1baDfe5AC7a1D301C`](https://explorer.testnet.chain.robinhood.com/address/0x06FCA6bc7D8086afa2DCf8B1baDfe5AC7a1D301C) | Morpho Vault V2 |
| Morpho Blue | [`0x3F36b776DF279B9284Eee44f534D020573c90200`](https://explorer.testnet.chain.robinhood.com/address/0x3F36b776DF279B9284Eee44f534D020573c90200) | Morpho Blue |
| Price router | [`0x1e474158f103102Ef4ad2Aa8AACdd93e3889b280`](https://explorer.testnet.chain.robinhood.com/address/0x1e474158f103102Ef4ad2Aa8AACdd93e3889b280) | [`shared/oracle`](contracts/src/shared/oracle/PriceRouter.sol) |

Both exit markets build on the shared core in [`contracts/src/market/ExitMarket.sol`](contracts/src/market/ExitMarket.sol): Dutch-auction sessions, escrowed limit bids, matching and pricing.

> [!NOTE]
> **Every contract is verified, and none of them can be changed.**
> - **Arbitrum Sepolia:** sources verified on Arbiscan and [Sourcify](https://sourcify.dev/#/lookup/0xD62db8A8eED08d2f81D9b838a37f3b54CF6df947).
> - **Robinhood Testnet:** all eleven contracts (Exeunt and the Morpho stack it runs on) verified on the Robinhood Testnet explorer.
> - **No admin:** there is no owner, no admin function and no upgrade path; every parameter is fixed at deployment. The contracts are not audited ([trust model](docs/security.md)).

# 3. Tech stack

- **Smart contracts:** Solidity 0.8.28, Foundry, OpenZeppelin Contracts 5.4
- **Lending venues:** Aave V3, Morpho Blue and Vault V2 with the AdaptiveCurveIrm
- **Prices:** Chainlink feeds behind an immutable price router; fixed $1 feeds for USDG and USDe where no feed exists
- **SDK and tools:** TypeScript, viem
- **MCP server:** Model Context Protocol SDK, stdio and Streamable HTTP
- **Backend:** Node.js, Express, Zod, pino, SQLite (node:sqlite)
- **Web app:** React, Vite
- **Testing:** Foundry unit, fuzz, invariant and fork tests; end-to-end runs on anvil forks and live testnets; headless Chrome tests of the hosted web app
- **Hosting:** Google Cloud VM, Cloudflare Tunnel, Caddy, systemd
- **Networks and tokens:** Arbitrum Sepolia, Robinhood Chain Testnet, Arbitrum One and Robinhood Chain forks; WETH, USDC, Paxos USDG

# 4. Setup

## 4.1. Requirements

- Node 20 or later.
- [Foundry](https://getfoundry.sh) (forge and anvil).
- An Arbitrum Sepolia RPC in `.env` as `ARB_SEPOLIA_RPC`, for the fork tests and deployments.
- Google Chrome, for the UI tests and the diagram and video renders (`CHROME_PATH` if it is not in a standard location).

The repository holds:

| Part | Where | What |
|---|---|---|
| Contracts | `contracts` | Solidity (Foundry): the `ExitMarket` core, Aave and Morpho venues, `ExeuntVault`, `AaveCollateralRoute`, price feeds, the deployment script. |
| SDK | `packages/sdk` | TypeScript (viem): reads, quotes, sell planning, unsigned transaction builders, Morpho EIP-712 signing. |
| MCP server | `packages/mcp` | 18 tools for AI agents: reads, quotes, simulation and unsigned transactions; never holds keys. |
| Fork kit | `packages/forkkit` | Anvil helpers: token balances, impersonation, time travel, demo position kits. |
| Web app | `apps/web` | React + Vite: Overview, Sell, Buy and repay, Earn, Frozen collateral, Developers. |
| Backend | `apps/backend` | Express: exit capacity history, utilization alerts with signed webhooks, fork faucet, JSON-RPC proxy for the hosted forks, hosted MCP. |
| End-to-end | `tools/e2e` | Unattended runner for forks and live testnets, `fork:up` for demo forks, headless Chrome UI tests. |
| Hosting | `infra` | VM provisioning, systemd units, Caddy, Cloudflare Tunnel. |
| Docs | `docs` | [Pitch](docs/pitch.md), [security model](docs/security.md), [test report](docs/test-report.md), diagrams and the pitch video source. |

## 4.2. How to run

### Install

```sh
git clone --recursive <repo> && cd exeunt
npm install
npm run abis                                              # export contract ABIs into the SDK (after contract changes)
npm run build -w @exeunt/sdk -w @exeunt/forkkit -w @exeunt/mcp
```

### Try it

```sh
npm run fork:up -w @exeunt/e2e -- --network=kelp-replay,earn-bank-run   # both replayed freezes on anvil (8602 / 8604), seeded
npm run dev -w @exeunt/backend                                           # API on http://127.0.0.1:8787
npm run dev -w @exeunt/web                                               # website on http://localhost:5173
```

Pick *Kelp replay* or *Earn bank-run* in the network selector, connect the demo wallet and use "Get demo funds" for a seller, borrower or bidder kit. Browser wallets are disabled on the forks, because the forks reuse the real chains' ids. On Arbitrum Sepolia and Robinhood Testnet, connect a browser wallet with testnet funds instead.

### Run the pieces yourself

```sh
cd contracts && forge build
```

The MCP server for an agent, over stdio:

```json
{ "mcpServers": { "exeunt": { "command": "node", "args": ["packages/mcp/dist/index.js"] } } }
```

The hosted backend serves the same server over Streamable HTTP at `https://api.exeunt.space/mcp`.

### Tests

```sh
cd contracts && forge test                                   # unit, fuzz, invariant, fork (fork tests skip without ARB_SEPOLIA_RPC)
npm test                                                     # SDK, MCP, backend, web
npm run e2e -w @exeunt/e2e -- --network=all                  # every flow on four forks, report in reports/
npm run e2e -w @exeunt/e2e -- --network=arbitrum-sepolia,robinhood-testnet --live   # real testnet funds
npm run ui -w @exeunt/e2e -- --url=https://exeunt.space       # drives the deployed website in headless Chrome
```

- **End-to-end runner:** it starts its own forks, deploys with the Foundry script, creates positions and runs every flow through the SDK with signed transactions. At every step it checks balances, debt, health and the pool's withdrawable liquidity.
- **Results:** the latest numbers for every tier are in [`docs/test-report.md`](docs/test-report.md).

### Deploy the contracts

Exeunt is already deployed on both testnets (addresses in section 2). Deploying again needs a funded deployer key in `.env`:

```sh
cd contracts
DEPLOY_NETWORK=arbitrum-sepolia forge script script/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC --broadcast
node script/fix-deploy-block.mjs arbitrum-sepolia 421614
```

- **Networks:** `DEPLOY_NETWORK` is one of `arbitrum-sepolia`, `robinhood-testnet`, `kelp-replay` or `earn-bank-run`; addresses are written to `contracts/deployments/<network>.json`.
- **Deploy block:** on Arbitrum chains `block.number` inside a contract is the L1 block, so `fix-deploy-block.mjs` rewrites the recorded deploy block to the L2 one that event queries need.
- **Robinhood Chain:** pass `--gas-estimate-multiplier 300`. It is an Arbitrum Orbit chain, and forge's local gas estimate leaves out its L1 data fee, so small transactions otherwise run out of gas.

### Verify the deployed contracts

```sh
# Arbitrum Sepolia: Arbiscan, then Sourcify
forge verify-contract <address> <path>:<Contract> --chain 421614 --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY --guess-constructor-args --rpc-url $ARB_SEPOLIA_RPC --watch
forge verify-contract <address> <path>:<Contract> --chain 421614 --verifier sourcify --watch

# Robinhood Testnet: its Blockscout explorer
forge verify-contract <address> <path>:<Contract> --chain 46630 --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/ --guess-constructor-args \
  --rpc-url https://rpc.testnet.chain.robinhood.com --watch
```

### Live deployment

The two live pieces:
- **The website** runs at **https://exeunt.space**, served by Caddy.
- **The API, MCP server and hosted forks** run at **api.exeunt.space**: one Google Cloud VM, reached only through a Cloudflare Tunnel.

```sh
CF_API_TOKEN=… node infra/cloudflare-tunnel.mjs   # tunnel, hostnames and DNS records for exeunt.space
bash infra/deploy.sh                               # build, ship and provision the VM
```

- **No keys on the server:** the VM holds no private keys.
- **Hosted forks:** both scenario forks run under systemd on localhost, on archive RPCs, and reset to their seeded state once a day.
- **JSON-RPC proxy:** the public reaches the forks only through the backend's `/rpc/<network>`, which forwards standard calls and signed transactions and blocks anvil's cheat methods, so visitors cannot rewrite the demo.

### Pitch video

The pitch video is built from [`docs/video`](docs/video): the narration in `script.json`, motion graphics in `scenes.html`, and `build.mjs`, which voices each line with OmniVoice, keeps the take Whisper transcribes best, adds burned-in captions and a music bed, and renders the frames in headless Chrome.

```sh
node docs/video/build.mjs                    # writes docs/video/out/exeunt-pitch.mp4
node docs/video/build.mjs --stills=12,40.5   # only PNG stills at those seconds
```

It needs `OMNIVOICE_URL` and `OMNIVOICE_API_KEY` in `.env`, a voice sample in `ref/voice-clone/`, Python with faster-whisper, ffmpeg, and a music bed generated with ACE-Step (the command is at the top of `build.mjs`).

### Design notes

- **Same-asset payments never touch an oracle.** Cross-asset quotes use Chainlink feeds with a staleness bound; USDG and USDe use fixed $1 feeds where no feed exists.
- **Buyers hold the pool's risk.** A buyer keeps the receipt until the pool is liquid again, including any bad debt.
- **Flash mode on Morpho** needs the buyer's signed authorization; the market applies a signed revoke in the same transaction and reverts if any authorization remains.
- **Full trust model and known limitations:** [`docs/security.md`](docs/security.md).

# 5. Copyright and License

Copyright (c) 2026 Exeunt contributors. Exeunt is released under the [MIT License](LICENSE).

Third-party dependencies keep their own licenses. In particular:
- **Morpho interfaces and libraries** (from Morpho Blue and Vault V2), which the exit markets import, are licensed under GPL-2.0-or-later.
- **Morpho Blue's core contract**, which the deployment script deploys on Robinhood Testnet, is licensed under BUSL-1.1.
- **The OmniVoice model** behind the pitch video's narration is licensed CC-BY-NC.
