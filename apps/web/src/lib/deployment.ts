import { NETWORKS, parseDeployment, type Deployment, type NetworkKey } from "@exeunt/sdk";

export type DeploymentState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ready"; deployment: Deployment };

/** Validates a fetched deployment file against the network it was requested for. */
export function checkDeployment(key: NetworkKey, raw: unknown): DeploymentState {
  try {
    const d = parseDeployment(raw);
    if (d.network !== key) return { status: "invalid", error: `the file is for "${d.network}", not "${key}"` };
    const chainId = NETWORKS[key].chain.id;
    if (d.chainId !== chainId) return { status: "invalid", error: `chain id ${d.chainId} does not match ${chainId}` };
    return { status: "ready", deployment: d };
  } catch (e) {
    return { status: "invalid", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetches /deployments/<network>.json, written at dev/build time by scripts/sync-deployments.mjs. */
export async function loadDeployment(
  key: NetworkKey,
  baseUrl: string = import.meta.env.BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentState> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}deployments/${key}.json`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return { status: "missing" };
  }
  if (!res.ok) return { status: "missing" };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    // Dev servers answer unknown paths with index.html, which is "not deployed" too.
    return { status: "missing" };
  }
  return checkDeployment(key, raw);
}
