import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatDuration, formatToken } from "../../lib/format";
import type { AsyncState } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import type { OpenSessions } from "./BuyPage";

export function OpenAuctions({
  meta,
  open,
  debt,
  currentId,
  onSelect,
}: {
  meta: MarketMeta;
  open: AsyncState<OpenSessions>;
  debt: bigint | undefined;
  currentId: bigint | null;
  onSelect: (id: bigint) => void;
}) {
  const u = meta.underlying;
  const data = open.data;
  return (
    <section aria-labelledby="h-sess" className="card card--pad stack col-wide">
      <h2 id="h-sess" className="h2-sm">
        Open auctions
      </h2>
      {open.error ? <Notice tone="danger">Can't read auctions: {describeError(open.error)}</Notice> : null}
      {!data && !open.error && <p className="muted loading">Reading open auctions…</p>}
      {data && data.sessions.length === 0 && (
        <p className="muted" data-testid="buy-no-sessions">
          No open auctions yet. Sellers open them from Sell; the discount rises until someone buys.
        </p>
      )}
      {data && data.sessions.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Remaining</th>
                <th scope="col">Discount now</th>
                <th scope="col">Your matching debt</th>
                <th scope="col">
                  <span className="sr-only">Select</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => {
                const on = s.id === currentId;
                const matching = debt === undefined ? null : debt < s.remainingAssets ? debt : s.remainingAssets;
                return (
                  <tr key={s.id.toString()} className={on ? "row-selected" : undefined} data-testid={`buy-session-row-${s.id}`}>
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">
                        #{s.id.toString()} · open {formatDuration(data.chainNow - s.startedAt)}
                      </div>
                    </td>
                    <td className="mono">{formatToken(s.remainingAssets, u)}</td>
                    <td className="mono text-good strong" data-testid={`buy-session-discount-${s.id}`}>
                      {formatBps(s.discountBps)}
                    </td>
                    <td className="mono">
                      {matching === null ? "Connect wallet" : matching === 0n ? "None" : formatToken(matching, u)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={on ? "btn btn--primary btn--small" : "btn btn--secondary btn--small"}
                        aria-pressed={on}
                        data-testid={`buy-select-${s.id}`}
                        onClick={() => onSelect(s.id)}
                      >
                        {on ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
