import { useEffect } from "react";
import { isAddressEqual } from "viem";
import type { BidView, ExeuntClient, SellPlan } from "@exeunt/sdk";
import { Highlight, Notice, SummaryRow } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { allPayMask } from "../../lib/paymask";

export function SellNowPreview({
  exeunt,
  meta,
  assets,
  bids,
  onPlan,
}: {
  exeunt: ExeuntClient;
  meta: MarketMeta;
  assets: bigint | null;
  bids: BidView[] | undefined;
  onPlan: (plan: SellPlan | null) => void;
}) {
  const u = meta.underlying;
  const plan = useAsync(
    () => exeunt.planSellNow(assets ?? 0n, meta.maxDiscountBps, allPayMask(meta.payTokens.length)),
    [exeunt, assets],
    { enabled: assets !== null, reloadKey: bids },
  );

  useEffect(() => {
    onPlan(plan.data ?? null);
  }, [plan.data, onPlan]);

  const total = (bids ?? []).reduce((s, b) => s + b.capacityAssets, 0n);
  const p = plan.data;

  if (plan.error) return <Notice tone="danger">Can't plan the sale: {describeError(plan.error)}</Notice>;

  const receive = p
    ? Object.entries(p.proceeds)
        .map(([token, amount]) => {
          const info = meta.payTokens.find((t) => isAddressEqual(t.address, token as `0x${string}`));
          return info ? formatToken(amount, info) : `${amount} of ${token}`;
        })
        .join(" + ")
    : "";

  return (
    <div className="summary" data-testid="sell-preview">
      <SummaryRow label="Filled now" testid="sell-filled">
        {assets === null ? "—" : p ? `${formatToken(p.filledAssets, u)} of ${formatToken(assets, u)}` : "…"}
      </SummaryRow>
      <Highlight label="Average discount" tone="warn" testid="sell-avg-discount">
        {p && p.filledAssets > 0n ? formatBps(p.averageDiscountBps) : "—"}
      </Highlight>
      <SummaryRow label="You receive" testid="sell-receive">
        <span className="text-good strong">{assets === null ? "—" : p ? receive || `0 ${u.symbol}` : "…"}</span>
      </SummaryRow>
      <p className="small muted">
        {assets === null
          ? "Enter an amount to see the fills, best price first."
          : p && p.filledAssets < assets
            ? `${formatToken(assets - p.filledAssets, u)} is more than the bids hold (${formatToken(total, u)}); run an auction for the rest.`
            : "Each bid pays in the asset it escrowed. You are paid in the same transaction."}
      </p>
    </div>
  );
}
