import {
  encodeAbiParameters,
  keccak256,
  numberToHex,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { erc20Abi } from "@exeunt/sdk";

/** Thin wrapper over anvil's JSON-RPC cheat methods. */
export class Anvil {
  constructor(readonly client: PublicClient) {}

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    // anvil_* and evm_* methods are not in viem's typed schema.
    return (this.client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({
      method,
      params,
    });
  }

  setBalance(address: Address, wei: bigint): Promise<unknown> {
    return this.rpc("anvil_setBalance", [address, numberToHex(wei)]);
  }

  setStorageAt(address: Address, slot: Hex, value: Hex): Promise<unknown> {
    return this.rpc("anvil_setStorageAt", [address, slot, value]);
  }

  impersonate(address: Address): Promise<unknown> {
    return this.rpc("anvil_impersonateAccount", [address]);
  }

  stopImpersonating(address: Address): Promise<unknown> {
    return this.rpc("anvil_stopImpersonatingAccount", [address]);
  }

  async increaseTime(seconds: number): Promise<void> {
    await this.rpc("evm_increaseTime", [seconds]);
    await this.rpc("evm_mine", []);
  }

  mine(): Promise<unknown> {
    return this.rpc("evm_mine", []);
  }

  snapshot(): Promise<Hex> {
    return this.rpc("evm_snapshot", []) as Promise<Hex>;
  }

  revert(id: Hex): Promise<unknown> {
    return this.rpc("evm_revert", [id]);
  }

  /** Sends a transaction as `from` without its key (anvil impersonation). */
  async sendAs(from: Address, to: Address, data: Hex, value = 0n): Promise<Hex> {
    await this.impersonate(from);
    const balance = await this.client.getBalance({ address: from });
    if (balance < 10n ** 17n) await this.setBalance(from, 10n ** 18n);
    const hash = (await this.rpc("eth_sendTransaction", [
      { from, to, data, value: numberToHex(value), gas: numberToHex(15_000_000n) },
    ])) as Hex;
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    await this.stopImpersonating(from);
    if (receipt.status !== "success") throw new Error(`impersonated tx reverted: ${hash}`);
    return hash;
  }

  /* --------------------------- ERC20 balances --------------------------- */

  private slotCache = new Map<Address, { slot: Hex; vyper: boolean } | null>();

  private static mappingKey(holder: Address, slot: Hex, vyper: boolean): Hex {
    return vyper
      ? keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [slot, holder]))
      : keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [holder, slot]));
  }

  /** Candidate base slots: 0..64 plus OpenZeppelin v5 namespaced ERC20 storage. */
  private static candidates(): Hex[] {
    const out: Hex[] = [];
    for (let i = 0; i <= 64; i++) out.push(pad(toHex(i)));
    out.push("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00");
    return out;
  }

  /** Finds the storage slot of `token`'s balance mapping by writing a probe value and reading balanceOf. */
  async findBalanceSlot(token: Address): Promise<{ slot: Hex; vyper: boolean }> {
    const cached = this.slotCache.get(token);
    if (cached) return cached;
    const probeHolder = "0x00000000000000000000000000000000000e7e07" as Address;
    const probe = 123_456_789_123n;
    for (const slot of Anvil.candidates()) {
      for (const vyper of [false, true]) {
        const key = Anvil.mappingKey(probeHolder, slot, vyper);
        const before = (await this.client.getStorageAt({ address: token, slot: key })) ?? pad("0x0");
        await this.setStorageAt(token, key, pad(toHex(probe)));
        const bal = await this.client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [probeHolder],
        });
        await this.setStorageAt(token, key, before);
        if (bal === probe) {
          const found = { slot, vyper };
          this.slotCache.set(token, found);
          return found;
        }
      }
    }
    throw new Error(`balance slot not found for ${token}`);
  }

  /** Sets `holder`'s balance of `token` to exactly `amount` (total supply is not adjusted). */
  async setErc20Balance(token: Address, holder: Address, amount: bigint): Promise<void> {
    const { slot, vyper } = await this.findBalanceSlot(token);
    await this.setStorageAt(token, Anvil.mappingKey(holder, slot, vyper), pad(toHex(amount)));
    const bal = await this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    if (bal !== amount) throw new Error(`deal failed for ${token}: wanted ${amount}, got ${bal}`);
  }

  /** Adds `amount` to `holder`'s current balance. */
  async dealErc20(token: Address, holder: Address, amount: bigint): Promise<void> {
    const bal = await this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    await this.setErc20Balance(token, holder, bal + amount);
  }
}
