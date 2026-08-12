# The 43-turn floor — where it comes from and whether it should move

**Analysis only. Nothing in this document has been changed in code.**

Question asked: where did 43 come from, did anything measure it, and what does a
shorter count buy?

Short answer: 43 is derived, not chosen; one of its two inputs is measured and
one is a bare literal that the rest of the repo contradicts; and cutting the turn
count is now worth about **1% of episode output** while costing the exact quality
the pipeline exists to protect. The real defect the analysis turned up points the
other way — episodes may be running ~20% short of their target duration.

---

## 1. 43 is not a constant anywhere

It is arithmetic, evaluated per episode:

```ts
// scriptSevenRolePipeline.ts:265
const totalWordTarget = Math.max(550, Math.round(args.targetDuration * 145));

// scriptCreativePipeline.ts:524
minimumTurnsFor(w) = Math.max(8, Math.ceil(w / ASSUMED_WORDS_PER_TURN))  // 27
```

For the 8-minute default:

| step | value |
|---|---:|
| `targetDuration × 145` | 1,160 words |
| `ceil(1160 / 27)` | **43 turns** |
| soft target `× 0.82` | 951 words |
| hard fail floor `× 0.6` again | 571 words |

So `43 = ceil(8 × 145 / 27)`. Two constants multiply into it, and they are of
very different quality.

---

## 2. One input is measured. The other is a bare literal.

### `ASSUMED_WORDS_PER_TURN = 27` — measured, documented, and caveated

Two full runs on 2026-08-06: 411 words over 15 turns (27.4) and 720 over 27
(26.7), on different models per host. The comment says outright that the previous
value was "a guessed 40" that under-planned by a third. This is real work.

Three limits on it, none of which make it wrong, all of which matter:

1. **It is extrapolated past its data.** Both observations came from runs of 411
   and 720 words. It is applied at 1,160 — about 60% beyond the largest measured
   run.
2. **One of the two data points is a failed run.** The 411-word run "died at the
   word floor". Its words-per-turn is a property of a broken episode.
3. **It is descriptive, used as normative.** 27 is what the writers *produced*
   under the then-current prompt. Feeding it back as a floor is self-confirming:
   plan 43 turns → writers fill 27-word turns → the next measurement says 27.

### `145` words per minute — no provenance, and contradicted twice in-repo

`scriptSevenRolePipeline.ts:265` multiplies by a bare `145`. No comment, no
citation, no test. The repository holds two other values for the same quantity:

| constant | value | provenance |
|---|---:|---|
| `scriptSevenRolePipeline.ts:265` | **145** | none — bare literal |
| `episodeEstimate.ts:11` `WORDS_PER_MINUTE` | **183** | derived and documented: scriptService's 2,200-word budget for a 12-minute target |
| `voiceAuditionScenes.ts:406` | **155** | audition pacing |

The two that matter are 145 and 183, and they are used at opposite ends of the
same product: **145 decides how much script to write; 183 is what the Studio
tells the user the episode will run.** They disagree by 26%.

---

## 3. Did anything measure the floor itself?

No. The 27 was measured; the floor built on it never was.

- `validateTurnPlan` **enforces** `minTurns` — a plan under it is rejected.
- There is **no ceiling**. The architect may plan more than 43 and often should.
- Nothing aggregates realised turn counts across episodes. The seven-role trace
  records the plan for one run; no metric asks "what does the architect actually
  plan, and how does that track episode quality?"

So the floor binds downward and is unobserved upward. Whether 43 is the operative
number in production or merely a formality the architect clears by ten is not
currently knowable from this repository.

---

## 4. What a shorter count actually buys — after the intent bound

This is where the answer changed while the work was in progress.

The turn plan was measured at **24,486 output tokens for one episode — 28% of
that episode's entire model output**, for an artefact that ships zero words. It
is billed twice: once as output when written, then again as *input* to every
host-writer call, on every movement, for both hosts.

That 28% is what made the turn count look like the lever. It was not the turn
count. It was the intents: `turnPlanMaxTokens` records 340 output tokens per
turn — roughly 255 words of prose in a field specified as "the conversational
ACTION".

With the 25-word intent bound now enforced, a turn's JSON is about 33 tokens of
intent plus ~45 for `turnIndex`, `beatIndex`, `speakerName`, `factRefs` and
`targetWords` — call it 80.

| | turns | ≈ output tokens |
|---|---:|---:|
| observed, before the intent bound | ~43 | 24,486 |
| 43 turns, intents bounded | 43 | ~3,400 |
| 31 turns, intents bounded | 31 | ~2,500 |

Cutting the floor from 43 to 31 — by moving `ASSUMED_WORDS_PER_TURN` from 27 to
38 — saves roughly **900 output tokens**, plus its read amplification. Against an
episode measured at 88,042 output tokens, that is about **1%**.

The intent bound already took ~86% of the plan's cost without touching the turn
count. There is no longer a cost argument for cutting the floor.

---

## 5. What a shorter count costs

Fewer turns for the same word target means **longer turns**: 1,160 words over 31
turns is 37 words each, against 27.

That is the failure mode the constant exists to prevent, and the file says so:

> the alternative to more turns is longer turns, and longer turns are how a
> conversation becomes two monologues. Filling eight minutes with fifteen
> speeches is worse than filling it with forty exchanges, even though both hit
> the word count.

It also runs directly against the padding problem. A writer told to produce 27
words lands a point and stops. A writer told to produce 38 for the same content
fills the gap — and filler is where the flat synthetic cadence comes from. Raising
the per-turn target is a padding *instruction*.

**Recommendation: leave the 43-turn floor alone.** It buys ~1% and sells the
texture. If anything is worth revisiting it is the absence of a ceiling, not the
floor.

---

## 6. The finding that does matter, and it is not about cost

If the delivered speech rate is nearer 183 words/minute than 145, then an
8-minute episode is being written to 1,160 words — about **6.3 minutes of
speech** — and its soft floor of 951 words is **5.2 minutes**. The "not blocking"
short-episode warning would be firing on episodes that are short by construction
rather than for want of evidence.

This is a scope defect, not a cost one, and it points toward *more* words rather
than fewer. It is also cheaply measurable, which is the recommended next step:

> For shipped episodes, compare `Episode.durationSeconds` — measured by `ffprobe`
> on the rendered file, so it is real — against the script's spoken word count.
> `durationSeconds` includes beds, stingers and pauses, so it overstates pure
> speech; if the implied rate still comes out above 145, the 145 is wrong and
> every episode is running short.

That query needs production database access, which is Coolify-internal and not
reachable from a development machine.

**Do not change 145 before running it.** Raising the word target raises cost on
every stage at once, and the case for doing so should rest on measured audio
duration, not on the fact that two constants in one repository disagree.
