// Step 1 of the demo video: the voiceover in the cloned voice (OmniVoice).
// Several takes per line; the take Whisper hears best is kept, trimmed, and transcribed again for word timings,
// which record.mjs uses to time clicks to the words that describe them.
// Usage: node docs/demo-video/voice.mjs        writes .cache/voice.json
// Needs: .env with OMNIVOICE_URL and OMNIVOICE_API_KEY; ref/voice-clone/voice.ogg and text.txt; ffmpeg; Python with faster-whisper.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allLines, cache, duration, env, log, match, root, run, sha, tokens, transcribe } from "./lib.mjs";

const TAKES = 3; // takes per line per round
const MAX_TAKES = 9;
const GOOD = 0.92; // Whisper match above which no more takes are generated

const refText = readFileSync(join(root, "ref", "voice-clone", "text.txt"), "utf8").replace(/\s+/g, " ").trim();
const refWav = join(cache, "ref.wav");
if (!existsSync(refWav)) run("ffmpeg", ["-v", "error", "-y", "-i", join(root, "ref", "voice-clone", "voice.ogg"), "-ac", "1", "-ar", "24000", refWav]);
const refBytes = readFileSync(refWav);

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
      log(`OmniVoice request failed (${e.cause?.code ?? e.message}), retrying`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

const lines = allLines();
for (const L of lines) {
  L.dir = join(cache, "tts", sha(L.say + "\n" + refText));
  mkdirSync(L.dir, { recursive: true });
}
let pending = lines;
for (let round = 0; pending.length && round * TAKES < MAX_TAKES; round++) {
  const fresh = [];
  let n = 0;
  for (const L of pending)
    for (let k = round * TAKES; k < (round + 1) * TAKES; k++) {
      const f = join(L.dir, `take-${k}.wav`);
      if (!existsSync(f)) await synth(L.say, f);
      if (!existsSync(f.replace(/\.wav$/, ".json"))) fresh.push(f);
      if (++n % 20 === 0) log(`round ${round + 1}: ${n}/${pending.length * TAKES} takes`);
    }
  log(`round ${round + 1}: ${fresh.length} new takes to transcribe`);
  transcribe(fresh);
  for (const L of pending) {
    L.takes = [];
    for (let k = 0; k < (round + 1) * TAKES; k++) {
      const f = join(L.dir, `take-${k}.wav`);
      const asr = JSON.parse(readFileSync(f.replace(/\.wav$/, ".json"), "utf8"));
      const span = asr.words.length ? asr.words.at(-1)[1] - asr.words[0][0] : 0;
      const rate = span > 0 ? tokens(L.spoken).length / span : 0; // words per second; outside a normal range means a broken take
      L.takes.push({ f, asr, score: rate < 1.4 || rate > 4.5 ? 0 : match(L.spoken, asr.text) });
    }
    L.best = L.takes.reduce((a, b) => (b.score > a.score ? b : a));
  }
  pending = pending.filter((L) => L.best.score < GOOD);
}

// Trim leading and trailing silence so the gaps between lines are the timeline's, not the model's.
const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
const clips = [];
for (const L of lines) {
  L.clip = join(L.dir, `best-${L.takes.indexOf(L.best)}.wav`);
  if (!existsSync(L.clip)) {
    run("ffmpeg", ["-v", "error", "-y", "-i", L.best.f, "-af", `${trim},areverse,${trim},areverse,apad=pad_dur=0.05`, "-ar", "48000", L.clip]);
    clips.push(L.clip);
  }
}
transcribe(clips.filter((c) => !existsSync(c.replace(/\.wav$/, ".json"))));

const voice = lines.map((L) => {
  const asr = JSON.parse(readFileSync(L.clip.replace(/\.wav$/, ".json"), "utf8"));
  return { key: L.key, beat: L.beat, i: L.i, text: L.text, spoken: L.spoken, clip: L.clip, dur: duration(L.clip), score: L.best.score, heard: L.best.asr.text, words: asr.words };
});
writeFileSync(join(cache, "voice.json"), JSON.stringify(voice, null, 1));
log("\nline            score  secs  heard (when not a full match)");
for (const v of voice) log(`${v.key.padEnd(15)} ${v.score.toFixed(2).padStart(5)} ${v.dur.toFixed(1).padStart(5)}  ${v.score < 1 ? v.heard : ""}`);
log(`\nvoice total ${voice.reduce((s, v) => s + v.dur, 0).toFixed(1)} s over ${voice.length} lines`);
