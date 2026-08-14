# Option (a) — Opus 5 on the writers, everything else off Opus

Priced against the **measured** token counts from episode `ade82ba1`
(`generate:script`, 22 calls, scoped ledger), not against estimates.
Anthropic list rates: Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5 per MTok;
cache write 1.25x input, cache read 0.1x input.

Baseline for comparison: **$2.3363** — that run, all Anthropic roles on Opus 5.

---

## Blocker fixed first: rates were per PROVIDER, not per model

Production ran `LLM_PRICE_ANTHROPIC_IN=5 / _OUT=25` — Opus 5's rates — applied to
**every** Anthropic call, because `rateFor()` keyed on the provider alone.

That is invisible while one model serves every role, and it breaks precisely
when you do what this document proposes. A Haiku 4.5 call would have been priced
at 5x its true input rate and 5x its true output rate; the ledger would have
reported the tiering change as barely cheaper than doing nothing, and the
decision made from that number would have been backwards.

`LLM_PRICE_<PROVIDER>_<MODEL>_<FIELD>` now wins where set, with the provider-wide
key as fallback. Guard: `npm run test:per-model-pricing`.

**Set the model rates below or the next measurement is not trustworthy.**

---

## The costed chain

| stage | model | in | out | cacheR | cacheW | cost |
|---|---|---:|---:|---:|---:|---:|
| host-writer (host A) | **opus-5** | 9,664 | 14,144 | 36,110 | 18,055 | **$0.5328** |
| host-writer (host B) | **opus-5** | 20,020 | 5,151 | 36,038 | 18,019 | **$0.3595** |
| selfverify-rewrite | haiku-4.5 | 71,706 | 1,651 | 15,020 | 7,510 | $0.0909 |
| turn-plan | haiku-4.5 | 16,191 | 5,479 | 0 | 3,293 | $0.0469 |
| outline | haiku-4.5 | 13,886 | 3,744 | 0 | 3,212 | $0.0358 |
| private-agendas | haiku-4.5 | 14,736 | 2,253 | 0 | 3,312 | $0.0293 |
| dialogue-director | haiku-4.5 | 6,582 | 3,137 | 0 | 3,536 | $0.0258 |
| selfverify-semantic | haiku-4.5 | 11,371 | 3,189 | 0 | 0 | $0.0273 |
| cold-open ×2 | haiku-4.5 | 762 | 1,952 | 0 | 37,012 | $0.0475 |
| cold-open consequence | haiku-4.5 | 11,399 | 443 | 192 | 0 | $0.0136 |
| story-spine | haiku-4.5 | 9,635 | 364 | 192 | 0 | $0.0114 |
| quality judge | haiku-4.5 | 6,528 | 2,648 | 0 | 0 | $0.0197 |
| cold-open judge | haiku-4.5 | 1,914 | 1,791 | 0 | 0 | $0.0109 |
| continuity editor | haiku-4.5 | 6,914 | 1,182 | 0 | 0 | $0.0128 |

**Writers $0.8923 + everything else $0.3719 = ~$1.26 per episode.**

Against the $2.3363 baseline that is a **46% cut**, and it lands just above the
~$1.20 target. Three variants, so the tradeoff is explicit:

| configuration | per episode |
|---|---:|
| Opus writers, Haiku everything else (incl. cold open) | **$1.26** |
| Opus writers **and** Opus cold-open tournament, Haiku rest | $1.50 |
| Opus writers, **Sonnet 5** everything else | $2.16 |

Sonnet-everywhere-else barely moves the number — the saving in option (a) comes
from Haiku specifically. Keeping the cold open on Opus costs $0.24, because the
tournament writes three candidates and two are discarded (the WordFlow
"selection" row).

---

## What is genuinely at risk

**The writers are not the expensive part of the non-writer set — `selfverify-rewrite`
is.** It carries 71,706 input tokens to change 1,651 tokens of prose, because it
re-sends the transcript for the antithesis and conversation-repair passes. On
Haiku that is $0.09; it was $0.45 on Opus. If quality holds, this single move is
a third of the total saving.

**The debate architect is the untested risk.** It owns outline, private agendas
and the turn plan — structural reasoning, not transcription — and Haiku 4.5 is a
much smaller model than has ever run it. If episode structure degrades, escalate
just that role to Sonnet 5 (+$0.23/episode, total $1.49) before touching
anything else.

**Haiku 4.5's prompt-cache minimum is 4,096 tokens**, against 1,024 on Sonnet 5
and 512 on Opus 5. Four of the migrated stages write 3.2–3.5K-token cache blocks,
which is *below* Haiku's minimum — those blocks will silently stop caching. The
costs above already assume no caching on them (they are billed as plain input),
so the number does not depend on caching that will not happen.

**Judges still do not share a model with the writers.** Writers on Opus 5,
quality and cold-open judges on Haiku 4.5. The constraint holds.

---

## Env changes

Set on **both** apps (web + worker). Env changes only reach containers on the
next deploy.

```
# --- per-model rates: REQUIRED, or the ledger prices Haiku as Opus ---
LLM_PRICE_ANTHROPIC_CLAUDE_OPUS_5_IN=5
LLM_PRICE_ANTHROPIC_CLAUDE_OPUS_5_OUT=25
LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN=1
LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_OUT=5
LLM_PRICE_ANTHROPIC_CLAUDE_SONNET_5_IN=3
LLM_PRICE_ANTHROPIC_CLAUDE_SONNET_5_OUT=15

# --- writers STAY on Opus 5 (unchanged) ---
SCRIPT_HOST_A_WRITER_LLM_PROVIDER=anthropic
SCRIPT_HOST_A_WRITER_LLM_MODEL=claude-opus-5
SCRIPT_HOST_B_WRITER_LLM_PROVIDER=anthropic
SCRIPT_HOST_B_WRITER_LLM_MODEL=claude-opus-5

# --- every other role moves off Opus, and off the free tiers ---
SCRIPT_DEBATE_ARCHITECT_LLM_PROVIDER=anthropic
SCRIPT_DEBATE_ARCHITECT_LLM_MODEL=claude-haiku-4-5
SCRIPT_DIALOGUE_DIRECTOR_LLM_PROVIDER=anthropic
SCRIPT_DIALOGUE_DIRECTOR_LLM_MODEL=claude-haiku-4-5
SCRIPT_MOVEMENT_LLM_PROVIDER=anthropic
SCRIPT_MOVEMENT_LLM_MODEL=claude-haiku-4-5
SCRIPT_REWRITE_LLM_PROVIDER=anthropic
SCRIPT_REWRITE_LLM_MODEL=claude-haiku-4-5
SCRIPT_STORY_EDITOR_LLM_PROVIDER=anthropic
SCRIPT_STORY_EDITOR_LLM_MODEL=claude-haiku-4-5
SCRIPT_CONTINUITY_EDITOR_LLM_PROVIDER=anthropic
SCRIPT_CONTINUITY_EDITOR_LLM_MODEL=claude-haiku-4-5
QUALITY_JUDGE_LLM_PROVIDER=anthropic
QUALITY_JUDGE_LLM_MODEL=claude-haiku-4-5
COLD_OPEN_JUDGE_LLM_PROVIDER=anthropic
COLD_OPEN_JUDGE_LLM_MODEL=claude-haiku-4-5
FACT_CHECK_LLM_PROVIDER=anthropic
FACT_CHECK_LLM_MODEL=claude-haiku-4-5

# --- the group fallback: anything unlisted lands on Haiku, never Opus ---
SCRIPT_LLM_PROVIDER=anthropic
SCRIPT_LLM_MODEL=claude-haiku-4-5
```

`SCRIPT_LLM_MODEL` is the rung-5 group fallback. Leaving it on `claude-opus-5`
would silently put any unlisted role back on Opus, which is how a tiering change
quietly fails to take effect.

### Escalation path, if quality drops

Change **only** the architect and re-measure before touching anything else:

```
SCRIPT_DEBATE_ARCHITECT_LLM_MODEL=claude-sonnet-5
```

---

## Verify after the deploy

1. `docker exec <worker> printenv | grep -E "_LLM_MODEL|LLM_PRICE"` — confirm the
   values actually reached the container (UI-entered vars can land preview-scoped
   and never ship).
2. Run one episode; read the `[LLMCost]` lines. Every non-writer Anthropic stage
   must name `claude-haiku-4-5`, and its cost must be roughly a fifth of the
   equivalent line in this document's baseline column.
3. `npm run measure:delivered-duration` — the tiering change must not move the
   duration numbers. If it does, the architect is planning shorter episodes and
   that is the signal to escalate it to Sonnet 5.
