// What an extra run actually costs, taken from the runs already paid for.
//
// The scheduler dropped from eight runs a day to two (see topicsGenerateCron),
// and anyone who wants fresher topics triggers one by hand. Asking someone to
// spend money without telling them how much is how a "just click it again"
// habit forms, so the control shows a figure before they commit.
//
// The figure is the MEDIAN of the cost ledger's own records for that job type.
// Not a rate card, not a guess from token counts: what this deployment's runs
// on this deployment's providers actually cost. A mean would let one runaway
// run (a 970-second topic sweep that failed at the last rung, having paid for
// every rung before it) set an estimate nobody would recognise.
//
// When there is no history, this returns null and the caller says so. An
// invented number attached to a real spend decision is worse than "unknown" —
// the whole point is that the operator can trust what the button tells them.

export type RunCostEstimate = {
  /** Median USD across successful past runs; null when not knowable yet. */
  medianUsd: number | null;
  /** How many past runs the figure rests on. */
  sampleSize: number;
  /** Cheapest and dearest observed — the spread matters when it is wide. */
  rangeUsd: { min: number; max: number } | null;
  /** Operator-facing sentence. Always safe to render. */
  summary: string;
};

/** A JobLog row's recorded ledger total, if it has one. Shape-tolerant: the
 *  ledger has grown fields over time and old rows predate some of them. */
export function costOfRun(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const llmCost = (output as { llmCost?: unknown }).llmCost;
  if (!llmCost || typeof llmCost !== "object") return null;
  const raw = (llmCost as { totalUsd?: unknown; costUsd?: unknown }).totalUsd
    ?? (llmCost as { costUsd?: unknown }).costUsd;
  const n = typeof raw === "number" ? raw : Number(raw);
  // Zero is a real, meaningful answer here: every free-tier provider is
  // unpriced, so a genuinely free run must not be discarded as "no data".
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function summarize(costs: number[], label: string): RunCostEstimate {
  const m = median(costs);
  if (m === null) {
    return {
      medianUsd: null,
      sampleSize: 0,
      rangeUsd: null,
      summary: `Cost unknown — no completed ${label} run has been recorded yet. The first run will establish it.`,
    };
  }
  const range = { min: Math.min(...costs), max: Math.max(...costs) };
  // A wide spread is the honest headline; quoting a single median across a
  // 10x range would be technically true and practically misleading.
  const wide = range.max > 0 && range.max >= range.min * 3;
  const summary = wide
    ? `About ${formatUsd(m)} per run (${costs.length} past runs ranged ${formatUsd(range.min)}–${formatUsd(range.max)}).`
    : `About ${formatUsd(m)} per run, based on the last ${costs.length} run${costs.length === 1 ? "" : "s"}.`;
  return { medianUsd: m, sampleSize: costs.length, rangeUsd: range, summary };
}

/** Estimate from this deployment's own JobLog history. */
export async function estimateOnDemandRunCost(
  db: any,
  jobType: string,
  opts: { sampleLimit?: number; label?: string } = {}
): Promise<RunCostEstimate> {
  const label = opts.label ?? jobType;
  try {
    const rows = await db.jobLog.findMany({
      where: { jobType, status: "completed" },
      select: { output: true },
      orderBy: { createdAt: "desc" },
      take: opts.sampleLimit ?? 20,
    });
    const costs = rows.map((r: { output: unknown }) => costOfRun(r.output)).filter((c: number | null): c is number => c !== null);
    return summarize(costs, label);
  } catch {
    return {
      medianUsd: null,
      sampleSize: 0,
      rangeUsd: null,
      summary: `Cost unknown — could not read past ${label} runs.`,
    };
  }
}
