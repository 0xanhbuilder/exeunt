import { useEffect, useRef, useState } from "react";
import { useNetwork } from "../lib/network-context";
import { networkGroups } from "../lib/networks";
import { ChevronDown } from "./Icons";

export function NetworkSelector() {
  const { key, info, setKey } = useNetwork();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className="net-btn"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Chain or scenario: ${info.label}`}
        data-testid="network-selector"
        data-network={key}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dot ${info.isFork ? "dot--fork" : "dot--live"}`} />
        <span className="net-btn-text">
          <span className="net-btn-caption">Chain / scenario</span>
          <span className="net-btn-name">{info.label}</span>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu net-menu" aria-label="Choose chain or scenario">
          {networkGroups().map((g) => (
            <div key={g.title}>
              <div className="menu-group-title">{g.title}</div>
              {g.networks.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  className="net-option"
                  aria-pressed={n.key === key}
                  data-testid={`network-option-${n.key}`}
                  onClick={() => {
                    setKey(n.key);
                    setOpen(false);
                  }}
                >
                  <span className={`dot dot--top ${n.isFork ? "dot--fork" : "dot--live"}`} />
                  <span className="net-option-text">
                    <span className="net-option-name">{n.label}</span>
                    <span className="net-option-desc">{n.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
