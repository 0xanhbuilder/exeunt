import { useState } from "react";
import { encodeFunctionData, isAddressEqual, type Address } from "viem";
import { aavePoolAbi, type ExeuntClient } from "@exeunt/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { Check, Cross, ArrowRight } from "../../components/Icons";
import { TxStatus } from "../../components/TxStatus";
import { Notice, Stat, SummaryRow, ToggleGroup } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { estimateAaveHealthAfter, valueInBase } from "../../lib/estimates";
import { formatHealth, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { buildPayMask } from "../../lib/paymask";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { aaveAccount, aavePoolPremiumBps, aaveVariableDebt, priceOf, type AaveAccount } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";

type Action = "repay" | "swap";

/** Keeps a 0.1% margin under the previewed proceeds: the route leaves a few wei per bid unsold. */
const SLACK_BPS = 10n;
const BPS = 10_000n;

interface RouteData {
  collateral: bigint;
  account: AaveAccount;
  /** Variable debt per payment token; null when this RPC cannot read it. */
  debts: (bigint | null)[];
  withdrawable: bigint;
  premiumBps: bigint;
}

async function loadRouteData(exeunt: ExeuntClient, meta: MarketMeta, user: Address): Promise<RouteData> {
  const [collateral, account, cap, premiumBps, debts] = await Promise.all([
    exeunt.balanceOf(meta.receipt.address, user),
    aaveAccount(exeunt, user),
    exeunt.capacity(),
    aavePoolPremiumBps(exeunt),
    Promise.all(meta.payTokens.map((t) => aaveVariableDebt(exeunt, t.address, user).catch(() => null))),
  ]);
  return { collateral, account, debts, withdrawable: cap.withdrawable, premiumBps };
}

/** Dry-runs a plain Aave withdrawal; null means it would work, so the fallback route must not be used. */
async function directWithdrawBlocked(exeunt: ExeuntClient, meta: MarketMeta, user: Address, amount: bigint): Promise<string | null> {
  const pool = exeunt.deployment.aavePool;
  if (!pool) return "not an Aave deployment";
  try {
    await exeunt.client.call({
      account: user,
      to: pool,
      data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [meta.underlying.address, amount, user] }),
    });
    return null;
  } catch (e) {
    return describeError(e);
  }
}

export function FrozenRoute({ exeunt, meta, route }: { exeunt: ExeuntClient; meta: MarketMeta; route: Address }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const [action, setAction] = useState<Action>("repay");
  const [amount, setAmount] = useState("");
  const [payChoice, setPayChoice] = useState<number | null>(null);

  const u = meta.underlying;
  const data = useAsync(() => loadRouteData(exeunt, meta, address ?? "0x"), [exeunt, meta, address], {
    reloadKey: refreshKey,
    enabled: address !== null,
    pollMs: 30_000,
  });
  const d = data.data;

  const parsed = parseAmountInput(amount, u.decimals);
  const amountError =
    parsed.error ??
    (parsed.value !== null && d && parsed.value > d.collateral ? `You hold ${formatToken(d.collateral, meta.receipt)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const sellAmount = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;

  // Never the frozen asset itself: the route flash-borrows the debt asset from Aave, and a frozen pool cannot
  // lend it. Repay: debts the bids can pay in. Swap: any other payment token.
  const isFrozenAsset = (t: { address: Address }) => isAddressEqual(t.address, u.address);
  const choices = meta.payTokens
    .map((t, i) => ({ t, i, debt: d?.debts[i] ?? null }))
    .filter((c) => !isFrozenAsset(c.t) && (action === "swap" || c.debt === null || c.debt > 0n));
  const frozenAssetIdx = meta.payTokens.findIndex(isFrozenAsset);
  const sameAssetDebt = frozenAssetIdx >= 0 ? (d?.debts[frozenAssetIdx] ?? null) : null;
  const payIdx = payChoice !== null && choices.some((c) => c.i === payChoice) ? payChoice : (choices[0]?.i ?? null);
  const payToken = payIdx !== null ? meta.payTokens[payIdx] : undefined;

  const direct = useAsync(
    () => directWithdrawBlocked(exeunt, meta, address ?? "0x", sellAmount ?? d?.collateral ?? 0n),
    [exeunt, address, sellAmount, d?.collateral],
    { reloadKey: refreshKey, enabled: address !== null && d !== undefined && (sellAmount ?? d?.collateral ?? 0n) > 0n },
  );
  const directWorks = direct.data === null && !direct.loading;

  const plan = useAsync(
    () => exeunt.planSellNow(sellAmount ?? 0n, meta.maxDiscountBps, buildPayMask([payIdx ?? 0])),
    [exeunt, sellAmount, payIdx],
    { reloadKey: refreshKey, enabled: sellAmount !== null && payIdx !== null, pollMs: 20_000 },
  );
  const prices = useAsync(
    () => Promise.all([priceOf(exeunt, u.address), priceOf(exeunt, payToken?.address ?? u.address)]),
    [exeunt, payToken?.address],
    { enabled: payToken !== undefined },
  );

  const p = plan.data;
  const proceeds = p && payToken ? (p.proceeds[payToken.address] ?? 0n) : null;
  const worst = p ? p.fills.reduce((m, f) => Math.max(m, f.discountBps), 0) : 0;
  const debt = payIdx !== null ? (d?.debts[payIdx] ?? null) : null;
  let repay: bigint | null = null;
  let minProceeds: bigint | null = null;
  if (proceeds !== null && d) {
    const safe = (proceeds * (BPS - SLACK_BPS)) / BPS;
    if (action === "repay") {
      // The route repays first with an Aave flash loan of the debt asset; the premium comes out of the proceeds.
      const net = (safe * BPS) / (BPS + d.premiumBps);
      // Interest accrues until the transaction lands; when the proceeds cover the whole debt, ask for 0.01% more so
      // it clears completely. Aave repays at most the debt and the route returns whatever is left over.
      const all = debt !== null ? debt + debt / BPS + 1n : null;
      repay = all !== null && all < net ? all : net;
    } else minProceeds = safe;
  }

  let healthAfter: bigint | null = null;
  if (d && p && prices.data && payToken && proceeds !== null) {
    const [pu, pp] = prices.data;
    healthAfter = estimateAaveHealthAfter({
      totalCollateralBase: d.account.totalCollateralBase,
      totalDebtBase: d.account.totalDebtBase,
      liquidationThresholdBps: d.account.liquidationThresholdBps,
      collateralRemovedBase: valueInBase(p.filledAssets, u.decimals, pu),
      collateralAddedBase: action === "swap" ? valueInBase(proceeds, payToken.decimals, pp) : 0n,
      debtRepaidBase: action === "repay" && repay !== null ? valueInBase(repay, payToken.decimals, pp) : 0n,
    });
  }

  const build = async (): Promise<TxStep[]> => {
    if (!address || sellAmount === null || payIdx === null || !p || p.filledAssets === 0n) {
      throw new Error("No bid can buy this collateral right now.");
    }
    const approve = await approvalStep(exeunt, meta.receipt, address, route, withATokenMargin(sellAmount, 1), "so the route can sell them for you");
    const main =
      action === "repay"
        ? {
            label: `Sell up to ${formatToken(sellAmount, meta.receipt)} and repay ${repay !== null && payToken ? formatToken(repay, payToken) : "debt"}`,
            tx: exeunt.routeRepayWithFrozenCollateral(sellAmount, p, worst, payIdx, repay ?? 0n),
          }
        : {
            label: `Sell up to ${formatToken(sellAmount, meta.receipt)} and supply the proceeds as ${payToken?.symbol ?? ""} collateral`,
            tx: exeunt.routeSwapFrozenCollateral(sellAmount, p, worst, payIdx, minProceeds ?? 0n),
          };
    return [...(approve ? [approve] : []), main];
  };

  const simulated = runner.state.outcome === "simulated" || runner.state.outcome === "partial";
  const ready =
    !!address && sellAmount !== null && payIdx !== null && !!p && p.filledAssets > 0n && !directWorks && !direct.loading;
  const reset = () => runner.reset();

  if (!address) return <Notice tone="neutral">Connect a wallet to load your Aave position.</Notice>;

  return (
    <div className="split split--top">
      <section aria-labelledby="h-check" className="card card--pad stack col-narrow">
        <h2 id="h-check" className="h2-sm">
          Your Aave position
        </h2>
        {data.error ? <Notice tone="danger">Can't read your position: {describeError(data.error)}</Notice> : null}
        <div className="stats">
          <Stat label="Collateral" value={d ? formatToken(d.collateral, meta.receipt) : "…"} testid="frozen-collateral" />
          <Stat
            label="Debt"
            testid="frozen-debt"
            value={
              d
                ? meta.payTokens
                    .map((t, i) => ({ t, debt: d.debts[i] ?? 0n }))
                    .filter((x) => x.debt > 0n)
                    .map((x) => formatToken(x.debt, x.t))
                    .join(" + ") || "None in payment assets"
                : "…"
            }
          />
          <Stat label="Health factor" value={d ? formatHealth(d.account.healthFactor) : "…"} testid="frozen-health" />
        </div>
        {d && d.collateral === 0n && <DemoFunds kits={["borrower"]} compact />}
        <ol className="checklist">
          <li>
            <span className={`check-icon ${directWorks ? "check-icon--ok" : "check-icon--bad"}`}>
              {directWorks ? <Check size={16} /> : <Cross size={16} />}
            </span>
            <span data-testid="frozen-direct">
              <b>Withdraw {u.symbol} directly: {direct.loading ? "checking…" : directWorks ? "works." : "blocked."}</b>{" "}
              {d
                ? directWorks
                  ? "Use Aave directly; the fallback route only runs when a direct withdrawal fails."
                  : `The pool has ${formatToken(d.withdrawable, u)} withdrawable for every depositor combined.${direct.data && d.withdrawable >= (sellAmount ?? d.collateral) ? ` ${direct.data}` : ""}`
                : ""}
            </span>
          </li>
          <li>
            <span className={`check-icon ${simulated ? "check-icon--ok" : "check-icon--idle"}`}>
              <Check size={16} />
            </span>
            <span>
              <b>Simulate the sale through Exeunt:</b>{" "}
              {simulated ? "passed against the current block." : runner.state.outcome === "failed" ? "failed." : "not run yet."}
            </span>
          </li>
          <li>
            <span className="check-icon check-icon--idle">
              <ArrowRight size={16} />
            </span>
            <span>
              <b>Send:</b>{" "}
              {simulated && sellAmount !== null
                ? `ready. One transaction sells up to ${formatToken(sellAmount, meta.receipt)} and ${action === "repay" ? `repays your ${payToken?.symbol ?? ""} debt.` : "supplies the new collateral."}`
                : "locked until the simulation passes."}
            </span>
          </li>
        </ol>
      </section>

      <section aria-labelledby="h-act" className="card card--pad card--feature stack col-wide">
        <h2 id="h-act" className="h2-sm">
          What do you need to do?
        </h2>
        <ToggleGroup<Action>
          label="Action"
          value={action}
          onChange={(a) => {
            setAction(a);
            setPayChoice(null);
            reset();
          }}
          options={[
            { value: "repay", label: "Repay debt", testid: "frozen-repay" },
            { value: "swap", label: "Swap collateral", testid: "frozen-swap" },
          ]}
        />
        <fieldset className="fieldset">
          <legend className="label">{action === "repay" ? "Debt to repay" : "New collateral"}</legend>
          {action === "repay" && sameAssetDebt !== null && sameAssetDebt > 0n && (
            <span className="hint" data-testid="frozen-same-asset-debt">
              Your {formatToken(sameAssetDebt, u)} debt is in the frozen asset itself: repay it with your{" "}
              {meta.receipt.symbol} directly on Aave (repay with aTokens), which needs no pool liquidity.
            </span>
          )}
          {choices.length === 0 ? (
            <span className="hint">
              {action === "repay"
                ? `You have no debt, other than ${u.symbol}, in an asset the bids pay in.`
                : "No other payment asset to swap into."}
            </span>
          ) : (
            <div className="toggle-group">
              {choices.map((c) => (
                <button
                  key={c.t.address}
                  type="button"
                  className="toggle toggle--pill"
                  aria-pressed={c.i === payIdx}
                  data-testid={`frozen-token-${c.t.symbol}`}
                  onClick={() => {
                    setPayChoice(c.i);
                    reset();
                  }}
                >
                  {c.t.symbol}
                  {action === "repay" && c.debt !== null ? ` · ${formatToken(c.debt, c.t)}` : ""}
                </button>
              ))}
            </div>
          )}
        </fieldset>
        <AmountField
          id="route-amt"
          label={`${meta.receipt.symbol} to sell through Exeunt`}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            reset();
          }}
          onMax={d && d.collateral > 0n ? () => setAmount(toInputString(d.collateral, meta.receipt.decimals)) : undefined}
          hint={`Sold to the best escrowed buyers, the Exeunt Vault or a limit bid, that pay in ${payToken?.symbol ?? "the chosen asset"}.`}
          error={amount ? amountError : null}
          testid="frozen-amount"
        />
        <div className="summary">
          <SummaryRow label="Proceeds" testid="frozen-proceeds">
            {proceeds !== null && payToken ? formatToken(proceeds, payToken) : sellAmount === null ? "—" : "…"}
          </SummaryRow>
          <SummaryRow label={action === "repay" ? `${payToken?.symbol ?? ""} debt repaid` : "New collateral supplied"} testid="frozen-outcome">
            {action === "repay"
              ? repay !== null && payToken
                ? debt !== null && repay >= debt
                  ? `${formatToken(debt, payToken)}, all of it`
                  : formatToken(repay, payToken)
                : "—"
              : minProceeds !== null && payToken
                ? `at least ${formatToken(minProceeds, payToken)}`
                : "—"}
          </SummaryRow>
          <SummaryRow label="Health factor after (estimate)" testid="frozen-health-after">
            {healthAfter !== null ? formatHealth(healthAfter) : "—"}
          </SummaryRow>
          {p && sellAmount !== null && p.filledAssets < sellAmount && (
            <p className="small muted">
              Bids paying in {payToken?.symbol} can take {formatToken(p.filledAssets, u)} now; the rest stays with you.
            </p>
          )}
          {action === "repay" && (
            <p className="small muted">Unsold collateral and any surplus proceeds come back to you in the same transaction.</p>
          )}
        </div>
        {directWorks && (
          <Notice tone="info" testid="frozen-direct-works">
            The pool can pay this out directly, so withdraw on Aave instead. The fallback route only runs when a direct
            withdrawal fails.
          </Notice>
        )}
        {wallet.writeBlockedReason && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <div className="row-sm">
          <button
            type="button"
            className="btn btn--secondary btn--lg grow-1"
            data-testid="frozen-simulate"
            disabled={!ready || runner.state.busy !== null}
            onClick={() => void runner.simulate(build)}
          >
            Simulate
          </button>
          <button
            type="button"
            className="btn btn--primary btn--lg grow-2"
            data-testid="frozen-submit"
            disabled={!ready || !simulated || runner.state.busy !== null || !!wallet.writeBlockedReason}
            onClick={() => void runner.send(build)}
          >
            {simulated ? "Send transaction" : "Simulate first"}
          </button>
        </div>
        <TxStatus state={runner.state} />
      </section>
    </div>
  );
}
