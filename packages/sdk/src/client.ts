import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  parseSignature,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  aavePoolAbi,
  erc20Abi,
  exeuntVaultAbi,
  morphoAbi,
  morphoAdapterAbi,
  vaultV2Abi,
} from "./abis/index.js";
import type { Deployment } from "./networks.js";
import type {
  BidView,
  BorrowerPosition,
  CapacityView,
  MorphoMarketParams,
  SellPlan,
  SessionParams,
  SessionView,
  TokenInfo,
  UnsignedTx,
} from "./types.js";

const BPS = 10_000n;
const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

const irmAbi = [
  {
    type: "function",
    name: "borrowRateView",
    stateMutability: "view",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const MARKET_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

const AUTH_TUPLE = {
  type: "tuple",
  components: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const SIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;

/** Morpho market id: keccak256(abi.encode(marketParams)). */
export function morphoMarketId(mp: MorphoMarketParams): Hex {
  return keccak256(encodeAbiParameters([MARKET_PARAMS_TUPLE], [mp]));
}

/**
 * Read and transaction-building client for one Exeunt deployment.
 * Every write method returns an unsigned transaction; signing is left to the caller's wallet.
 */
export class ExeuntClient {
  readonly deployment: Deployment;
  readonly client: PublicClient;
  private tokenCache = new Map<Address, TokenInfo>();

  constructor(deployment: Deployment, client: PublicClient) {
    this.deployment = deployment;
    this.client = client;
  }

  get market(): Address {
    return this.deployment.market;
  }

  /* ------------------------------------------------------------------ */
  /*                                Reads                                */
  /* ------------------------------------------------------------------ */

  async token(address: Address): Promise<TokenInfo> {
    const cached = this.tokenCache.get(address);
    if (cached) return cached;
    const [symbol, decimals] = await Promise.all([
      this.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const info = { address, symbol, decimals };
    this.tokenCache.set(address, info);
    return info;
  }

  async payTokens(): Promise<TokenInfo[]> {
    return Promise.all(this.deployment.payTokens.map((t) => this.token(t)));
  }

  async capacity(): Promise<CapacityView> {
    const c = await this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "capacity" });
    return {
      withdrawable: c.withdrawable,
      supplied: c.supplied,
      utilizationBps: Number(c.utilizationBps),
      debtorCapacity: c.debtorCapacity,
      sessionAssets: c.sessionAssets,
    };
  }

  /** Receipt value escrowed bids would buy from a seller who accepts up to `discountBps`. */
  async bidCapacityAt(discountBps: number): Promise<bigint> {
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "bidCapacityAt",
      args: [discountBps],
    });
  }

  async session(id: bigint): Promise<SessionView> {
    const [raw, discount, remaining, open] = await Promise.all([
      this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "sessions", args: [id] }),
      this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "discountOf", args: [id] }),
      this.client.readContract({
        address: this.market,
        abi: aaveExitMarketAbi,
        functionName: "remainingAssets",
        args: [id],
      }),
      this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "isOpen", args: [id] }),
    ]);
    const [seller, startedAt, endsAt, startBps, stepBps, capBps, payMask, stepInterval, units] = raw;
    return {
      id,
      seller,
      startedAt: Number(startedAt),
      endsAt: Number(endsAt),
      startBps,
      stepBps,
      capBps,
      payMask,
      stepInterval,
      units,
      discountBps: discount,
      remainingAssets: remaining,
      open,
      acceptedPayTokens: this.deployment.payTokens.filter((_, i) => (payMask >> i) & 1),
    };
  }

  /** All sessions ever opened, newest first. Pass `openOnly` to drop closed or empty ones. */
  async sessions(openOnly = false): Promise<SessionView[]> {
    const next = await this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "nextSessionId",
    });
    const ids: bigint[] = [];
    for (let i = next - 1n; i >= 1n; i--) ids.push(i);
    const all = await Promise.all(ids.map((id) => this.session(id)));
    return openOnly ? all.filter((s) => s.open) : all;
  }

  /** Active escrowed bids, best price for sellers first (lowest discount). */
  async bids(): Promise<BidView[]> {
    const ids = await this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "activeBidIds",
    });
    const views = await Promise.all(
      ids.map(async (id) => {
        const [bidder, minDiscountBps, payIdx, maxAssets, escrow] = await this.client.readContract({
          address: this.market,
          abi: aaveExitMarketAbi,
          functionName: "bids",
          args: [id],
        });
        const capacityAssets = await this.client.readContract({
          address: this.market,
          abi: aaveExitMarketAbi,
          functionName: "bidCapacity",
          args: [id, minDiscountBps],
        });
        const payToken = this.deployment.payTokens[payIdx] ?? zeroAddress;
        return { id, bidder, minDiscountBps, payIdx, payToken, maxAssets, escrow, capacityAssets };
      }),
    );
    return views.sort((a, b) => a.minDiscountBps - b.minDiscountBps || Number(a.id - b.id));
  }

  async quote(assets: bigint, discountBps: number, payToken: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "quote",
      args: [assets, discountBps, payToken],
    });
  }

  async balanceOf(token: Address, account: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  }

  /** Underlying value of the account's receipts (aToken balance, or vault shares converted). */
  async receiptValueOf(account: Address): Promise<bigint> {
    const bal = await this.balanceOf(this.deployment.receipt, account);
    if (this.deployment.venue === "aave") return bal;
    return this.client.readContract({
      address: this.deployment.receipt,
      abi: vaultV2Abi,
      functionName: "previewRedeem",
      args: [bal],
    });
  }

  /** Converts an underlying amount into the receipt-token amount a seller escrows. */
  async receiptAmountFor(assets: bigint): Promise<bigint> {
    if (this.deployment.venue === "aave") return assets;
    return this.client.readContract({
      address: this.deployment.receipt,
      abi: vaultV2Abi,
      functionName: "previewWithdraw",
      args: [assets],
    });
  }

  /**
   * Aave flash mode pulls this many extra aToken wei to absorb rounding and refunds what is unused.
   * Approve `price + collateralPullMargin(payToken)`. Zero on Morpho.
   */
  async collateralPullMargin(payToken: Address): Promise<bigint> {
    if (this.deployment.venue !== "aave") return 0n;
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "collateralPullMargin",
      args: [payToken],
    });
  }

  async allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
  }

  /* ----------------------------- borrowers ----------------------------- */

  /** Same-asset debt and health of a borrower; for Morpho, picks the adapter market with the largest debt. */
  async position(account: Address): Promise<BorrowerPosition> {
    const d = this.deployment;
    if (d.venue === "aave") {
      const [debt, data] = await Promise.all([
        this.balanceOf(d.debtToken as Address, account),
        this.client.readContract({
          address: d.aavePool as Address,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [account],
        }),
      ]);
      return { debt, health: data[5] };
    }
    const markets = await this.morphoMarkets();
    let best: BorrowerPosition = { debt: 0n, health: maxUint256 };
    for (const { id, params } of markets) {
      const [pos, m] = await Promise.all([
        this.client.readContract({
          address: d.morpho as Address,
          abi: morphoAbi,
          functionName: "position",
          args: [id, account],
        }),
        this.client.readContract({ address: d.morpho as Address, abi: morphoAbi, functionName: "market", args: [id] }),
      ]);
      const borrowShares = pos[1];
      if (borrowShares === 0n) continue;
      const totalBorrowAssets = await this.expectedTotalBorrow(params, m);
      const totalBorrowShares = m[3];
      // Same rounding as Morpho's toAssetsUp with virtual shares/assets.
      const debt =
        (borrowShares * (totalBorrowAssets + VIRTUAL_ASSETS) + totalBorrowShares + VIRTUAL_SHARES - 1n) /
        (totalBorrowShares + VIRTUAL_SHARES);
      if (debt <= best.debt) continue;
      const price = await this.client.readContract({
        address: params.oracle,
        abi: [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "price",
      });
      const maxBorrow = (((pos[2] * price) / ORACLE_SCALE) * params.lltv) / WAD;
      best = { debt, health: (maxBorrow * WAD) / debt, market: params, marketId: id, collateral: pos[2] };
    }
    return best;
  }

  /** Total borrow including interest accrued since the market's last update (Morpho's expectedMarketBalances). */
  private async expectedTotalBorrow(
    params: MorphoMarketParams,
    m: readonly [bigint, bigint, bigint, bigint, bigint, bigint],
  ): Promise<bigint> {
    const [, , totalBorrowAssets, , lastUpdate] = m;
    if (params.irm === zeroAddress || totalBorrowAssets === 0n) return totalBorrowAssets;
    const block = await this.client.getBlock();
    const elapsed = block.timestamp - lastUpdate;
    if (elapsed <= 0n) return totalBorrowAssets;
    const rate = await this.client.readContract({
      address: params.irm,
      abi: irmAbi,
      functionName: "borrowRateView",
      args: [
        params,
        {
          totalSupplyAssets: m[0],
          totalSupplyShares: m[1],
          totalBorrowAssets: m[2],
          totalBorrowShares: m[3],
          lastUpdate: m[4],
          fee: m[5],
        },
      ],
    });
    const first = rate * elapsed;
    const second = (first * first) / (2n * WAD);
    const third = (second * first) / (3n * WAD);
    return totalBorrowAssets + (totalBorrowAssets * (first + second + third)) / WAD;
  }

  private morphoMarketCache?: { id: Hex; params: MorphoMarketParams }[];

  /** Morpho markets the Earn vault supplies through its adapter. */
  async morphoMarkets(): Promise<{ id: Hex; params: MorphoMarketParams }[]> {
    if (this.morphoMarketCache) return this.morphoMarketCache;
    const d = this.deployment;
    const n = await this.client.readContract({
      address: d.adapter as Address,
      abi: morphoAdapterAbi,
      functionName: "marketIdsLength",
    });
    const out: { id: Hex; params: MorphoMarketParams }[] = [];
    for (let i = 0n; i < n; i++) {
      const id = await this.client.readContract({
        address: d.adapter as Address,
        abi: morphoAdapterAbi,
        functionName: "marketIds",
        args: [i],
      });
      const [loanToken, collateralToken, oracle, irm, lltv] = await this.client.readContract({
        address: d.morpho as Address,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [id],
      });
      out.push({ id, params: { loanToken, collateralToken, oracle, irm, lltv } });
    }
    this.morphoMarketCache = out;
    return out;
  }

  /** Venue data for buy calls: empty for Aave; market, forced deallocation flag and optional auth for Morpho. */
  async venueData(account: Address, opts: { force?: boolean; auth?: Hex } = {}): Promise<Hex> {
    if (this.deployment.venue === "aave") return "0x";
    const pos = await this.position(account);
    if (!pos.market) throw new Error("account has no USDG debt in the Earn vault's markets");
    return encodeAbiParameters(
      [MARKET_PARAMS_TUPLE, { type: "bool" }, { type: "bytes" }],
      [pos.market, opts.force ?? false, opts.auth ?? "0x"],
    );
  }

  /**
   * Morpho flash mode: the buyer signs a grant and a revoke (two EIP-712 signatures, no transaction).
   * The market uses the grant to withdraw only the freed collateral and applies the revoke in the same transaction.
   */
  async signMorphoAuthorization(wallet: WalletClient, account: Address, deadlineSeconds = 3600): Promise<Hex> {
    const d = this.deployment;
    if (d.venue !== "morpho") throw new Error("authorization is only needed on Morpho");
    const nonce = await this.client.readContract({
      address: d.morpho as Address,
      abi: morphoAbi,
      functionName: "nonce",
      args: [account],
    });
    const chainId = await this.client.getChainId();
    // Forks can run behind or ahead of wall-clock time; count from whichever is later.
    const block = await this.client.getBlock();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = (block.timestamp > now ? block.timestamp : now) + BigInt(deadlineSeconds);
    const domain = { chainId, verifyingContract: d.morpho as Address } as const;
    const types = {
      Authorization: [
        { name: "authorizer", type: "address" },
        { name: "authorized", type: "address" },
        { name: "isAuthorized", type: "bool" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;
    const grant = { authorizer: account, authorized: d.market, isAuthorized: true, nonce, deadline };
    const revoke = { ...grant, isAuthorized: false, nonce: nonce + 1n };
    const sign = async (message: typeof grant) => {
      // Prefer the wallet's own (local or injected) account; an address alone makes viem ask the RPC node to sign.
      const signer = wallet.account && wallet.account.address.toLowerCase() === account.toLowerCase() ? wallet.account : account;
      const sig = await wallet.signTypedData({
        account: signer,
        domain,
        types,
        primaryType: "Authorization",
        message,
      });
      const { r, s, v, yParity } = parseSignature(sig);
      return { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s };
    };
    const gs = await sign(grant);
    const rs = await sign(revoke);
    return encodeAbiParameters([AUTH_TUPLE, SIG_TUPLE, AUTH_TUPLE, SIG_TUPLE], [grant, gs, revoke, rs]);
  }

  /* ----------------------------- planning ------------------------------ */

  /** Best-price-first plan for selling `assets` into escrowed bids up to `maxDiscountBps`. */
  async planSellNow(assets: bigint, maxDiscountBps: number, payMask: number): Promise<SellPlan> {
    const bids = (await this.bids()).filter(
      (b) => b.minDiscountBps <= maxDiscountBps && ((payMask >> b.payIdx) & 1) === 1 && b.capacityAssets > 0n,
    );
    const plan: SellPlan = { bidIds: [], fills: [], filledAssets: 0n, proceeds: {}, averageDiscountBps: 0 };
    let weighted = 0n;
    for (const b of bids) {
      if (plan.filledAssets >= assets) break;
      const left = assets - plan.filledAssets;
      const f = b.capacityAssets < left ? b.capacityAssets : left;
      const pay = await this.quote(f, b.minDiscountBps, b.payToken);
      plan.bidIds.push(b.id);
      plan.fills.push({ bidId: b.id, assets: f, pay, payToken: b.payToken, discountBps: b.minDiscountBps });
      plan.filledAssets += f;
      plan.proceeds[b.payToken] = (plan.proceeds[b.payToken] ?? 0n) + pay;
      weighted += f * BigInt(b.minDiscountBps);
    }
    plan.averageDiscountBps = plan.filledAssets === 0n ? 0 : Number(weighted / plan.filledAssets);
    return plan;
  }

  /** Largest purchase a borrower can make from a session: the smaller of what is left and their debt. */
  async maxBuy(sessionId: bigint, account: Address): Promise<bigint> {
    const [s, pos] = await Promise.all([this.session(sessionId), this.position(account)]);
    return s.remainingAssets < pos.debt ? s.remainingAssets : pos.debt;
  }

  /* --------------------------- tx builders ---------------------------- */

  private tx(to: Address, data: Hex, description: string): UnsignedTx {
    return { to, data, value: 0n, description };
  }

  approve(token: Address, spender: Address, amount: bigint = maxUint256): UnsignedTx {
    return this.tx(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
      `Approve ${spender} to spend token ${token}`,
    );
  }

  openSession(receiptAmount: bigint, p: SessionParams): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "openSession", args: [receiptAmount, p] }),
      "Escrow receipts and open a Dutch-auction exit session",
    );
  }

  withdrawUnsold(sessionId: bigint, units: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "withdrawUnsold", args: [sessionId, units] }),
      "Take back unsold receipts from a session",
    );
  }

  buyAndRepay(sessionId: bigint, assets: bigint, payIdx: number, maxPay: bigint, venueData: Hex): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "buyAndRepay",
        args: [sessionId, assets, payIdx, maxPay, venueData],
      }),
      "Buy receipts at the current discount; the market repays your debt in the same transaction",
    );
  }

  buyAndRepayWithCollateral(
    sessionId: bigint,
    assets: bigint,
    payIdx: number,
    maxPay: bigint,
    venueData: Hex,
  ): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "buyAndRepayWithCollateral",
        args: [sessionId, assets, payIdx, maxPay, venueData],
      }),
      "Flash mode: repay debt first, then pay the seller with the collateral that frees up",
    );
  }

  placeBid(minDiscountBps: number, payIdx: number, maxAssets: bigint, escrow: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "placeBid",
        args: [minDiscountBps, payIdx, maxAssets, escrow],
      }),
      "Escrow funds and place a limit bid for receipts",
    );
  }

  cancelBid(bidId: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "cancelBid", args: [bidId] }),
      "Cancel a limit bid and get unused escrow back immediately",
    );
  }

  sellNow(plan: SellPlan, maxDiscountBps: number, payMask: number, minFilled: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "sellNow",
        args: [plan.filledAssets, plan.bidIds, maxDiscountBps, payMask, minFilled],
      }),
      "Sell receipts now into escrowed bids, best price first",
    );
  }

  matchBid(sessionId: bigint, bidId: bigint, assets: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "matchBid", args: [sessionId, bidId, assets] }),
      "Fill a limit bid from a session whose discount has reached it",
    );
  }

  redeemReceipt(assets: bigint, to: Address): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "redeemReceipt", args: [assets, to] }),
      "Redeem receipts for the underlying once the pool is liquid",
    );
  }

  /* ----------------------------- vault ----------------------------- */

  vaultDeposit(assets: bigint, receiver: Address): UnsignedTx {
    return this.tx(
      this.deployment.exeuntVault,
      encodeFunctionData({ abi: exeuntVaultAbi, functionName: "deposit", args: [assets, receiver] }),
      "Deposit into the Exeunt Vault",
    );
  }

  vaultRedeem(shares: bigint, receiver: Address, owner: Address): UnsignedTx {
    return this.tx(
      this.deployment.exeuntVault,
      encodeFunctionData({ abi: exeuntVaultAbi, functionName: "redeem", args: [shares, receiver, owner] }),
      "Redeem vault shares: idle capital now, held receipts in kind",
    );
  }

  vaultRecover(strategy = 0n, assets: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.deployment.exeuntVault,
      encodeFunctionData({ abi: exeuntVaultAbi, functionName: "recover", args: [strategy, assets] }),
      "Redeem receipts held by the vault now that the pool is liquid",
    );
  }

  async vaultState(account?: Address) {
    const v = this.deployment.exeuntVault;
    const [totalAssets, idleAssets, heldAssets, totalSupply, decimals, bidId] = await Promise.all([
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "totalAssets" }),
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "idleAssets" }),
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "heldAssets", args: [0n] }),
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "totalSupply" }),
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "decimals" }),
      this.client.readContract({ address: v, abi: exeuntVaultAbi, functionName: "bidOf", args: [0n] }),
    ]);
    const strategy = await this.client.readContract({
      address: v,
      abi: exeuntVaultAbi,
      functionName: "strategy",
      args: [0n],
    });
    let shares = 0n;
    let preview: readonly [bigint, readonly bigint[]] = [0n, []];
    if (account) {
      shares = await this.balanceOf(v, account);
      preview = await this.client.readContract({
        address: v,
        abi: exeuntVaultAbi,
        functionName: "previewRedeem",
        args: [shares],
      });
    }
    return {
      totalAssets,
      idleAssets,
      heldAssets,
      totalSupply,
      decimals,
      bidId,
      minDiscountBps: strategy.minDiscountBps,
      maxShareBps: strategy.maxShareBps,
      shares,
      redeemNow: preview[0],
      redeemInKind: preview[1][0] ?? 0n,
    };
  }

  /* --------------------------- borrower route --------------------------- */

  routeRepayWithFrozenCollateral(
    collateralAmount: bigint,
    plan: SellPlan,
    maxDiscountBps: number,
    payIdx: number,
    repayAmount: bigint,
  ): UnsignedTx {
    const route = this.requireRoute();
    return this.tx(
      route,
      encodeFunctionData({
        abi: aaveCollateralRouteAbi,
        functionName: "repayWithFrozenCollateral",
        args: [this.market, collateralAmount, plan.bidIds, maxDiscountBps, payIdx, repayAmount],
      }),
      "Repay debt by selling frozen collateral into bids (no withdrawal needed)",
    );
  }

  routeSwapFrozenCollateral(
    collateralAmount: bigint,
    plan: SellPlan,
    maxDiscountBps: number,
    payIdx: number,
    minProceeds: bigint,
  ): UnsignedTx {
    const route = this.requireRoute();
    return this.tx(
      route,
      encodeFunctionData({
        abi: aaveCollateralRouteAbi,
        functionName: "swapFrozenCollateral",
        args: [this.market, collateralAmount, plan.bidIds, maxDiscountBps, payIdx, minProceeds],
      }),
      "Swap frozen collateral for new collateral by selling it into bids",
    );
  }

  private requireRoute(): Address {
    const r = this.deployment.collateralRoute;
    if (!r) throw new Error("the frozen-collateral route exists on Aave networks only");
    return r;
  }

  /* ---------------------------- simulation ---------------------------- */

  /** Dry-runs an unsigned transaction from `account`; resolves on success, throws the revert reason otherwise. */
  async simulate(tx: UnsignedTx, account: Address): Promise<void> {
    await this.client.call({ account, to: tx.to, data: tx.data, value: tx.value });
  }
}

export { BPS, WAD };
