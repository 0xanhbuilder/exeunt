import { useState } from "react";
import type { Address } from "viem";
import type { BorrowerPosition, ExeuntClient, SessionView, TokenInfo } from "@exeunt/sdk";
import { DeploymentGate } from "../../components/DeploymentGate";
import { DemoFunds } from "../../components/DemoFunds";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { aaveAccount, morphoForceTerms, type AaveAccount } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";
import { BuyPanel } from "./BuyPanel";
import { OpenAuctions } from "./OpenAuctions";

export interface BorrowerInfo {
  position: BorrowerPosition;
  /** Morpho: collateral of the market the buyer borrows in. */
  collateralToken: TokenInfo | null;
  aave: AaveAccount | null;
  morphoForce: { force: boolean; penaltyWad: bigint } | null;
}

async function loadBorrower(exeunt: ExeuntClient, account: Address): Promise<BorrowerInfo> {
  const position = await exeunt.position(account);
  if (exeunt.deployment.venue === "aave") {
    return { position, collateralToken: null, aave: await aaveAccount(exeunt, account), morphoForce: null };
  }
  if (!position.market) return { position, collateralToken: null, aave: null, morphoForce: null };
  const [collateralToken, morphoForce] = await Promise.all([
    exeunt.token(position.market.collateralToken),
    morphoForceTerms(exeunt, position.market),
  ]);
  return { position, collateralToken, aave: null, morphoForce };
}

export interface OpenSessions {
  sessions: SessionView[];
  chainNow: number;
}

async function loadOpen(exeunt: ExeuntClient): Promise<OpenSessions> {
  const [sessions, block] = await Promise.all([exeunt.sessions(true), exeunt.client.getBlock()]);
  return { sessions, chainNow: Number(block.timestamp) };
}

const TITLE = "Repay your debt at a discount";
const LEAD =
  "Buy a stuck depositor's receipt below face value and repay what you owe with it, in one transaction. You keep the discount; they get out.";

export function BuyPage() {
  const head = (
    <section className="page-head">
      <h1>{TITLE}</h1>
      <p className="lead">{LEAD}</p>
    </section>
  );
  return <DeploymentGate head={head}>{({ exeunt, meta }) => <BuyBody exeunt={exeunt} meta={meta} />}</DeploymentGate>;
}

function BuyBody({ exeunt, meta }: { exeunt: ExeuntClient; meta: MarketMeta }) {
  const { info, refreshKey } = useNetwork();
  const { address } = useWallet();
  const [selected, setSelected] = useState<bigint | null>(null);
  const open = useAsync(() => loadOpen(exeunt), [exeunt], { pollMs: 15_000, reloadKey: refreshKey });
  const borrower = useAsync(() => loadBorrower(exeunt, address ?? "0x"), [exeunt, address], {
    reloadKey: refreshKey,
    enabled: address !== null,
    pollMs: 30_000,
  });

  const u = meta.underlying;
  const debt = borrower.data?.position.debt;
  const sessions = open.data?.sessions ?? [];
  const current = sessions.find((s) => s.id === selected) ?? sessions[0] ?? null;
  const where =
    meta.venue === "aave"
      ? `Aave V3 · ${info.label}`
      : borrower.data?.collateralToken
        ? `Morpho market ${u.symbol} / ${borrower.data.collateralToken.symbol} · ${info.label}`
        : `Morpho · ${info.label}`;

  return (
    <div className="stack-lg">
      <section aria-labelledby="h-buy" className="page-head page-head--split">
        <div className="stack-xs">
          <h1 id="h-buy">{TITLE}</h1>
          <p className="lead">{LEAD}</p>
        </div>
        <div className="debt-card card">
          <span className="small muted">Your {u.symbol} debt</span>
          <span className="debt-value mono" data-testid="buy-debt">
            {!address ? "—" : debt !== undefined ? formatToken(debt, u) : borrower.error ? "—" : "…"}
          </span>
          <span className="small text-2">{address ? where : "Connect a wallet to see what you owe"}</span>
        </div>
      </section>

      {borrower.error ? <Notice tone="danger">Can't read your debt: {describeError(borrower.error)}</Notice> : null}
      {address && debt === 0n && (
        <div className="stack-sm">
          <DemoFunds kits={["borrower"]} compact />
        </div>
      )}

      <div className="split split--top">
        <OpenAuctions
          meta={meta}
          open={open}
          debt={address ? debt : undefined}
          currentId={current?.id ?? null}
          onSelect={setSelected}
        />
        {current && (
          <BuyPanel
            key={`${current.id}`}
            exeunt={exeunt}
            meta={meta}
            session={current}
            borrower={borrower.data ?? null}
          />
        )}
      </div>
    </div>
  );
}
