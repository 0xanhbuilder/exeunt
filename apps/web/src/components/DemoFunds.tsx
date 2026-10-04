import { useState } from "react";
import { requestDemoFunds, type FaucetKit } from "../lib/api";
import { describeError } from "../lib/errors";
import { useNetwork } from "../lib/network-context";
import { receiptNoun } from "../lib/market";
import { useWallet } from "../lib/wallet-context";

const KIT_TITLE: Record<FaucetKit, string> = {
  seller: "Seller kit",
  borrower: "Borrower kit",
  bidder: "Bidder kit",
};

/** Fork-only faucet: the backend funds the connected address so each flow can be tried end to end. */
export function DemoFunds({ kits, compact = false }: { kits: FaucetKit[]; compact?: boolean }) {
  const { key, info, meta, refresh } = useNetwork();
  const { address } = useWallet();
  const [busy, setBusy] = useState<FaucetKit | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!info.isFork || !address) return null;

  const m = meta.data;
  const purpose: Record<FaucetKit, string> = {
    seller: m ? `${receiptNoun(m)} stuck in the frozen pool, to try selling` : "stuck receipts, to try selling",
    borrower: m ? `a ${m.underlying.symbol} debt with collateral, to try repaying at a discount` : "a debt, to try repaying at a discount",
    bidder: m
      ? `${m.payTokens.map((t) => t.symbol).join(", ")}, to try limit bids and the Exeunt Vault`
      : "payment tokens, to try bids and the vault",
  };

  const get = async (kit: FaucetKit) => {
    setBusy(kit);
    setResult(null);
    try {
      const txs = await requestDemoFunds(key, address, kit);
      setResult({ ok: true, text: `${KIT_TITLE[kit]} sent${txs.length ? ` in ${txs.length} transaction${txs.length > 1 ? "s" : ""}` : ""}.` });
      refresh();
    } catch (e) {
      setResult({ ok: false, text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? "demo-funds demo-funds--compact" : "demo-funds"} data-testid="demo-funds">
      {!compact && (
        <p className="small muted">
          Get demo funds on this fork, so you can try each flow without real assets.
        </p>
      )}
      <div className="demo-kits">
        {kits.map((kit) => (
          <button
            key={kit}
            type="button"
            className="btn btn--secondary btn--small demo-kit"
            data-testid={`demo-kit-${kit}`}
            disabled={busy !== null}
            onClick={() => void get(kit)}
          >
            <span className="demo-kit-title">{busy === kit ? "Sending…" : KIT_TITLE[kit]}</span>
            <span className="demo-kit-desc">{purpose[kit]}</span>
          </button>
        ))}
      </div>
      {result && (
        <p className={`small ${result.ok ? "text-good" : "text-bad"}`} role="status" data-testid="demo-funds-result">
          {result.text}
        </p>
      )}
    </div>
  );
}
