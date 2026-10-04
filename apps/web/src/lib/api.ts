import type { NetworkKey } from "@exeunt/sdk";
import { apiBaseUrl } from "./env";

/** All calls to the Exeunt backend. The backend is optional: callers show a notice when it is unreachable. */

export class ApiError extends Error {
  readonly offline: boolean;
  constructor(message: string, offline: boolean) {
    super(message);
    this.offline = offline;
  }
}

export interface HistoryPoint {
  t: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
}

export interface AlertRule {
  id: string;
  network: string;
  thresholdBps: number;
  webhookUrl: string | null;
}

export interface AlertEvent {
  network: string;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

export type FaucetKit = "seller" | "borrower" | "bidder";

type Json = Record<string, unknown>;

async function request(path: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
  } catch {
    throw new ApiError(`The Exeunt backend is unreachable at ${apiBaseUrl()}.`, true);
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = typeof body === "object" && body !== null ? (body as Json) : {};
  if (!res.ok) {
    const msg = typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : null;
    throw new ApiError(msg ?? `The backend answered ${res.status}.`, false);
  }
  return obj;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v): v is Json => typeof v === "object" && v !== null) : [];
}

export async function getCapacityHistory(network: NetworkKey, hours = 24): Promise<HistoryPoint[]> {
  const body = await request(`/api/capacity/${network}/history?hours=${hours}`);
  return list(body.points)
    .map((p) => ({
      t: num(p.t),
      utilizationBps: num(p.utilizationBps),
      withdrawable: String(p.withdrawable ?? ""),
      supplied: String(p.supplied ?? ""),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.utilizationBps));
}

export async function createAlert(input: {
  network: NetworkKey;
  thresholdBps: number;
  webhookUrl?: string;
  owner: string;
}): Promise<string> {
  const body = await request("/api/alerts", { method: "POST", body: JSON.stringify(input) });
  return String(body.id ?? "");
}

export async function listAlerts(owner: string): Promise<AlertRule[]> {
  const body = await request(`/api/alerts?owner=${encodeURIComponent(owner)}`);
  return list(body.alerts).map((a) => ({
    id: String(a.id ?? ""),
    network: String(a.network ?? ""),
    thresholdBps: num(a.thresholdBps),
    webhookUrl: typeof a.webhookUrl === "string" && a.webhookUrl !== "" ? a.webhookUrl : null,
  }));
}

export async function deleteAlert(id: string): Promise<void> {
  await request(`/api/alerts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getAlertEvents(owner: string): Promise<AlertEvent[]> {
  const body = await request(`/api/alerts/events?owner=${encodeURIComponent(owner)}`);
  return list(body.events).map((e) => ({
    network: String(e.network ?? ""),
    utilizationBps: num(e.utilizationBps),
    thresholdBps: num(e.thresholdBps),
    at: num(e.at),
  }));
}

export async function requestDemoFunds(network: NetworkKey, address: string, kit: FaucetKit): Promise<string[]> {
  const body = await request(
    "/api/faucet",
    { method: "POST", body: JSON.stringify({ network, address, kit }) },
    60_000,
  );
  if (body.ok !== true) throw new ApiError("The faucet did not confirm the transfer.", false);
  return Array.isArray(body.txs) ? body.txs.map((t) => String(t)) : [];
}
