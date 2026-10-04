import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { NetworkKey } from "@exeunt/sdk";
import { readDotEnv, REPO_ROOT } from "./lib/env.js";
import { check, Recorder, toMarkdown, type ScenarioResult } from "./lib/report.js";

/**
 * Drives the deployed web app in headless Chrome over the DevTools protocol, like a user would:
 * demo wallet, demo funds on forks, sell, buy and repay, Exeunt Vault, limit bids, withdraw unsold.
 * Usage: npm run ui -w @exeunt/e2e -- [--url=https://exeunt.space] [--network=kelp-replay,...]
 */

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const log = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal DevTools protocol client over Node's built-in WebSocket. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();

  /** JSON-RPC calls the page made to the fork proxy (UI_DEBUG_RPC=1), for diagnosing failures. */
  readonly rpcLog: { t: number; body: string; response?: string }[] = [];
  private rpcByRequest = new Map<string, { t: number; body: string; response?: string }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: { requestId: string; request?: { url: string; postData?: string } };
      };
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      if (msg.method === "Network.requestWillBeSent" && msg.params?.request?.url.includes("/rpc/")) {
        const entry = { t: Date.now(), body: msg.params.request.postData ?? "" };
        this.rpcLog.push(entry);
        this.rpcByRequest.set(msg.params.requestId, entry);
      }
      if (msg.method === "Network.loadingFinished" && msg.params && this.rpcByRequest.has(msg.params.requestId)) {
        const entry = this.rpcByRequest.get(msg.params.requestId);
        void this.send<{ body: string }>("Network.getResponseBody", { requestId: msg.params.requestId })
          .then((r) => {
            if (entry) entry.response = r.body;
          })
          .catch(() => undefined);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        this.pending.delete(id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result as T);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

class Page {
  constructor(private readonly cdp: Cdp, readonly base: string) {}

  async eval<T>(expression: string): Promise<T> {
    const res = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`page error: ${res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  async goto(hash: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url: `${this.base}/${hash}` });
    await this.waitFor(`document.readyState === "complete"`, 30_000, "page load");
  }

  async waitFor(condition: string, timeoutMs: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.eval<boolean>(`Boolean(${condition})`).catch(() => false)) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  q(testid: string): string {
    return `document.querySelector('[data-testid="${testid}"]')`;
  }

  async waitTestId(testid: string, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(this.q(testid), timeoutMs, `[data-testid="${testid}"]`);
  }

  /** Transaction hashes on screen before the last click; a new action counts as done only once they change. */
  private hashesBefore = "";

  private txHashes(): Promise<string> {
    return this.eval<string>(`[...document.querySelectorAll('[data-testid="tx-hash"]')].map((e) => e.getAttribute("data-hash")).join(",")`);
  }

  async click(testid: string, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(`${this.q(testid)} && !${this.q(testid)}.disabled`, timeoutMs, `enabled ${testid}`);
    this.hashesBefore = await this.txHashes();
    await this.eval(`${this.q(testid)}.click()`);
  }

  /** Clicks the first element whose test id starts with `prefix`; returns its full test id. */
  async clickFirst(prefix: string, timeoutMs = 60_000): Promise<string> {
    const sel = `document.querySelector('[data-testid^="${prefix}"]')`;
    await this.waitFor(sel, timeoutMs, `${prefix}*`);
    const id = await this.eval<string>(`${sel}.getAttribute("data-testid")`);
    this.hashesBefore = await this.txHashes();
    await this.eval(`${sel}.click()`);
    return id;
  }

  /** Sets a React-controlled input the way typing would. */
  async type(testid: string, value: string): Promise<void> {
    await this.waitTestId(testid);
    await this.eval(`(() => {
      const el = ${this.q(testid)};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  }

  async text(testid: string): Promise<string> {
    return this.eval<string>(`(${this.q(testid)}?.textContent ?? "").trim()`);
  }

  /**
   * Waits for the transaction panel to report every step of the action just clicked as confirmed, or fails with
   * its message. The panel keeps the previous action's "sent" outcome until the new one starts, so the hashes
   * must also differ from those shown before the click.
   */
  async waitTxSent(timeoutMs = 240_000): Promise<string> {
    const outcome = `${this.q("tx-status")}?.getAttribute("data-outcome")`;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const o = await this.eval<string | null>(outcome).catch(() => null);
      const hashes = await this.txHashes().catch(() => this.hashesBefore);
      if (o === "sent" && hashes !== this.hashesBefore) return hashes;
      if (o === "failed") throw new Error(`transaction failed: ${await this.text("tx-message")} ${await this.eval<string>(`[...document.querySelectorAll(".tx-step-error")].map((e) => e.textContent).join(" | ")`)}`);
      await sleep(1000);
    }
    throw new Error("timed out waiting for the transaction to confirm");
  }

  /** Saves a screenshot and the visible text, for diagnosing a failed step. */
  async capture(path: string): Promise<void> {
    const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${path}.png`, Buffer.from(shot.data, "base64"));
    writeFileSync(`${path}.txt`, await this.eval<string>("document.body.innerText"));
  }

  /** Selects the network and the demo wallet key the app reads at start-up, then reloads. */
  async session(network: NetworkKey, key: Hex): Promise<void> {
    await this.goto("#/");
    await this.eval(`(() => {
      localStorage.setItem("exeunt.network", ${JSON.stringify(network)});
      localStorage.setItem("exeunt.demoWallet.privateKey", ${JSON.stringify(key)});
      localStorage.setItem("exeunt.wallet.kind", "demo");
    })()`);
    // A hash-only navigation keeps the running app; reload so it reads the new settings.
    await this.cdp.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    await this.waitFor(`document.readyState === "complete"`, 30_000, "reload");
    await this.waitTestId("wallet-button");
  }
}

function findChrome(): string {
  const p = process.env.CHROME_PATH ?? CHROME_PATHS.find((c) => existsSync(c));
  if (!p) throw new Error("Chrome or Edge not found; set CHROME_PATH");
  return p;
}

async function launch(): Promise<{ chrome: ChildProcess; cdp: Cdp }> {
  const port = 9333;
  const profile = mkdtempSync(join(tmpdir(), "exeunt-ui-"));
  const chrome = spawn(findChrome(), [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      // not up yet
    }
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) throw new Error("Chrome did not expose a page target");
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  if (process.env.UI_DEBUG_RPC) await cdp.send("Network.enable");
  return { chrome, cdp };
}

interface Amounts {
  sell: string;
  buy: string;
  vault: string;
  bid: string;
}

const FORK_AMOUNTS: Record<"aave" | "morpho", Amounts> = {
  aave: { sell: "2", buy: "0.5", vault: "1", bid: "1" },
  morpho: { sell: "2000", buy: "500", vault: "1000", bid: "1000" },
};

/** Read-only pass over every page of a network. */
async function browse(r: Recorder, page: Page, network: NetworkKey): Promise<void> {
  await r.step(`${network}: every page renders with live chain data`, async () => {
    await page.goto("#/");
    await page.waitFor(`${page.q(`capacity-row-${network}`)}`, 60_000, "capacity row");
    const routes: [string, string][] = [["sell", "sell"], ["buy", "buy"], ["earn", "earn"], ["frozen-collateral", "frozen"], ["developers", "developers"]];
    for (const [path, route] of routes) {
      await page.goto(`#/${path}`);
      await page.waitTestId(`page-${route}`);
    }
    await page.goto("#/earn");
    await page.waitTestId("orderbook", 60_000);
    return { capacity: (await page.text(`capacity-row-${network}`)).slice(0, 120) };
  }, { independent: true });
}

async function forkFlow(r: Recorder, page: Page, network: NetworkKey, venue: "aave" | "morpho"): Promise<void> {
  const amt = FORK_AMOUNTS[venue];
  for (const kit of ["seller", "borrower", "bidder"] as const) {
    await r.step(`${network}: get the ${kit} demo kit from the faucet`, async () => {
      await page.goto("#/sell");
      await page.click(`demo-kit-${kit}`);
      await page.waitFor(`${page.q("demo-funds-result")} && !${page.q("demo-funds-result")}.textContent.includes("…")`, 240_000, "faucet result");
      const msg = await page.text("demo-funds-result");
      check(!/fail|error|limit/i.test(msg), msg);
      return { result: msg.slice(0, 140) };
    });
  }

  await r.step(`${network}: open a Dutch auction from the Sell page`, async () => {
    await page.goto("#/sell");
    await page.click("sell-mode-auction");
    await page.type("sell-amount", amt.sell);
    await page.click("sell-submit");
    return { txs: await page.waitTxSent() };
  });

  await r.step(`${network}: buy and repay from the wallet on the Buy page`, async () => {
    await page.goto("#/buy");
    const picked = await page.clickFirst("buy-select-");
    await page.type("buy-amount", amt.buy);
    await page.click("buy-submit");
    return { session: picked, txs: await page.waitTxSent() };
  });

  await r.step(`${network}: deposit into the Exeunt Vault`, async () => {
    await page.goto("#/earn");
    await page.type("vault-deposit-amount", amt.vault);
    await page.click("vault-deposit-submit");
    return { txs: await page.waitTxSent() };
  });

  await r.step(`${network}: place a limit bid, then cancel it`, async () => {
    await page.goto("#/earn");
    await page.click("earn-tab-bids");
    await page.type("bid-amount", amt.bid);
    await page.click("bid-submit");
    await page.waitTxSent();
    const cancel = await page.clickFirst("bid-cancel-");
    return { cancelled: cancel, txs: await page.waitTxSent() };
  });

  await r.step(`${network}: withdraw the unsold auction at once`, async () => {
    await page.goto("#/sell");
    const id = await page.clickFirst("session-withdraw-");
    return { session: id, txs: await page.waitTxSent() };
  });
}

/** Live testnets: the funded deployer sells, the second test account buys; tiny amounts. */
async function liveFlow(r: Recorder, page: Page, network: NetworkKey, venue: "aave" | "morpho", keys: { seller: Hex; buyer: Hex }) {
  const amt = venue === "aave" ? { sell: "0.0006", buy: "0.0002", bid: "0.0002" } : { sell: "2", buy: "0.5", bid: "0.5" };
  await r.step(`${network}: seller opens a Dutch auction in the web app`, async () => {
    await page.session(network, keys.seller);
    await page.goto("#/sell");
    await page.click("sell-mode-auction");
    await page.type("sell-amount", amt.sell);
    await page.click("sell-submit");
    return { txs: await page.waitTxSent() };
  });
  await r.step(`${network}: buyer buys and repays in the web app`, async () => {
    await page.session(network, keys.buyer);
    await page.goto("#/buy");
    const picked = await page.clickFirst("buy-select-");
    await page.type("buy-amount", amt.buy);
    await page.click("buy-submit");
    return { session: picked, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: buyer places and cancels a limit bid`, async () => {
    await page.goto("#/earn");
    await page.click("earn-tab-bids");
    await page.type("bid-amount", amt.bid);
    await page.click("bid-submit");
    await page.waitTxSent();
    const cancel = await page.clickFirst("bid-cancel-");
    return { cancelled: cancel, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: seller withdraws the unsold rest`, async () => {
    await page.session(network, keys.seller);
    await page.goto("#/sell");
    const id = await page.clickFirst("session-withdraw-");
    return { session: id, txs: await page.waitTxSent() };
  });
}

const VENUE: Record<NetworkKey, "aave" | "morpho"> = {
  "arbitrum-sepolia": "aave",
  "robinhood-testnet": "morpho",
  "kelp-replay": "aave",
  "earn-bank-run": "morpho",
};

async function main(): Promise<void> {
  const url = (process.argv.find((a) => a.startsWith("--url="))?.split("=")[1] ?? "https://exeunt.space").replace(/\/$/, "");
  const arg = process.argv.find((a) => a.startsWith("--network="))?.split("=")[1] ?? "all";
  const networks = (arg === "all" ? Object.keys(VENUE) : arg.split(",")) as NetworkKey[];
  const env = readDotEnv();
  const startedAt = new Date().toISOString();
  const { chrome, cdp } = await launch();
  const page = new Page(cdp, url);
  const results: ScenarioResult[] = [];
  try {
    for (const network of networks) {
      const t0 = Date.now();
      const r = new Recorder(network, log);
      log(`\n== ${network} (web app at ${url})`);
      const isFork = network === "kelp-replay" || network === "earn-bank-run";
      // Forks get a fresh burner; live testnets browse as the funded deployer.
      const key = isFork ? generatePrivateKey() : ((env.PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey());
      await r.step(`${network}: select the network and connect the demo wallet`, async () => {
        await page.session(network, key);
        await page.waitTestId("wallet-address", 5_000).catch(async () => {
          await page.click("wallet-button");
          await page.waitTestId("wallet-address");
        });
        return { address: await page.text("wallet-address") };
      });
      await browse(r, page, network);
      if (isFork) {
        await forkFlow(r, page, network, VENUE[network]);
      } else if (env.PRIVATE_KEY && env.E2E_BUYER_KEY) {
        await liveFlow(r, page, network, VENUE[network], { seller: env.PRIVATE_KEY as Hex, buyer: env.E2E_BUYER_KEY as Hex });
      }
      if (r.hasFailed) {
        const base = join(REPO_ROOT, "reports", `ui-failure-${network}`);
        mkdirSync(join(REPO_ROOT, "reports"), { recursive: true });
        await page.capture(base).catch(() => undefined);
        if (process.env.UI_DEBUG_RPC) writeFileSync(`${base}-rpc.json`, JSON.stringify(cdp.rpcLog.slice(-60), null, 1));
        log(`  captured ${base}.png / .txt`);
      }
      results.push({ network, mode: "live", steps: r.steps, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0 });
    }
  } finally {
    cdp.close();
    chrome.kill();
  }
  const dir = join(REPO_ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  const md = toMarkdown(results, startedAt).replace("# Exeunt end-to-end report", `# Exeunt web app report (${url})`);
  writeFileSync(join(dir, "ui-latest.md"), md);
  const steps = results.flatMap((x) => x.steps);
  const failed = steps.filter((s) => !s.ok).length;
  log(`\n${steps.length - failed}/${steps.length} steps passed. Report: reports/ui-latest.md`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
