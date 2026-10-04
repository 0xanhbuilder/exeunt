// Step 2 of the demo video: pre-production checks, then the live footage of https://exeunt.space.
// Two headless Chrome profiles (Alice and Bob, each with its own demo wallet) are driven like a user: a visible cursor
// moves to each control, clicks, types, and green rings point at what the voiceover describes. Each voiceover line gets
// at least its spoken length on screen, so the voice can be laid over the footage line by line; "atWord" actions wait
// for the word that describes them. Frames come from the DevTools screencast and are stored with their arrival times.
// Usage: node docs/demo-video/record.mjs [--beats=capacity,auction] [--voice=file]   (needs .cache/voice.json from voice.mjs)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, cache, lineKey, log, script, sleep } from "./lib.mjs";

const SITE = "https://exeunt.space";
const API = "https://api.exeunt.space";
const NET = "kelp-replay";
const W = 1568;
const H = 882;
const LEAD = 0.8; // seconds of footage before a beat's first line
const TAIL = 0.8; // after its last line
const GAP = 0.45; // minimum pause after each line's voice
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find((p) => existsSync(p));

const voice = Object.fromEntries(JSON.parse(readFileSync(args.voice ?? join(cache, "voice.json"), "utf8")).map((v) => [v.key, v]));
const only = args.beats ? new Set(args.beats.split(",")) : null;
const warnings = [];
const warn = (m) => {
  warnings.push(m);
  log(`  ! ${m}`);
};

// ---------------------------------------------------------------- pre-production checks
log("== pre-production checks");
for (const n of ["kelp-replay", "earn-bank-run"]) {
  const addr = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await (await fetch(`${API}/rpc/${n}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }) })).json();
  if (r.result === undefined) throw new Error(`fork ${n} cannot read a fresh account: ${JSON.stringify(r.error)}; refresh it (systemctl start exeunt-refresh@${n})`);
  log(`  fork ${n}: fresh-account read ok`);
}
const nowUtc = new Date();
for (const [n, hh, mm] of [["kelp-replay", 3, 0], ["earn-bank-run", 3, 30]]) {
  const reset = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), hh, mm);
  const mins = [reset - 864e5, reset, reset + 864e5].map((t) => (t - nowUtc.getTime()) / 6e4).find((m) => m > -20 && m < 1440);
  if (mins !== undefined && mins > -20 && mins < 45) throw new Error(`${n} resets at ${hh}:${String(mm).padStart(2, "0")} UTC, ${mins.toFixed(0)} min from now; record later`);
  log(`  ${n} daily reset: ${mins === undefined ? "not soon" : `in ${(mins / 60).toFixed(1)} h`}`);
}

// ---------------------------------------------------------------- browser
class Cdp {
  nextId = 1;
  pending = new Map();
  handlers = new Map();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      if (msg.method) this.handlers.get(msg.method)?.(msg.params);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        this.pending.delete(id);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const OVERLAY = `(() => {
  if (window.__demo) return;
  const st = { x: ${W * 0.6}, y: ${H * 0.55}, rings: [], el: null };
  const api = {};
  window.__demo = api;
  const css = \`
    #__demo { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    #__demo .ring { position: fixed; border: 3px solid #3fd08a; border-radius: 12px; opacity: 0;
      box-shadow: 0 0 0 5px rgba(63,208,138,.18), 0 0 26px rgba(63,208,138,.35); transition: opacity .25s; }
    #__demo .tag { position: absolute; left: -3px; top: -40px; background: #3fd08a; color: #04130c; font-weight: 700;
      font-size: 16px; line-height: 1; padding: 9px 13px; border-radius: 8px; white-space: nowrap; }
    #__demo .ring.below .tag { top: auto; bottom: -40px; }
    #__demo .cur { position: fixed; left: 0; top: 0; width: 30px; height: 30px; margin: -3px 0 0 -5px;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
    #__demo .rip { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
      border: 3px solid #3fd08a; animation: __rip .5s ease-out forwards; }
    #__demo .nudge { position: fixed; left: 0; top: 0; width: 1px; height: 1px; background: #000; opacity: .01; }
    @keyframes __rip { to { transform: scale(3.4); opacity: 0; } }\`;
  const install = () => {
    if (document.getElementById("__demo")) return;
    const root = document.createElement("div");
    root.id = "__demo";
    root.style.fontFamily = getComputedStyle(document.body || document.documentElement).fontFamily;
    root.innerHTML = "<style>" + css + "</style><div class=nudge></div>" +
      '<div class=cur><svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2 L4 19.5 L8.6 15.3 L11.6 22.3 L14.7 21 L11.7 14.2 L18.3 14.2 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg></div>';
    document.documentElement.appendChild(root);
    st.el = root;
    place();
  };
  const place = () => { const c = st.el && st.el.querySelector(".cur"); if (c) { c.style.left = st.x + "px"; c.style.top = st.y + "px"; } };
  const center = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
    return { x: b.left + Math.min(b.width / 2, 60 + b.width * 0.25), y: b.top + b.height / 2 }; };
  api.install = install;
  api.moveTo = (sel, ms) => new Promise((resolve) => {
    install();
    const x0 = st.x, y0 = st.y, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms), k = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const c = center(sel) || { x: x0, y: y0 };
      st.x = x0 + (c.x - x0) * k; st.y = y0 + (c.y - y0) * k; place();
      p < 1 ? requestAnimationFrame(step) : resolve(!!document.querySelector(sel));
    };
    requestAnimationFrame(step);
  });
  api.ripple = () => { install(); const r = document.createElement("div"); r.className = "rip"; r.style.left = st.x + "px"; r.style.top = st.y + "px";
    st.el.appendChild(r); setTimeout(() => r.remove(), 600); };
  api.ring = (sel, label, keep, below) => {
    install();
    if (!keep) api.clear();
    const d = document.createElement("div"); d.className = "ring";
    if (label) { const t = document.createElement("div"); t.className = "tag"; t.textContent = label; d.appendChild(t); }
    st.el.appendChild(d); st.rings.push({ sel, d, below: !!below }); track();
  };
  api.clear = () => { for (const r of st.rings) r.d.remove(); st.rings = []; };
  api.nudge = () => { install(); const n = st.el.querySelector(".nudge"); n.style.opacity = n.style.opacity === "0.02" ? "0.01" : "0.02"; };
  api.park = (x, y) => { install(); st.x = x; st.y = y; place(); };
  let last = "";
  const track = () => {
    let sig = "";
    for (const r of st.rings) {
      const e = document.querySelector(r.sel);
      if (!e) { r.d.style.opacity = "0"; continue; }
      const b = e.getBoundingClientRect(), p = 7;
      const s = [b.left - p, b.top - p, b.width + 2 * p, b.height + 2 * p].map(Math.round);
      sig += s.join(",") + ";";
      Object.assign(r.d.style, { left: s[0] + "px", top: s[1] + "px", width: s[2] + "px", height: s[3] + "px", opacity: "1" });
      r.d.classList.toggle("below", r.below || b.top < 64);
    }
    last = sig;
    if (st.rings.length) requestAnimationFrame(track);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();`;

let port = 9440;
async function openProfile(name) {
  const p = port++;
  const dir = mkdtempSync(join(tmpdir(), `exeunt-demo-${name}-`));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${p}`, `--user-data-dir=${dir}`, "--hide-scrollbars", "--no-first-run", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      // not up yet
    }
    if (!wsUrl) await sleep(400);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY });
  const page = new Page(name, cdp, proc, dir);
  return page;
}

// A bare name is a data-testid; anything else is a CSS selector.
const sel = (t) => (/^[\w-]+$/.test(t) ? `[data-testid="${t}"]` : t);
const vars = {};

class Page {
  constructor(name, cdp, proc, dir) {
    Object.assign(this, { name, cdp, proc, dir });
    this.hashesBefore = "";
  }
  async eval(expression) {
    const r = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  q(s) {
    return `document.querySelector(${JSON.stringify(s)})`;
  }
  async waitFor(cond, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval(`Boolean(${cond})`).catch(() => false)) return true;
      await sleep(250);
    }
    if (what) throw new Error(`${this.name}: timed out waiting for ${what}`);
    return false;
  }
  /** Replaces {sid} (Alice's auction) and {bid} (Bob's newest bid) with ids read from the page the first time they are needed. */
  async resolve(target) {
    for (const [k, prefix] of [["sid", "session-row-"], ["bid", "bid-cancel-"]]) {
      if (!target.includes(`{${k}}`)) continue;
      if (vars[k] === undefined) {
        await this.waitFor(`document.querySelector('[data-testid^="${prefix}"]')`, 30_000, `${prefix}*`);
        vars[k] = await this.eval(`String(Math.max(...[...document.querySelectorAll('[data-testid^="${prefix}"]')].map((e) => Number(e.getAttribute("data-testid").slice(${prefix.length})))))`);
        log(`  ${k} = ${vars[k]}`);
      }
      target = target.replace(`{${k}}`, vars[k]);
    }
    return sel(target);
  }
  async goto(hash) {
    await this.cdp.send("Page.navigate", { url: `${SITE}/${hash}` });
    await this.waitFor(`document.readyState === "complete"`, 30_000, "page load");
  }
  /** Loads a page from scratch (closes menus, resets forms). */
  async fresh(hash) {
    await this.goto(hash);
    await this.cdp.send("Page.reload", { ignoreCache: false });
    await sleep(800);
    await this.waitFor(`document.readyState === "complete"`, 30_000, "reload");
  }
  async visible(s, timeout = 15_000) {
    if (!(await this.waitFor(this.q(s), timeout))) return false;
    const inView = await this.eval(`(() => { const b = ${this.q(s)}.getBoundingClientRect(); return b.top >= 70 && b.bottom <= innerHeight - 20; })()`);
    if (!inView) await this.scroll(s);
    return true;
  }
  async scroll(s) {
    if (!(await this.waitFor(this.q(s), 30_000))) return warn(`${this.name}: nothing to scroll to at ${s}`);
    await this.eval(`${this.q(s)}.scrollIntoView({ behavior: "smooth", block: "center" })`);
    await sleep(900);
  }
  async point(s, label, keep, below) {
    if (!(await this.visible(s))) return warn(`${this.name}: nothing to point at ${s}`);
    await this.eval(`__demo.moveTo(${JSON.stringify(s)}, 650)`);
    await this.eval(`__demo.ring(${JSON.stringify(s)}, ${JSON.stringify(label ?? "")}, ${!!keep}, ${!!below})`);
  }
  async txHashes() {
    return this.eval(`[...document.querySelectorAll('[data-testid="tx-hash"]')].map((e) => e.getAttribute("data-hash")).join(",")`);
  }
  async click(s) {
    if (!(await this.visible(s))) return warn(`${this.name}: nothing to click at ${s}`);
    await this.eval(`__demo.moveTo(${JSON.stringify(s)}, 600)`);
    await this.waitFor(`${this.q(s)} && !${this.q(s)}.disabled`, 30_000, `enabled ${s}`);
    this.hashesBefore = await this.txHashes();
    await this.eval(`(__demo.ripple(), ${this.q(s)}.click())`);
    await sleep(350);
  }
  async type(s, value) {
    await this.click(s);
    await this.eval(`(() => { const el = ${this.q(s)}; el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    for (let i = 1; i <= value.length; i++) {
      await this.eval(`(() => { const el = ${this.q(s)}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(el, ${JSON.stringify(value.slice(0, i))}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await sleep(140);
    }
    await sleep(300);
  }
  /** Waits until the transaction panel reports the action just clicked as confirmed (new hashes, outcome "sent"). */
  async tx(ms = 180_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const o = await this.eval(`document.querySelector('[data-testid="tx-status"]')?.getAttribute("data-outcome") ?? null`).catch(() => null);
      const h = await this.txHashes().catch(() => this.hashesBefore);
      if (o === "sent" && h !== this.hashesBefore) return;
      if (o === "failed") throw new Error(`${this.name}: transaction failed: ${await this.eval(`document.body.innerText.slice(0, 400)`)}`);
      await sleep(300);
    }
    throw new Error(`${this.name}: transaction did not confirm`);
  }
  async rect(s) {
    return this.eval(`(() => { const b = ${this.q(s)}.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  }
  async shot(file) {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  async session(network, key) {
    await this.goto("#/");
    await this.eval(`(() => { localStorage.setItem("exeunt.network", ${JSON.stringify(network)});
      localStorage.setItem("exeunt.demoWallet.privateKey", ${JSON.stringify(key)}); localStorage.setItem("exeunt.wallet.kind", "demo"); })()`);
    await this.cdp.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    await this.waitFor(`document.readyState === "complete"`, 30_000, "reload");
    await this.waitFor(this.q(sel("wallet-button")), 30_000, "wallet button");
  }
  async kit(kit) {
    await this.goto("#/");
    await this.waitFor(this.q(sel("wallet-button")), 30_000, "wallet button");
    if (!(await this.eval(`Boolean(${this.q(sel(`demo-kit-${kit}`))})`))) await this.eval(`${this.q(sel("wallet-button"))}.click()`);
    await this.waitFor(`${this.q(sel(`demo-kit-${kit}`))} && !${this.q(sel(`demo-kit-${kit}`))}.disabled`, 30_000, `demo-kit-${kit}`);
    await this.eval(`${this.q(sel(`demo-kit-${kit}`))}.click()`);
    const res = this.q(sel("demo-funds-result"));
    await this.waitFor(`${res} && !${res}.textContent.includes("…")`, 240_000, `${kit} kit`);
    const msg = await this.eval(`${res}.textContent`);
    if (/fail|error|limit/i.test(msg)) throw new Error(`${this.name} ${kit} kit: ${msg}`);
    log(`  ${this.name}: ${msg}`);
  }
  async text(s) {
    return this.eval(`(${this.q(s)}?.textContent ?? "").trim()`);
  }
}

// ---------------------------------------------------------------- set-up: profiles, wallets, positions
log("== set-up");
const burner = () => "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const keys = { alice: burner(), bob: burner() };
const alice = await openProfile("alice");
const bob = await openProfile("bob");
const profiles = { alice, bob };
const stills = join(cache, "stills");
mkdirSync(stills, { recursive: true });
const footageDir = join(cache, "footage");
const recording = { site: SITE, network: NET, recordedAt: new Date().toISOString(), viewport: [W, H], keys, beats: [], warnings };

try {
  await alice.session(NET, keys.alice);
  await alice.kit("seller");
  await bob.session(NET, keys.bob);
  await bob.kit("borrower");
  await bob.session(NET, keys.bob);
  await bob.kit("bidder");

  // Stills for the set-up beat, and checks that the positions are what the voiceover says.
  await alice.fresh("#/sell");
  await alice.eval("__demo.park(-60, -60)");
  await alice.waitFor(`/^10 WETH/.test(${alice.q(sel("sell-position-balance"))}?.textContent ?? "")`, 60_000, "Alice holds 10 WETH");
  await sleep(1500);
  await alice.shot(join(stills, "alice.png"));
  recording.stills = { alice: await alice.rect(sel("sell-position")) };
  await bob.fresh("#/buy");
  await bob.eval("__demo.park(-60, -60)");
  await bob.waitFor(`/^5 WETH/.test(${bob.q(sel("buy-debt"))}?.textContent ?? "")`, 60_000, "Bob owes 5 WETH");
  await sleep(1500);
  await bob.shot(join(stills, "bob.png"));
  recording.stills.bob = await bob.rect(".debt-card");
  if (!(await bob.eval(`Boolean(${bob.q(sel("demo-funds"))})`))) await bob.eval(`${bob.q(sel("wallet-button"))}.click()`);
  await bob.waitFor(bob.q(sel("demo-funds")), 15_000, "faucet in the wallet menu");
  await sleep(800);
  await bob.shot(join(stills, "faucet.png"));
  recording.stills.faucet = await bob.rect(sel("demo-funds"));
  await bob.eval(`${bob.q(sel("wallet-button"))}.click()`);
  log("  stills: alice.png (10 WETH), bob.png (owes 5 WETH), faucet.png");

  // The MCP call shown in the developers beat, made for real against the hosted server.
  const mcpReq = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_exit_capacity", arguments: { network: NET } } };
  const mcpRes = await (await fetch(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(mcpReq) })).json();
  const capacity = JSON.parse(mcpRes.result.content[0].text);
  recording.mcp = { url: `${API}/mcp`, request: mcpReq, capacity };
  log(`  mcp get_exit_capacity: utilization ${capacity.utilization.percent}, withdrawable ${capacity.withdrawableNow.human} WETH`);

  // ---------------------------------------------------------------- beats
  for (const beat of script.beats.filter((b) => b.kind === "live")) {
    const page = profiles[beat.profile];
    if (only && !only.has(beat.id)) continue; // partial runs are previews of single beats
    log(`== ${beat.id} (${beat.profile})`);
    // Every beat starts from a freshly loaded page, off camera.
    await page.fresh(beat.page);
    await page.waitFor(page.q(await page.resolve(beat.ready)), 60_000, `${beat.id} ready (${beat.ready})`);
    await page.eval(`(window.scrollTo(0, 0), __demo.install(), __demo.clear(), __demo.park(${W * 0.62}, ${H * 0.58}))`);
    await sleep(1800);

    const dir = join(footageDir, beat.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = [];
    let t0 = 0;
    page.cdp.handlers.set("Page.screencastFrame", (p) => {
      const t = (Date.now() - t0) / 1000;
      const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
      writeFileSync(join(dir, file), Buffer.from(p.data, "base64"));
      frames.push([Math.max(0, +t.toFixed(3)), file]);
      page.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
    });
    t0 = Date.now();
    await page.cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await page.eval("__demo.nudge()");
    await sleep(LEAD * 1000);

    const lines = [];
    for (const [i, line] of beat.lines.entries()) {
      const v = voice[lineKey(beat.id, i)];
      const start = Date.now();
      for (const a of line.do ?? []) {
        if (a.atWord) {
          const w = v.words.find((x) => x[2].toLowerCase().replace(/[^a-z0-9-]/g, "").startsWith(a.atWord.toLowerCase()));
          if (!w) warn(`${v.key}: word "${a.atWord}" not found in the take`);
          else if (start + w[0] * 1000 > Date.now()) await sleep(start + w[0] * 1000 - Date.now());
        }
        if (a.scroll) await page.scroll(await page.resolve(a.scroll));
        if (a.click) await page.click(await page.resolve(a.click));
        if (a.type) await page.type(await page.resolve(a.type), a.value);
        if (a.point) await page.point(await page.resolve(a.point), a.label, a.keep, a.below);
        if (a.clear) await page.eval("__demo.clear()");
        if (a.tx) await page.tx();
        if (a.wait) await sleep(a.wait * 1000);
      }
      const minEnd = start + (v.dur + GAP) * 1000;
      if (Date.now() < minEnd) await sleep(minEnd - Date.now());
      lines.push({ key: v.key, start: +((start - t0) / 1000).toFixed(3), end: +((Date.now() - t0) / 1000).toFixed(3), insert: line.insert ?? null });
      log(`  ${v.key}: ${((Date.now() - start) / 1000).toFixed(1)} s on screen for ${v.dur.toFixed(1)} s of voice`);
    }
    await page.eval("__demo.nudge()");
    await sleep(TAIL * 1000);
    await page.cdp.send("Page.stopScreencast");
    page.cdp.handlers.delete("Page.screencastFrame");
    await page.eval("__demo.clear()");
    const durationSec = +((Date.now() - t0) / 1000).toFixed(3);
    recording.beats.push({ id: beat.id, profile: beat.profile, duration: durationSec, frames, lines });
    log(`  ${frames.length} frames, ${durationSec.toFixed(1)} s`);
    writeFileSync(join(cache, "footage.json"), JSON.stringify(recording));
  }
} finally {
  writeFileSync(join(cache, "footage.json"), JSON.stringify(recording));
  for (const p of [alice, bob]) {
    p.proc.kill();
  }
}
log(`\n${recording.beats.length} beats recorded, ${warnings.length} warnings${warnings.length ? ":\n  " + warnings.join("\n  ") : ""}`);
if (warnings.length) process.exitCode = 1;
