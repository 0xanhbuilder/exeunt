// Builds the pitch video docs/video/out/exeunt-pitch.mp4 from script.json and scenes.html:
// 1. narration in the cloned voice (OmniVoice), several takes per line, the take Whisper hears best is kept;
// 2. timeline and burned-in captions from the narration lengths;
// 3. voice track plus background music;
// 4. frames of scenes.html rendered with headless Chrome, encoded with ffmpeg.
//
// Usage:  node docs/video/build.mjs                  full build
//         node docs/video/build.mjs --stills=5,42.5  only PNG stills at those seconds (docs/video/out/stills)
//         node docs/video/build.mjs --audio          stop after the audio mix
// Needs:  .env with OMNIVOICE_URL and OMNIVOICE_API_KEY; ref/voice-clone/voice.ogg and text.txt (the voice sample);
//         docs/video/.cache/music-raw.wav (ACE-Step, see MUSIC below); ffmpeg; Python with faster-whisper; Chrome.
// MUSIC:  ACE_CHECKPOINT_DIR=<video-factory>/data/models/ace-step-v1-3.5B <video-factory>/.venv-ace/Scripts/python
//         <video-factory>/tools/local-node/ace_worker.py --duration 240 --out docs/video/.cache/music-raw.wav --prompt
//         "minimal ambient electronic, soft warm synth pads, gentle pulsing arpeggio, light percussion, calm and confident,
//         modern tech product pitch, instrumental background music, no vocals, steady, 100 bpm"
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cache = join(here, ".cache");
const out = join(here, "out");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));

const FPS = 30;
const TAKES = 4; // takes per line per round
const MAX_TAKES = 12;
const GOOD = 0.9; // Whisper match above which no more takes are generated
const LEAD_IN = 1.2; // first scene: seconds of picture before the first line
const SCENE_IN = 0.7; // other scenes: seconds before their first line
const SCENE_OUT = 0.5; // seconds after a scene's last line
const LINE_GAP = 0.4;
const TAIL = 3.5; // end card after the last line
const MUSIC_DB = -18; // music bed relative to its raw level (about -15 LUFS raw)
const CAPTION_MAX = 84; // characters per caption chunk

mkdirSync(join(cache, "tts"), { recursive: true });
mkdirSync(out, { recursive: true });

const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: opts.encoding ?? "utf8", maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 6).join(" ")}… failed:\n${r.stderr}`);
  return r.stdout;
};
const duration = (f) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ---------- 1. narration ----------
const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
const refText = readFileSync(join(root, "ref", "voice-clone", "text.txt"), "utf8").replace(/\s+/g, " ").trim();
const refWav = join(cache, "ref.wav");
if (!existsSync(refWav)) run("ffmpeg", ["-v", "error", "-y", "-i", join(root, "ref", "voice-clone", "voice.ogg"), "-ac", "1", "-ar", "24000", refWav]);
const refBytes = readFileSync(refWav);

const sayText = (line) =>
  Object.entries(script.say).reduce((s, [w, r]) => s.replace(new RegExp(`\\b${w}\\b`, "g"), r), line.say ?? line.text);

const WILD = new Set(["exeunt", "aave", "aaves", "eth", "usdg", "morpho", "paxos", "mcp", "sdk", "earns"]);
const tokens = (s) => s.toLowerCase().replace(/['’]/g, "").match(/[a-z]+/g) ?? [];
// Share of the line's words that Whisper heard, in order (longest common subsequence); names Whisper cannot know match anything.
function match(target, heard) {
  const a = tokens(target);
  const b = tokens(heard);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] || WILD.has(a[i - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return a.length ? dp[a.length][b.length] / a.length : 1;
}

async function synth(text, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      form.append("text", text);
      form.append("ref_text", refText);
      form.append("ref_audio", new Blob([refBytes]), "ref.wav");
      const res = await fetch(`${env.OMNIVOICE_URL}/clone`, { method: "POST", headers: { "x-api-key": env.OMNIVOICE_API_KEY }, body: form });
      if (!res.ok) throw new Error(`OmniVoice ${res.status}: ${await res.text()}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      process.stdout.write(`OmniVoice request failed (${e.cause?.code ?? e.message}), retrying\n`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

function transcribe(files) {
  if (files.length) run("python", [join(here, "asr.py"), ...files]);
}

const lines = script.scenes.flatMap((s) => s.lines.map((l, i) => ({ scene: s.id, i, line: l })));
for (const L of lines) {
  L.say = sayText(L.line);
  L.dir = join(cache, "tts", sha(L.say + "\n" + refText));
  mkdirSync(L.dir, { recursive: true });
}
let pending = lines;
for (let round = 0; pending.length && round * TAKES < MAX_TAKES; round++) {
  const fresh = [];
  for (const L of pending)
    for (let k = round * TAKES; k < (round + 1) * TAKES; k++) {
      const f = join(L.dir, `take-${k}.wav`);
      if (!existsSync(f)) await synth(L.say, f);
      if (!existsSync(f.replace(/\.wav$/, ".json"))) fresh.push(f);
    }
  process.stdout.write(`round ${round + 1}: ${fresh.length} new takes to transcribe\n`);
  transcribe(fresh);
  for (const L of pending) {
    L.takes = [];
    for (let k = 0; k < (round + 1) * TAKES; k++) {
      const f = join(L.dir, `take-${k}.wav`);
      const asr = JSON.parse(readFileSync(f.replace(/\.wav$/, ".json"), "utf8"));
      const span = asr.words.length ? asr.words.at(-1)[1] - asr.words[0][0] : 0;
      const rate = span > 0 ? tokens(L.say).length / span : 0; // words per second; outside a normal range means a broken take
      L.takes.push({ f, asr, score: rate < 1.4 || rate > 4.5 ? 0 : match(L.line.text, asr.text) });
    }
    L.best = L.takes.reduce((a, b) => (b.score > a.score ? b : a));
  }
  pending = pending.filter((L) => L.best.score < GOOD);
}

for (const L of lines) {
  L.clip = join(L.dir, "best.wav");
  // Trim leading and trailing silence so the gaps between lines are the timeline's, not the model's.
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  run("ffmpeg", ["-v", "error", "-y", "-i", L.best.f, "-af", `${trim},areverse,${trim},areverse,apad=pad_dur=0.05`, "-ar", "48000", L.clip]);
  L.dur = duration(L.clip);
}
process.stdout.write("\nline              score  secs  heard (when not a full match)\n");
for (const L of lines)
  process.stdout.write(
    `${(L.scene + "-" + L.i).padEnd(16)} ${L.best.score.toFixed(2).padStart(5)} ${L.dur.toFixed(1).padStart(5)}  ${L.best.score < 1 ? L.best.asr.text : ""}\n`,
  );

// ---------- 2. timeline and captions ----------
function chunks(text) {
  if (text.length <= CAPTION_MAX) return [text];
  const cuts = [...text.matchAll(/[,.;:] /g)].map((m) => m.index + 1);
  const mid = text.length / 2;
  const cut = cuts.length ? cuts.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : text.lastIndexOf(" ", mid);
  return [...chunks(text.slice(0, cut).trim()), ...chunks(text.slice(cut).trim())];
}
let t = 0;
const scenes = script.scenes.map((s, index) => {
  const scene = { id: s.id, label: s.label, index, start: t, lines: [] };
  t += index === 0 ? LEAD_IN : SCENE_IN;
  for (const L of lines.filter((l) => l.scene === s.id)) {
    scene.lines.push({ start: t, end: t + L.dur, text: L.line.text });
    L.start = t;
    t += L.dur + LINE_GAP;
  }
  t += SCENE_OUT - LINE_GAP;
  scene.end = t;
  return scene;
});
scenes.at(-1).end = t += TAIL;
const total = t;
const captions = scenes.flatMap((s) =>
  s.lines.flatMap((l) => {
    const parts = chunks(l.text);
    const chars = parts.reduce((n, p) => n + p.length, 0);
    let at = l.start;
    return parts.map((p) => {
      const c = { start: at, end: at + ((l.end - l.start) * p.length) / chars, text: p };
      at = c.end;
      return c;
    });
  }),
);
const timeline = { fps: FPS, width: 1920, height: 1080, duration: total, scenes, captions };
writeFileSync(join(cache, "timeline.json"), JSON.stringify(timeline, null, 1));
process.stdout.write(`\ntotal ${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, "0")}, ${tokens(lines.map((l) => l.line.text).join(" ")).length} words\n`);

// ---------- 3. audio ----------
const SR = 48000;
const voice = new Float32Array(Math.ceil(total * SR));
for (const L of lines) {
  const pcm = run("ffmpeg", ["-v", "error", "-i", L.clip, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { encoding: "buffer" });
  voice.set(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), Math.round(L.start * SR));
}
const voiceRaw = join(cache, "voice.f32");
writeFileSync(voiceRaw, Buffer.from(voice.buffer));
const music = join(cache, "music-raw.wav");
if (!existsSync(music)) throw new Error("docs/video/.cache/music-raw.wav is missing; see MUSIC at the top of this file");
// A video longer than the music plays it twice, crossfaded.
const bed = duration(music) >= total ? "[1:a]" : "[1:a][2:a]acrossfade=d=6,";
const mix = join(cache, "mix.m4a");
run("ffmpeg", [
  "-v", "error", "-y",
  "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", voiceRaw,
  "-i", music, "-i", music,
  "-filter_complex",
  `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${SR},pan=stereo|c0=c0|c1=c0[v];` +
    `${bed}atrim=0:${total},asetpts=N/SR/TB,aresample=${SR},volume=${MUSIC_DB}dB,afade=t=in:d=2,afade=t=out:st=${total - 4}:d=4[m];` +
    `[v][m]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=disabled[a]`,
  "-map", "[a]", "-c:a", "aac", "-b:a", "192k", mix,
]);
process.stdout.write(`audio: ${mix}\n`);
if ("audio" in args) process.exit(0);

// ---------- 4. frames ----------
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");
const TYPES = { ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = path === "/timeline.json" ? join(cache, "timeline.json") : join(here, path === "/" ? "scenes.html" : path.slice(1));
  if (!file.startsWith(here) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const PORT = 9556;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars", `--user-data-dir=${mkdtempSync(join(tmpdir(), "pitch-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = targets.find((x) => x.type === "page")?.webSocketDebuggerUrl;
  } catch {
    // Chrome not up yet
  }
  if (!wsUrl) await sleep(500);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pendingCalls = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pendingCalls.has(msg.id)) {
    pendingCalls.get(msg.id)(msg);
    pendingCalls.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pendingCalls.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
for (let i = 0; i < 60 && !(await evaluate("window.ready === true || !!window.initError").catch(() => false)); i++) await sleep(500);
if (!(await evaluate("window.ready === true"))) throw new Error(`scenes.html did not get ready: ${await evaluate("window.initError ?? 'timeout'")}`);

const shot = async (format) => Buffer.from((await send("Page.captureScreenshot", { format, quality: format === "jpeg" ? 92 : undefined })).data, "base64");
if (args.stills) {
  mkdirSync(join(out, "stills"), { recursive: true });
  for (const s of args.stills.split(",").map(Number)) {
    await evaluate(`seek(${s})`);
    const f = join(out, "stills", `t${s.toFixed(1).padStart(6, "0")}.png`);
    writeFileSync(f, await shot("png"));
    process.stdout.write(`${f}\n`);
  }
} else {
  const video = join(out, "exeunt-pitch.mp4");
  const ff = spawn("ffmpeg", [
    "-v", "error", "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-i", mix,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-shortest", "-movflags", "+faststart", video,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.ceil(total * FPS);
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    await evaluate(`seek(${f / FPS})`);
    if (!ff.stdin.write(await shot("jpeg"))) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % (FPS * 10) === 0) process.stdout.write(`frame ${f}/${frames} (${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
  process.stdout.write(`video: ${video}\n`);
}
ws.close();
chrome.kill();
server.close();
