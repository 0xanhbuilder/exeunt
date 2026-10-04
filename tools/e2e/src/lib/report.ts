export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  details: Record<string, string>;
  txs: string[];
  error?: string;
}

export interface ScenarioResult {
  network: string;
  mode: "fork" | "live";
  forkBlock?: string;
  deployment?: Record<string, unknown>;
  steps: StepResult[];
  startedAt: string;
  ms: number;
}

export class AssertionError extends Error {}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/** Within `tol` (absolute) of `expected`. */
export function near(actual: bigint, expected: bigint, tol: bigint, what: string): void {
  const diff = actual > expected ? actual - expected : expected - actual;
  check(diff <= tol, `${what}: expected ${expected} ± ${tol}, got ${actual}`);
}

/** Runs named steps, keeps going after a failure only when a step is marked independent. */
export class Recorder {
  readonly steps: StepResult[] = [];
  private failed = false;
  private currentTxs: string[] = [];

  constructor(readonly network: string, private readonly log: (line: string) => void) {}

  get hasFailed(): boolean {
    return this.failed;
  }

  noteTx(hash: string): void {
    this.currentTxs.push(hash);
  }

  async step(
    name: string,
    fn: () => Promise<Record<string, string> | void>,
    opts: { independent?: boolean } = {},
  ): Promise<boolean> {
    if (this.failed && !opts.independent) {
      this.steps.push({ name, ok: false, ms: 0, details: {}, txs: [], error: "skipped: an earlier step failed" });
      this.log(`  - SKIP ${name}`);
      return false;
    }
    const t0 = Date.now();
    this.currentTxs = [];
    try {
      const details = (await fn()) ?? {};
      const ms = Date.now() - t0;
      this.steps.push({ name, ok: true, ms, details, txs: this.currentTxs });
      this.log(`  ✓ ${name} (${ms} ms)${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`);
      return true;
    } catch (e) {
      const ms = Date.now() - t0;
      const error = e instanceof Error ? e.message.split("\n").slice(0, 6).join(" | ") : String(e);
      this.steps.push({ name, ok: false, ms, details: {}, txs: this.currentTxs, error });
      this.failed = true;
      this.log(`  ✗ ${name}: ${error}`);
      return false;
    }
  }
}

export function toMarkdown(results: ScenarioResult[], startedAt: string): string {
  const lines: string[] = [];
  const total = results.flatMap((r) => r.steps);
  const passed = total.filter((s) => s.ok).length;
  lines.push(`# Exeunt end-to-end report`);
  lines.push("");
  lines.push(`Started ${startedAt}. ${passed}/${total.length} steps passed.`);
  lines.push("");
  lines.push("| Network | Mode | Fork block | Passed | Duration |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const ok = r.steps.filter((s) => s.ok).length;
    lines.push(`| ${r.network} | ${r.mode} | ${r.forkBlock ?? "-"} | ${ok}/${r.steps.length} | ${(r.ms / 1000).toFixed(1)} s |`);
  }
  for (const r of results) {
    lines.push("");
    lines.push(`## ${r.network}`);
    lines.push("");
    lines.push("| # | Step | Result | Details |");
    lines.push("|---|---|---|---|");
    r.steps.forEach((s, i) => {
      const details = s.ok
        ? Object.entries(s.details)
            .map(([k, v]) => `${k}: ${v}`)
            .join("<br>")
        : (s.error ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${i + 1} | ${s.name} | ${s.ok ? "pass" : "FAIL"} | ${details} |`);
    });
  }
  return `${lines.join("\n")}\n`;
}
