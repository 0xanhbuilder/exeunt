import { useNetwork } from "../lib/network-context";
import { explorerTxUrl } from "../lib/networks";
import { shortAddress } from "../lib/format";
import type { RunnerState, StepPhase } from "../lib/tx";

const PHASE_TEXT: Record<StepPhase, string> = {
  queued: "Waiting",
  simulating: "Simulating…",
  simulated: "Simulation passed",
  deferred: "Simulated after the approval confirms",
  signing: "Confirm in your wallet…",
  pending: "Sent, waiting for the block…",
  confirmed: "Confirmed",
  failed: "Failed",
};

export function TxStatus({ state }: { state: RunnerState }) {
  const { info } = useNetwork();
  if (state.steps.length === 0 && !state.message) return null;
  const tone =
    state.outcome === "failed" ? "danger" : state.outcome === "sent" || state.outcome === "simulated" ? "success" : "info";
  return (
    <div className={`tx-status tx-status--${tone}`} data-testid="tx-status" data-outcome={state.outcome} aria-live="polite">
      {state.steps.length > 0 && (
        <ol className="tx-steps">
          {state.steps.map((s, i) => {
            const url = s.hash ? explorerTxUrl(info, s.hash) : null;
            return (
              <li key={i} className={`tx-step tx-step--${s.phase}`} data-testid={`tx-step-${i}`} data-phase={s.phase}>
                <span className="tx-step-label">{s.label}</span>
                <span className="tx-step-phase">{PHASE_TEXT[s.phase]}</span>
                {s.hash && (
                  <span className="tx-step-hash mono" data-testid="tx-hash" data-hash={s.hash}>
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        {shortAddress(s.hash)} ↗
                      </a>
                    ) : (
                      <span title={s.hash}>{shortAddress(s.hash)}</span>
                    )}
                  </span>
                )}
                {s.error && <span className="tx-step-error">{s.error}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {state.message && (
        <p className="tx-message" data-testid="tx-message">
          {state.message}
        </p>
      )}
    </div>
  );
}
