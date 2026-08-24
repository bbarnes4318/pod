// WHERE DID THE HOUR GO? The arithmetic, separated from the database.
//
// WHY IT EXISTS. On 2026-08-24 a script job ran for 4096 seconds and the only
// account of what it had been doing lived on the worker's stdout — inside a
// container, behind a hosting dashboard, gone at the next deploy. The operator
// could see that it was slow and nothing whatsoever about why.
//
// The answer was already in the database and nothing read it. Every script job
// writes `output.llmCost` (costLedger.ts): per stage, the models used, the call
// count, the retries, the fallbacks, and `wallMs` — time actually spent inside
// HTTP calls.
//
// THE DECISIVE NUMBER IS THE ONE NOBODY WAS COMPUTING: the difference between
// how long the job took and how long it spent inside those calls. Every second
// of that gap is a second the job was asleep — in a rate-window hold or a retry
// backoff — because those are the only things this pipeline does that take real
// time and are not an HTTP request.
//
//   gap small  -> the CALLS are slow. Prompt size and model choice set the pace.
//   gap large  -> the job spent its life WAITING on a saturated account. That is
//                 a quota problem, and no amount of prompt tuning will touch it.
//
// Two opposite fixes. An operator who guesses wrong spends a week tuning prompts
// on a quota problem, which is precisely the week this module exists to save.
//
// PURE, and deliberately so: the arithmetic above is the part that can be wrong
// in a way that matters, so it lives where a network-free test can pin it. The
// CLI (scripts/diagnoseScriptRuns.ts) only queries and prints.

/** One stage exactly as costLedger writes it into JobLog.output.llmCost.stages. */
export interface RawStage {
  stage?: unknown;
  models?: unknown;
  roles?: unknown;
  calls?: unknown;
  wallMs?: unknown;
  retries?: unknown;
  fallbacks?: unknown;
  failures?: unknown;
}

export interface ScriptRunRow {
  id: string;
  status: string;
  error: string | null;
  input: unknown;
  output: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface StageBreakdown {
  stage: string;
  wallMs: number;
  /** Share of the run's CALLING time, 0-100. */
  sharePercent: number;
  calls: number;
  models: string[];
  roles: string[];
}

export type RunVerdict =
  /** Most of the run was rate-window holds and backoffs. A quota problem. */
  | "mostly_waiting"
  /** The time went into inference itself. A prompt/model problem. */
  | "mostly_calling"
  /** No per-call record — nothing may be concluded from it. */
  | "no_data";

export interface ScriptRunAnalysis {
  jobLogId: string;
  episodeId: string;
  status: string;
  /** True while the row has no ending, so its duration is measured to `now`. */
  stillOpen: boolean;
  jobMs: number;
  /** Time inside provider HTTP calls. */
  llmMs: number;
  /** jobMs - llmMs: holds and backoffs. Never negative. */
  waitMs: number;
  /** waitMs as a share of the run, 0-100. 0 when the run has no duration. */
  waitPercent: number;
  calls: number;
  retries: number;
  fallbacks: number;
  failures: number;
  verdict: RunVerdict;
  stages: StageBreakdown[];
  errorLines: string[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A run counts as "mostly waiting" only when the waiting both DOMINATES and is
 * large in absolute terms.
 *
 * The share alone is not enough: a four-second job that spent three seconds
 * waiting is 75% idle and completely uninteresting. The floor keeps the verdict
 * for runs where the waiting is the operator's actual problem.
 */
export const WAITING_SHARE_THRESHOLD = 0.5;
export const WAITING_ABSOLUTE_FLOOR_MS = 60_000;

/**
 * Read one JobLog row and say where its time went.
 *
 * `now` is injected so a still-running row can be measured deterministically.
 */
export function analyzeScriptRun(row: ScriptRunRow, now: number = Date.now()): ScriptRunAnalysis {
  const input = asObject(row.input);
  const output = asObject(row.output);
  const episodeId = typeof input?.episodeId === "string" ? input.episodeId : "(unknown episode)";

  // A row with no ending has not finished, so it is timed to now and SAID to be
  // open. Reporting an in-progress run as a finished measurement is the same
  // class of lie as the counter that started this.
  const stillOpen = row.status === "running" || row.status === "submitted";
  const endMs = stillOpen ? now : row.updatedAt.getTime();
  const jobMs = Math.max(0, endMs - row.createdAt.getTime());

  const llmCost = asObject(output?.llmCost);
  const rawStages: RawStage[] = Array.isArray(llmCost?.stages)
    ? (llmCost!.stages as RawStage[])
    : [];
  const totals = asObject(llmCost?.totals);

  const llmMs = rawStages.reduce((t, s) => t + num(s.wallMs), 0);
  const sum = (key: keyof RawStage) => rawStages.reduce((t, s) => t + num(s[key]), 0);
  const calls = num(totals?.calls) || sum("calls");
  const retries = num(totals?.retries) || sum("retries");
  const fallbacks = num(totals?.fallbacks) || sum("fallbacks");
  const failures = num(totals?.failures) || sum("failures");

  // Clamped at zero: a row whose updatedAt predates a late-arriving cost record
  // must not report negative waiting.
  const waitMs = Math.max(0, jobMs - llmMs);
  const waitFraction = jobMs > 0 ? waitMs / jobMs : 0;

  const stages: StageBreakdown[] = rawStages
    .map((s) => ({
      stage: typeof s.stage === "string" && s.stage ? s.stage : "(unnamed)",
      wallMs: num(s.wallMs),
      sharePercent: llmMs > 0 ? Math.round((num(s.wallMs) / llmMs) * 100) : 0,
      calls: num(s.calls),
      models: strList(s.models),
      roles: strList(s.roles),
    }))
    .sort((a, b) => b.wallMs - a.wallMs);

  // NO RECORD MEANS NO VERDICT. A job that died before its first provider call
  // has nothing to attribute, and "0s calling, 100% waiting" would be a
  // confident lie about a run we know nothing about.
  const verdict: RunVerdict =
    rawStages.length === 0
      ? "no_data"
      : waitFraction >= WAITING_SHARE_THRESHOLD && waitMs > WAITING_ABSOLUTE_FLOOR_MS
        ? "mostly_waiting"
        : "mostly_calling";

  return {
    jobLogId: row.id,
    episodeId,
    status: row.status,
    stillOpen,
    jobMs,
    llmMs,
    waitMs,
    waitPercent: Math.round(waitFraction * 100),
    calls,
    retries,
    fallbacks,
    failures,
    verdict,
    stages,
    errorLines: row.error ? row.error.split("\n") : [],
  };
}

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "·".repeat(width - filled);
}

/** The report for one run, as lines. Separated from printing so a test can read
 *  what an operator would see without capturing stdout. */
export function formatScriptRunReport(
  a: ScriptRunAnalysis,
  createdAt: Date,
  maxErrorLines = 12
): string[] {
  const out: string[] = [];
  out.push(
    `${createdAt.toISOString()}  ${a.status.toUpperCase()}${a.stillOpen ? "  (still open — timed to now)" : ""}`
  );
  out.push(`  episode ${a.episodeId}   job log ${a.jobLogId}`);
  out.push(`  took ${secs(a.jobMs)} total`);

  if (a.verdict === "no_data") {
    out.push(
      `  no per-call cost record on this row — either it failed before its first provider call,`
    );
    out.push(`  or it is still running (llmCost is written when the job ends).`);
  } else {
    const callFraction = a.jobMs > 0 ? 1 - a.waitMs / a.jobMs : 0;
    out.push(`    calling providers  ${bar(callFraction)}  ${secs(a.llmMs)}  (${a.calls} call(s))`);
    out.push(
      `    waiting            ${bar(1 - callFraction)}  ${secs(a.waitMs)}  (${a.waitPercent}% of the run)`
    );

    if (a.verdict === "mostly_waiting") {
      out.push(
        `  >> MOSTLY WAITING. ${a.waitPercent}% of this run was rate-window holds and retry backoffs,`
      );
      out.push(
        `     not inference. This is a QUOTA problem: the account(s) below could not serve the`
      );
      out.push(`     request when it was asked. Prompt tuning will not help; more headroom will.`);
    } else {
      out.push(
        `  >> MOSTLY CALLING. The time is going into inference itself, so look at the slowest`
      );
      out.push(`     stage below — its prompt size and model choice are what set this run's length.`);
    }

    if (a.retries || a.fallbacks || a.failures) {
      out.push(
        `     ${a.retries} retry(s), ${a.fallbacks} fallback(s), ${a.failures} failed call(s) — every` +
          ` one of these is paid-for time that produced nothing.`
      );
    }

    out.push(`     slowest stages:`);
    for (const s of a.stages.slice(0, 6)) {
      out.push(
        `       ${s.stage.padEnd(26)} ${secs(s.wallMs).padStart(7)}  ${String(s.sharePercent).padStart(3)}%  ` +
          `${s.calls} call(s)  ${s.models.join(", ") || "(no model recorded)"}` +
          `${s.roles.length ? `  [${s.roles.join(", ")}]` : ""}`
      );
    }
  }

  if (a.errorLines.length) {
    out.push(`     error: ${a.errorLines[0].slice(0, 240)}`);
    for (const line of a.errorLines.slice(1, maxErrorLines)) {
      out.push(`            ${line.slice(0, 240)}`);
    }
    if (a.errorLines.length > maxErrorLines) {
      out.push(`            ... ${a.errorLines.length - maxErrorLines} more line(s)`);
    }
  }
  return out;
}
