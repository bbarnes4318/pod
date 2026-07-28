# Show continuity

What turns a hundred disconnected episodes into a season, and — more
importantly — what it refuses to do.

Code: [`src/lib/services/showContinuity.ts`](../src/lib/services/showContinuity.ts)
(pure engine) and
[`showContinuityService.ts`](../src/lib/services/showContinuityService.ts)
(prompt, guards, persistence).

## The rule everything else follows

**The model never invents a continuity value.** It selects from a closed list and
reports what it used; the engine computes the next state. A generator that could
author its own continuity would drift, contradict itself, and re-reveal beats the
audience has already heard.

## The rule this version added

**Nothing is mandatory.** The previous engine required a fixed set of comedy
devices in *every* episode — a crowd figure, a pronoun correction, a name-drop, a
teammate from a bank. That is a checklist, and a checklist produces episodes that
sound assembled rather than lived. Worse, it made the show's memory a scoreboard:
the state existed to count gags, so the only thing that could carry across
episodes was a gag.

Now:

- Every device is **optional**.
- **At most one** device carries real weight in an episode.
- Using **none** is a legitimate, frequently correct outcome, and the prompt says
  so in words rather than leaving the model to infer it.
- The word `required` does not appear in the continuity prompt block, and
  [`npm run test:continuity`](../src/scripts/testShowContinuity.ts) fails if it
  comes back.

## The four devices

### 1. The Red Eye File — LADDER, topic-gated

Cal Mercer's one unresolved career decision: he helped an organization turn its
own failed decision into a story about a player's character. Seven authored
layers, each firing at most once, revealed across a season.

Three independent gates, all of which must pass:

| Gate | Rule |
| :--- | :--- |
| Ladder | Layers fire in order and terminate. Nothing generates an eighth. |
| **Topic** | The episode must genuinely be about scapegoating, leaks, public narratives, or an organization protecting itself. |
| Rate limit | At most 1 in any 4 episodes. |

The topic gate is the difference between continuity and a tic. Without it the
ladder advances on schedule and the confession arrives on top of a story it has
nothing to do with.

> **The material is fictional and composite.** It is never attached to a real
> player, team, or event; never offered as evidence about a current story; and
> never implies Cal has private knowledge about a real person. This is stated in
> his persona, restated in the prompt block, and asserted by
> `npm run test:cast-replacement`.

### 2. The Language Ledger — LOG

Every institutional phrase Cal reaches for ("culture fit", "everybody signed
off"), what he was covering when he said it, and whether a later episode shows
him rejecting or revising it. Zabala may throw one back at him when the current
story is the same kind of story — at most 1 in any 3 episodes.

This is not a gotcha counter. It is the evidence of whether he is changing, and
it is what the public [`/ledger`](../src/app/ledger/page.tsx) page renders.

### 3. Position memory — LOG

What each host actually argued, with a normalized topic key. A prior position may
return **only** when the current subject genuinely overlaps and the callback
advances the conversation. A callback on an unrelated topic is rejected by
`checkContinuity`, because that is a receipt being waved rather than a season
being told.

### 4. Relationship movement — STATE

Trust, disclosures, rationalizations, overreaches, position changes, and one open
interpersonal thread.

**It is never rendered as a number and never spoken.** `describeRelationship`
turns the counters into a sentence a writer can act on. A visible score turns the
show into a game mechanic — the model starts writing toward the meter, and the
audience hears it.

## Two-phase commit

Writing continuity when fact-check passes is too early: a script can clear
fact-check and then die in audio generation, having already burned a Red Eye
layer.

1. **Fact-check passes** → the validated claim is stored on the *episode*.
   Nothing global moves.
2. **The audio exists** → every produced episode's claim is folded, in order, and
   the result is written to `ShowContinuity`.

The fold is the source of truth; the `ShowContinuity` row is a cache of it. That
is what makes a failed generation, a deleted episode, or a bug in the increment
logic recoverable rather than silent permanent damage.

## Kill switch

`CONTINUITY_INJECTION=false` disables injection entirely. With it off — or for a
standalone episode with no podcast — the composed system prompt is
**byte-identical** to the base prompt. A kill switch that alters the prompt is
not a kill switch, and that identity is asserted by the test suite.

## Retired state

The previous engine's columns were archived to `ShowContinuityLegacyDutch` and
dropped; per-episode claims in the retired shape were moved to
`Episode.legacyContinuityUpdate`. **Nothing in the runtime reads either.** They
exist so a rollback restores state instead of losing it, and may be dropped one
release after the recast ships. `npm run test:continuity` asserts that retired
state cannot reach a prompt even if it were somehow present on a state object.

## Tests

```bash
npm run test:continuity
npm run test:cast-replacement
npm run test:cal-dialogue
npm run test:ledger
```
