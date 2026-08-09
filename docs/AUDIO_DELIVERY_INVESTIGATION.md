# Audio delivery investigation — why both hosts sounded like they were reading cold

Date: 2026-08-09. Investigated against production (`podcast.hopwhistle.com`), which
was running `86353652` — the exact tip of `origin/main` at the time.

---

## A0 — Persisted render mode for the last three rendered episodes

Read directly from the production database (read-only, via the documented
worker-container diagnosis path).

| Episode | Created | `ttsRenderMode` | `fallbackReason` | Provider | Model |
|---|---|---|---|---|---|
| `0c90db5b` | 2026-08-09 04:43 | `scene` | *(never persisted — see below)* | fish | `s2.1-pro-free` |
| `e7867729` | 2026-08-02 00:26 | `scene` | *(never persisted)* | fish | `s2.1-pro-free` |
| `330d2eaa` | 2026-07-30 23:46 | `scene` | *(never persisted)* | fish | `s2.1-pro-free` |

Distribution across **all 56 episodes** in the database:

```
scene         15
null          41   (never reached TTS at all)
legacy_line    0
mixed_fallback 0
```

**`legacy_line` and `mixed_fallback` have never occurred in this database, not
once.** Every episode that has ever rendered audio rendered in scene mode, on
Fish, with every scene as a `multi_speaker_scene` render unit — zero
`single_line` fallbacks.

Two secondary findings from the same query:

- **`fallbackReason` is never persisted.** `generateDialogueScenes()` returns it
  on the summary but only writes `ttsRenderMode` to the episode. There is no
  column and no row carrying *why* a mode was chosen. Relevant to B1.
- The prompt's premise that `TTS_RENDER_MODE=auto` lets an episode fall back to
  `legacy_line` is true as written, but `auto` and `scene` behave identically in
  `generateDialogueScenes()` — only the literal string `legacy_line`, or an
  ineligible cast, diverted to the line pipeline. Neither ever happened.

### Which A0b branch this put me on

Branch 2: **the bad episodes were already `scene`.** The audio was performed and
still sounded cold, so the degraded-path work in A0/A1 is correct hardening but
is *not* the cause. I kept going.

---

## A0b.1 — Is the direction reaching the engine?

**No. This is the cause.**

Fish's `/v1/tts` endpoint has **no natural-language `instructions` parameter**.
The complete request body built by `buildFishScenePayload()` is:

```
text, reference_id, format, sample_rate, mp3_bitrate, temperature, top_p,
prosody{speed,volume,normalize_loudness}, chunk_length, normalize, latency,
max_new_tokens, repetition_penalty, min_chunk_length,
condition_on_previous_chunks, early_stop_threshold
```

The **only** channel for performance direction is bracket cue text inlined into
`text`. So whatever `buildPerformanceDirection()` compiles has to survive the
squeeze into that bracket, or it does not reach the engine at all.

It did not survive. `compactFishDeliveryCue()` extracted the direction with:

```js
/Delivery style:\s*(.*?)(?=\s+(?:This is|The disagreement|Mid-conversation|
  Your intensity|When genuinely|Never:)|$)/i
```

Those six lookahead terms are the **exact opening words of the scene shading,
the intensity range, the anger signature and the prohibited traits.** The regex
stopped precisely where the performance direction began. It then kept only the
**first sentence** of what remained.

Everything below was compiled correctly and then discarded before the request:

| Direction component | Reached Fish? |
|---|---|
| Role function ("equal protagonist, never the designated analyst…") | **No** |
| Scene shading (`cold_open` / `argument_escalation` / `closing` …) | **No** |
| Intensity range (baseline → peak) | **No** |
| Anger signature (`slower_quieter` / `louder_slower`) | **No** *(except one accent line per scene)* |
| Prohibited traits ("never … audiobook narration, announcer cadence") | **No** |
| First sentence of the delivery style | Yes |

### Proof from production

`providerMetadata.directionCues` on the 11 selected scene rows of episode
`0c90db5b` — spanning `cold_open`, `argument_escalation`, `argument_resolution`,
`conversation` and `closing`:

```
Mercer  [Low, lightly weathered, close-mic and brisk; blunt dry conversation with one
         person, never polished, analytical, narrated, or announced; speaking to the
         other host, reacting in this moment, never reading]

Zabala  [Fast, flat Northwest Indiana vowels, smoker's edge; speaking to the other
         host, reacting in this moment, never reading]
```

**Byte-identical on every one of the 11 scenes.** The cold open, the peak of the
argument and the goodbye were all rendered under the same cue.

This answers the A2 sub-question directly: scene shading *does* differ inside
`buildPerformanceDirection()`, and is then stripped before the request. Every
scene received identical shading, so **the episode had no dynamic range by
construction.**

### Why one host was worse than the other

Look at the two cues above. The regex kept only the first sentence of each
host's `speakingStyle`, which made the direction a **lottery on sentence order**:

- **Mercer's** style opens on *manner* — "blunt dry conversation with one person,
  never polished, analytical, narrated, or announced". He kept a real, and
  strongly negative, performance instruction.
- **Zabala's** style opens on *timbre* — "Fast, flat Northwest Indiana vowels,
  smoker's edge". That is a description of a **voice**, not of a **performance**.
  She reached the engine with **no delivery instruction whatsoever**, so Fish had
  nothing to perform against and defaulted to a neutral read.

Everything that would have differentiated her — "Starts laughing while she is
still attacking", "Talks over people to interrupt", "Once per fight she drops to
quiet and slow" — sat in sentences 3–7 and was cut.

---

## A0b.2 — Is the scene the right unit?

**Yes.** Utterances per selected scene, from production:

| Episode | Utterances per scene | Histogram | Total lines |
|---|---|---|---|
| `0c90db5b` | 6, 8, 2, 10, 6, 7, 4, 9, 10, 6, 1 | 1×1, 2×1, 4×1, 6×3, 7×1, 8×1, 9×1, 10×2 | 69 |
| `e7867729` | 6, 5, 6, 5, 7, 5, 6, 4, 6, 1, 8, 7 | 1×1, 4×1, 5×3, 6×4, 7×2, 8×1 | 66 |
| `330d2eaa` | 8, 1, 9, 6, 4, 6, 6, 6, 3 | 1×1, 3×1, 4×1, 6×4, 8×1, 9×1 | 49 |

Median ≈ 6 utterances per scene. This is **not** line rendering with extra
steps — the engine has real conversational context to perform against. The
planner is not the problem.

One caveat: each episode contains exactly one 1-utterance scene, always the
`closing`. A single-utterance scene has no conversational context by definition.
Minor, but it is the one place where "scene mode" degenerates to line mode.

---

## A3 — Best-of selection: the prompt's premise is out of date

The brief states there is "no best-of selection on the scene path at all" and
that `FISH_PERFORMANCE_CANDIDATES` is "a dead knob". **Both are incorrect on
current `main`.** There are two nested candidate loops:

**Outer loop** — `candidateCountFor()` in `ttsSceneService.ts`, reading
`TTS_SCENE_CANDIDATES_COLD_OPEN` / `_PEAK` / `_DEFAULT`, all defaulting to 1 and
none set in production. This loop creates one `DialogueSceneAudio` row per
candidate. Production data confirms it runs at 1 (`maxCandIdx=0` on the newest
episode; the higher values on older episodes are retries after failures, not
best-of). **This is the loop that does nothing.**

**Inner loop** — `performanceCandidateCount()` in `fishDialogue.ts`, which
defaults **in code** to **3 for `cold_open` and `argument_escalation`, 2
otherwise**, and is raised by `FISH_PERFORMANCE_CANDIDATES`. This loop is real,
it runs in production, and it selects on a genuine acoustic quality signal
(`analyzeSpokenPerformanceBuffer` — loudness range, pause standard deviation),
discarding candidates that fail and throwing `quality_gate_failed` if none pass.

Measured on episode `0c90db5b`, all 11 scenes: `candidatesRequested=3`,
`candidatesCompleted=3`. Selection was doing real work — scene 5
(`argument_escalation`) scored `52 / 92 / 72` and only one candidate passed;
scene 0 scored `83 / 83 / 38`. Six of the 11 scenes selected a candidate other
than index 0.

So A3 items 1 and 2 are already satisfied *at the Fish adapter*: defaults live
in code, and selection is on a real quality signal. What remains genuinely wrong
is the misleading **outer** knob, which multiplies cost (outer × inner) if anyone
ever raises it believing it is the quality dial. **Not yet fixed — see below.**

---

## What I changed

Commit `a01b4b8`, branch `fix/cold-delivery-scene-direction`.

1. **Scene shading now reaches the engine.** `sceneShadingCue()` emits a compact
   per-scene-type cue once at the head of the scene, deliberately *off* the
   per-host cue budget so it cannot be crowded out by a character cue.
2. **The speaker cue is no longer a first-sentence lottery.** It takes whole
   sentences up to a 210-character budget, so a timbre-first style still carries
   its manner clauses through.
3. **The anger signature is read from the structured profile**, not scraped back
   out of the compiled prose, so it cannot be lost to a regex again.
4. **A5** — added a register clause to Zabala's `speakingStyle`, written for her
   and placed second so it lands inside the cue budget: *"Contractions always,
   endings bitten off, sentences left as fragments when she is moving."* Her
   cadence, intensity and argument patterns are untouched.
5. **A0 hardening** — `scene` is the only production render mode;
   `readRenderModeSetting()` returns it regardless of `TTS_RENDER_MODE`.
   Degraded modes require `TTS_ALLOW_DEGRADED_RENDER_MODES=true` *and* a
   non-production `NODE_ENV`. An ineligible cast, any single-line fallback, and
   any failed scene now throw with a reason instead of shipping partially-cold
   audio. Policy moved to `renderModePolicy.ts` (DB-free, so it is testable —
   `ttsSceneService` imports Prisma, which asserts production env at import).
6. **Test** — `npm run test:render-mode-hardening`, 9 assertions, network-free.
   Asserts no production env can select `legacy_line` or `mixed_fallback`, that
   the Fish request text genuinely differs across `cold_open` /
   `argument_escalation` / `closing`, and that **both** rostered hosts receive
   manner direction rather than timbre alone.

### Before / after, verbatim

Zabala, previously — the entire performance direction she received:

```
[Fast, flat Northwest Indiana vowels, smoker's edge; speaking to the other host,
 reacting in this moment, never reading]
```

Zabala, now, in an `argument_escalation` scene:

```
[the disagreement is building, intensity climbing across the exchange]
[Fast, flat Northwest Indiana vowels, smoker's edge. Contractions always, endings
 bitten off, sentences left as fragments when she is moving. Builds in stacks —
 three short clauses, then a long one that lands; speaking to the other host,
 reacting in this moment, never reading]
```

Mercer, now, same scene — note the anger signature, previously absent:

```
[the disagreement is building, intensity climbing across the exchange]
[Low, lightly weathered, close-mic and brisk; blunt dry conversation with one
 person, never polished, analytical, narrated, or announced. He reacts before he
 explains; angry here means slower, quieter, more precise — never louder;
 speaking to the other host, reacting in this moment, never reading]
```

---

## Not done — stated plainly

**No audio was rendered and no listening comparison was made.** Every A0b
comparison that was supposed to end in files under `docs/audio-comparison/`
is outstanding:

- **A0b.3 (free vs paid Fish model)** — not tested. `docs/FISH_MODEL_DECISION.md`
  remains unverified either way.
- **A0b.4 (Fish vs ElevenLabs)** — not tested. Note for whoever picks this up:
  `ELEVENLABS_API_KEY` is **not actually set** in the local `.env` — it sits
  inside a prose block as `* ELEVENLABS_API_KEY=…`, which dotenv does not parse
  as an assignment. Production may differ.
- **The re-render proving the fix** — not done. The change above is verified by
  unit test and by inspection of the exact strings now sent to Fish; it has
  **not** been confirmed by ear.

### A1 — the two-sources-of-truth hazard is not hypothetical

Read from the production `AiHost` table, and cross-checked against the
`voiceMap` actually used to render episode `0c90db5b`:

| Host | Prod `ttsVoiceId` | `roster.ts` says | Match? |
|---|---|---|---|
| Bernadette Zabala (`fa4ba92d`, slug `bernie-line-two`) | `c176f96ab88b4fb39f74e19165bacbdc` | `c73dbfe6a10249968409a343ea13a37e` | **No** |
| Cal "Red Eye" Mercer (`28ddbd52`) | `36780e7121b84d5c9c24cbd2f15eaaa4` | `PLACEHOLDER_VOICE_ID` | **No** |

Both live hosts are rendering on voices the roster does not declare. The roster
is not the source of truth it presents itself as, and nothing detects the drift.

Two further defects surfaced by the same query:

- **There are two active hosts named "Bernadette Zabala"** — `1ae9a0a6`
  (slug `bernadette-zabala`) and `fa4ba92d` (slug `bernie-line-two`) — both
  active, both pointing at the same voice id. Casting currently disambiguates
  only by the pinned `Episode.hostIds`.
- **`Tom Sloan` is active with `ttsVoiceId = "PLACEHOLDER_USER_VOICE"`**, a
  literal string. It would fail Fish's 32-hex reference-id validation the moment
  he is cast — at render time, after the script is written and paid for. This is
  precisely the failure A1's preflight is meant to move earlier.

Also outstanding from Part A: A1 (single source of truth for voice assignment,
preflight eligibility, boot assertion — note `Cal Mercer's ttsVoiceId` is still
`PLACEHOLDER_VOICE_ID` in the roster, which is an independent and real delivery
defect), A2's hard-error-on-missing-profile, A3's removal of the misleading outer
candidate knob, A4 (QA gate defaults), and A6 (the nine fact-check failures).
Parts B and C are untouched.
