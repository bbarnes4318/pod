# LLM cost accounting — what a number means before you price anything

Every per-episode cost figure produced before **2026-08-12** was measured with a
ledger that could not tell one job's tokens from another's. This file records
what was wrong, what the corrected accounting is, and which spend is genuinely
not an episode cost at all.

Read this before quoting a per-episode dollar figure.

---

## 1. The defect: a process-wide watermark on a concurrent worker

`llmCostSince(mark)` filtered call records on `id >= mark` and nothing else. That
is "every call the process made since I started" — not "every call *I* made".

The worker runs background jobs concurrently. So any job that read its own cost
was actually reading *the whole worker's* cost for the wall-clock window it
happened to occupy, including unrelated jobs that started and finished inside it.

The bug is invisible in sequential testing. It only appears under interleaving,
which is why `npm run test:llm-cost-job-scoping` interleaves deliberately.

### What it cost us in practice

A `generate:script` JobLog from 2026-08-10 was carrying:

| | input tokens | output tokens |
|---|---:|---:|
| recorded against the episode | 318,598 | 124,211 |
| **actually the episode** (22 calls) | **212,652** | **88,042** |
| belonged to concurrent `generate:research-brief` jobs | 105,946 | 36,169 |

The recorded input was **50% higher than the truth**. That number was carried
into a costing exercise and into a proposed model-tiering decision before anyone
checked which stages were even inside it.

### The fix

`costLedger.ts` now scopes by job id through `AsyncLocalStorage`, the same
mechanism `withLlmStage` already used for stage attribution:

```ts
withLlmJob(jobLog.id, () => generateScriptForEpisode(job.data))
```

Every `LlmCallRecord` is stamped with the ambient job id, and `llmCostSince`
takes an optional `{ jobId }` — defaulting to the ambient one — so a job sees
only its own calls. Three worker handlers are wrapped: `generate:script`,
`factcheck:script`, and the content-asset generator. All five `llmCostSince`
call sites in the worker pass their `jobLog.id` explicitly.

Calls made outside any job keep the old behaviour, so the one-off harnesses and
scripts — which have no job and nothing concurrent — still report correctly.

**Guard:** `npm run test:llm-cost-job-scoping`.

---

## 2. Research spend is not episode spend

The contamination above was not random noise. It was `generate:research-brief`,
and understanding why it is *separate* matters more than subtracting it.

Research briefs are produced by the **topic pipeline**, which runs on its own
schedule against the day's ingested topics. It is not per-episode work:

- It runs whether or not an episode is ever made from those topics.
- One research pass can serve several episodes, or none.
- Its volume tracks the number of *topics ingested*, not episodes produced.

So attributing it to an episode is wrong in both directions — it inflates the
episode and it hides the topic pipeline's own cost, which nobody is watching
because it has never appeared as a line item.

**This is why the "cache the research brief" idea is dead as an episode-level
fix.** It was proposed to cut per-episode cost; the spend it targets is not in
the episode. It may still be worth doing on its own merits as a *topic pipeline*
optimisation, but it must be justified and measured there, against topic volume,
not smuggled into an episode budget.

### Accounting rule

Per-episode cost means the `generate:script` job's own scoped total, plus the
fact-check and content-asset jobs for that episode. Research-brief spend is
reported separately, per topic, and is not part of the episode budget number.

---

## 3. What this invalidates

Any per-episode figure produced before the scoping fix, including figures used
in earlier tiering arguments. They were measured on an unscoped ledger against a
worker running at concurrency 2.

The corrected baseline has to be re-measured on a clean ledger. Until that run
exists, there is no trustworthy per-episode dollar figure in this repository.

---

## 4. Related

- `src/lib/providers/llm/costLedger.ts` — the ledger and its scoping.
- `src/scripts/testLlmCostJobScoping.ts` — the interleaving proof.
- `docs/verification/first-render-checklist.md` — how to read a live render.
