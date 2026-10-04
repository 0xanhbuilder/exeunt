import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import type { ExeuntClient, TokenInfo, UnsignedTx } from "@exeunt/sdk";
import { describeError } from "./errors";
import { formatToken } from "./format";
import { useNetwork } from "./network-context";
import { useWallet } from "./wallet-context";

/**
 * Aave can take a costlier branch at execution than during estimation (seen on Arbitrum Sepolia:
 * withdrawUnsold estimated 141,740 gas but needed more), so every send carries a 30% buffer.
 */
export function withGasBuffer(estimate: bigint): bigint {
  return (estimate * 13n) / 10n;
}

/**
 * An aToken transfer can round up by one scaled unit (a few wei), so an exact allowance can fall short.
 * Approvals for aToken pulls add this margin per transfer; it is worth a negligible fraction of a token.
 */
export function withATokenMargin(amount: bigint, transfers: number): bigint {
  return amount + 10n * BigInt(Math.max(1, transfers));
}

export interface TxStep {
  label: string;
  tx: UnsignedTx;
  /** Later steps rely on this approval being on-chain, so they cannot be simulated before it lands. */
  approval?: boolean;
}

/** An exact-amount approval when the current allowance is short; null when none is needed. */
export async function approvalStep(
  exeunt: ExeuntClient,
  token: TokenInfo,
  owner: Address,
  spender: Address,
  amount: bigint,
  why: string,
): Promise<TxStep | null> {
  if (amount === 0n) return null;
  const current = await exeunt.allowance(token.address, owner, spender);
  if (current >= amount) return null;
  return {
    label: `Approve ${formatToken(amount, token)} ${why}`,
    tx: exeunt.approve(token.address, spender, amount),
    approval: true,
  };
}

export type StepPhase =
  | "queued"
  | "simulating"
  | "simulated"
  | "deferred"
  | "signing"
  | "pending"
  | "confirmed"
  | "failed";

export interface StepView {
  label: string;
  phase: StepPhase;
  hash?: Hex;
  error?: string;
}

export interface RunnerState {
  busy: "simulate" | "send" | null;
  steps: StepView[];
  outcome: "none" | "simulated" | "partial" | "failed" | "sent";
  message: string | null;
}

const IDLE: RunnerState = { busy: null, steps: [], outcome: "none", message: null };

export interface TxRunner {
  state: RunnerState;
  /** Dry-runs each step with eth_call; steps after an unconfirmed approval are marked deferred. */
  simulate: (build: () => Promise<TxStep[]>) => Promise<boolean>;
  /** For each step: simulate, ask the wallet to sign, wait for the receipt. Stops at the first failure. */
  send: (build: () => Promise<TxStep[]>) => Promise<boolean>;
  reset: () => void;
}

export function useTxRunner(): TxRunner {
  const { exeunt, info, publicClient, refresh } = useNetwork();
  const wallet = useWallet();
  const [state, setState] = useState<RunnerState>(IDLE);

  const patchStep = useCallback((i: number, patch: Partial<StepView>) => {
    setState((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));
  }, []);

  const fail = useCallback((message: string) => {
    setState((s) => ({ ...s, busy: null, outcome: "failed", message }));
  }, []);

  const simulate = useCallback(
    async (build: () => Promise<TxStep[]>) => {
      const account = wallet.address;
      if (!exeunt || !account) {
        setState({ ...IDLE, outcome: "failed", message: "Connect a wallet to simulate." });
        return false;
      }
      setState({ busy: "simulate", steps: [], outcome: "none", message: null });
      let steps: TxStep[];
      try {
        steps = await build();
      } catch (e) {
        fail(describeError(e));
        return false;
      }
      setState((s) => ({ ...s, steps: steps.map((st) => ({ label: st.label, phase: "queued" })) }));
      let afterApproval = false;
      let deferred = false;
      for (const [i, step] of steps.entries()) {
        if (afterApproval) {
          patchStep(i, { phase: "deferred" });
          deferred = true;
          continue;
        }
        patchStep(i, { phase: "simulating" });
        try {
          await exeunt.simulate(step.tx, account);
          patchStep(i, { phase: "simulated" });
        } catch (e) {
          const msg = describeError(e);
          patchStep(i, { phase: "failed", error: msg });
          fail(`Simulation failed: ${msg}`);
          return false;
        }
        if (step.approval) afterApproval = true;
      }
      setState((s) => ({
        ...s,
        busy: null,
        outcome: deferred ? "partial" : "simulated",
        message: deferred
          ? "The approval simulates fine. The rest is simulated again right after the approval confirms, and nothing more is sent if it fails."
          : "Simulation passed against the current block.",
      }));
      return true;
    },
    [exeunt, wallet.address, patchStep, fail],
  );

  const send = useCallback(
    async (build: () => Promise<TxStep[]>) => {
      const account = wallet.address;
      const client = wallet.walletClient;
      if (!exeunt || !account || !client || wallet.writeBlockedReason) {
        setState({ ...IDLE, outcome: "failed", message: wallet.writeBlockedReason ?? "Connect a wallet first." });
        return false;
      }
      setState({ busy: "send", steps: [], outcome: "none", message: null });
      let steps: TxStep[];
      try {
        await wallet.ensureChain();
        steps = await build();
      } catch (e) {
        fail(describeError(e));
        return false;
      }
      setState((s) => ({ ...s, steps: steps.map((st) => ({ label: st.label, phase: "queued" })) }));
      for (const [i, step] of steps.entries()) {
        patchStep(i, { phase: "simulating" });
        try {
          await exeunt.simulate(step.tx, account);
        } catch (e) {
          const msg = describeError(e);
          patchStep(i, { phase: "failed", error: msg });
          fail(`Simulation failed, so this step was not sent: ${msg}`);
          if (i > 0) refresh();
          return false;
        }
        patchStep(i, { phase: "signing" });
        try {
          const estimate = await publicClient.estimateGas({
            account,
            to: step.tx.to,
            data: step.tx.data,
            value: step.tx.value,
          });
          const hash = await client.sendTransaction({
            account: client.account,
            chain: info.chain,
            to: step.tx.to,
            data: step.tx.data,
            value: step.tx.value,
            gas: withGasBuffer(estimate),
          });
          patchStep(i, { phase: "pending", hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
          patchStep(i, { phase: "confirmed" });
        } catch (e) {
          const msg = describeError(e);
          patchStep(i, { phase: "failed", error: msg });
          fail(msg);
          if (i > 0) refresh();
          return false;
        }
      }
      setState((s) => ({ ...s, busy: null, outcome: "sent", message: "Done. Every step is confirmed on-chain." }));
      refresh();
      return true;
    },
    [exeunt, info.chain, publicClient, wallet, patchStep, fail, refresh],
  );

  const reset = useCallback(() => setState(IDLE), []);
  return { state, simulate, send, reset };
}
