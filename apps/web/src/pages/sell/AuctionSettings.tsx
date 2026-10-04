import { isAddressEqual } from "viem";
import type { BidView, SessionParams } from "@exeunt/sdk";
import { secondsToReach, validateSessionParams } from "../../lib/auction";
import { formatBps, formatDuration, parsePercentToBps } from "../../lib/format";
import type { MarketMeta } from "../../lib/market";
import { buildPayMask } from "../../lib/paymask";

export interface AuctionInputs {
  start: string;
  step: string;
  everyMinutes: string;
  cap: string;
  hours: string;
  payIdx: number[];
}

/** BRD leaves the curve open (TODO); these defaults reach a 3% bid in about 2.5 hours. */
export function defaultAuctionInputs(meta: MarketMeta): AuctionInputs {
  return {
    start: "0.50",
    step: "0.25",
    everyMinutes: "15",
    cap: "5.00",
    hours: "24",
    payIdx: meta.payTokens.map((_, i) => i),
  };
}

export function deriveSessionParams(
  inputs: AuctionInputs,
  meta: MarketMeta,
): { params: SessionParams | null; error: string | null } {
  const startBps = parsePercentToBps(inputs.start);
  const stepBps = parsePercentToBps(inputs.step);
  const capBps = parsePercentToBps(inputs.cap);
  const minutes = Number(inputs.everyMinutes);
  const hours = Number(inputs.hours);
  if (startBps === null || stepBps === null || capBps === null) {
    return { params: null, error: "Discounts are percentages with up to two decimals" };
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(hours) || hours <= 0) {
    return { params: null, error: "Interval and duration must be positive numbers" };
  }
  const params: SessionParams = {
    startBps,
    stepBps,
    stepInterval: Math.round(minutes * 60),
    capBps,
    duration: Math.round(hours * 3600),
    payMask: inputs.payIdx.length > 0 ? buildPayMask(inputs.payIdx) : 0,
  };
  const error = validateSessionParams(params, {
    maxDiscountBps: meta.maxDiscountBps,
    maxDurationSeconds: meta.maxSessionDuration,
    payTokenCount: meta.payTokens.length,
  });
  return error ? { params: null, error } : { params, error: null };
}

function flashPayIndices(meta: MarketMeta): number[] {
  if (meta.venue === "aave") return meta.aaveFlashPayIdx;
  return meta.payTokens.flatMap((t, i) => (isAddressEqual(t.address, meta.underlying.address) ? [] : [i]));
}

export function AuctionSettings({
  meta,
  bids,
  inputs,
  onChange,
}: {
  meta: MarketMeta;
  bids: BidView[];
  inputs: AuctionInputs;
  onChange: (next: AuctionInputs) => void;
}) {
  const { params, error } = deriveSessionParams(inputs, meta);
  const set = (patch: Partial<AuctionInputs>) => onChange({ ...inputs, ...patch });
  const togglePay = (i: number) =>
    set({ payIdx: inputs.payIdx.includes(i) ? inputs.payIdx.filter((x) => x !== i) : [...inputs.payIdx, i].sort() });

  const vaultMin = meta.vault.minDiscountBps;
  const flash = flashPayIndices(meta);
  const bestBid = bids.find((b) => b.capacityAssets > 0n);

  let path: string | null = null;
  if (params) {
    const toVault = secondsToReach(params, vaultMin);
    const toBid = bestBid ? secondsToReach(params, bestBid.minDiscountBps) : null;
    const toCap = secondsToReach(params, params.capBps);
    path = [
      `Starts at ${formatBps(params.startBps)}, rises ${formatBps(params.stepBps)} every ${formatDuration(params.stepInterval)} up to ${formatBps(params.capBps)}${toCap ? ` (after ${formatDuration(toCap)})` : ""}.`,
      bestBid && toBid !== null
        ? `Reaches the best limit bid (${formatBps(bestBid.minDiscountBps)}) ${toBid === 0 ? "at once" : `after ${formatDuration(toBid)}`}.`
        : null,
      toVault !== null
        ? `Reaches the Exeunt Vault's ${formatBps(vaultMin)} ${toVault === 0 ? "at once" : `after ${formatDuration(toVault)}`}.`
        : `Never reaches the Exeunt Vault's ${formatBps(vaultMin)} minimum.`,
      `Ends after ${formatDuration(params.duration)}; borrowers can buy at any moment until then.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  const field = (id: string, label: string, value: string, key: keyof AuctionInputs, suffix: string) => (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="input-row">
        <input
          id={id}
          className="input input--mono"
          inputMode="decimal"
          value={value}
          data-testid={id}
          onChange={(e) => set({ [key]: e.target.value } as Partial<AuctionInputs>)}
        />
        <span className="input-suffix">{suffix}</span>
      </div>
    </div>
  );

  return (
    <div className="stack-sm">
      <fieldset className="fieldset">
        <legend className="label">Get paid in</legend>
        <div className="toggle-group">
          {meta.payTokens.map((t, i) => (
            <button
              key={t.address}
              type="button"
              className="toggle toggle--pill"
              aria-pressed={inputs.payIdx.includes(i)}
              data-testid={`sell-pay-${t.symbol}`}
              onClick={() => togglePay(i)}
            >
              {t.symbol}
            </button>
          ))}
        </div>
        <span className="hint">
          Accept more assets to reach more buyers. The Exeunt Vault pays in {meta.vault.asset.symbol}
          {flash.length > 0
            ? `; borrowers in flash mode pay with freed ${flash.map((i) => meta.payTokens[i]?.symbol).join(" or ")} collateral`
            : ""}
          .
        </span>
      </fieldset>
      <fieldset className="fieldset">
        <legend className="label">Auction settings</legend>
        <div className="field-grid">
          {field("auction-start", "Start discount", inputs.start, "start", "%")}
          {field("auction-step", "Rises by", inputs.step, "step", "%")}
          {field("auction-every", "Every", inputs.everyMinutes, "everyMinutes", "min")}
          {field("auction-cap", "Never above", inputs.cap, "cap", "%")}
          {field("auction-hours", "Run for", inputs.hours, "hours", "h")}
        </div>
      </fieldset>
      <p className={error ? "small text-bad" : "small muted"} data-testid="auction-path">
        {error ?? path}
      </p>
    </div>
  );
}
