import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  http,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describeError } from "./errors";
import { readStorage, writeStorage } from "./hooks";
import { useNetwork } from "./network-context";

export type WalletKind = "injected" | "demo";
export type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

const DEMO_KEY_STORAGE = "exeunt.demoWallet.privateKey";
const KIND_STORAGE = "exeunt.wallet.kind";

export interface WalletContextValue {
  kind: WalletKind | null;
  address: Address | null;
  walletClient: ConnectedWalletClient | null;
  hasInjected: boolean;
  busy: boolean;
  error: string | null;
  /** Injected wallet is on another chain than the selected network. */
  wrongChain: boolean;
  /** Why writes are disabled right now, or null when they are allowed. */
  writeBlockedReason: string | null;
  connectInjected: () => Promise<void>;
  connectDemo: () => void;
  disconnect: () => void;
  ensureChain: () => Promise<void>;
  /** Wallet to hand to SDK helpers that sign typed data for `address`. */
  typedDataSigner: () => WalletClient | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function injectedProvider(): EIP1193Provider | undefined {
  return typeof window !== "undefined" ? window.ethereum : undefined;
}

function hasErrorCode(err: unknown, code: number): boolean {
  let current: unknown = err;
  for (let i = 0; i < 10 && typeof current === "object" && current !== null; i++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === code) return true;
    current = e.cause;
  }
  return false;
}

function readDemoKey(): Hex | null {
  const key = readStorage(DEMO_KEY_STORAGE);
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null;
}

/**
 * The SDK passes the account as an address when signing typed data, which viem routes to the RPC. A burner
 * key lives in the page, so its signer must sign locally instead.
 */
function localTypedDataSigner(client: ConnectedWalletClient, account: PrivateKeyAccount): WalletClient {
  const signTypedData = (args: Parameters<PrivateKeyAccount["signTypedData"]>[0]) => account.signTypedData(args);
  return { ...client, signTypedData } as unknown as WalletClient;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { info, rpcUrl } = useNetwork();
  const provider = injectedProvider();
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [injectedAddress, setInjectedAddress] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [demoKey, setDemoKey] = useState<Hex | null>(readDemoKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = readStorage(KIND_STORAGE);
    if (saved === "demo" && readDemoKey()) setKind("demo");
    if (saved === "injected" && provider) {
      provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          const first = accounts[0];
          if (first) {
            setInjectedAddress(getAddress(first));
            setKind("injected");
          }
        })
        .catch(() => undefined);
    }
  }, [provider]);

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (accounts: Address[]) => {
      const first = accounts[0];
      setInjectedAddress(first ? getAddress(first) : null);
    };
    const onChain = (chainId: string) => setWalletChainId(Number(chainId));
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    provider
      .request({ method: "eth_chainId" })
      .then((id) => setWalletChainId(Number(id)))
      .catch(() => undefined);
    return () => {
      provider.removeListener("accountsChanged", onAccounts);
      provider.removeListener("chainChanged", onChain);
    };
  }, [provider]);

  const demoAccount = useMemo(() => (demoKey ? privateKeyToAccount(demoKey) : null), [demoKey]);

  const walletClient = useMemo<ConnectedWalletClient | null>(() => {
    if (kind === "demo" && demoAccount) {
      return createWalletClient({ account: demoAccount, chain: info.chain, transport: http(rpcUrl) });
    }
    if (kind === "injected" && provider && injectedAddress) {
      return createWalletClient({ account: injectedAddress, chain: info.chain, transport: custom(provider) });
    }
    return null;
  }, [kind, demoAccount, provider, injectedAddress, info.chain, rpcUrl]);

  const address: Address | null =
    kind === "demo" ? (demoAccount?.address ?? null) : kind === "injected" ? injectedAddress : null;

  const connectInjected = useCallback(async () => {
    if (!provider) {
      setError("No browser wallet found. Install one, or use the demo wallet on testnets and forks.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const first = accounts[0];
      if (!first) throw new Error("The wallet returned no account.");
      setInjectedAddress(getAddress(first));
      setKind("injected");
      writeStorage(KIND_STORAGE, "injected");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [provider]);

  const connectDemo = useCallback(() => {
    let key = readDemoKey();
    if (!key) {
      key = generatePrivateKey();
      writeStorage(DEMO_KEY_STORAGE, key);
    }
    setDemoKey(key);
    setKind("demo");
    setError(null);
    writeStorage(KIND_STORAGE, "demo");
  }, []);

  const disconnect = useCallback(() => {
    setKind(null);
    setError(null);
    writeStorage(KIND_STORAGE, null);
  }, []);

  const ensureChain = useCallback(async () => {
    if (kind !== "injected" || !walletClient) return;
    const current = await walletClient.getChainId();
    if (current === info.chain.id) return;
    try {
      await walletClient.switchChain({ id: info.chain.id });
    } catch (e) {
      if (!hasErrorCode(e, 4902)) throw e;
      await walletClient.addChain({ chain: { ...info.chain, rpcUrls: { default: { http: [rpcUrl] } } } });
      await walletClient.switchChain({ id: info.chain.id });
    }
    setWalletChainId(info.chain.id);
  }, [kind, walletClient, info.chain, rpcUrl]);

  const typedDataSigner = useCallback((): WalletClient | null => {
    if (!walletClient) return null;
    if (kind === "demo" && demoAccount) return localTypedDataSigner(walletClient, demoAccount);
    return walletClient as unknown as WalletClient;
  }, [walletClient, kind, demoAccount]);

  const wrongChain = kind === "injected" && walletChainId !== null && walletChainId !== info.chain.id;

  let writeBlockedReason: string | null = null;
  if (!address) writeBlockedReason = "Connect a wallet first.";
  else if (kind === "injected" && info.isFork) {
    writeBlockedReason = `${info.label} is a local fork that reuses chain id ${info.chain.id}, so a browser wallet would send to the real chain. Use the demo wallet here.`;
  }

  const value: WalletContextValue = {
    kind,
    address,
    walletClient,
    hasInjected: provider !== undefined,
    busy,
    error,
    wrongChain,
    writeBlockedReason,
    connectInjected,
    connectDemo,
    disconnect,
    ensureChain,
    typedDataSigner,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}
