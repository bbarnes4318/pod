// Per-stage LLM cost metering. MEASUREMENT ONLY — no behavior changes.
//
// Every provider reports each successful API call here with the token usage
// the PROVIDER returned (never estimated). Call sites label the pipeline
// stage via withLlmStage(); the label propagates through async boundaries
// with AsyncLocalStorage, so nested helpers inherit their caller's stage.
//
// Field names deliberately avoid the substrings the /admin/job-logs secret
// masker redacts by key ("token", "key", "secret", ...) — hence tkIn/tkOut,
// not inputTokens (the masker turned `tokensDelta` into "[MASKED]").
//
// Retrieval: worker job handlers snapshot the ledger delta for their run and
// attach it to the JobLog output as `llmCost`, so the numbers ride the same
// operator surfaces every other job diagnostic uses. Each call also emits a
// one-line `[LLMCost]` console log.

import { AsyncLocalStorage } from "async_hooks";

export interface LlmCallRecord {
  /** Monotonic id — marks survive ledger trimming. */
  id: number;
  stage: string;
  provider: string;
  model: string;
  /** Uncached input tokens billed at the full input rate. */
  tkIn: number;
  tkOut: number;
  /** Cache-read input tokens (Anthropic cache_read_input_tokens / OpenAI cached_tokens). */
  tkCacheRead: number;
  /** Cache-write input tokens (Anthropic cache_creation_input_tokens). */
  tkCacheWrite: number;
  /** Provider-reported reasoning tokens. 0 when the provider reports none —
   *  never inferred from output length. */
  tkReasoning: number;
  durationMs: number;
  at: string; // ISO timestamp
  // ---- role-based routing attribution (all optional: a direct provider call
  // that was not routed by role records nothing here rather than a guess) ----
  /** LLMRole this call served. */
  role?: string;
  /** LLM_ROUTING_PROFILE in force. */
  profile?: string;
  /** Which resolution rung produced this provider/model. */
  candidateSource?: string;
  /** HTTP attempts made for this call, including the first. */
  attempts?: number;
  /** Retries of a transient failure against this same provider/model. */
  retries?: number;
  /** How many EARLIER candidates in the role chain failed before this one ran. */
  fallbacks?: number;
  /** Structured-output repair requests made for this call (0 or 1). */
  repairs?: number;
  /** Did the call ultimately succeed? Failures are recorded too. */
  ok?: boolean;
  /** Failure category when ok === false. */
  failure?: string;
  /** Whether reasoning was REQUESTED. The reasoning TEXT is never stored. */
  reasoningRequested?: boolean;
  /** Whether the response actually carried separate reasoning content. Distinct
   *  from `reasoningRequested` on purpose: asking is not evidence of reasoning,
   *  and a role must never be reported as having reasoned because it asked to. */
  reasoningReturned?: boolean;
  /** USD estimate, or null when the endpoint is free/unpriced or no rate is
   *  configured. NEVER a fabricated number. */
  estimatedCostUsd?: number | null;
}

export interface LlmStageAggregate {
  stage: string;
  models: string[];
  calls: number;
  tkIn: number;
  tkOut: number;
  tkCacheRead: number;
  tkCacheWrite: number;
  tkReasoning: number;
  wallMs: number;
  /** Roles observed in this stage (empty for unrouted direct calls). */
  roles: string[];
  retries: number;
  fallbacks: number;
  repairs: number;
  failures: number;
  /** Sum of the priced calls only; null when nothing in the stage was priced. */
  estimatedCostUsd: number | null;
}

const stageStorage = new AsyncLocalStorage<string>();

/**
 * Role attribution for the calls inside one routed attempt.
 *
 * Carried in AsyncLocalStorage for the same reason the stage label is: it must
 * survive async boundaries and stay correct when several episodes are in flight
 * in the same worker process. Passing it through the provider constructor would
 * mislabel concurrent calls that share a cached provider instance.
 */
export interface LlmAttribution {
  role: string;
  profile: string;
  candidateSource: string;
  /** How many earlier candidates in the role chain already failed. */
  fallbacks: number;
}

const attributionStorage = new AsyncLocalStorage<LlmAttribution>();

export function withLlmAttribution<T>(attr: LlmAttribution, fn: () => T): T {
  return attributionStorage.run(attr, fn);
}

export function currentLlmAttribution(): LlmAttribution | undefined {
  return attributionStorage.getStore();
}

let nextId = 1;
let entries: LlmCallRecord[] = [];
// Backstop for the long-lived worker process; a single episode produces tens
// of records, so trimming never touches an in-flight measurement window.
const MAX_ENTRIES = 20000;

/** Run `fn` with all LLM calls inside it attributed to `stage`. */
export function withLlmStage<T>(stage: string, fn: () => T): T {
  return stageStorage.run(stage, fn);
}

export function currentLlmStage(): string {
  return stageStorage.getStore() || "unlabeled";
}

/**
 * Per-1M-token rates, supplied by the OPERATOR. Deliberately empty by default:
 * a hosted trial endpoint has no price, and inventing a rate for a paid one
 * produces a confident dollar figure that is simply wrong. Configure
 * LLM_PRICE_<PROVIDER>_IN / _OUT (USD per 1M tokens) to get estimates.
 */
export interface LlmRates {
  in: number;
  out: number;
  /** Per-1M rate for cache-READ input tokens. */
  cacheRead: number;
  /** Per-1M rate for cache-WRITE (cache-creation) input tokens. */
  cacheWrite: number;
}

/**
 * Cache tokens are NOT priced at the input rate, and treating them as if they
 * were is wrong in both directions at once: a cache read is far cheaper than
 * fresh input and a cache write is more expensive. Anthropic's published
 * multipliers are 0.1x input for a read and 1.25x input for a 5-minute write —
 * so a workload that caches heavily looks ~10x more expensive than it is if
 * reads are billed as input, which would make the caching work in this same
 * change set look like a regression on the very dashboard meant to measure it.
 *
 * These are DEFAULTS applied only when the operator has not configured an
 * explicit rate. An operator who sets LLM_PRICE_<PROVIDER>_CACHE_READ overrides
 * them; anyone whose provider prices cache tokens differently sets that rate
 * rather than inheriting an Anthropic assumption.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Per-1M-token rates, supplied by the OPERATOR.
 *
 * `_IN` and `_OUT` are required together — a provider with one and not the
 * other is a half-configured rate, and half a rate produces a confidently wrong
 * total rather than an honest "unpriced". The two cache rates are optional and
 * fall back to the multipliers above.
 */
function rateFor(provider: string): LlmRates | null {
  const p = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const num = (suffix: string): number | null => {
    const raw = process.env[`LLM_PRICE_${p}_${suffix}`];
    // An unset variable and an empty one both mean "not configured". Number("")
    // is 0, which would otherwise read as a genuine zero rate.
    if (raw === undefined || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const inRate = num("IN");
  const outRate = num("OUT");
  if (inRate === null || outRate === null) return null;
  return {
    in: inRate,
    out: outRate,
    cacheRead: num("CACHE_READ") ?? inRate * CACHE_READ_MULTIPLIER,
    cacheWrite: num("CACHE_WRITE") ?? inRate * CACHE_WRITE_MULTIPLIER,
  };
}

/** Resolved rates for a provider, or null when unpriced. Exported for tests. */
export function resolvedRatesFor(provider: string): LlmRates | null {
  return rateFor(provider);
}

export interface CostBasis {
  tkIn: number;
  tkOut: number;
  tkCacheRead?: number;
  tkCacheWrite?: number;
}

/**
 * USD estimate, or null when the endpoint is unpriced or no rate is configured.
 *
 * Accepts either the four-argument positional form used before cache pricing
 * existed, or a CostBasis object. The positional form is kept because prices
 * with no cache tokens are still the common case and rewriting every call site
 * to build an object would have been churn, not clarity.
 */
export function estimateCostUsd(
  provider: string,
  basis: CostBasis | number,
  tkOutOrUnpriced?: number | boolean,
  unpricedArg?: boolean
): number | null {
  const b: CostBasis =
    typeof basis === "number" ? { tkIn: basis, tkOut: Number(tkOutOrUnpriced) || 0 } : basis;
  const unpriced = typeof basis === "number" ? Boolean(unpricedArg) : Boolean(tkOutOrUnpriced);

  // AN EXPLICIT RATE OUTRANKS THE PROVIDER'S `unpriced` FLAG.
  //
  // The flag means "this integration has no list price" — true of a free trial
  // endpoint, and the right default. It is NOT a statement that the operator
  // cannot know better. Previously the flag was checked first and won
  // unconditionally, so `LLM_PRICE_NVIDIA_IN=0` was silently ignored and every
  // NVIDIA and Z.ai line logged `cost=unpriced` however the worker was
  // configured — four variables that did nothing, and a cost summary where the
  // free rungs were indistinguishable from the unmeasured ones.
  //
  // Order now: a configured rate wins if there is one; with no rate the result
  // is null either way, so the flag still decides every case it used to — it
  // just no longer overrides an operator who has said what the thing costs.
  // That keeps "unpriced" meaning "nobody has said what this costs" rather than
  // "we decided not to look", and makes an explicit 0 a MEASUREMENT: a free rung
  // reporting $0.0000 is a fact, an absent rate is an absence, and a cost line
  // should not blur the two.
  //
  // `unpriced` is therefore no longer consulted directly — it is subsumed by
  // "is there a rate?". Kept in the signature because every call site passes it
  // and it documents the provider's own claim at the point of the call.
  void unpriced;
  const rate = rateFor(provider);
  if (!rate) return null;
  return (
    ((b.tkIn || 0) * rate.in +
      (b.tkOut || 0) * rate.out +
      (b.tkCacheRead || 0) * rate.cacheRead +
      (b.tkCacheWrite || 0) * rate.cacheWrite) /
    1_000_000
  );
}

export function recordLlmCall(rec: {
  provider: string;
  model: string;
  tkIn: number;
  tkOut: number;
  tkCacheRead?: number;
  tkCacheWrite?: number;
  tkReasoning?: number;
  durationMs: number;
  stage?: string;
  role?: string;
  profile?: string;
  candidateSource?: string;
  attempts?: number;
  retries?: number;
  fallbacks?: number;
  repairs?: number;
  ok?: boolean;
  failure?: string;
  reasoningRequested?: boolean;
  reasoningReturned?: boolean;
  estimatedCostUsd?: number | null;
}): void {
  const attr = currentLlmAttribution();
  const entry: LlmCallRecord = {
    id: nextId++,
    stage: rec.stage ?? currentLlmStage(),
    provider: rec.provider,
    model: rec.model,
    tkIn: rec.tkIn || 0,
    tkOut: rec.tkOut || 0,
    tkCacheRead: rec.tkCacheRead || 0,
    tkCacheWrite: rec.tkCacheWrite || 0,
    tkReasoning: rec.tkReasoning || 0,
    durationMs: Math.round(rec.durationMs),
    at: new Date().toISOString(),
    role: rec.role ?? attr?.role,
    profile: rec.profile ?? attr?.profile,
    candidateSource: rec.candidateSource ?? attr?.candidateSource,
    attempts: rec.attempts,
    retries: rec.retries,
    fallbacks: rec.fallbacks ?? attr?.fallbacks,
    repairs: rec.repairs,
    ok: rec.ok,
    failure: rec.failure,
    reasoningRequested: rec.reasoningRequested,
    reasoningReturned: rec.reasoningReturned,
    estimatedCostUsd: rec.estimatedCostUsd ?? null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-Math.floor(MAX_ENTRIES / 2));
  console.log(
    `[LLMCost] stage=${entry.stage}${entry.role ? ` role=${entry.role}` : ""}` +
      `${entry.profile ? ` profile=${entry.profile}` : ""} provider=${entry.provider} model=${entry.model} ` +
      `in=${entry.tkIn} out=${entry.tkOut} cacheRead=${entry.tkCacheRead} cacheWrite=${entry.tkCacheWrite} ` +
      `reasoning=${entry.tkReasoning} ms=${entry.durationMs}` +
      `${entry.retries ? ` retries=${entry.retries}` : ""}${entry.fallbacks ? ` fallbacks=${entry.fallbacks}` : ""}` +
      `${entry.repairs ? ` repairs=${entry.repairs}` : ""}${entry.ok === false ? ` FAILED=${entry.failure}` : ""}` +
      `${entry.estimatedCostUsd === null ? " cost=unpriced" : ` cost=$${entry.estimatedCostUsd?.toFixed(4)}`}`
  );
}

/** Position marker: pass to llmCostSince() to aggregate only later calls. */
export function llmCostMark(): number {
  return nextId;
}

/** Per-stage aggregates for every call recorded at/after `mark`, plus raw calls. */
export function llmCostSince(mark: number): {
  stages: LlmStageAggregate[];
  totals: Omit<LlmStageAggregate, "stage" | "models" | "roles">;
  callCount: number;
} {
  const relevant = entries.filter((e) => e.id >= mark);
  const byStage = new Map<string, LlmStageAggregate>();
  for (const e of relevant) {
    const agg = byStage.get(e.stage) || {
      stage: e.stage,
      models: [],
      calls: 0,
      tkIn: 0,
      tkOut: 0,
      tkCacheRead: 0,
      tkCacheWrite: 0,
      tkReasoning: 0,
      wallMs: 0,
      roles: [],
      retries: 0,
      fallbacks: 0,
      repairs: 0,
      failures: 0,
      estimatedCostUsd: null,
    };
    if (!agg.models.includes(`${e.provider}/${e.model}`)) agg.models.push(`${e.provider}/${e.model}`);
    if (e.role && !agg.roles.includes(e.role)) agg.roles.push(e.role);
    agg.calls++;
    agg.tkIn += e.tkIn;
    agg.tkOut += e.tkOut;
    agg.tkCacheRead += e.tkCacheRead;
    agg.tkCacheWrite += e.tkCacheWrite;
    agg.tkReasoning += e.tkReasoning;
    agg.wallMs += e.durationMs;
    agg.retries += e.retries || 0;
    agg.fallbacks += e.fallbacks || 0;
    agg.repairs += e.repairs || 0;
    if (e.ok === false) agg.failures++;
    // null stays null until at least one PRICED call lands, so an unpriced
    // stage reports "unpriced" rather than a confident $0.00.
    if (typeof e.estimatedCostUsd === "number") {
      agg.estimatedCostUsd = (agg.estimatedCostUsd ?? 0) + e.estimatedCostUsd;
    }
    byStage.set(e.stage, agg);
  }
  const stages = [...byStage.values()].sort((a, b) => b.tkIn + b.tkOut - (a.tkIn + a.tkOut));
  const totals = stages.reduce(
    (t, s) => ({
      calls: t.calls + s.calls,
      tkIn: t.tkIn + s.tkIn,
      tkOut: t.tkOut + s.tkOut,
      tkCacheRead: t.tkCacheRead + s.tkCacheRead,
      tkCacheWrite: t.tkCacheWrite + s.tkCacheWrite,
      tkReasoning: t.tkReasoning + s.tkReasoning,
      wallMs: t.wallMs + s.wallMs,
      retries: t.retries + s.retries,
      fallbacks: t.fallbacks + s.fallbacks,
      repairs: t.repairs + s.repairs,
      failures: t.failures + s.failures,
      estimatedCostUsd:
        typeof s.estimatedCostUsd === "number"
          ? (t.estimatedCostUsd ?? 0) + s.estimatedCostUsd
          : t.estimatedCostUsd,
    }),
    {
      calls: 0,
      tkIn: 0,
      tkOut: 0,
      tkCacheRead: 0,
      tkCacheWrite: 0,
      tkReasoning: 0,
      wallMs: 0,
      retries: 0,
      fallbacks: 0,
      repairs: 0,
      failures: 0,
      estimatedCostUsd: null as number | null,
    }
  );
  return { stages, totals, callCount: relevant.length };
}
