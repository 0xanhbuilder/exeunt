const BULLETS: { tone: string; who: string; text: string }[] = [
  {
    tone: "danger",
    who: "Stuck depositors",
    text: "sell their receipt and get paid now, instead of waiting for the pool to refill.",
  },
  {
    tone: "info",
    who: "Borrowers",
    text: "repay their debt for less than face value, even with no cash on hand.",
  },
  {
    tone: "good",
    who: "Everyone",
    text: "can deposit into the Exeunt Vault or place limit bids to earn base yield; when a pool freezes, that capital buys stuck receipts below face value and redeems them at full value when the pool refills, to earn extra.",
  },
  {
    tone: "neutral",
    who: "Depositors and curators",
    text: "see how much of each pool can still get out, so the risk is visible before a freeze.",
  },
];

export function Hero() {
  return (
    <section aria-labelledby="h-hero" className="hero">
      <div className="hero-main">
        <div className="eyebrow">Aave on Arbitrum · Morpho on Robinhood Chain</div>
        <h1 id="h-hero" className="hero-title">
          The exit market for frozen lending pools
        </h1>
        <ul className="hero-bullets">
          {BULLETS.map((b) => (
            <li key={b.who}>
              <span className={`bullet-dot bullet-dot--${b.tone}`} aria-hidden="true" />
              <span>
                <b>{b.who}</b> {b.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="hero-stats">
        <div className="hero-stat">
          <span className="hero-stat-value mono text-bad">100%</span>
          <span className="hero-stat-text">
            Utilization of Aave's WETH pool on Arbitrum during the Kelp exploit, 18–19 Apr 2026
          </span>
        </div>
        <div className="hero-stat">
          <span className="hero-stat-value mono text-warn">91.7%</span>
          <span className="hero-stat-text">
            Utilization of Steakhouse USDG, the vault behind Robinhood Earn: only $43.9M of $529.2M could leave at
            once, 3 Oct 2026
          </span>
        </div>
      </div>
    </section>
  );
}
