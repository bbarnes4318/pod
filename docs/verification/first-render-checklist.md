# First render on `fix/llm-pipeline-hardening`

The one gate this branch cannot close by itself. Two of its changes — prompt
caching and dollar telemetry — are only observable in a real render against a
live provider, and **both fail quietly**: a cache that never hits still produces
a correct episode, and an unpriced ledger still logs every call. Neither shows up
as an error, so neither is proven until someone runs this.

Nothing here has been run. There are no provider credentials in the environment
this branch was developed in, so every number below is a thing to check, not a
thing that was observed.

---

## The short version — one command

If you only want the caching claim settled:

```bash
npm run verify:cache-proof            # prints the plan and the cost, spends nothing
npm run verify:cache-proof -- --yes   # SPENDS REAL MONEY (~$0.30–$0.80)
```

That runs one episode with **only** the two host-writer roles pinned to Anthropic
— every other role stays on the free chain — captures the log, and pipes it
through the verifier. One command in, pass/fail/inconclusive out. It needs
`ANTHROPIC_API_KEY` (it aborts rather than falling through to a free model), and
`NVIDIA_API_KEY` + `ZAI_API_KEY` so the rest of the episode does not land on the
paid rung. Export `LLM_PRICE_ANTHROPIC_IN=5` and `_OUT=25` first, or the pricing
condition fails for want of a rate.

The rest of this document is the manual version, plus what the output means.

---

## The one thing to decide first

**Under `verified_development`, Anthropic is the PAID BACKUP.** A healthy episode
never reaches it — the free chain (Z.ai, Nemotron, Mistral, GLM-5.2) serves
everything. That is the correct production shape, and it means a normal render
proves *nothing* about caching or pricing, because both only apply to the
Anthropic rung.

So there are two different runs here, and they answer different questions:

| Run | What it proves | What it costs |
|---|---|---|
| **A — normal render** | The chain repairs hold: no dead rungs, continuity roles land first-try. | Free (trial endpoints). |
| **B — Anthropic-pinned host writers** | The prompt-cache split actually caches, and the ledger reports dollars. | Real money — a few cents of Opus 5. |

Run A first. It is free and it catches the routing regressions. Run B only when
you want the caching claim to stop being theoretical.

---

## Run A — normal render

On the worker, with the branch deployed:

```bash
export LLM_ROUTING_PROFILE=verified_development
```

Trigger one episode through the real pipeline (the server-action curl route from
the ops runbook — this is the same path the Studio "create" flow uses; do not use
a stub or a test harness, they will not produce `[LLMCost]` lines from real
providers).

Capture the **worker** log for the whole run — not the web log, which makes no
LLM calls:

```bash
ssh root@178.156.153.87 'docker logs --since 30m $(docker ps -q --filter name=xrw61e96)' > /tmp/render-a.log
```

Then:

```bash
npm run verify:llm-cost-render -- /tmp/render-a.log
```

Expect on run A: conditions 2 and 3 **pass**, conditions 1 and 4
**inconclusive** (no Anthropic calls — which is the healthy shape).

---

## Run B — prove the cache

Pin the host writers to Anthropic for one episode. These are role overrides, so
they change nothing else in the chain:

```bash
export LLM_ROUTING_PROFILE=verified_development
export SCRIPT_HOST_A_WRITER_LLM_PROVIDER=anthropic
export SCRIPT_HOST_A_WRITER_LLM_MODEL=claude-opus-5
export SCRIPT_HOST_B_WRITER_LLM_PROVIDER=anthropic
export SCRIPT_HOST_B_WRITER_LLM_MODEL=claude-opus-5
export LLM_PRICE_ANTHROPIC_IN=5
export LLM_PRICE_ANTHROPIC_OUT=25
```

The host writers are the right role to pin because they are the repeat callers —
roughly six calls per episode, all sharing one static prefix per host. That is
exactly the shape the caching change was built for, and the only place a cache
read can appear.

> Pinning both hosts to one model collapses the two-voices property for this
> episode. That is fine for a verification render and **not** fine for anything
> anyone will listen to. Unset these afterwards.

Render, capture as above to `/tmp/render-b.log`, then:

```bash
npm run verify:llm-cost-render -- /tmp/render-b.log
```

Expect on run B: **all four conditions pass.**

---

## The four conditions

The verifier checks these mechanically so this is repeatable rather than someone
squinting at a few hundred log lines. What each one means:

### 1. `cacheRead` > 0 on every Anthropic call after the first

The whole payoff of the prompt restructure. The first call for a given
`(episode, host)` **writes** the cache; every later call for that host should
**read** it.

- **Pass** — the static block (private brief, spine, evidence packet) is
  byte-identical across the host's movement calls and is being served from cache
  at ~0.1× input price.
- **Fail** — something per-call has got into the static block and the prefix is
  changing every time, so the packet is being re-billed at full price on every
  movement. `npm run test:prompt-cache-stability` asserts byte-identity offline;
  if that passes and this fails, the difference is on the wire, not in the
  builder.
- **Inconclusive** — fewer than two Anthropic calls. Nothing was proven.

### 2. Zero calls to `deepseek-ai/deepseek-v4-pro`

It is marked `broken-in-production` (14–27ms rejections, zero successful
completions, observed 2026-08-10) and should be filtered out of every default
chain. A single line naming it — **including a failed one** — means a stage is
still paying a guaranteed-losing attempt, and the filter or the profile in force
is not what you think it is.

### 3. `continuity_report` and `script_continuity_editor` land first-try

Both had `deepseek-v4-pro` as their PRIMARY, so before this branch every
continuity call started one guaranteed failure down. They now lead with Z.ai
flash and fall back to Nemotron. First-try means `fallbacks=0`, `retries=0`, no
`FAILED=`.

**Continuity is optional and topic-gated in this show**, so an episode that does
not trigger it produces no line at all and the verifier reports *inconclusive*.
To exercise it, render a continuity-eligible topic.

### 4. `cost=` shows dollars, not `unpriced`, on the Anthropic rung

Before this branch the Anthropic adapter never called `estimateCostUsd` at all,
so it logged `cost=unpriced` no matter how the rates were configured. A failure
here after setting `LLM_PRICE_ANTHROPIC_IN` and `_OUT` means only one of the two
is set — they are required together, and one without the other resolves to no
rate rather than to half a rate.

Free rungs (NVIDIA, Z.ai) reporting `cost=$0.0000` are a **measurement**, not a
gap — that is the point of setting their rates to an explicit `0`.

---

## Reading the exit code

| Code | Meaning |
|---|---|
| `0` | All four passed. |
| `1` | Something was **disproven**. Read the failing condition; do not merge past it. |
| `3` | Inconclusive only — nothing failed and nothing was proven. |
| `2` | Bad input: no file, no `[LLMCost]` lines in it (usually the web log instead of the worker's), or a missing `ANTHROPIC_API_KEY`. |

**Exit 3 is not a pass.** A run that could not evaluate a condition has not
verified it, and reporting it as green is how an unproven claim becomes an
assumed one.

---

## What each of the three outcomes actually looks like

So you can tell them apart without reading the code.

### PASS — the cache is working (exit 0)

```
  ✓ cacheRead > 0 on Anthropic calls after the first
      5 of 6 Anthropic calls followed the first, and every one read from cache (41,204 cached tokens total).

  ✓ zero calls to deepseek-ai/deepseek-v4-pro
      The model does not appear in this log at all, so no stage paid a guaranteed-losing attempt on it.

  ✓ continuity_report completes on its new primary at the first attempt
      Served by zai/glm-4.7-flash on the first attempt — no fallback, no retry.

  ✓ cost= shows dollars on the Anthropic rung
      All 6 Anthropic calls priced; total $0.3120.

4 passed, 0 failed, 0 inconclusive
```

The number that matters is **cached tokens total**. Large means the private
brief, spine and evidence packet are being served from cache instead of re-billed
on every movement — the entire point of the restructure.

### FAIL — something is disproven (exit 1)

```
  ✗ cacheRead > 0 on Anthropic calls after the first
      5 of 6 Anthropic calls after the first read NOTHING from cache. The cached prefix is being
      invalidated between calls — something per-call has got into the static block.
      Offending stages: script:host-writer:Zabala, script:host-writer:Mercer.

4 passed, 1 failed, 0 inconclusive
```

Read the named condition and stop. If `test:prompt-cache-stability` passes
offline but this fails, the bytes are right and the difference is on the wire —
check that the provider actually received `cacheableContext` rather than a
concatenated prompt.

### INCONCLUSIVE — nothing was proven (exit 3)

```
  ? cacheRead > 0 on Anthropic calls after the first
      No Anthropic-served calls in this log. Under verified_development, Anthropic is the PAID
      BACKUP and a healthy run never reaches it — so this is the expected shape of a clean render,
      and it means the caching change is UNPROVEN rather than proven.

1 passed, 0 failed, 3 inconclusive

INCONCLUSIVE IS NOT PASS — a condition that could not be evaluated is unproven.
```

This is what a **normal** episode produces, and it is the outcome most likely to
be misread as success. If you see it from `verify:cache-proof` rather than from a
plain render, the pins did not take — check that `ANTHROPIC_API_KEY` is set in
the same shell.

---

## If you only do one thing

Run B, and read the `cacheRead` column of the per-stage summary the verifier
prints. If the host-writer stages show a large cached-token count, the most
expensive change on this branch is doing what it was built to do.
