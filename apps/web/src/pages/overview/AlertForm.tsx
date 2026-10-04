import { useState, type FormEvent } from "react";
import { createAlert, deleteAlert, listAlerts } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { formatBps, parsePercentToBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useNetwork } from "../../lib/network-context";
import { useWallet } from "../../lib/wallet-context";

export function AlertForm({ threshold, onThreshold }: { threshold: string; onThreshold: (v: string) => void }) {
  const { key, info } = useNetwork();
  const { address } = useWallet();
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState(0);
  const alerts = useAsync(() => listAlerts(address ?? ""), [address, version], { enabled: address !== null });

  const bps = parsePercentToBps(threshold);
  const thresholdError = bps === null || bps <= 0 || bps > 10_000 ? "Enter a utilization between 0.01 and 100" : null;
  const hookError = webhook.trim() !== "" && !/^https?:\/\/\S+$/i.test(webhook.trim()) ? "Enter an http(s) URL" : null;
  const canSave = address !== null && !thresholdError && !hookError && !busy;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!address || bps === null || !canSave) return;
    setBusy(true);
    setStatus(null);
    try {
      const hook = webhook.trim();
      await createAlert({ network: key, thresholdBps: bps, owner: address, ...(hook ? { webhookUrl: hook } : {}) });
      setStatus({ ok: true, text: `Saved. You'll be told when ${info.label} crosses ${formatBps(bps)}.` });
      setVersion((v) => v + 1);
    } catch (err) {
      setStatus({ ok: false, text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteAlert(id);
      setVersion((v) => v + 1);
    } catch (err) {
      setStatus({ ok: false, text: describeError(err) });
    }
  };

  const mine = (alerts.data ?? []).filter((a) => a.network === key);

  return (
    <form className="panel alert-form stack-sm" aria-labelledby="h-alert" onSubmit={(e) => void save(e)}>
      <h3 id="h-alert" className="h3">
        Alert me
      </h3>
      <p className="small muted">Hear about a freeze before the exits fill up, so you can sell or bid early.</p>
      <label htmlFor="alert-th" className="label">
        When utilization rises above
      </label>
      <div className="input-row input-row--narrow">
        <input
          id="alert-th"
          className="input input--mono"
          type="text"
          inputMode="decimal"
          value={threshold}
          onChange={(e) => onThreshold(e.target.value)}
          data-testid="alert-threshold"
          aria-invalid={thresholdError ? true : undefined}
        />
        <span>%</span>
      </div>
      {thresholdError && <span className="hint text-bad">{thresholdError}</span>}
      <label htmlFor="alert-hook" className="label">
        Webhook URL (optional)
      </label>
      <input
        id="alert-hook"
        className="input"
        type="url"
        placeholder="https://"
        value={webhook}
        onChange={(e) => setWebhook(e.target.value)}
        data-testid="alert-webhook"
        aria-invalid={hookError ? true : undefined}
      />
      <span className={hookError ? "hint text-bad" : "hint"}>
        {hookError ?? "You always get an in-app banner. Add a webhook to reach your bot, vault or curator tooling."}
      </span>
      <button type="submit" className="btn btn--primary" disabled={!canSave} data-testid="alert-save">
        {busy ? "Saving…" : address ? "Save alert" : "Connect a wallet to save an alert"}
      </button>
      {status && (
        <p className={`small ${status.ok ? "text-good" : "text-bad"}`} role="status" data-testid="alert-status">
          {status.text}
        </p>
      )}
      {mine.length > 0 && (
        <ul className="alert-list">
          {mine.map((a) => (
            <li key={a.id} data-testid={`alert-row-${a.id}`}>
              <span className="small">
                Above <b className="mono">{formatBps(a.thresholdBps)}</b>
                {a.webhookUrl ? ` · webhook ${a.webhookUrl}` : " · in-app"}
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => void remove(a.id)}
                data-testid={`alert-delete-${a.id}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
