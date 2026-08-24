// A WALL CLOCK FOR A JOB THAT HAS NEVER HAD ONE.
//
// WHY IT EXISTS. On 2026-08-24 an operator clicked "generate script" and
// watched /admin/job-logs read "Running 4096s" — sixty-eight minutes — with no
// end in sight and no way to tell whether anything was still happening. Nothing
// in the stack was wrong in isolation. Every limit in the pipeline is a limit on
// ONE HTTP REQUEST, and those limits multiply:
//
//     240s   request timeout (nvidia / zai / moonshot / google)
//   x   3     attempts per candidate (maxRetries = 2)
//   x   N     candidates in the role's fallback chain
//   x   3     rate-window passes (LLM_RATE_WINDOW_PASSES = 2, plus the first)
//   x  21     roles in one episode
//
// Nothing anywhere multiplied those numbers back out and said "no". A single
// degraded provider therefore does not fail an episode — it stretches it, and
// the stretch has no ceiling. 4096 seconds is not the worst case, it is an
// ordinary Saturday with one slow account.
//
// THE BUDGET IS COOPERATIVE, ON PURPOSE. The obvious fix — race the handler
// against a timer — is worse than nothing: `Promise.race` abandons the result
// but cannot stop the work, so the job reports "failed" while the chain behind
// it keeps calling providers and keeps spending the owner's money for another
// hour, invisibly. Instead the deadline is carried in AsyncLocalStorage (the
// same mechanism as the routing profile and the cost ledger) and consulted at
// the four places that can start or extend a wait:
//
//   1. routing.ts   — before trying the next candidate in a role's chain
//   2. routing.ts   — before waiting out a rate window and re-running the chain
//   3. transports   — before a retry backoff or a rate-window hold
//   4. transports   — the per-request timeout is clamped to what is left
//
// (4) is what makes the bound real rather than advisory: the longest a job can
// overshoot its deadline is one in-flight HTTP request, and that request was
// already given no more time than the budget had left.
//
// A budget is never inherited by accident. Only a job handler establishes one
// (withJobBudget); everything called outside one — a script, a test, an admin
// action — sees `Infinity` remaining and behaves exactly as it did before.

import { AsyncLocalStorage } from "async_hooks";

export interface JobBudget {
  /** Human-readable owner of the budget, used in the failure message. */
  label: string;
  startedAt: number;
  /** Epoch ms after which no new provider work may START. */
  deadlineAt: number;
}

const budgetStorage = new AsyncLocalStorage<JobBudget>();

/**
 * Raised when a job runs out of wall clock.
 *
 * Deliberately its own class rather than a generic Error: the worker turns it
 * into a JobLog failure that names the budget and the knob, and a caller that
 * wants to treat "we ran out of time" differently from "the provider refused"
 * can, without matching on message text.
 */
export class JobBudgetExceededError extends Error {
  readonly label: string;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  /** Where in the pipeline the budget was found to be spent. */
  readonly at: string;
  /** What the run actually spent its time on, when the caller can say. */
  readonly history: string[];

  constructor(args: {
    label: string;
    elapsedMs: number;
    budgetMs: number;
    at: string;
    history?: string[];
  }) {
    const history = args.history ?? [];
    super(
      `[JobBudget] ${args.label} exceeded its ${Math.round(args.budgetMs / 1000)}s wall-clock budget ` +
        `(${Math.round(args.elapsedMs / 1000)}s elapsed) and was stopped at: ${args.at}. ` +
        `Nothing further was requested from any provider. This is a BUDGET stop, not a provider failure: ` +
        `the run was too slow, not wrong. Raise SCRIPT_JOB_BUDGET_MS if this job legitimately needs longer.` +
        // THE EVIDENCE TRAVELS WITH THE ERROR, because the operator who needs it
        // usually cannot get at the worker's stdout. The console has always
        // carried this history; the console lives inside a container behind a
        // hosting dashboard, and "go read the worker logs" is not an answer
        // available to someone looking at /admin/job-logs on their phone at 4am.
        // The error string is written to JobLog.error, which that page renders.
        (history.length
          ? `\nWHERE THE TIME WENT (most recent chain, in order):\n  - ${history.join("\n  - ")}`
          : "")
    );
    this.name = "JobBudgetExceededError";
    this.label = args.label;
    this.elapsedMs = args.elapsedMs;
    this.budgetMs = args.budgetMs;
    this.at = args.at;
    this.history = history;
  }
}

/** Run `fn` under a wall-clock budget. Nested calls do not extend an outer
 *  budget — the tighter of the two wins, because the outer one is the promise
 *  actually made to the operator. */
export function withJobBudget<T>(args: { label: string; budgetMs: number; now?: number }, fn: () => T): T {
  const startedAt = args.now ?? Date.now();
  const outer = budgetStorage.getStore();
  const deadlineAt = Math.min(
    startedAt + Math.max(0, args.budgetMs),
    outer?.deadlineAt ?? Number.POSITIVE_INFINITY
  );
  return budgetStorage.run({ label: args.label, startedAt, deadlineAt }, fn);
}

export function currentJobBudget(): JobBudget | undefined {
  return budgetStorage.getStore();
}

/** Milliseconds of budget left, or Infinity when no budget is in scope. */
export function jobBudgetRemainingMs(now: number = Date.now()): number {
  const budget = budgetStorage.getStore();
  if (!budget) return Number.POSITIVE_INFINITY;
  return budget.deadlineAt - now;
}

export function jobBudgetExpired(now: number = Date.now()): boolean {
  return jobBudgetRemainingMs(now) <= 0;
}

/**
 * Stop here if the budget is spent.
 *
 * `at` names the step that was ABOUT to start, so the failure says what did not
 * happen rather than what did. Call it before work, never after.
 */
export function assertJobBudget(
  at: string,
  now: number = Date.now(),
  history?: string[]
): void {
  const budget = budgetStorage.getStore();
  if (!budget) return;
  if (now < budget.deadlineAt) return;
  throw new JobBudgetExceededError({
    label: budget.label,
    elapsedMs: now - budget.startedAt,
    budgetMs: budget.deadlineAt - budget.startedAt,
    at,
    history,
  });
}

/**
 * The wait a caller may actually perform.
 *
 * Returns the requested wait when it fits, and throws when it does not — a
 * sleep that is guaranteed to end past the deadline is time spent to reach a
 * failure we can already predict, which is the exact shape of the bug this
 * module exists to kill. Callers that would rather shorten than fail can
 * compare `jobBudgetRemainingMs()` themselves.
 */
export function budgetedWaitMs(requestedMs: number, at: string, now: number = Date.now()): number {
  const remaining = jobBudgetRemainingMs(now);
  if (requestedMs <= remaining) return requestedMs;
  const budget = budgetStorage.getStore()!;
  throw new JobBudgetExceededError({
    label: budget.label,
    elapsedMs: now - budget.startedAt,
    budgetMs: budget.deadlineAt - budget.startedAt,
    at: `${at} (needed ${Math.round(requestedMs / 1000)}s, ${Math.max(0, Math.round(remaining / 1000))}s left)`,
  });
}

/**
 * A per-request timeout that cannot outlive the job.
 *
 * A 240s request timeout is correct for a request with 240s of budget behind
 * it and absurd for one with 12s. Clamping here is what turns the cooperative
 * checks above into a hard ceiling: the last request a job starts can only run
 * until the deadline.
 */
export function clampTimeoutToBudget(timeoutMs: number, now: number = Date.now()): number {
  const remaining = jobBudgetRemainingMs(now);
  if (!Number.isFinite(remaining)) return timeoutMs;
  // Never return 0 or a negative: an AbortController armed with 0 aborts before
  // the socket opens, which categorizes as an implausibly fast failure and
  // reads in the log as a provider defect rather than as our own deadline.
  return Math.max(1_000, Math.min(timeoutMs, Math.floor(remaining)));
}

/** How long one script-generation job may run, in ms.
 *
 *  Default 25 minutes. QUALITY_TIER_INFO promises the free tier 8-12 minutes
 *  and the measured pipeline has never legitimately exceeded ~33 minutes, so
 *  the default sits above every real run and far below the hour-plus that
 *  prompted this. Clamped: a typo must not restore "no ceiling at all". */
export const DEFAULT_SCRIPT_JOB_BUDGET_MS = 25 * 60 * 1000;
export const MIN_SCRIPT_JOB_BUDGET_MS = 5 * 60 * 1000;
export const MAX_SCRIPT_JOB_BUDGET_MS = 2 * 60 * 60 * 1000;

export function scriptJobBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SCRIPT_JOB_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SCRIPT_JOB_BUDGET_MS;
  return Math.min(MAX_SCRIPT_JOB_BUDGET_MS, Math.max(MIN_SCRIPT_JOB_BUDGET_MS, Math.floor(raw)));
}
