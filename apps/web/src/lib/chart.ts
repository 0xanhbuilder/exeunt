export interface UtilPoint {
  t: number;
  utilizationBps: number;
}

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartGeometry {
  polyline: string;
  last: { x: number; y: number } | null;
  ticks: { y: number; label: string }[];
  yFor: (bps: number) => number;
  minBps: number;
  maxBps: number;
}

/** Lays out a utilization line chart; the y axis starts at the nearest 5% step below the data and the threshold. */
export function chartGeometry(points: readonly UtilPoint[], box: ChartBox, thresholdBps?: number): ChartGeometry {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.utilizationBps);
  if (thresholdBps !== undefined) values.push(thresholdBps);
  const lowest = values.length > 0 ? Math.min(...values) : 8_000;
  const minBps = Math.max(0, Math.min(9_500, Math.floor((lowest - 100) / 500) * 500));
  const maxBps = 10_000;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const yFor = (bps: number) => {
    const clamped = Math.min(maxBps, Math.max(minBps, bps));
    return box.top + plotH - ((clamped - minBps) / (maxBps - minBps)) * plotH;
  };
  const first = sorted[0];
  const lastPoint = sorted[sorted.length - 1];
  const t0 = first?.t ?? 0;
  const span = lastPoint && first && lastPoint.t > first.t ? lastPoint.t - first.t : 1;
  const xFor = (t: number) => (sorted.length < 2 ? box.left + plotW : box.left + ((t - t0) / span) * plotW);
  const coords = sorted.map((p) => ({ x: round(xFor(p.t)), y: round(yFor(p.utilizationBps)) }));
  const stepBps = maxBps - minBps > 2_000 ? 1_000 : 500;
  const ticks: { y: number; label: string }[] = [];
  for (let b = minBps; b <= maxBps; b += stepBps) ticks.push({ y: round(yFor(b)), label: `${b / 100}%` });
  return {
    polyline: coords.map((c) => `${c.x},${c.y}`).join(" "),
    last: coords[coords.length - 1] ?? null,
    ticks,
    yFor: (bps) => round(yFor(bps)),
    minBps,
    maxBps,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
