import type { ReactNode } from "react";
import type { ExeuntClient } from "@exeunt/sdk";
import { describeError } from "../lib/errors";
import type { MarketMeta } from "../lib/market";
import { useNetwork, type NetworkContextValue } from "../lib/network-context";
import { Notice } from "./ui";

type GateState = { ready: true; exeunt: ExeuntClient; meta: MarketMeta } | { ready: false; notice: ReactNode };

function gateState({ info, deployment, exeunt, meta, rpcUrl }: NetworkContextValue): GateState {
  if (deployment.status === "loading") {
    return { ready: false, notice: <p className="muted loading">Loading the {info.label} deployment…</p> };
  }
  if (deployment.status === "missing") {
    return {
      ready: false,
      notice: (
        <Notice tone="neutral" testid="not-deployed">
          <b>Exeunt is not deployed on {info.label} yet.</b> Pick another chain or scenario in the selector above to
          use the market now.
        </Notice>
      ),
    };
  }
  if (deployment.status === "invalid") {
    return {
      ready: false,
      notice: (
        <Notice tone="danger" testid="deployment-invalid">
          <b>The {info.label} deployment file is invalid:</b> {deployment.error}
        </Notice>
      ),
    };
  }
  if (exeunt && meta.data) return { ready: true, exeunt, meta: meta.data };
  if (!exeunt || meta.loading || !meta.error) {
    return { ready: false, notice: <p className="muted loading">Reading the market on {info.label}…</p> };
  }
  return {
    ready: false,
    notice: (
      <Notice tone="danger" testid="rpc-error">
        <div className="stack-sm">
          <span>
            <b>Can't read Exeunt on {info.label}</b> ({rpcUrl}). {describeError(meta.error)}
          </span>
          <button type="button" className="btn btn--secondary btn--small" onClick={meta.reload}>
            Try again
          </button>
        </div>
      </Notice>
    ),
  };
}

/** Renders its children only once the selected network has a deployment that answers on the RPC. */
export function DeploymentGate({
  children,
  head,
}: {
  children: (ctx: { exeunt: ExeuntClient; meta: MarketMeta }) => ReactNode;
  /** Shown above the notice while the market is not readable, for pages whose heading needs market data. */
  head?: ReactNode;
}) {
  const state = gateState(useNetwork());
  if (state.ready) return <>{children({ exeunt: state.exeunt, meta: state.meta })}</>;
  if (!head) return <>{state.notice}</>;
  return (
    <div className="stack-lg">
      {head}
      {state.notice}
    </div>
  );
}
