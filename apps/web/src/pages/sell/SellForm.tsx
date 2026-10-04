import { useState } from "react";
import type { ExeuntClient, SellPlan } from "@exeunt/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { TxStatus } from "../../components/TxStatus";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatAmount, formatBps, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { poolTitle, receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { venueLabel } from "../../lib/networks";
import { allPayMask } from "../../lib/paymask";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";
import { AuctionSettings, defaultAuctionInputs, deriveSessionParams, type AuctionInputs } from "./AuctionSettings";
import { SellNowPreview } from "./SellNowPreview";

type Mode = "now" | "auction";

export function SellForm({ exeunt, meta }: { exeunt: ExeuntClient; meta: MarketMeta }) {
  const { info, refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const [mode, setMode] = useState<Mode>("now");
  const [amount, setAmount] = useState("");
  const [usingMax, setUsingMax] = useState(false);
  const [auction, setAuction] = useState<AuctionInputs>(() => defaultAuctionInputs(meta));
  const [plan, setPlan] = useState<SellPlan | null>(null);

  const position = useAsync(
    async () => {
      const owner = address ?? "0x";
      const [value, units] = await Promise.all([exeunt.receiptValueOf(owner), exeunt.balanceOf(meta.receipt.address, owner)]);
      return { value, units };
    },
    [exeunt, address],
    { reloadKey: refreshKey, enabled: address !== null, pollMs: 20_000 },
  );
  const market = useAsync(
    async () => {
      const [cap, bids] = await Promise.all([exeunt.capacity(), exeunt.bids()]);
      return { cap, bids };
    },
    [exeunt],
    { reloadKey: refreshKey, pollMs: 15_000 },
  );

  const u = meta.underlying;
  const parsed = parseAmountInput(amount, u.decimals);
  const balance = position.data?.value;
  const assets = parsed.value;
  const amountError =
    parsed.error ??
    (assets !== null && balance !== undefined && assets > balance ? `You hold ${formatToken(balance, u)}` : null) ??
    (assets === 0n ? "Enter more than zero" : null);
  const validAssets = assets !== null && assets > 0n && !amountError ? assets : null;
  const bestBid = market.data?.bids.find((b) => b.capacityAssets > 0n);
  const util = market.data?.cap.utilizationBps;
  const busy = runner.state.busy !== null;
  const auctionParams = deriveSessionParams(auction, meta);

  const setMax = () => {
    if (balance === undefined) return;
    setAmount(toInputString(balance, u.decimals));
    setUsingMax(true);
    runner.reset();
  };

  const sellNowSteps = async (): Promise<TxStep[]> => {
    if (!address || !plan || plan.filledAssets === 0n) throw new Error("No bid can fill this sale right now.");
    const worst = plan.fills.reduce((m, f) => Math.max(m, f.discountBps), 0);
    // aTokens and vault shares both round up per fill; a few wei of extra allowance covers it.
    const allowance =
      meta.venue === "aave"
        ? withATokenMargin(plan.filledAssets, plan.fills.length)
        : (await exeunt.receiptAmountFor(plan.filledAssets)) + BigInt(plan.fills.length);
    const approve = await approvalStep(exeunt, meta.receipt, address, exeunt.market, allowance, "so the market can hand them to the buyers");
    return [
      ...(approve ? [approve] : []),
      {
        label: `Sell ${formatToken(plan.filledAssets, u)} into ${plan.fills.length} bid${plan.fills.length > 1 ? "s" : ""}`,
        // The previewed bids, capped at the worst previewed discount, all-or-nothing: what you saw is the worst case.
        tx: exeunt.sellNow(plan, worst, allPayMask(meta.payTokens.length), plan.filledAssets),
      },
    ];
  };

  const auctionSteps = async (): Promise<TxStep[]> => {
    if (!address || !validAssets || !auctionParams.params) throw new Error(auctionParams.error ?? "Check the auction settings.");
    const receiptAmount = usingMax
      ? await exeunt.balanceOf(meta.receipt.address, address)
      : await exeunt.receiptAmountFor(validAssets);
    const allowance = meta.venue === "aave" ? withATokenMargin(receiptAmount, 1) : receiptAmount;
    const approve = await approvalStep(exeunt, meta.receipt, address, exeunt.market, allowance, "so the market can hold them in escrow");
    return [
      ...(approve ? [approve] : []),
      { label: `Open an auction for ${formatToken(validAssets, u)}`, tx: exeunt.openSession(receiptAmount, auctionParams.params) },
    ];
  };

  const canSellNow = !!plan && plan.filledAssets > 0n && !!validAssets;
  const canAuction = !!validAssets && !!auctionParams.params;
  const blocked = wallet.writeBlockedReason;

  return (
    <div className="split split--top">
      <section aria-labelledby="h-pos" className="stack col-narrow">
        <h2 id="h-pos" className="h2-sm">
          1. Pick a position
        </h2>
        {!address ? (
          <Notice tone="neutral">Connect a wallet to load the position you want to sell.</Notice>
        ) : (
          <button type="button" className="choice choice--card" aria-pressed="true" data-testid="sell-position">
            <span className="choice-row">
              <span className="choice-title">{receiptNoun(meta)}</span>
              <span className="mono" data-testid="sell-position-balance">
                {position.data ? formatToken(position.data.value, u) : position.error ? "—" : "…"}
              </span>
            </span>
            <span className="choice-desc">
              {venueLabel(info)} · {poolTitle(meta)} pool {util !== undefined ? `${formatBps(util)} utilized` : ""}
              {meta.venue === "morpho" && position.data
                ? ` · ${formatAmount(position.data.units, meta.receipt.decimals)} shares`
                : ""}
            </span>
          </button>
        )}
        {position.error ? <Notice tone="danger">Can't read your position: {describeError(position.error)}</Notice> : null}
        {address && position.data?.value === 0n && (
          <div className="stack-sm">
            <Notice tone="neutral">
              You hold no {receiptNoun(meta)} on {info.label}, so there is nothing to sell here yet.
            </Notice>
            <DemoFunds kits={["seller"]} compact />
          </div>
        )}
      </section>

      <section aria-labelledby="h-how-sell" className="card card--pad stack col-wide">
        <h2 id="h-how-sell" className="h2-sm">
          2. Choose how to sell
        </h2>
        <div className="choices" role="group" aria-label="How to sell">
          <button
            type="button"
            className="choice"
            aria-pressed={mode === "now"}
            data-testid="sell-mode-now"
            onClick={() => {
              setMode("now");
              runner.reset();
            }}
          >
            <span className="choice-title">Sell now</span>
            <span className="choice-desc">
              Fill against limit bids and the Exeunt Vault, best price first.{" "}
              {bestBid ? `Best bid: ${formatBps(bestBid.minDiscountBps)} discount.` : "No bids right now."}
            </span>
          </button>
          <button
            type="button"
            className="choice"
            aria-pressed={mode === "auction"}
            data-testid="sell-mode-auction"
            onClick={() => {
              setMode("auction");
              runner.reset();
            }}
          >
            <span className="choice-title">Run an auction</span>
            <span className="choice-desc">
              Discount starts at {auction.start || "…"}% and rises until a borrower, the Exeunt Vault or a limit bid
              buys. Withdraw what is unsold anytime.
            </span>
          </button>
        </div>

        <AmountField
          id="sell-amt"
          label={`Amount of ${receiptNoun(meta)} to sell (${u.symbol} value)`}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            setUsingMax(false);
            runner.reset();
          }}
          onMax={balance !== undefined && balance > 0n ? setMax : undefined}
          hint={balance !== undefined ? `You hold ${formatToken(balance, u)}` : undefined}
          error={amount ? amountError : null}
          testid="sell-amount"
        />

        {mode === "now" ? (
          <SellNowPreview exeunt={exeunt} meta={meta} assets={validAssets} bids={market.data?.bids} onPlan={setPlan} />
        ) : (
          <AuctionSettings
            meta={meta}
            bids={market.data?.bids ?? []}
            inputs={auction}
            onChange={(next) => {
              setAuction(next);
              runner.reset();
            }}
          />
        )}

        {blocked && address ? <Notice tone="warn">{blocked}</Notice> : null}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          data-testid="sell-submit"
          disabled={!address || !!blocked || busy || (mode === "now" ? !canSellNow : !canAuction)}
          onClick={() => void runner.send(mode === "now" ? sellNowSteps : auctionSteps)}
        >
          {busy ? "Working…" : mode === "now" ? "Sell now" : "Open auction"}
        </button>
        <TxStatus state={runner.state} />
      </section>
    </div>
  );
}
