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
  durationMs: number;
  at: string; // ISO timestamp
}

export interface LlmStageAggregate {
  stage: string;
  models: string[];
  calls: number;
  tkIn: number;
  tkOut: number;
  tkCacheRead: number;
  tkCacheWrite: number;
  wallMs: number;
}

const stageStorage = new AsyncLocalStorage<string>();

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

export function recordLlmCall(rec: {
  provider: string;
  model: string;
  tkIn: number;
  tkOut: number;
  tkCacheRead?: number;
  tkCacheWrite?: number;
  durationMs: number;
  stage?: string;
}): void {
  const entry: LlmCallRecord = {
    id: nextId++,
    stage: rec.stage ?? currentLlmStage(),
    provider: rec.provider,
    model: rec.model,
    tkIn: rec.tkIn || 0,
    tkOut: rec.tkOut || 0,
    tkCacheRead: rec.tkCacheRead || 0,
    tkCacheWrite: rec.tkCacheWrite || 0,
    durationMs: Math.round(rec.durationMs),
    at: new Date().toISOString(),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-Math.floor(MAX_ENTRIES / 2));
  console.log(
    `[LLMCost] stage=${entry.stage} provider=${entry.provider} model=${entry.model} ` +
      `in=${entry.tkIn} out=${entry.tkOut} cacheRead=${entry.tkCacheRead} cacheWrite=${entry.tkCacheWrite} ms=${entry.durationMs}`
  );
}

/** Position marker: pass to llmCostSince() to aggregate only later calls. */
export function llmCostMark(): number {
  return nextId;
}

/** Per-stage aggregates for every call recorded at/after `mark`, plus raw calls. */
export function llmCostSince(mark: number): {
  stages: LlmStageAggregate[];
  totals: Omit<LlmStageAggregate, "stage" | "models">;
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
      wallMs: 0,
    };
    if (!agg.models.includes(`${e.provider}/${e.model}`)) agg.models.push(`${e.provider}/${e.model}`);
    agg.calls++;
    agg.tkIn += e.tkIn;
    agg.tkOut += e.tkOut;
    agg.tkCacheRead += e.tkCacheRead;
    agg.tkCacheWrite += e.tkCacheWrite;
    agg.wallMs += e.durationMs;
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
      wallMs: t.wallMs + s.wallMs,
    }),
    { calls: 0, tkIn: 0, tkOut: 0, tkCacheRead: 0, tkCacheWrite: 0, wallMs: 0 }
  );
  return { stages, totals, callCount: relevant.length };
}
