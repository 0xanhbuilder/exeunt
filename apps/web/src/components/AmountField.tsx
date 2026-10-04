import type { ReactNode } from "react";

export function AmountField({
  id,
  label,
  value,
  onChange,
  onMax,
  hint,
  error,
  testid,
  suffix,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  onMax?: () => void;
  hint?: ReactNode;
  error?: string | null;
  testid: string;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="input-row">
        <input
          id={id}
          className="input input--mono"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          data-testid={testid}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
        {onMax && (
          <button type="button" className="btn btn--secondary" onClick={onMax} data-testid={`${testid}-max`}>
            Max
          </button>
        )}
      </div>
      <span id={`${id}-hint`} className={error ? "hint text-bad" : "hint"}>
        {error ?? hint}
      </span>
    </div>
  );
}
