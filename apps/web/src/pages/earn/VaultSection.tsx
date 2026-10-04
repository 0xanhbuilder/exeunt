import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { aaveExitMarketAbi, exeuntVaultAbi, type BidView, type ExeuntClient } from "@exeunt/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { TxStatus } from "../../components/TxStatus";
import { Chip, Notice, Stat, SummaryRow, ToggleGroup } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatShare, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { baseYieldLine, receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

type VaultMode = "deposit" | "withdraw";

interface VaultData {
  state: Awaited<ReturnType<ExeuntClient["vaultState"]>>;
  withdrawable: bigint;
  walletBalance: bigint | null;
  /** Underlying value of the receipts a full withdrawal hands over in kind. */
  inKindValue: bigint;
}

async function loadVault(exeunt: ExeuntClient, meta: MarketMeta, account: Address | null): Promise<VaultData> {
  const [state, cap, walletBalance] = await Promise.all([
    exeunt.vaultState(account ?? undefined),
    exeunt.capacity(),
    account ? exeunt.balanceOf(meta.vault.asset.address, account) : Promise.resolve(null),
  ]);
  const inKindValue =
    state.redeemInKind === 0n
      ? 0n
      : await exeunt.client.readContract({
          address: exeunt.market,
          abi: aaveExitMarketAbi,
          functionName: "receiptValue",
          args: [state.redeemInKind],
        });
  return { state, withdrawable: cap.withdrawable, walletBalance, inKindValue };
}

export function VaultSection({ exeunt, meta, bids }: { exeunt: ExeuntClient; meta: MarketMeta; bids?: BidView[] }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const upkeep = useTxRunner();
  const [mode, setMode] = useState<VaultMode>("deposit");
  const [amount, setAmount] = useState("");
  const vault = useAsync(() => loadVault(exeunt, meta, address), [exeunt, meta, address], {
    pollMs: 20_000,
    reloadKey: refreshKey,
  });

  const asset = meta.vault.asset;
  const v = vault.data?.state;
  const parsed = parseAmountInput(amount, asset.decimals);
  const balance = vault.data?.walletBalance ?? null;
  const amountError =
    parsed.error ??
    (parsed.value !== null && balance !== null && parsed.value > balance ? `You hold ${formatToken(balance, asset)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const depositAssets = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;

  const preview = useAsync(
    () =>
      exeunt.client.readContract({
        address: meta.vault.address,
        abi: exeuntVaultAbi,
        functionName: "previewDeposit",
        args: [depositAssets ?? 0n],
      }),
    [exeunt, depositAssets],
    { enabled: depositAssets !== null },
  );

  const vaultBid = v && v.bidId > 0n ? bids?.find((b) => b.id === v.bidId && isAddressEqual(b.bidder, meta.vault.address)) : undefined;
  const held = v?.heldAssets ?? 0n;
  const withdrawable = vault.data?.withdrawable ?? 0n;
  const recoverable = held < withdrawable ? held : withdrawable;
  const busy = runner.state.busy !== null;

  let chip: { tone: "open" | "tight" | "neutral"; text: string } = { tone: "neutral", text: "…" };
  if (v) {
    if (v.totalAssets === 0n) chip = { tone: "neutral", text: "Empty: waiting for its first deposit" };
    else if (held > 0n) chip = { tone: "tight", text: "Holding receipts: recovers as the pool refills" };
    else chip = { tone: "open", text: `Waiting: no auction has reached ${formatBps(v.minDiscountBps)} yet` };
  }

  const depositSteps = async (): Promise<TxStep[]> => {
    if (!address || depositAssets === null) throw new Error("Enter an amount to deposit.");
    const approve = await approvalStep(exeunt, asset, address, meta.vault.address, depositAssets, "so the vault can take your deposit");
    return [
      ...(approve ? [approve] : []),
      { label: `Deposit ${formatToken(depositAssets, asset)} into the Exeunt Vault`, tx: exeunt.vaultDeposit(depositAssets, address) },
    ];
  };

  const withdrawSteps = async (): Promise<TxStep[]> => {
    if (!address) throw new Error("Connect a wallet first.");
    const shares = await exeunt.balanceOf(meta.vault.address, address);
    if (shares === 0n) throw new Error("You have no vault shares.");
    return [{ label: "Withdraw everything from the Exeunt Vault", tx: exeunt.vaultRedeem(shares, address, address) }];
  };

  return (
    <>
      <section aria-labelledby="h-vault" className="card card--pad stack" data-testid="vault-section">
        <div className="panel-head">
          <h2 id="h-vault" className="h2">
            {meta.vault.name}
          </h2>
          <Chip tone={chip.tone} testid="vault-state">
            {chip.text}
          </Chip>
        </div>
        {vault.error ? <Notice tone="danger">Can't read the vault: {describeError(vault.error)}</Notice> : null}
        <div className="stats">
          <Stat label="Waiting capital" value={v ? formatToken(v.idleAssets, asset) : "…"} testid="vault-idle" />
          <Stat label="Held in stuck receipts" value={v ? formatToken(held, asset) : "…"} testid="vault-held" />
          <Stat
            label="Standing bid now"
            value={vaultBid ? formatToken(vaultBid.capacityAssets, meta.underlying) : v ? "None" : "…"}
            testid="vault-bid"
          />
          <Stat label="Total" value={v ? formatToken(v.totalAssets, asset) : "…"} testid="vault-total" />
        </div>
        <ul className="rules">
          <li>
            Buys {receiptNoun(meta)} when the discount reaches <b>{formatBps(meta.vault.minDiscountBps)}</b>, using at
            most <b>{formatBps(meta.vault.maxShareBps, 0)}</b> of capital per receipt, so one freeze can't tie up
            most of the vault.
          </li>
          <li>Base yield while waiting: {baseYieldLine(asset)}.</li>
          <li>
            Redeems receipts at full value as soon as the pool refills; anyone can trigger it. Depositors keep the
            discount plus the interest the receipts earn meanwhile.
          </li>
        </ul>
        {recoverable > 0n && (
          <div className="stack-sm">
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="vault-recover"
              disabled={upkeep.state.busy !== null || !!wallet.writeBlockedReason}
              onClick={() =>
                void upkeep.send(async () => [
                  {
                    label: `Redeem ${formatToken(recoverable, asset)} of held receipts for the vault`,
                    tx: exeunt.vaultRecover(0n, recoverable),
                  },
                ])
              }
            >
              The pool can pay out again: redeem {formatToken(recoverable, asset)} of held receipts now
            </button>
            <TxStatus state={upkeep.state} />
          </div>
        )}
      </section>

      <section aria-labelledby="h-dw" className="card card--pad card--feature stack">
        <div className="panel-head">
          <h2 id="h-dw" className="h2-sm">
            Your position:{" "}
            <span data-testid="vault-position">
              {!address ? "connect a wallet" : v ? (v.shares === 0n ? "none yet" : `${formatShare(v.shares, v.totalSupply)} of the vault`) : "…"}
            </span>
          </h2>
          <ToggleGroup<VaultMode>
            label="Deposit or withdraw"
            value={mode}
            onChange={(m) => {
              setMode(m);
              runner.reset();
            }}
            options={[
              { value: "deposit", label: "Deposit", testid: "vault-mode-deposit" },
              { value: "withdraw", label: "Withdraw", testid: "vault-mode-withdraw" },
            ]}
          />
        </div>
        {mode === "deposit" ? (
          <>
            <AmountField
              id="dep-amt"
              label={`Deposit ${asset.symbol}`}
              value={amount}
              onChange={(val) => {
                setAmount(val);
                runner.reset();
              }}
              onMax={balance !== null && balance > 0n ? () => setAmount(toInputString(balance, asset.decimals)) : undefined}
              hint={
                balance !== null
                  ? `You hold ${formatToken(balance, asset)}${preview.data !== undefined && v ? ` · you get ${formatShare(preview.data, v.totalSupply + preview.data)} of the vault` : ""}`
                  : "Connect a wallet to deposit"
              }
              error={amount ? amountError : null}
              testid="vault-deposit-amount"
            />
            <button
              type="button"
              className="btn btn--primary btn--lg"
              data-testid="vault-deposit-submit"
              disabled={!address || depositAssets === null || busy || !!wallet.writeBlockedReason}
              onClick={() => void runner.send(depositSteps).then((ok) => ok && setAmount(""))}
            >
              {busy ? "Working…" : `Deposit ${asset.symbol}`}
            </button>
            {address && balance === 0n && <DemoFunds kits={["bidder"]} compact />}
          </>
        ) : (
          <>
            <div className="summary">
              <SummaryRow label="Paid out now" testid="vault-out-now">
                {v ? formatToken(v.redeemNow, asset) : "…"}
              </SummaryRow>
              <SummaryRow label="Paid in kind (your share of held receipts)" testid="vault-out-kind">
                {v && vault.data
                  ? v.redeemInKind === 0n
                    ? `0 ${meta.receipt.symbol}`
                    : `${formatToken(v.redeemInKind, meta.receipt)}${meta.venue === "morpho" ? ` (≈ ${formatToken(vault.data.inKindValue, meta.underlying)})` : ""}`
                  : "…"}
              </SummaryRow>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--lg"
              data-testid="vault-withdraw-submit"
              disabled={!address || !v || v.shares === 0n || busy || !!wallet.writeBlockedReason}
              onClick={() => void runner.send(withdrawSteps)}
            >
              {busy ? "Working…" : "Withdraw all · no waiting period"}
            </button>
          </>
        )}
        {wallet.writeBlockedReason && address && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <TxStatus state={runner.state} />
        <p className="small muted">
          Risks: capital can sit in stuck receipts until the pool refills, and receipts lose value if the pool takes
          bad debt. The per-receipt cap limits both.
        </p>
      </section>
    </>
  );
}
