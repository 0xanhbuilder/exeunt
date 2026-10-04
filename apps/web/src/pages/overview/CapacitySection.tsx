import { useState } from "react";
import type { CapacityView, ExeuntClient } from "@exeunt/sdk";
import { DeploymentGate } from "../../components/DeploymentGate";
import { ToggleGroup } from "../../components/ui";
import { parsePercentToBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { bidLevels, type BidLevel } from "../../lib/orderbook";
import { AlertForm } from "./AlertForm";
import { CapacityTable } from "./CapacityTable";
import { MyPools } from "./MyPools";
import { UtilizationChart } from "./UtilizationChart";

export interface CapacityData {
  cap: CapacityView;
  /** Receipt value escrowed bids (including the Exeunt Vault) buy at any discount up to the market maximum. */
  bidTotal: bigint;
  levels: BidLevel[];
}

async function loadCapacity(exeunt: ExeuntClient, meta: MarketMeta): Promise<CapacityData> {
  const [cap, bidTotal, bids] = await Promise.all([
    exeunt.capacity(),
    exeunt.bidCapacityAt(meta.maxDiscountBps),
    exeunt.bids(),
  ]);
  return { cap, bidTotal, levels: bidLevels(bids) };
}

type View = "all" | "mine";

export function CapacitySection() {
  const { info } = useNetwork();
  const [view, setView] = useState<View>("all");
  const [threshold, setThreshold] = useState("95");
  return (
    <section id="capacity" className="card card--lg stack" aria-labelledby="h-pools">
      <div className="section-head">
        <div className="stack-xs">
          <h2 id="h-pools" className="h2">
            Exit capacity on {info.label}
          </h2>
          <p className="muted small">
            How much can leave each pool right now, and who stands ready to buy the rest. Read from the chain.
          </p>
        </div>
        <ToggleGroup<View>
          variant="tab"
          label="Pools view"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "All pools", testid: "capacity-tab-all" },
            { value: "mine", label: "My pools", testid: "capacity-tab-mine" },
          ]}
        />
      </div>
      <DeploymentGate>
        {({ exeunt, meta }) => (
          <CapacityBody exeunt={exeunt} meta={meta} view={view} threshold={threshold} onThreshold={setThreshold} />
        )}
      </DeploymentGate>
    </section>
  );
}

function CapacityBody({
  exeunt,
  meta,
  view,
  threshold,
  onThreshold,
}: {
  exeunt: ExeuntClient;
  meta: MarketMeta;
  view: View;
  threshold: string;
  onThreshold: (v: string) => void;
}) {
  const { refreshKey } = useNetwork();
  const capacity = useAsync(() => loadCapacity(exeunt, meta), [exeunt, meta], {
    pollMs: 15_000,
    reloadKey: refreshKey,
  });
  return (
    <>
      {view === "all" ? (
        <CapacityTable meta={meta} capacity={capacity} />
      ) : (
        <MyPools exeunt={exeunt} meta={meta} capacity={capacity.data} />
      )}
      <div className="split">
        <UtilizationChart
          meta={meta}
          currentBps={capacity.data?.cap.utilizationBps}
          thresholdBps={parsePercentToBps(threshold) ?? undefined}
        />
        <AlertForm threshold={threshold} onThreshold={onThreshold} />
      </div>
    </>
  );
}
