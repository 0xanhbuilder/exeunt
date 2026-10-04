import { hrefFor, type Route } from "../lib/router";
import { useNetwork } from "../lib/network-context";
import { networkKind } from "../lib/networks";
import { CodeIcon, LogoMark } from "./Icons";
import { NetworkSelector } from "./NetworkSelector";
import { WalletMenu } from "./WalletMenu";

const NAV: { route: Route; label: string; testid: string }[] = [
  { route: "overview", label: "Overview", testid: "nav-overview" },
  { route: "sell", label: "Sell", testid: "nav-sell" },
  { route: "buy", label: "Buy & repay", testid: "nav-buy" },
  { route: "earn", label: "Earn", testid: "nav-earn" },
  { route: "frozen", label: "Frozen collateral", testid: "nav-frozen" },
];

export function Header({ route }: { route: Route }) {
  const { info } = useNetwork();
  return (
    <>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href={hrefFor("overview")} aria-label="Exeunt home">
            <LogoMark />
            <span className="brand-name">Exeunt</span>
          </a>
          <nav aria-label="Main" className="main-nav">
            {NAV.map((n) => (
              <a
                key={n.route}
                href={hrefFor(n.route)}
                className="nav-link"
                aria-current={route === n.route ? "page" : undefined}
                data-testid={n.testid}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="header-right">
            <a
              className="dev-link"
              href={hrefFor("developers")}
              aria-current={route === "developers" ? "page" : undefined}
              data-testid="nav-developers"
            >
              <CodeIcon size={14} />
              Developers
            </a>
            <NetworkSelector />
            <WalletMenu />
          </div>
        </div>
      </header>
      <div className={`ctx-bar ${info.isFork ? "ctx-bar--fork" : "ctx-bar--live"}`} data-testid="network-context">
        <div className="container ctx-inner">
          <b>{info.label}</b>
          <span>
            {info.description.startsWith(networkKind(info)) ? info.description : `${networkKind(info)} · ${info.description}`}
          </span>
        </div>
      </div>
    </>
  );
}
