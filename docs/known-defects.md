# Known defects

Real defects that are understood, reproducible, and deliberately **not fixed**,
each with what it would take to fix it and why that was not done here.

A defect belongs in this file only if it is a genuine product-behaviour problem.
Stale test fixtures do not go here — they get fixed. See the triage note at the
bottom for why that distinction earned its own paragraph.

---

## 1. `buildBody`'s if/else shadows adaptive thinking on Opus 4.6 and Sonnet 4.6

**Status:** latent — no model this repository routes to is affected today.
**File:** `src/lib/providers/llm/anthropic.ts`, `buildBody()`.
**Guard:** `npm run test:anthropic-model-ids` fails if the affected set changes.

### What it is

`buildBody` chooses the model's quality lever with an if/else:

```ts
const mode = anthropicTuningMode(this.model);
if (mode === "sampling") {
  if (options.temperature !== undefined) body.temperature = options.temperature;
} else if (mode === "adaptive-thinking") {
  body.thinking = { type: "adaptive" };
  body.max_tokens = (options.maxTokens || 8192) + headroom;
}
```

The two classifications are not mutually exclusive. A model that is **both**
sampling-capable and adaptive-capable takes the first branch and never reaches
the second, so it gets `temperature` and:

- no `thinking: {type: "adaptive"}`, and
- no `LLM_THINKING_HEADROOM_TOKENS` of `max_tokens` headroom.

Nothing errors. The model simply runs without its main quality lever, and the
only symptom is output that is quietly worse than it should be.

### Who is affected

Exactly two ids on the allowlist, neither of which is routed to by any profile:

| Model | Sampling | Adaptive | Branch taken |
|---|---|---|---|
| `claude-opus-4-6` | yes | yes | `sampling` — **thinking shadowed** |
| `claude-sonnet-4-6` | yes | yes | `sampling` — **thinking shadowed** |

**The script model is not affected.** This was the specific worry that prompted
the investigation, and it does not hold: `claude-opus-5` rejects sampling params,
so `anthropicTuningMode()` returns `adaptive-thinking`, the else-branch runs, and
thinking **is** enabled with headroom. The same is true of `claude-sonnet-5`,
`claude-fable-5`, `claude-opus-4-8` and `claude-opus-4-7`.

So this is a trap for whoever next pins `SCRIPT_LLM_MODEL` to a 4.6-generation
id, not a live regression.

### Reproduction

```bash
npm run test:anthropic-model-ids
```

The check named *"exactly the 4.6 pair is shadowed by the if/else, and nothing
newer"* asserts the affected set is exactly `claude-opus-4-6, claude-sonnet-4-6`.
It fails the moment a current model joins them — which is the case that would
matter.

Directly:

```ts
import { anthropicTuningMode } from "@/lib/providers/llm/anthropic";
anthropicTuningMode("claude-sonnet-4-6"); // "sampling"  — thinking never sent
anthropicTuningMode("claude-opus-5");     // "adaptive-thinking"
```

### The fix, and why it is not here

Make the two checks independent rather than exclusive:

```ts
if (anthropicSupportsSampling(this.model) && options.temperature !== undefined) {
  body.temperature = options.temperature;
}
if (anthropicSupportsAdaptiveThinking(this.model)) {
  body.thinking = { type: "adaptive" };
  body.max_tokens = (options.maxTokens || 8192) + headroom;
}
```

Not landed here for three reasons:

1. **It changes what is sent to a model.** Enabling thinking raises `max_tokens`
   by the headroom and changes output character. That is a behaviour change to
   generation, and this branch is hardening — the two should not arrive together
   where one can be blamed for the other.
2. **Nothing is currently affected**, so the change carries risk and no benefit
   until someone pins a 4.6 model.
3. **The headroom interaction needs its own thought.** Thinking tokens count
   against `max_tokens`, and the in-file history is explicit about what happens
   without room: *"the v11 outline call died at exactly its 8000 cap and forced
   the single-shot fallback"*. Turning thinking on for a model whose callers
   sized `maxTokens` on the assumption it was off is precisely how that
   truncation returns.

If a 4.6 model is ever pinned deliberately, do the fix and the headroom review
together, and re-render before trusting it.

---

## Triage note: the 16 failures that were not defects

`test:llm-routing` and `test:seven-role-pipeline` carried 16 failures that
predated this work. None of them were product defects. All 16 were **stale test
fixtures** — the product moved and the fakes did not:

- 14 in `test:seven-role-pipeline`, all one root cause: the stub architect's
  turn plan was a perfect metronome (12 of 13 speaker runs exactly two turns),
  which a later validator correctly rejects. The architect failed, every
  downstream role was skipped, and 14 tests reported a cascade instead of the
  thing each was written to check.
- 2 in `test:llm-routing`: one hardcoded a model that had since been pulled from
  the chains; the other used a fake that modelled **two** call kinds while the
  pipeline had grown to **seven** (outline, private agendas, cold-open write,
  cold-open judge, movement, movement repair, character pass).

They are fixed rather than recorded here, because a stale fixture is not a
defect — it is a test that stopped testing. The reason it is worth writing down
at all: a suite that fails 14 times on every run stops being read, and the one
real signal in it goes unnoticed. In this case the cascade was hiding a genuine
weakening of the host-isolation guarantee, which only became visible once the
other 13 were cleared.
