import type { BidView } from "@exeunt/sdk";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken } from "../../lib/format";
import type { AsyncState } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { BID_OWNER_LABEL, bidOwner } from "../../lib/orderbook";
import { useWallet } from "../../lib/wallet-context";

/** Public book shared by limit bids and the Exeunt Vault; sellers fill from the smallest discount first. */
export function OrderBook({ meta, book }: { meta: MarketMeta; book: AsyncState<BidView[]> }) {
  const { address } = useWallet();
  const u = meta.underlying;
  const bids = (book.data ?? []).filter((b) => b.capacityAssets > 0n);
  const total = bids.reduce((s, b) => s + b.capacityAssets, 0n);
  return (
    <aside aria-labelledby="h-book" className="card card--pad stack-sm col-narrow" data-testid="orderbook">
      <h2 id="h-book" className="h2-sm">
        Bids · {receiptNoun(meta)}
      </h2>
      <p className="small muted">
        Every bid is escrowed, so a seller knows it will pay. Sellers fill from the smallest discount first.
      </p>
      {book.error ? <Notice tone="danger">Can't read bids: {describeError(book.error)}</Notice> : null}
      {!book.data && !book.error && <p className="muted loading">Reading bids…</p>}
      {book.data && bids.length === 0 && <p className="muted">No bids yet. Be the first buyer sellers can count on.</p>}
      {bids.length > 0 && (
        <div className="book">
          <div className="book-row book-row--head">
            <span>Discount</span>
            <span className="right">Buys up to</span>
            <span className="right">Bidder</span>
          </div>
          {bids.map((b) => {
            const owner = bidOwner(b.bidder, meta.vault.address, address);
            const pay = meta.payTokens[b.payIdx];
            return (
              <div key={b.id.toString()} className="book-row" data-testid={`orderbook-row-${b.id}`} data-owner={owner}>
                <span className="mono">≥ {formatBps(b.minDiscountBps)}</span>
                <span className="mono right" title={pay ? `Escrowed ${formatToken(b.escrow, pay)}` : undefined}>
                  {formatToken(b.capacityAssets, u)}
                </span>
                <span className={`who who--${owner}`}>{BID_OWNER_LABEL[owner]}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="book-total">
        <span>Total buying power</span>
        <span className="mono" data-testid="orderbook-total">
          {formatToken(total, u)}
        </span>
      </div>
    </aside>
  );
}
