# Coolify environment changes

## Verify before merge — already done, 2026-08-12

**Checked directly against the running worker container** (`xrw61e96a26n3cmhzxglxkf0`),
not inferred from a file. Read back with `docker exec <worker> printenv`:

| Key | Required | Actual | |
|---|---|---|---|
| `SCRIPT_LLM_PROVIDER` | `anthropic` | `anthropic` | ✅ |
| `SCRIPT_LLM_MODEL` | `claude-opus-5` | `claude-opus-5` | ✅ |
| `ANTHROPIC_MODEL` | on the allowlist | `claude-sonnet-5` | ✅ |
| `LLM_ROUTING_PROFILE` | `verified_development` | `verified_development` | ✅ |
| `ANTHROPIC_API_KEY` / `NVIDIA_API_KEY` / `ZAI_API_KEY` | present | all present | ✅ |
| `LLM_PRICE_ANTHROPIC_IN` / `_OUT` | `5` / `25` | **absent** | ❌ §2 |

**The model pins in §1 are already correct in production — there is nothing to
change there.** An earlier draft of this file predicted `SCRIPT_LLM_MODEL` would
read `claude-opus-4-8`, on the strength of `.env.coolify.local` in this repo.
That prediction was wrong: that file is a stale local snapshot and does not
reflect the running worker. §1 is retained below as a record of the required
values, not as an outstanding action.

`ANTHROPIC_MODEL=claude-sonnet-5` is correct and deliberate — it is the
general-purpose model for the cheap structured stages, while `SCRIPT_LLM_MODEL`
puts script writing on Opus 5. The two are a designed pair; see `.env.example`.

**§2 (pricing) is the only outstanding env change.** Its absence is exactly why
every `[LLMCost]` line reads `cost=unpriced`.

> **Scope caveat, still live.** Coolify variables can be saved preview-scoped and
> never reach the production container, which presents exactly like being unset.
> The table above was read from inside the running container, so it reflects what
> the worker actually sees — but when you ADD the §2 pricing variables, confirm
> them the same way rather than trusting the UI.

---


Everything in this file must be applied **by hand in Coolify**. Production env is
not in this repository and no code change in this branch can set any of it.

| App | Coolify UUID |
|---|---|
| `take-machine-web` | `fs2y9ukgyykqq39bptosl7un` |
| `take-machine-worker` | `xrw61e96a26n3cmhzxglxkf0` |

Two standing cautions before applying anything:

- **Deploys are manual.** Pushing to `main` deploys nothing — this repo has no
  webhooks. Env changes take effect on the next manual deploy of each app.
- **Check the scope of every variable you set.** Variables added through the
  Coolify UI can land preview-scoped and never reach production, which presents
  exactly like "the key is missing". Verify through the `/envs` API rather than
  the UI before concluding a variable did not take.

Nothing below changes behaviour on its own except the two model pins in §1.
The price variables are measurement-only, and the two API keys in §3 are
optional.

---

## 1. Model pins — align production with the settled decision

```
SCRIPT_LLM_MODEL=claude-opus-5
ANTHROPIC_MODEL=claude-opus-5
```

**Apply to: BOTH apps.** The worker is the one that matters — it runs script
generation — but the web app resolves the same variables for the Studio preview
paths, and a split between them produces episodes that differ by which service
happened to generate them.

Why, one line each:

- `SCRIPT_LLM_MODEL=claude-opus-5` — Opus 5 writes scripts is this project's
  settled decision, and the local Coolify snapshot (`.env.coolify.local`) instead
  carries `claude-opus-4-8`, an older generation. Same price ($5/$25 per MTok),
  older model.
- `ANTHROPIC_MODEL=claude-opus-5` — the fallback the Anthropic adapter uses when
  no per-call model is given. It has an in-code default of `claude-opus-5` as of
  this branch, so this line only removes the chance of an env value silently
  overriding it with something else.

> **A correction to the task that produced this file.** The hardening audit
> recorded `claude-opus-5` as "not a valid Anthropic API model id" and asked for
> a downgrade to `claude-sonnet-4-6`. That was checked against Anthropic's live
> model catalogue on 2026-08-11 and does not hold: `claude-opus-5` is current and
> served, while `claude-sonnet-4-6` and `claude-opus-4-8` are real but *older*
> generations. There is no 404 to fix. What the audit was right about is that
> nothing was stopping an invalid id from shipping — so the guard was built
> instead (`npm run test:anthropic-model-ids`), and the model was left alone.
> Confirmed with Jimmy before writing this file.

---

## 2. Dollar telemetry — turn `cost=unpriced` into real numbers

Per-1M-token rates. All measurement-only: they change what the `[LLMCost]` log
lines and the per-stage ledger report, and nothing about routing or generation.

### Both apps

```
LLM_PRICE_ANTHROPIC_IN=5
LLM_PRICE_ANTHROPIC_OUT=25
```

- Anthropic's published rate for `claude-opus-5`, the model pinned in §1:
  **$5 / input MTok, $25 / output MTok**. Source:
  <https://platform.claude.com/docs/en/about-claude/models/overview> (read
  2026-08-11).
- Anthropic is the only **paid** rung in the chain, so these are the two numbers
  that actually represent money. Set them on both apps so a cost figure means
  the same thing wherever it was produced.
- If you re-pin `SCRIPT_LLM_MODEL` to a different model, change these with it —
  nothing derives the rate from the model id.

### ~~Worker only — NVIDIA and Z.ai rates~~ DO NOT SET: they do nothing

An earlier draft of this file asked for these four:

```
LLM_PRICE_NVIDIA_IN=0     LLM_PRICE_NVIDIA_OUT=0
LLM_PRICE_ZAI_IN=0        LLM_PRICE_ZAI_OUT=0
```

**They have no effect. Do not bother setting them.** Caught by actually running a
render on 2026-08-12 rather than by reading the code: the NVIDIA and Z.ai
adapters hardcode `unpriced: true` (`nvidia.ts:45`, `zai.ts:43`), and
`estimateCostUsd` returns `null` on that flag *before* it ever looks at a rate.
Every NVIDIA and Z.ai line therefore logs `cost=unpriced` no matter what these
variables say. Observed directly:

```
[LLMCost] stage=script:story-spine role=script_story_editor provider=nvidia
  model=nvidia/nemotron-3-ultra-550b-a55b in=1152 out=1223 ... cost=unpriced
```

— with `LLM_PRICE_NVIDIA_IN=0` and `_OUT=0` both exported in that shell.

That is arguably correct behaviour: a provider-level "we have no price for this"
outranking an operator-supplied rate is defensible for a free trial endpoint. It
is also not what this file previously claimed, and the claim would have had you
setting four variables and then wondering why the log did not change.

**A question for Jimmy, not a blocker:** should an explicitly configured rate
override the provider's `unpriced` flag? Today it does not, and
`test:llm-cost-pricing` asserts the current behaviour deliberately
(*"an unpriced endpoint stays null even with rates configured"*). Changing it
would let free rungs report a measured `$0.0000` instead of an absent
`unpriced` — a real difference when reading a cost summary. Left alone here
because it is a semantics decision, not a bug fix.

**The Anthropic rates above are unaffected** — that provider is `unpriced: false`
and prices correctly.

### Cache rates — deliberately NOT set

`LLM_PRICE_<PROVIDER>_CACHE_READ` and `_CACHE_WRITE` exist and are intentionally
left unset. Unset, they derive from the input rate at Anthropic's published
multipliers — **0.1× for a cache read, 1.25× for a cache write** — which is
correct for Anthropic and a reasonable default elsewhere. Set them explicitly
only for a provider that prices cache tokens on some other basis; an explicit
`0` is honoured as a real zero rather than treated as unset.

This matters more than it looks. The host-writer prompts in this branch were
restructured so the evidence packet caches across a host's movement calls, so
cache-read volume should now be large. Pricing those reads at the input rate
would make a well-cached episode look roughly six times more expensive than it
is — a caching improvement showing up as a cost regression on the dashboard
built to measure it.

---

## 3. Host-B latency experiment — optional, and only if you want it measured

```
MOONSHOT_API_KEY=<key from platform.moonshot.ai>
XAI_API_KEY=<key from console.x.ai>
```

**Apply to: worker only.** Variable names confirmed against
`src/lib/providers/llm/moonshot.ts` and `src/lib/providers/llm/xai.ts`.

Neither key is required for anything in production. They are read by
`npm run test:role-experiments dialogue`, which now offers Moonshot (Kimi K3) and
xAI (Grok) as candidates for `host_b_writer`. Without them the experiment prints
a clear SKIPPED line per candidate and measures the rest normally.

Why it is worth running: `host_b_writer` leads with Mistral Medium 3.5 purely to
keep a second model *family* writing the second host. Mistral measured judge 76
against Z.ai's 79 — a difference small enough to live with — and 536 s per
episode against 143 s. The entire cost of that arrangement is latency, and it is
being paid for a quality gap that is not really there. The obvious replacement,
Kimi K2.6 via NVIDIA, is 404 for this account; these two providers have working
direct integrations and have never been measured on the role.

Optionally also `MOONSHOT_MODEL` / `XAI_MODEL` to pin something other than the
defaults (`kimi-k3`, `grok-4.3`).

**This branch does not change the `host_b_writer` chain.** The experiment writes
`artifacts/role-experiment-dialogue-hostb.json` and stops there; promotion is
Jimmy's call on the judge and latency columns, against the promotion rule already
documented in `profiles.ts`.

---

## Verifying it took

After deploying both apps:

```bash
npm run routing:staleness
```

and, on the next real episode, read the `[LLMCost]` lines in the worker job log:

- every line should end in `cost=$…` rather than `cost=unpriced` — the free rungs
  report `cost=$0.0000`, which is a measurement, not a gap;
- on any Anthropic-served call **after the first** in an episode, `cacheRead`
  should be non-zero. A `cacheRead=0` on every call means the cached prefix is
  being invalidated and the prompt split is not doing its job.
