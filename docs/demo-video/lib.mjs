// Shared helpers for the demo video scripts (voice.mjs, record.mjs, build.mjs, qc.mjs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..", "..");
export const cache = join(here, ".cache");
export const out = join(here, "out");
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

export const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));

export const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

export const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: opts.encoding ?? "utf8", maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 6).join(" ")}… failed:\n${r.stderr}`);
  return r.stdout;
};
export const duration = (f) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
export const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (line) => process.stdout.write(`${line}\n`);

export const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
export const lineKey = (beat, i) => `${beat}-${i}`;
/** Every voiceover line in order, with the text the voice model reads. */
export const allLines = () =>
  script.beats.flatMap((b) =>
    b.lines.map((l, i) => ({
      key: lineKey(b.id, i),
      beat: b.id,
      i,
      text: l.text,
      spoken: l.say ?? l.text,
      say: Object.entries(script.say).reduce((s, [w, r]) => s.replace(new RegExp(`\\b${w}\\b`, "g"), r), l.say ?? l.text),
    })),
  );

const WILD = new Set(["exeunt", "aave", "aaves", "usdg", "usdc", "weth", "wsteth", "morpho", "paxos", "mcp", "sdk", "kelp", "steakhouse"]);
export const tokens = (s) =>
  (s.toLowerCase().replace(/['’]/g, "").replace(/(\d),(\d)/g, "$1$2").match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []);
/** Share of the line's words that were heard, in order (longest common subsequence); names Whisper cannot know match anything. */
export function match(target, heard) {
  const a = tokens(target);
  const b = tokens(heard);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] || WILD.has(a[i - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return a.length ? dp[a.length][b.length] / a.length : 1;
}
export const transcribe = (files) => {
  for (let i = 0; i < files.length; i += 40) run("python", [join(here, "asr.py"), ...files.slice(i, i + 40)]);
};
