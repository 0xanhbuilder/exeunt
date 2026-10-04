import { ApiError, getCapacityHistory } from "../../lib/api";
import { chartGeometry } from "../../lib/chart";
import { apiBaseUrl } from "../../lib/env";
import { describeError } from "../../lib/errors";
import { formatBps, formatDuration } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { poolTitle, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";

const BOX = { width: 640, height: 210, left: 48, right: 14, top: 18, bottom: 30 };
const HOURS = 24;

export function UtilizationChart({
  meta,
  currentBps,
  thresholdBps,
}: {
  meta: MarketMeta;
  currentBps?: number;
  thresholdBps?: number;
}) {
  const { key } = useNetwork();
  const history = useAsync(() => getCapacityHistory(key, HOURS), [key], { pollMs: 60_000 });
  const points = history.data ?? [];
  const now = currentBps === undefined ? "…" : formatBps(currentBps);

  let body;
  if (history.error) {
    const offline = history.error instanceof ApiError && history.error.offline;
    body = (
      <p className="chart-empty muted" data-testid="chart-unavailable">
        {offline
          ? `History comes from the Exeunt backend, which is unreachable at ${apiBaseUrl()}.`
          : `History is unavailable: ${describeError(history.error)}`}{" "}
        Utilization now: <b className="mono">{now}</b>.
      </p>
    );
  } else if (history.data === undefined) {
    body = <p className="chart-empty muted loading">Loading history…</p>;
  } else if (points.length === 0) {
    body = (
      <p className="chart-empty muted">
        No history recorded for this pool yet. Utilization now: <b className="mono">{now}</b>.
      </p>
    );
  } else {
    const g = chartGeometry(points, BOX, thresholdBps);
    const first = points.reduce((a, b) => (a.t < b.t ? a : b));
    const ageSeconds = (Date.now() - first.t) / 1000;
    const thresholdY = thresholdBps !== undefined && thresholdBps <= 10_000 ? g.yFor(thresholdBps) : null;
    body = (
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        width="100%"
        height={BOX.height}
        role="img"
        aria-label={`Utilization over the last ${HOURS} hours, now ${now}`}
        className="chart"
        data-testid="utilization-chart"
      >
        {g.ticks.map((t) => (
          <g key={t.label}>
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={t.y} y2={t.y} className="chart-grid" />
            <text x={BOX.left - 8} y={t.y + 4} textAnchor="end" className="chart-label">
              {t.label}
            </text>
          </g>
        ))}
        <line x1={BOX.left} x2={BOX.left} y1={BOX.top} y2={BOX.height - BOX.bottom} className="chart-axis" />
        {thresholdY !== null && thresholdBps !== undefined && (
          <g>
            <line
              x1={BOX.left}
              x2={BOX.width - BOX.right}
              y1={thresholdY}
              y2={thresholdY}
              className="chart-threshold"
            />
            <text x={BOX.left + 8} y={thresholdY - 6} className="chart-threshold-label">
              Your alert · {formatBps(thresholdBps)}
            </text>
          </g>
        )}
        <polyline points={g.polyline} className="chart-line" fill="none" />
        {g.last && <circle cx={g.last.x} cy={g.last.y} r={4} className="chart-dot" />}
        <text x={BOX.left} y={BOX.height - 8} className="chart-label">
          {formatDuration(ageSeconds)} ago
        </text>
        <text x={BOX.width - BOX.right} y={BOX.height - 8} textAnchor="end" className="chart-label">
          now
        </text>
      </svg>
    );
  }

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <h3 className="h3">Utilization, last {HOURS} hours</h3>
        <span className="small muted">{poolTitle(meta)}</span>
      </div>
      {body}
    </div>
  );
}
