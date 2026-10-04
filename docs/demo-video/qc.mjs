// Step 4 of the demo video: quality checks on the finished out/exeunt-demo.mp4; writes out/qc-report.md and
// contact sheets of the encoded frames (out/qc/sheet-NN.png, one still per voiceover line) for a visual pass.
// Usage: node docs/demo-video/qc.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cache, log, match, out, run } from "./lib.mjs";

const video = join(out, "exeunt-demo.mp4");
const tl = JSON.parse(readFileSync(join(cache, "timeline.json"), "utf8"));
const footage = JSON.parse(readFileSync(join(cache, "footage.json"), "utf8"));
const voice = Object.fromEntries(JSON.parse(readFileSync(join(cache, "voice.json"), "utf8")).map((v) => [v.key, v]));
const rows = [];
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const lines = tl.segments.flatMap((s) => s.lines.map((l) => ({ ...l, beat: s.id, kind: s.kind })));

// 1. container and streams
const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", video]));
const v = probe.streams.find((s) => s.codec_type === "video");
const a = probe.streams.find((s) => s.codec_type === "audio");
const dur = Number(probe.format.duration);
check("video stream", v.codec_name === "h264" && v.width === 1920 && v.height === 1080 && v.r_frame_rate === "30/1" && v.pix_fmt === "yuv420p",
  `${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate} fps ${v.pix_fmt}`);
check("audio stream", a.codec_name === "aac" && Number(a.sample_rate) === 48000 && a.channels === 2, `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch`);
check("duration matches the timeline", Math.abs(dur - tl.duration) < 0.25, `${fmt(dur)} (timeline ${fmt(tl.duration)})`);

// 2. loudness
const eb = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const I = Number(eb.match(/I:\s+(-?[\d.]+) LUFS/g)?.at(-1)?.match(/-?[\d.]+/)[0]);
const TP = Number(eb.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.at(-1)?.match(/-?[\d.]+/)[0]);
check("loudness", I > -19 && I < -13 && TP <= -0.5, `integrated ${I} LUFS, true peak ${TP} dBFS (target -16 LUFS, peak below -1)`);

// 3. picture: long black or frozen stretches
const vf = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-vf", "blackdetect=d=1:pix_th=0.06,freezedetect=n=0.0008:d=10", "-an", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const blacks = [...vf.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${fmt(+m[1])}–${fmt(+m[2])}`);
const freezes = [...vf.matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_duration: ([\d.]+)/g)].map((m) => `${fmt(+m[1])} for ${(+m[2]).toFixed(1)} s`);
check("no black stretch over 1 s", blacks.length === 0, blacks.join(", ") || "none");
check("no still picture over 10 s", freezes.length === 0, freezes.join(", ") || "none");

// 4. narration: every line heard, in order, at its place
const wav = join(cache, "qc-mix.wav");
run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav]);
run("python", [join(cache, "..", "asr.py"), wav]);
const heard = JSON.parse(readFileSync(wav.replace(/\.wav$/, ".json"), "utf8")).words;
const lineRows = [];
let worst = 1;
let lateMax = 0;
for (const l of lines) {
  const ws = heard.filter((w) => w[0] >= l.start - 0.35 && w[0] < l.voiceEnd + 0.35);
  const score = match(voice[l.key].spoken, ws.map((w) => w[2]).join(" "));
  const late = ws.length ? Math.abs(ws[0][0] - l.start) : 99;
  worst = Math.min(worst, score);
  lateMax = Math.max(lateMax, late);
  lineRows.push({ key: l.key, start: l.start, score, late, heard: ws.map((w) => w[2]).join(" ") });
}
const weak = lineRows.filter((r) => r.score < 0.85);
check("every line heard in the final mix", weak.length === 0, `worst match ${worst.toFixed(2)}${weak.length ? `; weak: ${weak.map((r) => r.key).join(", ")}` : ""}`);
check("each line starts on its cue", lateMax < 0.6, `largest offset ${lateMax.toFixed(2)} s`);
const overlaps = lines.filter((l, i) => i > 0 && l.start < lines[i - 1].voiceEnd + 0.15).map((l) => l.key);
check("no two lines overlap", overlaps.length === 0, overlaps.join(", ") || "none");

// 5. live footage and captions
check("recording had no missing elements", footage.warnings.length === 0, footage.warnings.join("; ") || "none");
const waits = lines.filter((l) => l.kind === "live" && l.end - l.voiceEnd > 6).map((l) => `${l.key} ${(l.end - l.voiceEnd).toFixed(1)} s`);
check("no long silent waits in the footage", waits.length === 0, waits.join(", ") || "none over 6 s after a line");
const longCaps = tl.captions.filter((c) => c.text.length > 82);
check("captions fit one line", longCaps.length === 0, `${tl.captions.length} captions, longest ${Math.max(...tl.captions.map((c) => c.text.length))} characters`);

// 6. contact sheets of the encoded video, one frame per line (at 70% of its voice)
const qcDir = join(out, "qc");
rmSync(qcDir, { recursive: true, force: true });
mkdirSync(qcDir, { recursive: true });
const per = 12;
for (let s = 0; s * per < lines.length; s++) {
  const group = lines.slice(s * per, (s + 1) * per);
  const files = group.map((l, k) => {
    const f = join(qcDir, `l${s}-${k}.png`);
    const at = l.start + 0.7 * (l.voiceEnd - l.start);
    run("ffmpeg", ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=640:360", f]);
    return f;
  });
  const sheet = join(qcDir, `sheet-${String(s + 1).padStart(2, "0")}.png`);
  run("ffmpeg", ["-v", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
    `${files.map((_, k) => `[${k}:v]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, k) => `${(k % 3) * 640}_${Math.floor(k / 3) * 360}`).join("|")}:fill=black[o]`,
    "-map", "[o]", sheet]);
  for (const f of files) rmSync(f);
  log(`sheet ${sheet}: ${group[0].key} … ${group.at(-1).key}`);
}

const md = [
  "# Demo video QC report",
  "",
  `Video: \`docs/demo-video/out/exeunt-demo.mp4\`, ${fmt(dur)}. Footage recorded ${footage.recordedAt} on ${footage.site} (${footage.network}).`,
  "",
  "| Check | Result | Detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.name} | ${r.ok ? "pass" : "**fail**"} | ${r.detail.replace(/\|/g, "/")} |`),
  "",
  "## Lines",
  "",
  "| Line | Starts | Heard match | Offset (s) |",
  "|---|---|---|---|",
  ...lineRows.map((r) => `| ${r.key} | ${fmt(r.start)} | ${r.score.toFixed(2)} | ${r.late.toFixed(2)} |`),
  "",
];
writeFileSync(join(out, "qc-report.md"), md.join("\n"));
const failed = rows.filter((r) => !r.ok).length;
log(`\n${rows.length - failed}/${rows.length} checks passed; report: ${join(out, "qc-report.md")}`);
if (existsSync(wav)) rmSync(wav);
process.exitCode = failed ? 1 : 0;
