import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { ExeuntClient, NETWORKS, type NetworkInfo, type NetworkKey } from "@exeunt/sdk";
import { loadDeployment, type DeploymentState } from "./deployment";
import { rpcEnvName, rpcUrlFor } from "./env";
import { readStorage, useAsync, writeStorage, type AsyncState } from "./hooks";
import { loadMarketMeta, type MarketMeta } from "./market";
import { DEFAULT_NETWORK, isNetworkKey } from "./networks";

const STORAGE_KEY = "exeunt.network";

export interface NetworkContextValue {
  key: NetworkKey;
  info: NetworkInfo;
  rpcUrl: string;
  setKey: (key: NetworkKey) => void;
  publicClient: PublicClient;
  deployment: DeploymentState;
  exeunt: ExeuntClient | null;
  meta: AsyncState<MarketMeta>;
  /** Increments after every confirmed transaction so views reload. */
  refreshKey: number;
  refresh: () => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

function initialNetwork(): NetworkKey {
  const fromUrl = new URLSearchParams(window.location.search).get("network");
  if (isNetworkKey(fromUrl)) return fromUrl;
  const saved = readStorage(STORAGE_KEY);
  return isNetworkKey(saved) ? saved : DEFAULT_NETWORK;
}

function makePublicClient(info: NetworkInfo, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: info.chain,
    transport: http(rpcUrl),
    batch: info.chain.contracts?.multicall3 ? { multicall: true } : undefined,
    pollingInterval: info.isFork ? 1_000 : 2_000,
  });
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [key, setKeyState] = useState<NetworkKey>(initialNetwork);
  const [loaded, setLoaded] = useState<{ key: NetworkKey; state: DeploymentState } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const setKey = useCallback((next: NetworkKey) => {
    setKeyState(next);
    writeStorage(STORAGE_KEY, next);
  }, []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const info = NETWORKS[key];
  const rpcUrl = rpcUrlFor(key);
  const publicClient = useMemo(() => makePublicClient(info, rpcUrl), [info, rpcUrl]);

  useEffect(() => {
    let cancelled = false;
    loadDeployment(key).then((state) => {
      if (!cancelled) setLoaded({ key, state });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const deployment: DeploymentState = loaded && loaded.key === key ? loaded.state : { status: "loading" };
  const exeunt = useMemo(
    () => (deployment.status === "ready" ? new ExeuntClient(deployment.deployment, publicClient) : null),
    [deployment, publicClient],
  );

  const rpcHint = `Check that ${rpcUrl} serves ${info.label}; for a local fork set ${rpcEnvName(key)} to the fork's RPC.`;
  const metaState = useAsync(
    async () => {
      if (!exeunt) throw new Error("not deployed");
      return { client: exeunt, meta: await loadMarketMeta(exeunt, rpcHint) };
    },
    [exeunt],
    { enabled: exeunt !== null },
  );
  // Only hand out metadata read through the current client, never a previous network's.
  const current = metaState.data && metaState.data.client === exeunt ? metaState.data.meta : undefined;
  const meta: AsyncState<MarketMeta> = {
    data: current,
    error: current ? null : metaState.error,
    loading: !current && (metaState.loading || (exeunt !== null && !metaState.error)),
    reload: metaState.reload,
  };

  const value: NetworkContextValue = {
    key,
    info,
    rpcUrl,
    setKey,
    publicClient,
    deployment,
    exeunt,
    meta,
    refreshKey,
    refresh,
  };
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork outside NetworkProvider");
  return ctx;
}
