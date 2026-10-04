import type { ReactNode } from "react";
import { formatBps, TONE_LABEL, utilizationTone } from "../lib/format";

export type NoticeTone = "info" | "warn" | "danger" | "success" | "neutral";

export function Notice({
  tone = "neutral",
  children,
  testid,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : undefined} data-testid={testid}>
      {children}
    </div>
  );
}

export function StatusChip({ utilizationBps, testid }: { utilizationBps: number; testid?: string }) {
  const tone = utilizationTone(utilizationBps);
  return (
    <span className={`chip chip--${tone}`} data-testid={testid} data-status={tone}>
      {TONE_LABEL[tone]}
    </span>
  );
}

export function Chip({ tone, children, testid }: { tone: "open" | "tight" | "frozen" | "neutral"; children: ReactNode; testid?: string }) {
  return (
    <span className={`chip chip--${tone}`} data-testid={testid}>
      {children}
    </span>
  );
}

export function UtilBar({ utilizationBps, testid }: { utilizationBps: number; testid?: string }) {
  const tone = utilizationTone(utilizationBps);
  return (
    <span className="util" data-testid={testid} data-bps={utilizationBps}>
      <span className="util-track" aria-hidden="true">
        <span className={`util-fill util-fill--${tone}`} style={{ width: `${Math.min(100, utilizationBps / 100)}%` }} />
      </span>
      <span className="mono">{formatBps(utilizationBps)}</span>
    </span>
  );
}

export function Stat({ label, value, testid, sub }: { label: string; value: ReactNode; testid?: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono" data-testid={testid}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export interface ToggleOption<T extends string> {
  value: T;
  label: ReactNode;
  testid?: string;
  disabled?: boolean;
}

/** Single-choice button group (tabs or pills), announced with aria-pressed like the mockup. */
export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "pill",
}: {
  options: ToggleOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  variant?: "pill" | "tab" | "dark";
}) {
  return (
    <div role="group" aria-label={label} className="toggle-group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`toggle toggle--${variant}`}
          aria-pressed={o.value === value}
          data-testid={o.testid}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SummaryRow({ label, children, testid }: { label: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="summary-row">
      <span className="summary-label">{label}</span>
      <span className="summary-value mono" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}

/** The one number a panel is about (average discount, savings), shown large. */
export function Highlight({
  label,
  children,
  tone,
  testid,
}: {
  label: ReactNode;
  children: ReactNode;
  tone: "warn" | "good";
  testid?: string;
}) {
  return (
    <div className={`highlight highlight--${tone}`}>
      <span className="highlight-label">{label}</span>
      <span className="highlight-value mono" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}
