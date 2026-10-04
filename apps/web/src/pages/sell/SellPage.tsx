import { DeploymentGate } from "../../components/DeploymentGate";
import { SellForm } from "./SellForm";
import { YourSales } from "./YourSales";

export function SellPage() {
  return (
    <div className="stack-lg">
      <section aria-labelledby="h-sell" className="page-head">
        <h1 id="h-sell">Sell a stuck position</h1>
        <p className="lead">
          The pool can't pay you out, so sell your stuck position on Exeunt and get paid now instead of waiting for
          the pool to refill.
        </p>
      </section>
      <DeploymentGate>
        {({ exeunt, meta }) => (
          <>
            <SellForm exeunt={exeunt} meta={meta} />
            <YourSales exeunt={exeunt} meta={meta} />
          </>
        )}
      </DeploymentGate>
    </div>
  );
}
