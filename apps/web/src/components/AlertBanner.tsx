import { useState } from "react";
import { NETWORKS } from "@exeunt/sdk";
import { getAlertEvents, type AlertEvent } from "../lib/api";
import { formatBps } from "../lib/format";
import { readStorage, useAsync, writeStorage } from "../lib/hooks";
import { isNetworkKey } from "../lib/networks";
import { hrefFor } from "../lib/router";
import { useWallet } from "../lib/wallet-context";

const DISMISSED_KEY = "exeunt.alerts.dismissed";

function eventKey(e: AlertEvent): string {
  return `${e.network}:${e.at}:${e.thresholdBps}`;
}

function readDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(readStorage(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function eventTime(at: number): string {
  const ms = at < 1e12 ? at * 1000 : at;
  return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** In-app delivery of utilization alerts; silent when the backend is offline. */
export function AlertBanner() {
  const { address } = useWallet();
  const events = useAsync(() => getAlertEvents(address ?? ""), [address], {
    pollMs: 30_000,
    enabled: address !== null,
  });
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);

  const visible = (events.data ?? [])
    .filter((e) => !dismissed.has(eventKey(e)))
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  if (visible.length === 0) return null;

  const dismiss = (e: AlertEvent) => {
    const next = new Set(dismissed);
    next.add(eventKey(e));
    setDismissed(next);
    writeStorage(DISMISSED_KEY, JSON.stringify([...next].slice(-200)));
  };

  return (
    <div className="alert-banners container" data-testid="alert-banner">
      {visible.map((e) => (
        <div key={eventKey(e)} className="notice notice--warn alert-banner" role="status">
          <span>
            <b>
              Utilization on {isNetworkKey(e.network) ? NETWORKS[e.network].label : e.network} hit{" "}
              {formatBps(e.utilizationBps)}
            </b>
            , above your alert at {formatBps(e.thresholdBps)} ({eventTime(e.at)}). Exits are getting scarce: sell
            early or check what the pool can still pay out.
          </span>
          <span className="row-sm">
            <a href={`${hrefFor("overview")}`} className="btn btn--secondary btn--small">
              Exit capacity
            </a>
            <button type="button" className="btn btn--secondary btn--small" onClick={() => dismiss(e)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
