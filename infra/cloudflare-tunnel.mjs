// Creates (or reuses) the "exeunt" Cloudflare Tunnel, sets its public hostnames and DNS records through the
// Cloudflare API, and writes the tunnel run token to .release/tunnel-token (git-ignored).
// Usage: CF_API_TOKEN=... node infra/cloudflare-tunnel.mjs
// The token needs: Account · Cloudflare Tunnel · Edit, and Zone · DNS · Edit on exeunt.space.
import { mkdirSync, writeFileSync } from "node:fs";

const ZONE = "exeunt.space";
const TUNNEL = "exeunt";
const INGRESS = [
  { hostname: "api.exeunt.space", service: "http://127.0.0.1:8787" },
  { hostname: "exeunt.space", service: "http://127.0.0.1:8080" },
  { hostname: "www.exeunt.space", service: "http://127.0.0.1:8080" },
  { service: "http_status:404" },
];

const token = process.env.CF_API_TOKEN;
if (!token) {
  process.stderr.write("CF_API_TOKEN is not set\n");
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

const log = (line) => process.stdout.write(`${line}\n`);

const verified = await cf("GET", "/user/tokens/verify");
log(`token: ${verified.status}`);

const zones = await cf("GET", `/zones?name=${ZONE}`);
const zone = zones[0];
if (!zone) throw new Error(`zone ${ZONE} is not visible to this token`);
const accountId = zone.account.id;
log(`zone ${ZONE}: ${zone.id} (${zone.status}), account ${accountId}`);

const existing = await cf("GET", `/accounts/${accountId}/cfd_tunnel?name=${TUNNEL}&is_deleted=false`);
const tunnel = existing[0] ?? (await cf("POST", `/accounts/${accountId}/cfd_tunnel`, { name: TUNNEL, config_src: "cloudflare" }));
log(`tunnel ${TUNNEL}: ${tunnel.id}${existing[0] ? " (reused)" : " (created)"}`);

await cf("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: INGRESS } });
log("ingress configured");

const target = `${tunnel.id}.cfargotunnel.com`;
for (const { hostname } of INGRESS.filter((r) => r.hostname)) {
  const records = await cf("GET", `/zones/${zone.id}/dns_records?name=${hostname}`);
  const conflict = records.find((r) => r.type !== "CNAME");
  if (conflict) throw new Error(`${hostname} already has a ${conflict.type} record; remove it in the dashboard first`);
  const record = { type: "CNAME", name: hostname, content: target, proxied: true, comment: "Exeunt tunnel" };
  if (records[0]) await cf("PUT", `/zones/${zone.id}/dns_records/${records[0].id}`, record);
  else await cf("POST", `/zones/${zone.id}/dns_records`, record);
  log(`dns ${hostname} -> ${target}`);
}

const runToken = await cf("GET", `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
mkdirSync(".release", { recursive: true });
writeFileSync(".release/tunnel-token", runToken);
log("tunnel run token written to .release/tunnel-token");
