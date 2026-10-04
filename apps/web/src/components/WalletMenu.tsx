import { useEffect, useRef, useState } from "react";
import { useNetwork } from "../lib/network-context";
import { shortAddress } from "../lib/format";
import { useWallet } from "../lib/wallet-context";
import { DemoFunds } from "./DemoFunds";
import { ChevronDown } from "./Icons";

export function WalletMenu() {
  const wallet = useWallet();
  const { info } = useNetwork();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copy = async () => {
    if (!wallet.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const connected = wallet.address !== null;

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className="wallet-btn"
        aria-expanded={open}
        aria-haspopup="true"
        data-testid="wallet-button"
        data-connected={connected}
        data-address={wallet.address ?? ""}
        onClick={() => setOpen((o) => !o)}
      >
        {connected && wallet.address ? (
          <>
            <span className={`dot ${wallet.wrongChain ? "dot--warn" : "dot--live"}`} />
            <span className="mono">{shortAddress(wallet.address)}</span>
            {wallet.kind === "demo" && <span className="wallet-tag">demo</span>}
          </>
        ) : (
          <span>Connect wallet</span>
        )}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu wallet-menu">
          {!connected ? (
            <div className="stack-sm">
              <div className="menu-group-title">Connect to sign transactions</div>
              <button
                type="button"
                className="menu-option"
                data-testid="wallet-connect-injected"
                disabled={wallet.busy}
                onClick={() => void wallet.connectInjected().then(() => setOpen(false))}
              >
                <span className="menu-option-title">Browser wallet</span>
                <span className="menu-option-desc">
                  {wallet.hasInjected
                    ? "MetaMask, Rabby or any injected wallet. Use it on the live testnets."
                    : "No browser wallet detected in this browser."}
                </span>
              </button>
              <button
                type="button"
                className="menu-option"
                data-testid="wallet-connect-demo"
                onClick={() => {
                  wallet.connectDemo();
                  setOpen(false);
                }}
              >
                <span className="menu-option-title">Demo wallet</span>
                <span className="menu-option-desc">
                  A burner key kept in this browser, for testnets and scenario forks only. Never send real funds to it.
                </span>
              </button>
              {wallet.error && <p className="small text-bad">{wallet.error}</p>}
            </div>
          ) : (
            <div className="stack-sm">
              <div className="menu-group-title">
                {wallet.kind === "demo" ? "Demo wallet · burner key in this browser" : "Browser wallet"}
              </div>
              <div className="wallet-address mono" data-testid="wallet-address">
                {wallet.address}
              </div>
              <div className="row-sm">
                <button type="button" className="btn btn--secondary btn--small" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy address"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  data-testid="wallet-disconnect"
                  onClick={() => {
                    wallet.disconnect();
                    setOpen(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
              {wallet.kind === "demo" && (
                <p className="small muted">
                  For testnets and forks only: the key sits unencrypted in this browser's storage.
                  {!info.isFork && " On a live testnet, send it a little testnet ETH for gas first."}
                </p>
              )}
              {wallet.wrongChain && (
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  data-testid="wallet-switch-chain"
                  onClick={() => void wallet.ensureChain().catch(() => undefined)}
                >
                  Switch wallet to {info.label}
                </button>
              )}
              {wallet.writeBlockedReason && <p className="small text-warn">{wallet.writeBlockedReason}</p>}
              {info.isFork && <DemoFunds kits={["seller", "borrower", "bidder"]} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
