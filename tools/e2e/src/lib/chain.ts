import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  maxUint256,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  exeuntVaultAbi,
  morphoVaultExitMarketAbi,
  ExeuntClient,
  type UnsignedTx,
} from "@exeunt/sdk";
import type { Recorder } from "./report.js";

/** Anvil's well-known test keys #1..#9 (never used outside local forks). */
const TEST_KEYS: Hex[] = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d20de3b5aec",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

export interface Actor {
  name: string;
  account: PrivateKeyAccount;
  address: Address;
  wallet: WalletClient;
}

export function makeClients(rpcUrl: string, chain: Chain): { publicClient: PublicClient } {
  return { publicClient: createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) }) as PublicClient };
}

export function makeActors(names: string[], rpcUrl: string, chain: Chain, keys: Hex[] = TEST_KEYS): Actor[] {
  return names.map((name, i) => {
    const key = keys[i];
    if (!key) throw new Error(`no key for actor ${name}`);
    const account = privateKeyToAccount(key);
    return {
      name,
      account,
      address: account.address,
      wallet: createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 120_000 }) }),
    };
  });
}

const ERROR_ABIS: Abi[] = [aaveExitMarketAbi, morphoVaultExitMarketAbi, exeuntVaultAbi, aaveCollateralRouteAbi];

function revertData(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const inner = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
  return inner?.data;
}

/** Human-readable revert reason, decoding Exeunt custom errors when possible. */
export function explain(e: unknown): string {
  const data = revertData(e);
  if (data && data.length >= 10) {
    for (const abi of ERROR_ABIS) {
      try {
        const d = decodeErrorResult({ abi, data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        // try next ABI
      }
    }
    return `revert ${data.slice(0, 10)}`;
  }
  if (e instanceof ContractFunctionRevertedError) return e.shortMessage;
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Simulates then sends an SDK-built transaction from `actor`, exactly like the web app does,
 * and fails loudly with the decoded revert reason.
 */
export async function send(
  r: Recorder,
  sdk: ExeuntClient,
  actor: Actor,
  tx: UnsignedTx,
): Promise<{ hash: Hex; gasUsed: bigint }> {
  try {
    await sdk.simulate(tx, actor.address);
  } catch (e) {
    throw new Error(`simulation failed for "${tx.description}" from ${actor.name}: ${explain(e)}`);
  }
  // Execution can take costlier branches than the estimate saw (e.g. Aave disabling collateral), so add 30%.
  const estimate = await sdk.client.estimateGas({ account: actor.address, to: tx.to, data: tx.data, value: tx.value });
  const hash = await actor.wallet.sendTransaction({
    account: actor.account,
    chain: actor.wallet.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: (estimate * 13n) / 10n,
  });
  r.noteTx(hash);
  const receipt = await sdk.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${tx.description} (${hash})`);
  return { hash, gasUsed: receipt.gasUsed };
}

/** Sends an approval only when the current allowance is below `amount`. */
export async function ensureAllowance(
  r: Recorder,
  sdk: ExeuntClient,
  actor: Actor,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const current = await sdk.allowance(token, actor.address, spender);
  if (current >= amount) return;
  await send(r, sdk, actor, sdk.approve(token, spender, maxUint256));
}

/** Expects `tx` to revert in simulation; returns the decoded reason. */
export async function expectRevert(sdk: ExeuntClient, actor: Actor, tx: UnsignedTx): Promise<string> {
  try {
    await sdk.simulate(tx, actor.address);
  } catch (e) {
    return explain(e);
  }
  throw new Error(`expected "${tx.description}" to revert`);
}
