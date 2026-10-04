import { FlowArrow, Lock, LogoMark, ArrowRight } from "../../components/Icons";
import { useNetwork } from "../../lib/network-context";

export function HowItWorks() {
  const { meta } = useNetwork();
  const m = meta.data;
  const payList = m ? m.payTokens.map((t) => t.symbol).join(", ") : "USDG, USDC, wstETH";
  return (
    <section aria-labelledby="h-how" className="card card--lg stack-lg">
      <h2 id="h-how" className="h2">
        How Exeunt works
      </h2>
      <div className="how-flow">
        <div className="how-card how-card--seller">
          <span className="how-icon">
            <Lock size={22} />
          </span>
          <span className="how-title">Stuck depositor</span>
          <span className="how-text">Holds aWETH or USDG vault shares the pool can't pay out.</span>
        </div>
        <div className="how-arrow">
          <FlowArrow />
          <span>sells receipt</span>
        </div>
        <div className="how-card how-card--market">
          <span className="how-icon how-icon--market">
            <LogoMark size={22} />
          </span>
          <span className="how-title">Exeunt market</span>
          <span className="how-text">
            Sell now to the best limit bid or the Exeunt Vault, or run an auction whose discount rises until someone
            buys. Every sale settles in one transaction.
          </span>
        </div>
        <div className="how-arrow">
          <FlowArrow />
          <span>best price first</span>
        </div>
        <div className="how-buyers">
          <div className="how-buyer">
            <span className="how-buyer-title">Borrowers of the same asset</span>
            <span className="how-buyer-text">
              Use the receipt to repay their debt for less than face value, paying from their wallet or with a flash
              loan.
            </span>
          </div>
          <div className="how-buyer">
            <span className="how-buyer-title">Exeunt Vault</span>
            <span className="how-buyer-text">
              Depositors' capital waits outside the pool, buys stuck receipts at a set discount, and redeems them at
              full value when the pool refills.
            </span>
          </div>
          <div className="how-buyer">
            <span className="how-buyer-title">Limit bids</span>
            <span className="how-buyer-text">
              Buyers who want a discount set their price in advance; a bid fills when a sale reaches it.
            </span>
          </div>
        </div>
      </div>
      <div className="notice notice--success how-paid">
        <ArrowRight size={20} />
        <span>
          <b>The seller is paid in the same transaction:</b> {payList}
          {m ? " on this network," : ""} or the buyer's freed collateral. The pool's withdrawable liquidity stays
          the same, so nobody else's exit gets smaller.
        </span>
      </div>
    </section>
  );
}
