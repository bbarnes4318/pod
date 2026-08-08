# LLM route policy — nine roles are nine decisions

This show has nine editorial roles. Each one is a separate decision about which
model does that job. This document exists because that stopped being true without
anyone deciding it should.

## What went wrong

Every one of the nine roles was pointed at Anthropic — seven at `claude-opus-5`,
two at `claude-sonnet-5`. Nobody chose that. It is what you get from:

- `LLM_ROUTING_PROFILE` unset, which means the `legacy` profile, under which
  every role collapses onto one of three grouped variables (`LLM_*`,
  `SCRIPT_LLM_*`, `VERIFY_*`); plus
- `SCRIPT_LLM_PROVIDER=anthropic` and `SCRIPT_LLM_MODEL=claude-opus-5`, which
  were set back when there was one script call.

`SCRIPT_LLM_MODEL` was never authorisation to put one model in nine chairs. Two
consequences followed and neither was visible:

1. **Both host writers resolved to the identical endpoint.** Their prompts are
   isolated — neither writer can see the other's private brief — but isolation
   does not create difference. One model given two isolated briefs writes two
   versions of itself, and the hosts converge.
2. **The "independent" editorial judge shared a provider with every writer it
   graded.** The check compared endpoint strings, so `anthropic/claude-sonnet-5`
   grading `anthropic/claude-opus-5` passed. Two models from one lab share
   training data, alignment and blind spots.

The failed canary provided no model-quality evidence for any of this. It never
reached a writing role — it stopped at the first live LLM call on an unfunded
account.

## The rule

| Level | Meaning | Verdict |
|---|---|---|
| `provider` | Judge and writers are different providers | **independent** |
| `model` | Same provider, different model | **not independent** — recorded, and blocked if another provider was credentialed and unused |
| `none` | Same endpoint, or the judge does not resolve | **never acceptable** |

`independent` is true only at provider level. A deployment with one credentialed
provider cannot do better, so it runs with `independence=false` on the record
rather than being blocked — the limitation is in the account, not the
configuration. A deployment that *had* an alternative and did not use it is a
fixable mistake and stops the run before it spends anything.

One implementation, in `src/lib/providers/llm/routingAudit.ts`. The canary's
pre-spend gate and the production-readiness preflight both call it, so "will this
deploy?" and "did this run?" cannot answer differently.

## The nine roles

| Role | Variables |
|---|---|
| Story editor | `SCRIPT_STORY_EDITOR_LLM_PROVIDER` / `_LLM_MODEL` |
| Debate architect | `SCRIPT_DEBATE_ARCHITECT_LLM_PROVIDER` / `_LLM_MODEL` |
| Host A writer | `SCRIPT_HOST_A_WRITER_LLM_PROVIDER` / `_LLM_MODEL` |
| Host B writer | `SCRIPT_HOST_B_WRITER_LLM_PROVIDER` / `_LLM_MODEL` |
| Dialogue director | `SCRIPT_DIALOGUE_DIRECTOR_LLM_PROVIDER` / `_LLM_MODEL` |
| Continuity editor | `SCRIPT_CONTINUITY_EDITOR_LLM_PROVIDER` / `_LLM_MODEL` |
| Fact checker | `FACT_CHECK_LLM_PROVIDER` / `_LLM_MODEL` |
| Cold-open judge | `COLD_OPEN_JUDGE_LLM_PROVIDER` / `_LLM_MODEL` |
| Final editorial judge | `QUALITY_JUDGE_LLM_PROVIDER` / `_LLM_MODEL` |

`cold_open_judge` is new. It picks which of three openings survives; the final
judge grades the finished script. Two different questions, two routes. Unset, it
resolves exactly where the cold-open judge resolved before the role existed, so
declaring it changed nothing.

## Reading the current configuration

```bash
npm run audit:llm-routing
```

Configuration only — resolves no provider, makes no request, spends nothing. It
prints provider and model names; credentials appear as a presence bit and never
as a value, prefix or length. Exit code is non-zero only for a role that resolves
to nothing or a judge grading its own output.

## Cold-open candidates

With two or more **distinct credentialed** writer routes, the three candidates
are written one per route. With one, the original single-call path runs and
nothing changes. `planColdOpenWriterRoutes()` decides; the tournament record
stores `authorship.mode`, which route wrote each candidate, and any candidate a
route failed to produce.

Three openings from one model are three moods. The tournament was built to
compare opinions.

## Changing a route

Promotion comes from stored blind results on our own fixtures — never from a
public benchmark, a release announcement, or one impressive sample.

```bash
npm run eval:models -- --dry-run --candidates <p/m>,<p/m> --judge <p/m>
npm run eval:models -- --candidates <p/m>,<p/m> --judge <p/m>
npm run eval:models -- --decide
```

Ten dimensions, split by how they are known:

- **Deterministic** — host distinctness, factual support, repetition. Computed
  from the script by the same code production uses.
- **Measured** — estimated cost, latency. Read off the cost ledger and the clock.
- **Judged** — story selection, opening strength, spoken naturalness,
  argumentative progression, character consistency. Scored by an LLM judge shown
  anonymised, shuffled candidates with every provider and model token scrubbed
  from the text.

Cost and latency carry **zero weight** in the quality composite. They are
constraints, not quality — a cheap fast model that writes badly must never
out-score a good one on a weighted average — so they gate instead.

The harness refuses to run when the judge shares a provider with a candidate.
`decidePromotion` requires two stored runs on identical fixtures, complete
results, a composite margin above judge noise, no dimension regressing more than
five points, and latency and cost within 1.5× the incumbent. There is no model
name anywhere in `modelEvaluation.ts` — by construction it cannot prefer a
vendor.

`--decide` prints what the evidence supports. Changing a route is still a person
editing a variable.

## Not in scope here

TTS routing is a separate concern. Fish Audio at `s2.1-pro-free` remains the
required production speech provider and ElevenLabs remains an optional adapter —
see `ttsProviderPolicy.ts`. Nothing in LLM routing touches either.
