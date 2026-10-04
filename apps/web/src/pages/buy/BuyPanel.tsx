import { useRef, useState } from "react";
import { isAddressEqual, zeroAddress, type Hex } from "viem";
import { WAD, type ExeuntClient, type SessionView, type TokenInfo } from "@exeunt/sdk";
import { AmountField } from "../../components/AmountField";
import { TxStatus } from "../../components/TxStatus";
import { Highlight, Notice, SummaryRow, ToggleGroup } from "../../components/ui";
import { describeError } from "../../lib/errors";
import {
  discountedValue,
  estimateAaveHealthAfter,
  estimateAaveRepay,
  estimateMorphoHealthAfter,
  valueInBase,
} from "../../lib/estimates";
import { formatBps, formatHealth, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { maskIncludes, maskIndices, morphoFlashPayIndex } from "../../lib/paymask";
import { hrefFor } from "../../lib/router";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { aaveFlashTerms, priceOf } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";
import type { BorrowerInfo } from "./BuyPage";

type PayMode = "wallet" | "flash";

const AUTH_TTL_MS = 50 * 60 * 1000;

export function BuyPanel({
  exeunt,
  meta,
  session,
  borrower,
}: {
  exeunt: ExeuntClient;
  meta: MarketMeta;
  session: SessionView;
  borrower: BorrowerInfo | null;
}) {
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const authCache = useRef<{ auth: Hex; account: string; at: number } | null>(null);
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [mode, setMode] = useState<PayMode>("wallet");
  const [walletPayIdx, setWalletPayIdx] = useState<number | null>(null);
  const [flashPayIdxChoice, setFlashPayIdxChoice] = useState<number | null>(null);

  const u = meta.underlying;
  const debt = borrower?.position.debt ?? 0n;
  const maxBuy = session.remainingAssets < debt ? session.remainingAssets : debt;
  const amount = amountInput ?? (maxBuy > 0n ? toInputString(maxBuy, u.decimals) : "");
  const parsed = parseAmountInput(amount, u.decimals);
  const assets = parsed.value;
  const amountError =
    parsed.error ??
    (assets !== null && assets > maxBuy ? `At most ${formatToken(maxBuy, u)}` : null) ??
    (assets === 0n ? "Enter more than zero" : null);
  const validAssets = assets !== null && assets > 0n && !amountError ? assets : null;

  const accepted = maskIndices(session.payMask, meta.payTokens.length);
  const flashChoices =
    meta.venue === "aave"
      ? meta.aaveFlashPayIdx.filter((i) => maskIncludes(session.payMask, i))
      : (() => {
          const i = morphoFlashPayIndex(
            meta.payTokens.map((t) => t.address),
            borrower?.position.market?.collateralToken,
          );
          return i !== null && maskIncludes(session.payMask, i) ? [i] : [];
        })();
  const walletIdx = walletPayIdx !== null && accepted.includes(walletPayIdx) ? walletPayIdx : (accepted[0] ?? 0);
  // Aave: default flash payment to a collateral the buyer actually holds.
  const heldFlash = useAsync(
    async () => {
      const held: number[] = [];
      for (const i of flashChoices) {
        const aToken = exeunt.deployment.payATokens?.[i];
        if (aToken && address && (await exeunt.balanceOf(aToken, address)) > 0n) held.push(i);
      }
      return held;
    },
    [exeunt, address, flashChoices.join(",")],
    { enabled: meta.venue === "aave" && address !== null && flashChoices.length > 1 },
  );
  const flashIdx =
    flashPayIdxChoice !== null && flashChoices.includes(flashPayIdxChoice)
      ? flashPayIdxChoice
      : (heldFlash.data?.[0] ?? flashChoices[0] ?? null);
  const payIdx = mode === "wallet" ? walletIdx : flashIdx;
  const payToken: TokenInfo | null = payIdx === null ? null : (meta.payTokens[payIdx] ?? null);

  const quote = useAsync(
    () => exeunt.quote(validAssets ?? 0n, session.discountBps, payToken?.address ?? zeroAddress),
    [exeunt, validAssets, session.discountBps, payToken?.address],
    { enabled: validAssets !== null && payToken !== null },
  );

  const aaveTerms = useAsync(() => aaveFlashTerms(exeunt), [exeunt, session.id], { enabled: meta.venue === "aave" });

  // Collateral that flash mode takes: the aToken (Aave) or Morpho collateral; plus prices for the health estimate.
  const flashInfo = useAsync(
    async () => {
      if (!address || payIdx === null || !payToken) return null;
      if (meta.venue === "aave") {
        const aTokenAddr = exeunt.deployment.payATokens?.[payIdx];
        if (!aTokenAddr) return null;
        const [aToken, balance, pu, pp] = await Promise.all([
          exeunt.token(aTokenAddr),
          exeunt.balanceOf(aTokenAddr, address),
          priceOf(exeunt, u.address),
          priceOf(exeunt, payToken.address),
        ]);
        return { aToken, balance, pu, pp };
      }
      return { aToken: null, balance: borrower?.position.collateral ?? 0n, pu: 0n, pp: 0n };
    },
    [exeunt, address, payIdx, mode],
    { enabled: mode === "flash" && address !== null && payToken !== null, reloadKey: borrower },
  );

  // Debt repaid: the purchase minus the Aave flash premium, or minus the Morpho forced-deallocation penalty.
  let debtRepaid: bigint | null = null;
  let repayNote: string | null = null;
  let repayBlocked: string | null = null;
  if (validAssets !== null) {
    if (meta.venue === "aave") {
      if (aaveTerms.data) {
        const est = estimateAaveRepay({ assets: validAssets, ...aaveTerms.data });
        if (est.ok) {
          debtRepaid = est.debtRepaid;
          if (est.flashFee > 0n) repayNote = `after a ${formatToken(est.flashFee, u)} Aave flash fee`;
        } else repayBlocked = est.reason;
      }
    } else {
      const force = borrower?.morphoForce;
      if (force?.force) {
        debtRepaid = (validAssets * WAD) / (WAD + force.penaltyWad);
        repayNote = `after a ${formatBps(Number((force.penaltyWad * 10_000n) / WAD))} forced-withdrawal penalty`;
      } else debtRepaid = validAssets;
    }
  }
  const payValue = validAssets !== null ? discountedValue(validAssets, session.discountBps) : null;
  const savings = debtRepaid !== null && payValue !== null ? debtRepaid - payValue : null;

  // Health before and after (estimate) for flash mode.
  let healthBefore: bigint | null = null;
  let healthAfter: bigint | null = null;
  if (mode === "flash" && borrower && quote.data !== undefined && debtRepaid !== null) {
    if (meta.venue === "aave" && borrower.aave && flashInfo.data && payToken) {
      healthBefore = borrower.aave.healthFactor;
      healthAfter = estimateAaveHealthAfter({
        totalCollateralBase: borrower.aave.totalCollateralBase,
        totalDebtBase: borrower.aave.totalDebtBase,
        liquidationThresholdBps: borrower.aave.liquidationThresholdBps,
        collateralRemovedBase: valueInBase(quote.data, payToken.decimals, flashInfo.data.pp),
        debtRepaidBase: valueInBase(debtRepaid, u.decimals, flashInfo.data.pu),
      });
    } else if (meta.venue === "morpho" && borrower.position.collateral !== undefined) {
      healthBefore = borrower.position.health;
      healthAfter = estimateMorphoHealthAfter({
        health: borrower.position.health,
        debt: borrower.position.debt,
        collateral: borrower.position.collateral,
        collateralRemoved: quote.data,
        debtRepaid,
      });
    }
  }
  const collateralShort =
    mode === "flash" && flashInfo.data && quote.data !== undefined && flashInfo.data.balance < quote.data;

  const needsAuth = meta.venue === "morpho" && mode === "flash";
  const approvalToken: TokenInfo | null =
    mode === "wallet" ? payToken : meta.venue === "aave" ? (flashInfo.data?.aToken ?? null) : null;
  const allowance = useAsync(
    () => exeunt.allowance(approvalToken?.address ?? zeroAddress, address ?? zeroAddress, exeunt.market),
    [exeunt, approvalToken?.address, address, runner.state.outcome],
    { enabled: approvalToken !== null && address !== null },
  );
  const approvalAmount =
    quote.data === undefined ? undefined : mode === "flash" && meta.venue === "aave" ? withATokenMargin(quote.data, 1) : quote.data;
  const needsApproval = approvalToken !== null && approvalAmount !== undefined && (allowance.data ?? 0n) < approvalAmount;
  const signatures = (needsApproval ? 1 : 0) + (needsAuth ? 2 : 0) + 1;

  const getAuth = async (): Promise<Hex> => {
    const cached = authCache.current;
    if (cached && address && cached.account === address && Date.now() - cached.at < AUTH_TTL_MS) return cached.auth;
    const signer = wallet.typedDataSigner();
    if (!signer || !address) throw new Error("Connect a wallet first.");
    const auth = await exeunt.signMorphoAuthorization(signer, address);
    authCache.current = { auth, account: address, at: Date.now() };
    return auth;
  };

  const build = async (): Promise<TxStep[]> => {
    if (!address || validAssets === null || payIdx === null || !payToken) throw new Error("Check the amount and payment.");
    const fresh = await exeunt.session(session.id);
    if (!fresh.open) throw new Error("This auction has ended or sold out.");
    // The discount only rises, so today's price is the most this purchase can cost.
    const maxPay = await exeunt.quote(validAssets, fresh.discountBps, payToken.address);
    let venueData: Hex = "0x";
    if (meta.venue === "morpho") {
      venueData = await exeunt.venueData(address, {
        force: borrower?.morphoForce?.force ?? false,
        auth: mode === "flash" ? await getAuth() : undefined,
      });
    }
    const label = `Buy ${formatToken(validAssets, u)} of ${receiptNoun(meta)} at ${formatBps(fresh.discountBps)} off and repay your debt`;
    if (mode === "wallet") {
      const approve = await approvalStep(exeunt, payToken, address, exeunt.market, maxPay, "so the market can pay the seller");
      return [
        ...(approve ? [approve] : []),
        { label, tx: exeunt.buyAndRepay(session.id, validAssets, payIdx, maxPay, venueData) },
      ];
    }
    const steps: TxStep[] = [];
    if (meta.venue === "aave") {
      const aTokenAddr = exeunt.deployment.payATokens?.[payIdx];
      if (!aTokenAddr || isAddressEqual(aTokenAddr, zeroAddress)) throw new Error("This asset cannot be paid from collateral.");
      const aToken = await exeunt.token(aTokenAddr);
      const approve = await approvalStep(exeunt, aToken, address, exeunt.market, withATokenMargin(maxPay, 1), "so the market can pay the seller from your freed collateral");
      if (approve) steps.push(approve);
    }
    steps.push({ label, tx: exeunt.buyAndRepayWithCollateral(session.id, validAssets, payIdx, maxPay, venueData) });
    return steps;
  };

  const send = async () => {
    const ok = await runner.send(build);
    if (ok) {
      authCache.current = null;
      setAmountInput(null);
    }
  };

  if (!address) {
    return (
      <section className="card card--pad card--feature col-narrow stack-sm" aria-labelledby="h-panel">
        <h2 id="h-panel" className="h2-sm">
          Buy &amp; repay · {receiptNoun(meta)} #{session.id.toString()}
        </h2>
        <Notice tone="neutral">Connect a wallet to see how much of your debt this auction can repay.</Notice>
      </section>
    );
  }

  if (borrower && debt === 0n) {
    return (
      <section className="card card--pad card--feature col-narrow stack-sm" aria-labelledby="h-panel">
        <h2 id="h-panel" className="h2-sm">
          Buy &amp; repay · {receiptNoun(meta)} #{session.id.toString()}
        </h2>
        <Notice tone="warn" testid="buy-no-debt">
          You have no {u.symbol} debt{meta.venue === "morpho" ? " in a market this vault supplies" : ""}, so this{" "}
          {receiptNoun(meta)} has nothing to repay. You can still buy it at a discount with a limit bid on Earn, and
          redeem it at full value when the pool refills.
        </Notice>
        <a className="btn btn--dark" href={hrefFor("earn")}>
          Place a limit bid
        </a>
      </section>
    );
  }

  const flashHow =
    meta.venue === "aave"
      ? "Exeunt repays your debt first with a one-transaction loan, then pays the seller with the collateral that repayment frees."
      : `Exeunt borrows ${u.symbol} for this one transaction, repays your debt, turns the seller's vault shares back into ${u.symbol} to return the loan, and pays the seller with the collateral your repayment frees.`;

  const flashToken = flashIdx !== null ? meta.payTokens[flashIdx] : undefined;
  const steps = whatHappens(meta, mode, validAssets, payToken, quote.data);

  return (
    <section className="card card--pad card--feature col-narrow stack" aria-labelledby="h-panel" data-testid="buy-panel">
      <h2 id="h-panel" className="h2-sm">
        Buy &amp; repay · {receiptNoun(meta)} #{session.id.toString()}
      </h2>

      <AmountField
        id="buy-amt"
        label={`Repay amount (${u.symbol})`}
        value={amount}
        onChange={(v) => {
          setAmountInput(v);
          runner.reset();
        }}
        hint={`Up to ${formatToken(maxBuy, u)}: the smaller of what is left (${formatToken(session.remainingAssets, u)}) and your debt`}
        error={amount ? amountError : null}
        testid="buy-amount"
      />

      <fieldset className="fieldset">
        <legend className="label">How to pay</legend>
        <ToggleGroup<PayMode>
          variant="dark"
          label="How to pay"
          value={mode}
          onChange={(m) => {
            setMode(m);
            runner.reset();
          }}
          options={[
            { value: "wallet", label: "From your wallet", testid: "buy-pay-wallet" },
            {
              value: "flash",
              label: "Flash loan · no cash needed",
              testid: "buy-pay-flash",
              disabled: flashChoices.length === 0,
            },
          ]}
        />
        <span className="hint">
          {flashChoices.length === 0
            ? meta.venue === "aave"
              ? "Flash mode needs the seller to accept an asset you hold as Aave collateral."
              : "Flash mode needs the seller to accept your market's collateral asset."
            : `Flash loan: ${flashHow}`}
        </span>
      </fieldset>

      {mode === "wallet" ? (
        <fieldset className="fieldset">
          <legend className="label">Pay with</legend>
          <div className="toggle-group">
            {accepted.map((i) => {
              const t = meta.payTokens[i];
              if (!t) return null;
              return (
                <button
                  key={t.address}
                  type="button"
                  className="toggle toggle--pill"
                  aria-pressed={i === walletIdx}
                  data-testid={`buy-pay-token-${t.symbol}`}
                  onClick={() => {
                    setWalletPayIdx(i);
                    runner.reset();
                  }}
                >
                  {t.symbol}
                </button>
              );
            })}
          </div>
          <span className="hint">The seller accepts these assets for this auction.</span>
        </fieldset>
      ) : (
        <div className="flash-box" data-testid="buy-flash-box">
          <p>
            <b>How the flash loan works:</b> {flashHow} It all happens in one transaction; if any step fails, nothing
            happens.
          </p>
          {flashChoices.length > 1 && (
            <div className="toggle-group">
              {flashChoices.map((i) => {
                const t = meta.payTokens[i];
                if (!t) return null;
                return (
                  <button
                    key={t.address}
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={i === flashIdx}
                    data-testid={`buy-flash-token-${t.symbol}`}
                    onClick={() => setFlashPayIdxChoice(i)}
                  >
                    Pay with {t.symbol} collateral
                  </button>
                );
              })}
            </div>
          )}
          <SummaryRow label="Collateral that will be taken" testid="buy-flash-collateral">
            {quote.data !== undefined && flashToken ? formatToken(quote.data, flashToken) : "…"}
          </SummaryRow>
          <SummaryRow label="Cash needed up front" testid="buy-flash-cash">
            0
          </SummaryRow>
          <SummaryRow label="Health factor (estimate)" testid="buy-flash-health">
            {healthBefore !== null ? formatHealth(healthBefore) : "…"} →{" "}
            {healthAfter !== null ? formatHealth(healthAfter) : "…"}
          </SummaryRow>
          <p className="small">
            {meta.venue === "aave"
              ? `Works from a normal wallet: you approve Exeunt once to move your ${flashInfo.data?.aToken?.symbol ?? "collateral aToken"}. Reverts in full if that collateral's pool is frozen too, or if your health factor would drop.`
              : "You sign twice, with no gas: a one-time permission for Exeunt to move the collateral this repayment frees, and its revocation, which runs inside the same transaction."}
          </p>
          {collateralShort && (
            <p className="small text-bad">
              You hold {flashInfo.data ? formatToken(flashInfo.data.balance, flashInfo.data.aToken ?? flashToken ?? u) : ""} of
              that collateral, less than the payment. Buy less, or pay from your wallet.
            </p>
          )}
        </div>
      )}

      <div className="summary">
        <SummaryRow label="You pay" testid="buy-you-pay">
          {quote.data !== undefined && payToken
            ? `${formatToken(quote.data, payToken)}${mode === "flash" ? " of your collateral" : ""}`
            : validAssets === null
              ? "—"
              : "…"}
        </SummaryRow>
        <SummaryRow label="Debt repaid" testid="buy-debt-repaid">
          {debtRepaid !== null ? `${formatToken(debtRepaid, u)}${repayNote ? ` (${repayNote})` : ""}` : "—"}
        </SummaryRow>
        <Highlight label="You save" tone="good" testid="buy-savings">
          {savings !== null ? formatToken(savings, u) : "—"}
        </Highlight>
        <p className="small muted">
          Bought at the auction's current discount, {formatBps(session.discountBps)}. It only rises, so waiting can
          only make it cheaper, but another borrower may buy first.
        </p>
      </div>
      {repayBlocked && <Notice tone="warn">{repayBlocked}</Notice>}
      {quote.error ? <Notice tone="danger">Can't price this purchase: {describeError(quote.error)}</Notice> : null}
      {borrower?.morphoForce?.force && (
        <p className="small muted">
          Your market is not the vault's liquidity market, so Exeunt pulls the freed {u.symbol} out of it with a forced
          withdrawal; its penalty comes off the debt repaid.
        </p>
      )}

      <details className="details">
        <summary>What happens in the transaction</summary>
        <ol>
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </details>

      {wallet.writeBlockedReason && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
      {needsAuth && <p className="small muted">Simulating flash mode first asks for the two permission signatures.</p>}
      <div className="row-sm">
        <button
          type="button"
          className="btn btn--secondary btn--lg grow-1"
          data-testid="buy-simulate"
          disabled={validAssets === null || runner.state.busy !== null || !payToken}
          onClick={() => void runner.simulate(build)}
        >
          Simulate
        </button>
        <button
          type="button"
          className="btn btn--primary btn--lg grow-2"
          data-testid="buy-submit"
          disabled={
            validAssets === null ||
            runner.state.busy !== null ||
            !payToken ||
            !!wallet.writeBlockedReason ||
            !!repayBlocked ||
            !!collateralShort
          }
          onClick={() => void send()}
        >
          {runner.state.busy === "send"
            ? "Working…"
            : `Buy & repay · ${signatures} signature${signatures > 1 ? "s" : ""}`}
        </button>
      </div>
      <TxStatus state={runner.state} />
    </section>
  );
}

function whatHappens(
  meta: MarketMeta,
  mode: PayMode,
  assets: bigint | null,
  payToken: TokenInfo | null,
  pay: bigint | undefined,
): string[] {
  const u = meta.underlying;
  const amt = assets !== null ? formatToken(assets, u) : `the amount in ${u.symbol}`;
  const paid = pay !== undefined && payToken ? formatToken(pay, payToken) : "the discounted price";
  const venue = meta.venue === "aave" ? "Aave" : "Morpho";
  const refill =
    meta.venue === "aave"
      ? `That repayment refills the pool, so the seller's ${meta.receipt.symbol} turn back into ${u.symbol}, which returns the loan.`
      : `That repayment frees ${u.symbol} in the market, so the seller's vault shares redeem for it, which returns the loan.`;
  const common = [
    `Exeunt borrows ${amt} for this transaction only (a flash loan).`,
    `It repays ${amt} of your ${venue} debt with it, minus any flash fee.`,
    refill,
  ];
  if (mode === "wallet") {
    return [...common, `You pay the seller ${paid} from your wallet.`, "Seller paid in full, or everything reverts."];
  }
  return [
    ...common,
    `Your debt dropped, so part of your collateral unlocks; Exeunt sends ${paid} of it to the seller.`,
    meta.venue === "aave"
      ? "Seller paid in full and your health factor did not fall, or everything reverts."
      : "Your one-time permission is revoked in the same transaction; seller paid in full, or everything reverts.",
  ];
}
