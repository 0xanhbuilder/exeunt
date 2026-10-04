// Step 3 of the demo video: timeline, captions, audio mix, and frames of scenes.html encoded to out/exeunt-demo.mp4.
// Motion-graphics beats take their length from the voiceover; live beats take it from the recorded footage, with each
// line's voice laid at the moment record.mjs started that line on screen.
// Usage:  node docs/demo-video/build.mjs                  full build
//         node docs/demo-video/build.mjs --stills=5,42.5  PNG stills at those seconds (out/stills), no video
//         node docs/demo-video/build.mjs --audio          stop after the audio mix
//         --voice=file uses another voice.json (previews with estimated timings)
// Needs:  .cache/voice.json (voice.mjs), .cache/footage.json (record.mjs), ffmpeg, Chrome.
//         Music bed: .cache/music-raw.wav (copied from the pitch video's ACE-Step track if present; otherwise voice only).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { args, cache, duration, here, lineKey, log, out, run, script, sleep } from "./lib.mjs";

const FPS = 30;
const LEAD_IN = 1.2; // first beat: picture before the first line
const SCENE_IN = 0.7; // other motion-graphics beats
const SCENE_OUT = 0.7;
const LINE_GAP = 0.45;
const TAIL = 3.5; // end card after the last line
const MUSIC_DB = -21; // music bed relative to its raw level (about -15 LUFS raw)
const CAPTION_MAX = 82;
const NETWORK = { robinhood: null, developers: "Earn bank-run" };

const voice = Object.fromEntries(JSON.parse(readFileSync(args.voice ?? join(cache, "voice.json"), "utf8")).map((v) => [v.key, v]));
const footage = JSON.parse(readFileSync(join(cache, "footage.json"), "utf8"));
const recorded = Object.fromEntries(footage.beats.map((b) => [b.id, b]));

// ---------- 1. timeline ----------
let t = 0;
// Stills-only previews may skip live beats that have no footage yet.
const beats = script.beats.filter((b) => b.kind !== "live" || recorded[b.id] || !args.stills);
const segments = beats.map((b) => {
  const index = script.beats.indexOf(b);
  const seg = { id: b.id, label: b.label, index, kind: b.kind, start: t, lines: [] };
  const words = (v, at) => v.words.map(([s, e, w]) => [+(at + s).toFixed(3), +(at + e).toFixed(3), w]);
  if (b.kind === "live") {
    const r = recorded[b.id];
    if (!r) throw new Error(`no footage for ${b.id}; run record.mjs`);
    Object.assign(seg, { profile: b.profile, page: b.page, network: b.id in NETWORK ? NETWORK[b.id] : "Kelp replay", frames: r.frames });
    for (const l of r.lines) {
      const v = voice[l.key];
      seg.lines.push({ key: l.key, start: t + l.start, end: t + l.end, voiceEnd: t + l.start + v.dur, text: v.text, insert: l.insert, words: words(v, t + l.start) });
    }
    t += r.duration;
  } else {
    t += index === 0 ? LEAD_IN : SCENE_IN;
    b.lines.forEach((_, i) => {
      const v = voice[lineKey(b.id, i)];
      seg.lines.push({ key: v.key, start: t, end: t + v.dur, voiceEnd: t + v.dur, text: v.text, insert: null, words: words(v, t) });
      t += v.dur + LINE_GAP;
    });
    t += SCENE_OUT - LINE_GAP;
    if (index === script.beats.length - 1) t += TAIL;
  }
  seg.end = t;
  return seg;
});
const total = t;

function chunks(text) {
  if (text.length <= CAPTION_MAX) return [text];
  const cuts = [...text.matchAll(/[,.;:] /g)].map((m) => m.index + 1);
  const mid = text.length / 2;
  const cut = cuts.length ? cuts.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : text.lastIndexOf(" ", mid);
  return [...chunks(text.slice(0, cut).trim()), ...chunks(text.slice(cut).trim())];
}
const captions = segments.flatMap((s) =>
  s.lines.flatMap((l) => {
    const parts = chunks(l.text);
    // Caption chunks share the line's spoken time by character count.
    const span = l.voiceEnd - l.start;
    const chars = parts.reduce((n, p) => n + p.length, 0);
    let at = l.start;
    let used = 0;
    return parts.map((p, k) => {
      used += p.length;
      const end = k === parts.length - 1 ? l.voiceEnd : l.start + (span * used) / chars;
      const c = { start: at, end, text: p };
      at = end;
      return c;
    });
  }),
);
const timeline = { fps: FPS, width: 1920, height: 1080, duration: total, segments, captions, mcp: footage.mcp, stills: footage.stills };
writeFileSync(join(cache, "timeline.json"), JSON.stringify(timeline));
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
log(`timeline ${fmt(total)}`);
for (const s of segments) log(`  ${String(s.index + 1).padStart(2)} ${s.label.padEnd(28)} ${fmt(s.start)} – ${fmt(s.end)}  (${(s.end - s.start).toFixed(1)} s, ${s.kind})`);

// ---------- 2. audio ----------
const SR = 48000;
const mix = join(cache, "mix.m4a");
if (!args.stills) {
  const buf = new Float32Array(Math.ceil(total * SR));
  for (const s of segments)
    for (const l of s.lines) {
      const pcm = run("ffmpeg", ["-v", "error", "-i", voice[l.key].clip, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { encoding: "buffer" });
      buf.set(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), Math.round(l.start * SR));
    }
  const voiceRaw = join(cache, "voice.f32");
  writeFileSync(voiceRaw, Buffer.from(buf.buffer));
  const music = join(cache, "music-raw.wav");
  const pitchMusic = join(here, "..", "video", ".cache", "music-raw.wav");
  if (!existsSync(music) && existsSync(pitchMusic)) copyFileSync(pitchMusic, music);
  const voiceChain = `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${SR},pan=stereo|c0=c0|c1=c0`;
  if (existsSync(music)) {
    // Loop the bed with crossfades until it covers the video.
    const md = duration(music);
    const copies = Math.max(1, Math.ceil((total + 8) / (md - 6)));
    const inputs = Array.from({ length: copies }, () => ["-i", music]).flat();
    let chain = "[1:a]";
    for (let k = 2; k <= copies; k++) chain += `[${k}:a]acrossfade=d=6[x${k}];[x${k}]`;
    run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", voiceRaw, ...inputs, "-filter_complex",
      `${voiceChain}[v];${chain}atrim=0:${total},asetpts=N/SR/TB,aresample=${SR},volume=${MUSIC_DB}dB,afade=t=in:d=2,afade=t=out:st=${total - 4}:d=4[m];` +
        `[v][m]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89[a]`,
      "-map", "[a]", "-c:a", "aac", "-b:a", "192k", mix]);
  } else {
    log("no music bed found; voice only");
    run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", voiceRaw, "-filter_complex", `${voiceChain},alimiter=limit=0.89[a]`, "-map", "[a]", "-c:a", "aac", "-b:a", "192k", mix]);
  }
  log(`audio: ${mix}`);
  if ("audio" in args) process.exit(0);
}

// ---------- 3. frames ----------
// Several headless Chrome workers render consecutive slices of the timeline in parallel; each slice is encoded on its
// own, then the slices are joined without re-encoding and the audio is added.
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const WORKERS = Number(args.workers ?? 6);
const TYPES = { ".html": "text/html", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (path === "/") file = join(here, "scenes.html");
  else if (path === "/timeline.json") file = join(cache, "timeline.json");
  else if (path.startsWith("/footage/") || path.startsWith("/stills/")) file = normalize(join(cache, path.slice(1)));
  if (!file || !file.startsWith(here) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "max-age=3600" });
  res.end(readFileSync(file));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

async function worker(k) {
  const port = 9557 + k;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--hide-scrollbars", `--user-data-dir=${mkdtempSync(join(tmpdir(), "demo-render-"))}`, "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Chrome not up yet
    }
    if (!wsUrl) await sleep(500);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 0;
  const calls = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && calls.has(msg.id)) {
      calls.get(msg.id)(msg);
      calls.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      calls.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
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
  const shot = async (format) => Buffer.from((await send("Page.captureScreenshot", { format, quality: format === "jpeg" ? 93 : undefined })).data, "base64");
  return { evaluate, shot, close: () => (ws.close(), chrome.kill()) };
}

if (args.stills) {
  const w = await worker(0);
  mkdirSync(join(out, "stills"), { recursive: true });
  for (const s of args.stills.split(",").map(Number)) {
    await w.evaluate(`seek(${s})`);
    const f = join(out, "stills", `t${s.toFixed(1).padStart(6, "0")}.png`);
    writeFileSync(f, await w.shot("png"));
    log(f);
  }
  w.close();
} else {
  const frames = Math.ceil(total * FPS);
  const per = Math.ceil(frames / WORKERS);
  const started = Date.now();
  const parts = await Promise.all(
    Array.from({ length: WORKERS }, async (_, k) => {
      const w = await worker(k);
      const part = join(cache, `part-${k}.mp4`);
      const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), part], { stdio: ["pipe", "inherit", "inherit"] });
      for (let f = k * per; f < Math.min(frames, (k + 1) * per); f++) {
        await w.evaluate(`seek(${f / FPS})`);
        if (!ff.stdin.write(await w.shot("jpeg"))) await new Promise((r) => ff.stdin.once("drain", r));
        if ((f - k * per) % (FPS * 30) === 0) log(`worker ${k}: frame ${f - k * per}/${per} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      }
      ff.stdin.end();
      await new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
      w.close();
      return part;
    }),
  );
  const list = join(cache, "parts.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replaceAll("\\", "/")}'`).join("\n"));
  const video = join(out, "exeunt-demo.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", mix, "-map", "0:v", "-map", "1:a", "-c", "copy", "-shortest", "-movflags", "+faststart", video]);
  log(`video: ${video} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
server.close();
