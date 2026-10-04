import { isAddressEqual, type Address } from "viem";
import type { BidView, ExeuntClient, SessionView } from "@exeunt/sdk";
import { TxStatus } from "../../components/TxStatus";
import { Chip, Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken } from "../../lib/format";
import { loadSellerHistory, summarizeFills, type SellerFill, type SellerHistory } from "../../lib/history";
import { useAsync } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { maskIncludes } from "../../lib/paymask";
import { useTxRunner } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

interface SalesData {
  mine: SessionView[];
  bids: BidView[];
  chainNow: number;
}

async function loadSales(exeunt: ExeuntClient, seller: Address): Promise<SalesData> {
  const [all, bids, block] = await Promise.all([exeunt.sessions(), exeunt.bids(), exeunt.client.getBlock()]);
  return { mine: all.filter((s) => isAddressEqual(s.seller, seller)), bids, chainNow: Number(block.timestamp) };
}

/** Bid that can fill this auction right now: the session's discount has reached its limit and it pays in an accepted asset. */
function matchableBid(s: SessionView, bids: BidView[]): BidView | null {
  if (!s.open) return null;
  const ok = bids.filter(
    (b) => b.minDiscountBps <= s.discountBps && maskIncludes(s.payMask, b.payIdx) && b.capacityAssets > 0n,
  );
  return ok.reduce<BidView | null>((best, b) => (!best || b.capacityAssets > best.capacityAssets ? b : best), null);
}

export function YourSales({ exeunt, meta }: { exeunt: ExeuntClient; meta: MarketMeta }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const sales = useAsync(() => loadSales(exeunt, address ?? "0x"), [exeunt, address], {
    reloadKey: refreshKey,
    enabled: address !== null,
    pollMs: 15_000,
  });
  const history = useAsync(() => loadSellerHistory(exeunt, address ?? "0x"), [exeunt, address], {
    reloadKey: refreshKey,
    enabled: address !== null,
  });

  const u = meta.underlying;
  const busy = runner.state.busy !== null;
  const blocked = wallet.writeBlockedReason !== null;

  const receivedText = (fills: SellerFill[]) => {
    const sum = summarizeFills(fills);
    if (sum.received.length === 0) return "0";
    return sum.received
      .map((r) => {
        const token = meta.payTokens.find((t) => isAddressEqual(t.address, r.token));
        return token ? formatToken(r.amount, token) : `${r.amount}`;
      })
      .join(" + ");
  };

  if (!address) return null;

  const h: SellerHistory | undefined = history.data;
  const data = sales.data;
  const sellNowGroups = new Map<string, SellerFill[]>();
  for (const f of h?.fills ?? []) {
    if (f.sessionId !== 0n) continue;
    const key = f.txHash ?? `fill-${sellNowGroups.size}`;
    sellNowGroups.set(key, [...(sellNowGroups.get(key) ?? []), f]);
  }
  const empty = data && data.mine.length === 0 && sellNowGroups.size === 0;

  return (
    <section aria-labelledby="h-mine" className="card card--pad stack">
      <h2 id="h-mine" className="h2-sm">
        Your sales
      </h2>
      {sales.error ? <Notice tone="danger">Can't read your auctions: {describeError(sales.error)}</Notice> : null}
      {history.error ? (
        <p className="small muted">
          Sold and received amounts come from event history, which this RPC could not serve: {describeError(history.error)}
        </p>
      ) : null}
      {!data && !sales.error && <p className="muted loading">Reading your auctions…</p>}
      {empty && <p className="muted">No sales yet. Your auctions and sell-now fills show up here.</p>}
      {data && !empty && (
        <div className="table-wrap">
          <table className="data data--wide">
            <thead>
              <tr>
                <th scope="col">Sale</th>
                <th scope="col">Sold</th>
                <th scope="col">Discount</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Unsold</th>
              </tr>
            </thead>
            <tbody>
              {data.mine.map((s) => {
                const fills = (h?.fills ?? []).filter((f) => f.sessionId === s.id);
                const sum = summarizeFills(fills);
                const opened = h?.opened.get(s.id);
                const ended = data.chainNow >= s.endsAt;
                const status = s.units === 0n ? "Closed" : ended ? "Ended" : "Open";
                const match = matchableBid(s, data.bids);
                return (
                  <tr key={s.id.toString()} data-testid={`session-row-${s.id}`} data-status={status.toLowerCase()}>
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">Auction #{s.id.toString()}</div>
                    </td>
                    <td className="mono" data-testid={`session-sold-${s.id}`}>
                      {h ? `${formatToken(sum.assets, u)} of ${formatToken(opened ?? sum.assets + s.remainingAssets, u)}` : "—"}
                    </td>
                    <td className="mono" data-testid={`session-discount-${s.id}`}>
                      {s.open
                        ? s.discountBps >= s.capBps
                          ? `${formatBps(s.discountBps)}, at its cap`
                          : `${formatBps(s.discountBps)} now, rising`
                        : sum.avgDiscountBps !== null
                          ? formatBps(sum.avgDiscountBps)
                          : "—"}
                    </td>
                    <td className="mono">{h ? receivedText(fills) : "—"}</td>
                    <td>
                      <Chip tone={status === "Open" ? "open" : "neutral"}>{status}</Chip>
                    </td>
                    <td>
                      <div className="row-sm">
                        {s.units > 0n ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--small"
                            disabled={busy || blocked}
                            data-testid={`session-withdraw-${s.id}`}
                            onClick={() =>
                              void runner.send(async () => [
                                {
                                  label: `Withdraw ${formatToken(s.remainingAssets, u)} unsold from auction #${s.id}`,
                                  tx: exeunt.withdrawUnsold(s.id),
                                },
                              ])
                            }
                          >
                            Withdraw {formatToken(s.remainingAssets, u)}
                          </button>
                        ) : (
                          <span className="muted">None</span>
                        )}
                        {match && (
                          <button
                            type="button"
                            className="btn btn--primary btn--small"
                            disabled={busy || blocked}
                            data-testid={`session-match-${s.id}`}
                            title="Your discount has reached this escrowed bid, so it can buy now. Anyone may trigger the fill; you get paid."
                            onClick={() =>
                              void runner.send(async () => [
                                {
                                  label: `Fill ${isAddressEqual(match.bidder, meta.vault.address) ? "the Exeunt Vault's" : "a limit"} bid #${match.id} from auction #${s.id} at ${formatBps(s.discountBps)}`,
                                  tx: exeunt.matchBid(s.id, match.id),
                                },
                              ])
                            }
                          >
                            Sell to bid at {formatBps(s.discountBps)}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {[...sellNowGroups.entries()].map(([key, fills]) => {
                const sum = summarizeFills(fills);
                return (
                  <tr key={key} data-testid="sellnow-row">
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">Sold now to bids</div>
                    </td>
                    <td className="mono">{formatToken(sum.assets, u)}</td>
                    <td className="mono">{sum.avgDiscountBps !== null ? formatBps(sum.avgDiscountBps) : "—"}</td>
                    <td className="mono">{receivedText(fills)}</td>
                    <td>
                      <Chip tone="neutral">Filled</Chip>
                    </td>
                    <td>
                      <span className="muted">None</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Unsold receipts come back to you at once, with no waiting period; what already sold stays sold.
      </p>
      <TxStatus state={runner.state} />
    </section>
  );
}
