// Renders every docs/diagrams/*.mmd to docs/images/<name>.png (2x, mermaid default theme) with headless Chrome.
// Usage: node docs/diagrams/render.mjs   (set CHROME_PATH if Chrome is not in a standard location)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "images");
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");

const page = `<!doctype html><html><head><style>body{margin:0;background:#fff}#d{display:inline-block;padding:24px;background:#fff}</style></head>
<body><div id="d"></div><script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  themeVariables: { fontFamily: "Arial, Helvetica, sans-serif", edgeLabelBackground: "#ffffff" },
  sequence: { showSequenceNumbers: true, mirrorActors: false },
});
window.renderDiagram = async (src) => {
  const { svg } = await mermaid.render("g" + Date.now(), src);
  const d = document.getElementById("d");
  d.innerHTML = svg;
  // Mermaid caps the SVG with max-width; use its natural size instead.
  const el = d.querySelector("svg");
  const vb = el.viewBox.baseVal;
  // Extra room below the last message, whose number badge mermaid otherwise clips.
  const h = vb.height + 24;
  el.setAttribute("viewBox", [vb.x, vb.y, vb.width, h].join(" "));
  el.setAttribute("width", String(vb.width));
  el.setAttribute("height", String(h));
  el.style.maxWidth = "none";
  const r = d.getBoundingClientRect();
  return { x: r.x, y: r.y, width: Math.ceil(r.width), height: Math.ceil(r.height) };
};
window.ready = true;
</script></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9555", `--user-data-dir=${mkdtempSync(join(tmpdir(), "mmd-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9555/json/list")).json();
    wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {
    // Chrome not up yet
  }
  if (!wsUrl) await sleep(500);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1600, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url });
for (let i = 0; i < 60 && !(await evaluate("window.ready === true").catch(() => false)); i++) await sleep(500);

mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const file of readdirSync(here).filter((f) => f.endsWith(".mmd")).sort()) {
  const name = file.replace(/\.mmd$/, "");
  try {
    const box = await evaluate(`window.renderDiagram(${JSON.stringify(readFileSync(join(here, file), "utf8"))})`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
    process.stdout.write(`${name}.png  ${box.width * 2}x${box.height * 2}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`${name}: ERROR ${e.message}\n`);
  }
}
ws.close();
chrome.kill();
server.close();
process.exit(failed ? 1 : 0);
