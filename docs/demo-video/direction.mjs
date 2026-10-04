// Writes direction.md, the director's script: pre-production plan and shot list (visuals, on-screen actions, voiceover,
// timings), from script.json and the timeline of the last build, so the document always matches the rendered video.
// Usage: node docs/demo-video/direction.mjs   (after build.mjs)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cache, here, script } from "./lib.mjs";

const tl = JSON.parse(readFileSync(join(cache, "timeline.json"), "utf8"));
const footage = existsSync(join(cache, "footage.json")) ? JSON.parse(readFileSync(join(cache, "footage.json"), "utf8")) : null;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const VISUALS = {
  intro: [
    "Title card: the Exeunt logo, \"Exeunt\", \"Product demo\".",
    "Tagline \"The exit market for frozen lending pools\" with chips for Arbitrum (Aave V3) and Robinhood Chain (Morpho).",
    "A lending-pool card: utilization counts up to 100% as the bar fills; the Withdraw button is greyed out and a red \"Blocked, sometimes for days\" tag pops in on the word \"withdraw\".",
    "Three buyer cards slide in on their words: Borrowers, Limit bids, The Exeunt Vault; then \"Paid right away\".",
    "Closing pill: \"No liquidity leaves the pool\".",
  ],
  setup: [
    "Network card \"Kelp replay\" with the exeunt.space chip; three facts appear on their words (fork of Arbitrum One, 18 April 2026, Aave WETH pool at 100%), then \"Aave's real contracts, real state\".",
    "Two browser windows with stills captured during pre-production: Alice (amber badge, Sell page) and Bob (blue badge, Buy page).",
    "On Alice's line her window lights up and zooms into her 10 WETH position; on Bob's line his window zooms into his 5 WETH debt.",
    "On the faucet line, Bob's wallet menu pops over and zooms into the three faucet kits.",
  ],
  outro: [
    "Recap grid of the nine features shown, staggered in.",
    "Closing line: \"A frozen pool no longer means a locked exit.\"",
    "\"Thanks for watching\" with exeunt.space and api.exeunt.space/mcp.",
  ],
};
const INSERTS = {
  mechanism: "Motion-graphics insert over the dimmed footage: \"One transaction, four moves\" (flash-borrow, repay Bob's debt, redeem Alice's receipts, return the loan), each step on its word, then \"Withdrawable liquidity unchanged\". The real transaction confirms underneath.",
  morpho: "Motion-graphics insert: \"Flash mode with signatures, not approvals\" (signed grant, withdraw the freed collateral, signed revoke), then \"Reverts if any authorization remains\".",
  mcp: "Motion-graphics insert: a terminal panel types the real `get_exit_capacity` call to api.exeunt.space/mcp, then prints the real result captured during pre-production (utilization, withdrawable, supplied, debtor capacity, bids by discount).",
};
const PROFILE = { alice: "Alice (depositor)", bob: "Bob (borrower and bidder)" };

function action(a) {
  const t = (x) => `\`${x}\``;
  const parts = [];
  if (a.atWord) parts.push(`on the word "${a.atWord}":`);
  if (a.scroll) parts.push(`scroll to ${t(a.scroll)}`);
  if (a.click) parts.push(`click ${t(a.click)}`);
  if (a.type) parts.push(`type "${a.value}" into ${t(a.type)}`);
  if (a.point) parts.push(`point at ${t(a.point)}${a.label ? ` with the label "${a.label}"` : ""}`);
  if (a.clear) parts.push("clear the highlights");
  if (a.tx) parts.push("wait for the transaction to confirm");
  return parts.join(" ");
}

const out = [];
out.push("# Exeunt demo video: director's script", "");
out.push(`Built from [demo-script.md](../demo-script.md). Final cut: \`out/exeunt-demo.mp4\`, ${fmt(tl.duration)}, 1920×1080 at 30 fps, voiceover in the cloned voice, burned-in captions, a quiet music bed.`, "");
out.push("Pipeline: `voice.mjs` (voiceover) → `record.mjs` (pre-production checks and live footage) → `build.mjs` (motion graphics, captions, mix, render) → `qc.mjs` (quality checks) → `direction.mjs` (this file).", "");
out.push("## Pre-production plan", "");
out.push("Everything below is done by `record.mjs` before the first frame is recorded, and the recording stops if a check fails.", "");
out.push("| Item | Plan | Check before recording |", "|---|---|---|");
out.push("| Site | https://exeunt.space, hosted, network **Kelp replay** (Arbitrum One fork, 18 Apr 2026) for steps 3–11; **Earn bank-run** (Robinhood Chain fork) for steps 12–13 | Both forks answer `eth_getBalance` for a fresh address through `api.exeunt.space/rpc/<network>` |");
out.push("| Timing | Not within 45 minutes before, or 20 minutes after, a daily fork reset (03:00 UTC Kelp replay, 03:30 UTC Earn bank-run): a reset wipes the positions | Clock check against both reset times |");
out.push("| Browser profile 1 | **Alice**, the depositor: her own Chrome profile (separate user-data directory), window 1568×882, built-in demo wallet with a new burner key | Wallet connected on Kelp replay |");
out.push("| Browser profile 2 | **Bob**, the borrower and bidder: a second Chrome profile, same size, his own demo wallet and burner key | Wallet connected on Kelp replay |");
out.push("| Alice's account | Faucet **Seller kit**: 10 WETH deposited into the Aave pool for her (aArbWETH receipts), pool re-frozen | Sell page shows exactly \"10 WETH\" |");
out.push("| Bob's account | Faucet **Borrower kit** (USDC collateral, 5 WETH borrowed) and **Bidder kit** (stablecoins and WETH/wstETH for bids and the vault) | Buy page shows a debt of exactly \"5 WETH\" |");
out.push("| Stills | Alice's Sell page, Bob's Buy page, Bob's wallet menu with the faucet kits, each with the position of the card the camera zooms into | Saved before recording |");
out.push("| MCP call | `tools/call get_exit_capacity {\"network\": \"kelp-replay\"}` against https://api.exeunt.space/mcp; the real answer is what the terminal insert shows | Response parsed |");
out.push("| Tabs per step | Each live step starts from a freshly loaded page in the right profile (table below), scrolled to the top, cursor parked | The step's first control is on the page |");
out.push("| State between steps | Alice's auction id is read when it opens and reused by Bob's Buy steps and Alice's withdraw step; Bob's new bid id is read when it is placed | Ids found on the page |");
out.push("");
if (footage) {
  out.push(`Last recording: ${footage.recordedAt}, ${footage.beats.length} live steps, ${footage.warnings.length} warnings.`, "");
}
out.push("## Shot list", "");
out.push("| # | Step | Starts | Length | Type | Profile and page |", "|---|---|---|---|---|---|");
for (const s of tl.segments) {
  const b = script.beats[s.index];
  const type = b.kind === "mg" ? "Motion graphics" : b.lines.some((l) => l.insert) ? "Live footage + motion-graphics insert" : "Live footage";
  out.push(`| ${s.index + 1} | ${s.label} | ${fmt(s.start)} | ${(s.end - s.start).toFixed(0)} s | ${type} | ${b.kind === "live" ? `${PROFILE[b.profile]}, \`${b.page}\`` : "—"} |`);
}
out.push("");
for (const s of tl.segments) {
  const b = script.beats[s.index];
  out.push(`### ${s.index + 1}. ${s.label} (${fmt(s.start)}–${fmt(s.end)})`, "");
  if (b.kind === "mg") {
    out.push("**Visuals**", "", ...VISUALS[b.id].map((v) => `- ${v}`), "");
  } else {
    out.push(`**Visuals**: live footage of ${PROFILE[b.profile]}'s browser window (profile badge, exeunt.space${b.page}); a cursor moves to each control, green rings and labels mark what the voice describes.`, "");
  }
  out.push("| Time | Voiceover | On screen |", "|---|---|---|");
  b.lines.forEach((l, i) => {
    const line = s.lines[i];
    const screen = [l.insert ? INSERTS[l.insert] : null, ...(l.do ?? []).map(action)].filter(Boolean).join("; ") || (b.kind === "mg" ? "see Visuals" : "hold on the current view");
    out.push(`| ${fmt(line.start)} | ${l.text} | ${screen} |`);
  });
  out.push("");
}
writeFileSync(join(here, "direction.md"), out.join("\n"));
console.log(join(here, "direction.md"));
