import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";

const MCP_CAPABILITIES = [
  "Read exit capacity",
  "List auctions and bids",
  "Quote and plan sales",
  "Simulate",
  "Build unsigned transactions",
];

export function DevelopersPage() {
  const { key, info, deployment, exeunt, meta, refreshKey } = useNetwork();
  const live = useAsync(() => (exeunt ? exeunt.capacity() : Promise.reject(new Error("not deployed"))), [exeunt], {
    reloadKey: refreshKey,
    enabled: exeunt !== null,
  });
  const market = deployment.status === "ready" ? deployment.deployment.market : null;
  const u = meta.data?.underlying;

  const reads = [
    market ? `// Exit market on ${info.label}: ${market}` : `// Exeunt is not deployed on ${info.label} yet`,
    "capacity() → (withdrawable, supplied, utilizationBps,",
    "              debtorCapacity, sessionAssets)",
    "bidCapacityAt(uint16 discountBps) → uint256  // escrowed bids only",
    "activeBidIds() → uint256[]     bids(id) → (bidder, minDiscountBps, …)",
    "nextSessionId()   sessions(id)   discountOf(id)   remainingAssets(id)",
  ].join("\n");

  const sdk = [
    `import { createPublicClient, http } from "viem";`,
    `import { ExeuntClient, NETWORKS, parseDeployment } from "@exeunt/sdk";`,
    ``,
    `const net = NETWORKS["${key}"];`,
    `const deployment = parseDeployment(await (await fetch(DEPLOYMENT_URL)).json());`,
    `const exeunt = new ExeuntClient(deployment, createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) }));`,
    ``,
    `const cap = await exeunt.capacity();`,
    `const plan = await exeunt.planSellNow(amount, 500, payMask); // best bids up to 5% off`,
    `const tx = exeunt.sellNow(plan, 500, payMask, plan.filledAssets); // unsigned`,
    `await exeunt.simulate(tx, account); // eth_call before any signature`,
    `// also: openSession, buyAndRepay(WithCollateral), placeBid, cancelBid,`,
    `// vaultDeposit, vaultRedeem, routeRepayWithFrozenCollateral, routeSwapFrozenCollateral`,
  ].join("\n");

  const mcp = JSON.stringify(
    { mcpServers: { exeunt: { command: "node", args: ["<path-to-exeunt>/packages/mcp/dist/index.js"] } } },
    null,
    2,
  );

  const hook = JSON.stringify(
    {
      network: key,
      utilizationBps: live.data?.utilizationBps ?? 9977,
      thresholdBps: 9500,
      at: 1791099128000,
    },
    null,
    2,
  );

  return (
    <div className="stack-lg">
      <section aria-labelledby="h-dev" className="page-head">
        <h1 id="h-dev">Developers</h1>
        <p className="lead">
          Four ways to use Exeunt from your app or AI agent, on every network in the selector. Currently pointing at{" "}
          {info.label}.
        </p>
      </section>
      <div className="dev-grid">
        <section aria-labelledby="h-reads" className="card card--pad stack-sm">
          <div className="dev-head">
            <span className="mono muted">01</span>
            <h2 id="h-reads" className="h2-sm">
              On-chain reads
            </h2>
          </div>
          <p className="text-2">
            Exit capacity, open auctions and limit bids, straight from the contracts. No permission, no fee. Vaults
            and curators call it before they allocate, to price freeze risk.
          </p>
          <pre className="code" data-testid="dev-reads">
            {reads}
          </pre>
          {live.data && u && (
            <p className="small muted" data-testid="dev-live-capacity">
              Live on {info.label}: {formatToken(live.data.withdrawable, u)} withdrawable of{" "}
              {formatToken(live.data.supplied, u)}, utilization {formatBps(live.data.utilizationBps)}.
            </p>
          )}
        </section>

        <section aria-labelledby="h-sdk" className="card card--pad stack-sm">
          <div className="dev-head">
            <span className="mono muted">02</span>
            <h2 id="h-sdk" className="h2-sm">
              SDK
            </h2>
          </div>
          <p className="text-2">
            Sell, buy and repay (wallet or flash loan), place limit bids, use the Exeunt Vault and call the
            frozen-collateral route. Every write comes back as an unsigned transaction, so position managers and
            aggregators keep their users' way out when a pool freezes without handing over keys.
          </p>
          <pre className="code" data-testid="dev-sdk">
            {sdk}
          </pre>
        </section>

        <section aria-labelledby="h-mcp" className="card card--pad card--dark stack-sm">
          <div className="dev-head">
            <span className="mono">03</span>
            <h2 id="h-mcp" className="h2-sm">
              MCP server for AI agents
            </h2>
          </div>
          <p className="dark-callout">
            <b>Reads, simulates and builds unsigned transactions.</b> It never holds keys and never signs; your wallet
            or your agent's wallet does.
          </p>
          <div className="chips">
            {MCP_CAPABILITIES.map((c) => (
              <span key={c} className="dark-chip">
                {c}
              </span>
            ))}
          </div>
          <pre className="code code--dark" data-testid="dev-mcp">
            {mcp}
          </pre>
          <ul className="dark-list">
            <li>A curator's agent sells early when a pool's exit capacity starts to drop.</li>
            <li>A borrower's agent repays at a discount with a flash loan the moment a pool freezes.</li>
            <li>A treasury agent moves idle funds into the Exeunt Vault to earn while it waits.</li>
          </ul>
        </section>

        <section aria-labelledby="h-hook" className="card card--pad stack-sm">
          <div className="dev-head">
            <span className="mono muted">04</span>
            <h2 id="h-hook" className="h2-sm">
              Webhook alerts
            </h2>
          </div>
          <p className="text-2">
            Get a POST when a pool's utilization rises above your threshold, so your bot can sell, bid or rebalance
            before the exits fill up. Set it up in Exit capacity on the Overview page.
          </p>
          <pre className="code" data-testid="dev-webhook">
            {hook}
          </pre>
          <a className="link-strong self-start" href={`${hrefFor("overview")}`}>
            Set an alert
          </a>
        </section>
      </div>
    </div>
  );
}
