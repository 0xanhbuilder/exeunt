import { useState } from "react";
import { isAddressEqual, zeroAddress } from "viem";
import type { BidView, ExeuntClient } from "@exeunt/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { TxStatus } from "../../components/TxStatus";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { bpsToPercentInput, formatBps, formatToken, parseAmountInput, parsePercentToBps } from "../../lib/format";
import { loadBidOrigins } from "../../lib/history";
import { useAsync } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

export function LimitBidsSection({ exeunt, meta, bids }: { exeunt: ExeuntClient; meta: MarketMeta; bids?: BidView[] }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const cancelRunner = useTxRunner();
  const [size, setSize] = useState("");
  const [discount, setDiscount] = useState(bpsToPercentInput(200));
  const [payIdx, setPayIdx] = useState(0);

  const u = meta.underlying;
  const payToken = meta.payTokens[payIdx] ?? meta.payTokens[0];
  const parsed = parseAmountInput(size, u.decimals);
  const discountBps = parsePercentToBps(discount);
  const discountError =
    discountBps === null || discountBps > meta.maxDiscountBps
      ? `Enter a discount from 0 to ${formatBps(meta.maxDiscountBps, 0)}`
      : null;
  const maxAssets = parsed.value !== null && parsed.value > 0n ? parsed.value : null;

  const escrow = useAsync(
    () => exeunt.quote(maxAssets ?? 0n, discountBps ?? 0, payToken?.address ?? zeroAddress),
    [exeunt, maxAssets, discountBps, payToken?.address],
    { enabled: maxAssets !== null && discountBps !== null && !discountError && payToken !== undefined },
  );
  const balance = useAsync(
    () => exeunt.balanceOf(payToken?.address ?? zeroAddress, address ?? zeroAddress),
    [exeunt, payToken?.address, address],
    { reloadKey: refreshKey, enabled: address !== null && payToken !== undefined },
  );
  const origins = useAsync(() => loadBidOrigins(exeunt, address ?? zeroAddress), [exeunt, address], {
    reloadKey: refreshKey,
    enabled: address !== null,
  });

  const short = escrow.data !== undefined && balance.data !== undefined && escrow.data > balance.data;
  const mine = address ? (bids ?? []).filter((b) => isAddressEqual(b.bidder, address)) : [];

  const placeSteps = async (): Promise<TxStep[]> => {
    if (!address || !maxAssets || discountBps === null || !payToken) throw new Error("Check the bid.");
    const amount = await exeunt.quote(maxAssets, discountBps, payToken.address);
    const approve = await approvalStep(exeunt, payToken, address, exeunt.market, amount, "so the market can hold it in escrow");
    return [
      ...(approve ? [approve] : []),
      {
        label: `Escrow ${formatToken(amount, payToken)} and bid for up to ${formatToken(maxAssets, u)} at ${formatBps(discountBps)} off or more`,
        tx: exeunt.placeBid(discountBps, payIdx, maxAssets, amount),
      },
    ];
  };

  return (
    <>
      <section aria-labelledby="h-place" className="card card--pad card--feature stack">
        <h2 id="h-place" className="h2-sm">
          Place a limit bid
        </h2>
        <p className="text-2">
          Buy stuck receipts at the discount you choose, then redeem them at full value when the pool refills. The
          bid sits in the same public book the Exeunt Vault uses.
        </p>
        <fieldset className="fieldset">
          <legend className="label">Receipt to buy</legend>
          <div className="toggle-group">
            <button type="button" className="toggle toggle--pill" aria-pressed="true">
              {receiptNoun(meta)}
            </button>
          </div>
        </fieldset>
        <div className="field-row">
          <AmountField
            id="ord-size"
            label={`Buy up to (${u.symbol} face value)`}
            value={size}
            onChange={(v) => {
              setSize(v);
              runner.reset();
            }}
            error={size ? parsed.error : null}
            testid="bid-amount"
          />
          <div className="field">
            <label htmlFor="ord-disc" className="label">
              Only at a discount of at least (%)
            </label>
            <input
              id="ord-disc"
              className="input input--mono"
              inputMode="decimal"
              value={discount}
              data-testid="bid-discount"
              aria-invalid={discountError ? true : undefined}
              onChange={(e) => {
                setDiscount(e.target.value);
                runner.reset();
              }}
            />
            <span className={discountError ? "hint text-bad" : "hint"}>
              {discountError ?? "Your bid never fills below this discount."}
            </span>
          </div>
        </div>
        <fieldset className="fieldset">
          <legend className="label">Escrow in</legend>
          <div className="toggle-group">
            {meta.payTokens.map((t, i) => (
              <button
                key={t.address}
                type="button"
                className="toggle toggle--pill"
                aria-pressed={i === payIdx}
                data-testid={`bid-escrow-${t.symbol}`}
                onClick={() => {
                  setPayIdx(i);
                  runner.reset();
                }}
              >
                {t.symbol}
              </button>
            ))}
          </div>
          <span className="hint" data-testid="bid-escrow-needed">
            {escrow.data !== undefined && payToken && maxAssets
              ? `Escrow needed: ${formatToken(escrow.data, payToken)}, enough to buy ${formatToken(maxAssets, u)} at ${formatBps(discountBps ?? 0)} off.`
              : "Enter a size to see the escrow it needs."}
            {balance.data !== undefined && payToken ? ` You hold ${formatToken(balance.data, payToken)}.` : ""}
          </span>
        </fieldset>
        {short && <Notice tone="warn">You hold less {payToken?.symbol} than this bid needs in escrow.</Notice>}
        {escrow.error ? <Notice tone="danger">Can't price the escrow: {describeError(escrow.error)}</Notice> : null}
        {wallet.writeBlockedReason && address && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          data-testid="bid-submit"
          disabled={
            !address ||
            !maxAssets ||
            !!discountError ||
            escrow.data === undefined ||
            short ||
            runner.state.busy !== null ||
            !!wallet.writeBlockedReason
          }
          onClick={() => void runner.send(placeSteps).then((ok) => ok && setSize(""))}
        >
          {runner.state.busy ? "Working…" : "Escrow and place bid"}
        </button>
        <TxStatus state={runner.state} />
        {address && balance.data === 0n && <DemoFunds kits={["bidder"]} compact />}
        <p className="small muted">
          Funds are escrowed when you place the bid, so sellers can count on it and it adds to the pool's exit
          capacity. Cancel anytime; it takes effect at once and the unused escrow comes straight back.
        </p>
      </section>

      <section aria-labelledby="h-mybids" className="card card--pad stack-sm">
        <h2 id="h-mybids" className="h2-sm">
          Your bids
        </h2>
        {!address && <p className="muted">Connect a wallet to see your bids.</p>}
        {address && mine.length === 0 && <p className="muted">No open bids. Bids you place show up here.</p>}
        {mine.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Filled</th>
                  <th scope="col">At least</th>
                  <th scope="col">Escrowed</th>
                  <th scope="col">
                    <span className="sr-only">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mine.map((b) => {
                  const pay = meta.payTokens[b.payIdx];
                  const original = origins.data?.get(b.id);
                  return (
                    <tr key={b.id.toString()} data-testid={`bid-row-${b.id}`}>
                      <td className="cell-title">{receiptNoun(meta)}</td>
                      <td className="mono">
                        {original !== undefined
                          ? `${formatToken(original - b.maxAssets, u)} of ${formatToken(original, u)}`
                          : `up to ${formatToken(b.maxAssets, u)} left`}
                      </td>
                      <td className="mono">{formatBps(b.minDiscountBps)}</td>
                      <td className="mono">{pay ? formatToken(b.escrow, pay) : b.escrow.toString()}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          data-testid={`bid-cancel-${b.id}`}
                          disabled={cancelRunner.state.busy !== null || !!wallet.writeBlockedReason}
                          onClick={() =>
                            void cancelRunner.send(async () => [
                              {
                                label: `Cancel bid #${b.id} and get ${pay ? formatToken(b.escrow, pay) : "the escrow"} back`,
                                tx: exeunt.cancelBid(b.id),
                              },
                            ])
                          }
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TxStatus state={cancelRunner.state} />
      </section>
    </>
  );
}
