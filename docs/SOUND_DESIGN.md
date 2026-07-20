# Sound Design (Post-Production Layer)

The stage between TTS generation and the final master. Instead of splicing
voice clips end to end, the stitcher renders a multi-track timeline: theme
music, stingers on topic changes, reaction SFX on emotional beats, and a
music bed sidechain-ducked under speech. Voice is the anchor — everything
else sits under it.

## Production styles (per episode, or show default)

| Style | What's mixed in |
| --- | --- |
| `clean` | Dialogue only — the legacy render. |
| `light` | Intro/outro themes + stingers on **topic** breaks. |
| `full`  | Themes + stingers on topic **and** segment breaks + reaction SFX + ducked music bed. |

SFX density (`subtle` / `medium` / `hype`) controls reaction frequency:
minimum spacing 45s / 25s / 12s, placement probability 0.4 / 0.6 / 0.85, and
air horns are hype-only. Placement is driven by the script's existing
per-line `tone`/`energy` metadata (amused → laugh/rimshot, heated+high →
crowd/impact/airhorn, dismissive+high → buzzer) — reactions land on peaks,
never wallpaper. Deterministic PRNG: same script + settings = same mix.

Resolution order for style/density: stitch-trigger option →
`Episode.soundDesign` → `SoundDesignConfig` default → `clean`. The values
used are pinned back onto `Episode.soundDesign` after a successful render.

## Where things live

- **Engine**: `src/lib/audio/soundDesign.ts` (placement planners,
  sidechain bed mix, timeline shifting) + `soundDesignShared.ts`
  (client-safe vocabulary). Integrated in
  `src/lib/services/audioStitchingService.ts`.
- **Asset library**: `AudioAsset` table, S3-backed
  (`sound-design/uploads/…`, `sound-design/seed/…`), managed at
  `/admin/sound-design`. Kinds: `theme_intro`, `theme_outro`, `stinger`,
  `bed`, `sfx` (categorized: laugh/crowd/airhorn/buzzer/rimshot/whoosh/
  impact), `highlight`.
- **Show config**: `SoundDesignConfig` singleton — which assets are the
  show's intro/outro/bed/stinger set + default style/density.
- **Per-episode**: `Episode.soundDesign` JSON
  `{ style, sfxDensity, highlights: [{lineIndex, assetId}] }`, set in the
  admin episode builder and the Final Audio console.

## Licensing rules (enforced)

- Every asset stores `license` (required at upload) and optional
  `licenseNote`. No license → upload rejected.
- The **starter sports pack** (12 assets) is synthesized from scratch with
  ffmpeg oscillators/noise by `src/lib/audio/soundPackGenerator.ts` — 100%
  original, zero third-party rights. Seed/reseed from `/admin/sound-design`.
- **Laughter is never faked**: it can't be synthesized credibly, so the
  `laugh` category stays empty until a licensed laugh pack is uploaded.
  The reaction planner simply skips categories with no assets.
- **Game highlights are rights-gated**: `kind=highlight` uploads require an
  explicit rights affirmation (`rightsConfirmed`); unconfirmed clips are
  never mixed into an episode, and the UI warns against pulling broadcast
  audio from the open web. Placement: Final Audio console → "Game
  Highlights" → clip plays right after the chosen script line (the timeline
  shifts to make room).

## The mix chain

1. Dialogue clips standardized to −18 LUFS, placed on a conversational
   timeline (variable gaps, jitter, interruption overlaps). Break gaps widen
   automatically to fit the longest configured stinger.
2. Stingers end ~150ms before the next speaker starts; reactions land just
   before a line's tail ends (−11…−15dB under voice by density).
3. Foreground rendered in one ffmpeg graph (room tone, stereo seating,
   micro-fades, glue compression).
4. Bed (full style): looped/trimmed, −12dB (env `AUDIO_BED_GAIN_DB`), faded,
   then `sidechaincompress` keyed by the foreground (ratio 10, attack 150ms,
   release 750ms) → ~10-12dB duck under speech, swells back in gaps.
5. Master: two-pass linear loudnorm to −16 LUFS (env-tunable), same as
   before.

The stitch job log's `output.soundDesign` records exactly what was mixed:
style, density, assets used, every reaction (line, asset, reason), and every
highlight — the audit trail for "why is there an air horn at 12:40".

## ProductionPlan (episode-aware cue sheets, flag-gated)

`SOUND_DESIGN_PLANNER=true` (default **off**) switches `light`/`full`
renders from the legacy placement path (fixed tone→SFX mapping + `i % n`
stinger rotation) to a per-episode **ProductionPlan** generated *before*
rendering:

- `src/lib/audio/productionPlanner.ts` reads the script's own signal —
  smoothed energy arc + peaks, segment structure (cold opens, topic turns),
  tones, interruptions — and picks cues by **weighted selection** over the
  whole active asset library, not first-available. **Silence is a
  first-class cue**: strong beats deliberately held back get an explicit
  `silence` cue with a reason, so the cue sheet documents restraint.
- **Anti-repetition**: the `SoundCueUsage` table records what every rendered
  episode consumed. At plan time the planner reads the last N episodes
  (`SOUND_DESIGN_COOLDOWN_EPISODES`, default 2) and **substitutes, never
  starves**: whether a slot fires is decided pool-size-independently
  (restraint weights), then WHICH asset plays is a least-recently-used pick
  over assets outside the window. Cooldown silence happens only on true pool
  exhaustion (every eligible asset ran within the window) and says so
  explicitly, distinct from budget-spent ("every stinger already used this
  episode") and from arc-driven restraint holds. Reaction SFX are
  soft-penalized, and per-episode max-uses are enforced
  (`SOUND_DESIGN_MAX_STINGER_USES`=1, `SOUND_DESIGN_MAX_SFX_USES`=2).
- The renderer **executes** the plan (`src/lib/audio/planExecution.ts`) with
  the exact timing conventions above; it stops inventing placements. The
  full plan is persisted in the stitch job log (`output.productionPlan`)
  and is byte-reproducible from inputs (seed = episodeId+scriptId hash).
- No stinger/reaction cue on the opening line unless the script opens with
  a `cold_open` segment. Flag off: nothing changes — the legacy path runs
  verbatim, no plan is generated, no usage is recorded.

Tests: `npm run test:sound-design` (legacy planner rules + measured ducking
proof), `npm run test:sound-pack` (synthesizes and validates the starter
pack), and `npm run test:production-planner` (plan generation, determinism,
cooldown, silence, opening-line rule, plan execution).

`npm run demo:sound-variety` is the acceptance harness: it renders the four
fixture episodes (`src/scripts/fixtures/varietyEpisodes/` — blowout /
rivalry / betting-line / injury-news) before (legacy) and after (planner)
with a cooldown ledger threaded across the run, writes cue sheets +
`variety-report.json` + mp3 renders to `samples/planner-variety/`, and
asserts the cue sheets measurably differ, cooldown suppressed repeats, hot
scripts out-cue calm ones, and plans replay deterministically.

## Prompt 6 addendum — ownership, frozen profiles, and render isolation

The sections above describe the mix engine. Ownership and selection now follow
`docs/AUDIO_ASSET_ARCHITECTURE.md`:

- `AudioAsset` is scoped (`shared_system` / `owner_private` / `podcast_private`
  / `legacy_global`) and immutable once ready; the singleton
  `SoundDesignConfig` is ONLY the shared **system default profile**, not a
  per-show configuration.
- A show's sound lives on `PodcastProductionConfig` (+ normalized
  `PodcastSoundAssignment` rows) and is FROZEN into each Episode's
  configuration snapshot (v2) at creation. The planner catalog and the
  renderer's asset set are exactly that frozen pool — reaction SFX included.
  Legacy episodes (no v2 snapshot) use a scope-guarded system-side pool.
- Cue cooldown is podcast-scoped by default (`cooldownScope = "owner"`
  widens to one owner's shows); another customer's usage never affects a
  show's rotation.
- Every render records an `EpisodeAudioRender` version with the executed plan
  plus per-asset `SoundCueUsage` rows (owner/podcast scope, content hash,
  gain/fades, selection source). Re-render modes: `remix_episode_profile`
  (default), `remix_current_podcast` (explicit), `reproduce` (stored plan,
  hash-verified).
- Asset downloads are bounded and sha256-verified; env `AUDIO_INTRO_URL` /
  `AUDIO_OUTRO_URL` fallbacks apply to LEGACY episodes only and are never
  logged as URLs.

## Prompt 7.5 (PR 1) — snapshot compatibility, audible bookends, diagnostics

Three correctness guarantees sit on top of the mix engine:

- **Canonical frozen-profile resolver.** `resolveSnapshotSoundProfile()` in
  `src/lib/services/episodeConfigurationSnapshot.ts` is the ONE place that reads
  a frozen sound profile off an episode snapshot. It keys on the SHAPE of
  `production.soundProfile`, never on the version number, so every
  profile-bearing version (v2, v3, and any future version) resolves identically
  — v1 and profile-less snapshots return "none" (legacy path), and a snapshot
  that carries a *structurally invalid* profile returns "corrupt" so the render
  fails honestly instead of silently falling back to the legacy global pool.
  (This replaced a `snap.version !== 2` check that dropped every post-Prompt-7
  v3 episode's identity.) The resolver is read-only — snapshot bytes and
  fingerprints for v1/v2/v3 are unchanged.
- **Frozen bookend intent (snapshot v4).** The frozen sound profile now carries
  EXPLICIT `introEnabled` / `outroEnabled` booleans, frozen at episode creation.
  This removes the v2/v3 ambiguity where "outro intentionally disabled" and
  "outro enabled but no asset assigned" both froze as `outro: null,
  excluded: []`. Rendering reads the FROZEN intent from the episode snapshot —
  never the podcast's current configuration — so a later podcast edit can never
  change a historical episode's requirements. v2/v3 profiles carry no explicit
  intent and keep the documented compatibility behavior (requirement inferred
  from the resolved asset / exclusion; never fabricated).
- **Three levels of enforcement for enabled bookends:**
  1. *Configuration save* (`savePodcastSoundProfile`): a CUSTOM profile that
     enables an intro/outro must assign a valid one, else a structured
     `bookend_enabled_without_asset` error (no partial write; concurrency
     intact). Disabled bookends need no assignment.
  2. *Snapshot creation* (`assertFrozenBookendIntent`, called from
     `buildEpisodeConfigurationSnapshot`): refuses to freeze a v4 profile whose
     intent says enabled but carries neither a resolved asset nor a structured
     exclusion — never silently converts enabled to disabled.
  3. *Render-time defense* (`verifyBookends` + `resolveBookendRequirement`):
     the final gate. For a non-clean episode, a REQUIRED bookend must be
     resolved, planned, loaded, executed, AND measurably audible. A required
     bookend that vanished at ANY stage — profile resolution, the theme genre
     gate, plan creation, asset loading, timeline execution, or mastering
     (silent/clipped/truncated) — FAILS the render with a stage-specific safe
     reason. On failure the prior master stays active, no failed output is
     promoted, the episode's prior status is restored, and no failed cue is
     recorded as usage. Requirement is decided by frozen v4 intent (enabled =>
     required even with no asset; disabled => not required); v2/v3 fall back to
     the resolved-asset/exclusion inference; the legacy/system path treats an
     enabled non-clean bookend with nothing configured as required. Disabled and
     clean bookends are skipped, not failed.
- **Safe render diagnostics.** `buildRenderDiagnostics()`
  (`src/lib/audio/renderDiagnostics.ts`) writes a safe cue-sheet report to
  `EpisodeAudioRender.diagnostics` (additive nullable column) on both success
  and failure: snapshot version, sound-profile mode, seed, per-cue selection
  reasons + musical fit, executed placement, cooldown result, skipped cues with
  safe reasons, speech-end / master-duration / outro-tail, and the bookend
  result. Names and asset ids only — every free-text field is scrubbed of
  URLs/keys/tokens as defense in depth.

## PR 2 — sonic identity, cue families, variant pools, deterministic selection

Different shows must not draw from one house identity. PR 2 gives each podcast a
coherent, recognizable sonic identity with controlled creative variation, frozen
per episode.

- **Sonic identity** (`src/lib/audio/sonicIdentity.ts`, stored as validated JSON
  on `PodcastProductionConfig.sonicIdentity`). A versioned, producer-declared
  identity: `primaryGenre`/`secondaryGenres`/`moods`, `pace`, `intensity`,
  `broadcastStyle`, allowed & prohibited **cue families**, allowed & prohibited
  **format ids**, humor/crowd/under-speech toggles, `transitionFrequency`,
  `maximumEffectsIntensity`, `bedPolicy`, `voiceOverMusicPolicy`, and min/max
  music-gap bounds. Validated enums + bounded values (never free-text-only). The
  permissive `DEFAULT_SONIC_IDENTITY` means an existing show behaves exactly as
  before. This is the producer's declared creative intent for THEIR show — it
  never fabricates facts about third-party assets.
- **Cue families** are a creative PURPOSE, not an asset kind: intro
  (`brand_main`…`brand_minimal`), outro (`close_main`…`close_documentary`),
  transition (`hard_hit`, `score_update`, `comedy_button`, …), reaction
  (`crowd_positive`, `ticker`, `comedy`, …), bed (`sports_drive`,
  `newsroom_clean`, …). A family is valid only for a compatible role
  (`isCueFamilyValidForRole`); the identity may prohibit families
  (`cueFamilyAllowedByIdentity`) — e.g. a news identity forbids comedy/arena, a
  documentary forbids `hard_hit`/`score_update`/`crowd_positive`.
- **Variant pools** replace singleton bookends. Every role (intro/outro/bed/
  transition/reaction) is a POOL of weighted, ordered `PodcastSoundAssignment`
  variants — each with a cue family, bounded `weight` [0,100], `isBrandedMotif`,
  `maxUsesPerEpisode`, `minEpisodeCooldown`, and optional per-assignment format
  allow/deny lists. The old "one enabled intro/outro/bed per podcast" index is
  dropped. Backward compatible: an existing single intro/outro/bed becomes a
  one-item pool; existing stinger/reaction pools keep order at default weight 1.
- **Deterministic selection** (`src/lib/audio/variantSelection.ts`).
  `selectEpisodeSoundVariants(permitted, {seed, formatId, identity})` chooses the
  EXACT intro/outro/bed for an episode from the permitted pools using a seeded
  mulberry32 stream (FNV-1a seed — the same PRNG family as the production
  planner): format + identity compatible, weight-biased, the outro prefers the
  intro's matching brand family and avoids the same file, `bedPolicy: none`
  yields no bed. No `Math.random`, no wall-clock. Identical inputs → identical
  selection; distinct seeds → coherent variety. It records `selectionSeed`,
  per-slot `selectionReasons`, and any format/identity `excluded` entries. Weight
  and identity/format/rights/scope/archive/readiness/role are all respected —
  weight never bypasses a gate.
- **Snapshot v5** freezes the selection. `buildEpisodeConfigurationSnapshot`
  takes an optional `soundSeed`; when present it selects + freezes the exact
  intro/outro/bed variant plus the permitted variant pools, the sonic identity,
  and selection reasons into the episode snapshot. Creation paths pass a CSPRNG
  `randomUUID()` seed (frozen into the snapshot ⇒ reproducible; distinct per
  episode). Rendering reads the frozen selection; a later podcast sound edit
  never changes a v5 episode. **v1–v4 remain readable and byte/fingerprint
  stable** — the new fields live only inside newly frozen v5 profiles (golden
  hashes v1 `ae7a53…`, v2 `ad246f…`, v3 `04fc4d…`, v4 `f2bb91…`).
- **Sound & Branding UI** (`/app/podcasts/[id]/sound`): configure the identity;
  build/reorder/weight variant pools per role with cue families, branded-motif,
  and format restrictions; blocking validation errors; and a deterministic
  **Preview Resolution** (owner-gated) that shows three example future-episode
  resolutions — selected intro/outro/bed, permitted families, exclusions, reasons
  — WITHOUT creating episodes or generating audio. No storage URLs/keys reach the
  page (previews use the authorized route).
- **Asset cue metadata** (`src/lib/audio/cueMetadata.ts`; `AudioAsset.cueMetadata`
  + `metadataState`). Admin-reviewed cue metadata is authoritative for HARD
  compatibility decisions ONLY when `metadataState === "verified"`; `suggested`
  is displayed but never silently trusted; `unclassified` carries none. No
  automated musical-analysis infrastructure is built here — a human verifies.

**Deferred:** the post-TTS actual-speech timing engine and final cue placement
rewrite are **PR 3**; the full within/cross-episode anti-repetition + diversity
engine and the listening acceptance suite are **PR 4**. PR 2 provides the data
model + deterministic frozen-pool foundation those consume.

### PR 2 review corrections

- **System-default variant pools are real** (not single-item). Administrators
  configure weighted, ordered variant pools per role via
  `SystemSoundAssignment` (tied to the singleton `SoundDesignConfig`, managed in
  the protected Admin Sound Design console). `resolveSystemDefaultSoundProfile`
  builds those pools — respecting rights/readiness/archive/supersession,
  shared_system-only, role/kind — freezes the selected intro/outro/bed +
  permitted transition/reaction pools, and records named exclusions. The legacy
  singleton `themeIntro/themeOutro/bed/stingerAssetIds` slots remain a one-item
  compatibility fallback, so existing installs keep their sound. No classification
  is fabricated: the system default carries the permissive identity and any
  admin-added variants; hard format/identity claims require **verified** cue
  metadata.
- **Save actions clear the persistent player bar.** The Sound & Branding and
  Admin system-pool Save/Preview buttons live in a sticky action footer whose
  bottom offset accounts for the fixed player bar and the mobile safe-area
  inset, so they are genuinely clickable by mouse and keyboard on every viewport
  (proven by ordinary Playwright `.click()` — no `force`/`dispatchEvent`).
- **Admin cue-metadata editor** (protected): per shared-system asset, set the
  cue family (role-scoped; invalid family/kind is rejected), genre/moods/
  instrumentation, and verification state (`unclassified`/`suggested`/
  `verified`). Only `verified` is authoritative; `suggested` is never silently
  promoted; `unclassified` stays honest.

## PR 3 — post-TTS sound direction (actual timing + format-specific production)

Pre-TTS planning estimates timing; **post-TTS direction** runs AFTER the dialogue
segments exist and their real durations, silences, and overlaps are measurable.
It is deterministic, fingerprinted, and gated by `POST_TTS_SOUND_DIRECTION_ENABLED`
(default OFF).

- **Where it runs.** In `audioStitchingService`, after the standardized segment
  WAVs and the real `dialogueClips` timeline exist, before cue placement. A
  flag-gated third branch replaces the planner/legacy CUE placement; the existing
  (PR 1-QA'd) intro/outro placement stays.
- **Actual dialogue timeline** (`dialogueTimeline.ts`) — encoded bounds vs
  AUDIBLE speech bounds (spoken duration is never the file duration), embedded vs
  assembly pauses, overlaps, per-line real gaps. Fails safe on impossible input.
- **Waveform gap analysis** (`waveformAnalysis.ts`) — deterministic FFmpeg
  per-segment silence measurement + gap classification (overlap_removed /
  too_short / breath / reaction_ok / transition_ok / topic_gap), room-tone aware,
  env-tunable (`POST_TTS_SILENCE_THRESHOLD_DB`, `_MIN_SILENCE_MS`,
  `_MIN_TRANSITION_GAP_MS`, `_MIN_REACTION_GAP_MS`,
  `_PROTECTED_SPEECH_PADDING_MS`, `_MAX_ANALYSIS_DURATION_MS`).
- **Protected speech regions** (`protectedRegions.ts`) — every audible span is at
  least soft-protected; opening/closing/interruption/critical content (from the
  script's `isFactualClaim` + number/negation/score-odds/injury-transaction
  detection) is HARD-protected. **No stinger/reaction/transition/unducked music
  covers a protected region**; a ducked bed may continue under ordinary speech
  (and hard speech only where policy allows).
- **Format-specific policies** (`formatSoundPolicy.ts`, keyed to the registry) —
  per-format intro/outro treatment, transition/reaction ceilings, min gap, bed
  behavior, and cue-family permissions (hard hits, comedy, crowd, data reveal,
  breaking news, chapter bridge, score update). Formats are meaningfully
  different (solo sparse; sports permits score/data/crowd; documentary cinematic
  bridges + longest gaps; news no comedy; rapid-fire shortest gaps, no
  under-speech bed).
- **The director** (`postTtsSoundDirector.ts`) — a seeded, fingerprinted plan:
  intro/outro treatments (a too-short asset falls back to another TREATMENT, not
  another asset; a required bookend with no usable asset -> structured failure);
  transitions ONLY at structural boundaries in transition-sized gaps; reactions
  ONLY on a preceding-line tone trigger in reaction-sized gaps (never every line,
  never at a boundary, never during overlap unless the format permits); a bed
  plan honoring the identity policy + format. Only frozen-pool assets; no
  Math.random / wall-clock / current-config reads.
- **Cue fitting** (`cueFitting.ts`) — full / faded excerpt / bounded time-stretch
  / reject, env-bounded (`POST_TTS_MAX_TIME_STRETCH_PERCENT`,
  `_MIN_CUE_AUDIBLE_MS`, `_MIN_FADE_MS`, `_MAX_FADE_MS`). Never an abrupt edge,
  never a 2s cue in a 500ms gap, never aggressive stretching.
- **Executed bookend treatments** (director + `postTtsExecution.ts`). Each intro/
  outro treatment is EXECUTED on the real timeline as explicit gain SEGMENTS, not
  merely recorded: `full_before` (theme entirely before the opening words),
  `short_sting_then_clean` (bounded sting → clean speech), `cold_open_ducked`
  (full lead, then the theme DUCKS under the host a hair before the protected
  open), `spoken_cold_open_then_theme` (dialogue leads; the theme enters ducked
  AFTER the first line); and `clean_then_outro`, `rise_under_final` (ducked under
  the final sentence, rising to full only after the protected close),
  `reflective_gap_then_outro` (a measured gap from the last audible word — never
  double-counting trailing silence), `hard_branded_close` (a short bounded
  close). The dialogue offset comes from the intro's speech-entry
  (`resolveIntroDialogueStartMs`), so the intro never overlaps the opening words.
- **Execution + validation** (`postTtsExecution.ts`) — placed, fitted clips +
  Part-15 pre-render validation: every clip is a frozen-profile, loaded asset;
  bounds/gains/fades valid; no cue AND no UNDUCKED bookend segment covers a
  hard-protected region (a ducked `under_speech` segment may); required bookends
  represented. Missing OPTIONAL cues skip with a reason; missing REQUIRED
  bookends, or an unsupported/unsafe treatment, fail the render.
- **Feature flag + render modes** (`postTtsFlag.ts`, `postTtsReproduce.ts`). OFF
  by default. Enabling it later does NOT change published episodes. A successful
  post-TTS render stores its FULL execution plan (every placement, bookend
  segment, bed interval, gain/fade/source-window) plus a versioned reproduce
  ENVELOPE (plan/source/frozen-profile fingerprints + referenced asset hashes).
  **Reproduce EXECUTES that stored plan VERBATIM** — the director, format-policy
  selection, and cue selector are never invoked (`stored_plan_reproduce`), so
  later changes to director code, policies, thresholds, ffmpeg, or the flag do
  not alter a reproduced render. A missing/corrupt/unsupported-version plan, or a
  frozen-profile / dialogue-source / asset-hash mismatch, fails clearly (prior
  master preserved, no cue usage) — never a silent re-plan or legacy fallback.
- **Diagnostics** (job log + `EpisodeAudioRender.diagnostics.postTts`) —
  planning engine (`post_tts` / `stored_plan_reproduce` / `legacy_planner`) +
  version, format policy, dialogue duration, gap/protected/cue counts, rejection
  reasons, intro/outro treatment, bed policy, plan fingerprint, warnings,
  fallback reason. Names/counts/reasons only — never URLs/keys/paths.

**Deferred to PR 4:** cross-episode repetition prevention, within-episode
cue-family diversity scoring, cue-sequence similarity, long-horizon cooldown, and
the multi-episode listening acceptance matrix. **Known limitation:** bookend
audibility QA stays RMS-threshold based (presence + non-truncation), and the
`demo:post-tts-sound-direction` harness proves treatments acoustically via
single-tone band-pass fixtures — production assets are full-spectrum, so the
same measurements are indicative, not a substitute for a listen.

## PR 4 — sound diversity & anti-repetition engine

A deterministic engine that stops the sound-system sounding mechanically
repetitive across one episode, consecutive episodes, and a podcast's recent
catalog — while preserving recognizable branding. Flag-gated
(`SOUND_DIVERSITY_ENGINE_ENABLED`, default OFF); off = exact PR 1–3 behavior.

- **Diversity policy** (`soundDiversityPolicy.ts`) — a typed, fully BOUNDED
  `SoundDiversityPolicy`: history window, hard/soft asset + family cooldowns,
  intro/outro/bed streak limits + min-variants-before-repeat, branded-motif
  min/max rate, weighted penalties/bonuses, within-episode family/asset caps,
  max cue-sequence similarity, system-cross-podcast toggle.
  `resolveSoundDiversityPolicy` clamps every field to its bound and fails SAFE
  to the default on invalid input. Resolved from code/env + the sonic identity —
  **not** baked into the identity/snapshot fingerprint, so v1–v5 fingerprints
  stay byte-identical. `DIVERSITY_BOUNDS` caps history window / cue tokens /
  candidates / comparisons / system records / diagnostic records.
- **History** (`diversityHistory.ts`) — podcast-scoped, from SUCCESSFUL renders
  only: intro/outro/bed + family + motif from each episode's FROZEN snapshot,
  cue-family sequence + transition/reaction assets from the succeeded render's
  STORED plan. One entry per episode (reproduce/remix never double-count),
  strict podcast/owner/system isolation, deterministic recency ordering, bounded
  window; system scope is opt-in and shared-system-assets-only.
- **Pre-snapshot intro/outro/bed** (`soundDiversity.ts` + `…Selection.ts`) —
  hard immediate-asset cooldown (respected whenever an alternative exists),
  streak limits + min-variants + exact intro/outro pair avoidance (excluded in
  enforce, penalized in soft), soft asset/family/recency penalties, branded-
  continuity + brand-match bonuses. One-item pools select honestly
  (`single_item_pool`, no false cooldown claim); exhausted survivors relax to
  the least-recently-used. Weight is a preference (favored over a large sample)
  without a monopoly (low-weight variants still appear). Frozen into
  `production.diversityDecision` — EXCLUDED from the fingerprint (the selection
  it produced already lives in soundProfile and is hashed).
- **Within-episode cue diversity** (`soundCueDiversity.ts`) — chooses WHICH
  eligible cue asset the director places: within-episode asset/family caps,
  per-assignment maxUsesPerEpisode, cross-episode cooldown, same-asset/same-
  family penalties, prefer a different compatible family; never an incompatible
  family for variety, sparse formats stay sparse, a cue opportunity may remain
  empty. Runs only on FRESH renders (reproduce replays the stored plan).
- **Cue-sequence similarity** (`soundSequenceSimilarity.ts`) — ROLE:family
  tokenization + a bounded [0,1] unigram+bigram-Jaccard similarity; over the
  policy ceiling records a soft `sequence_similarity_relaxed` (never reorders
  required cues, never hard-fails).
- **Branded-motif continuity** (`soundMotifContinuity.ts`) — measures the recent
  per-role motif rate and prefers it below the minimum, penalizes it above the
  maximum, else neutral; `unavailable` (no eligible motif) / `unavoidable`
  (motif-only pool) reported honestly. Intro/outro evaluated independently.
- **System cross-podcast diversity** — opt-in
  (`SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED`), a SOFT penalty over shared-system
  assets only; never uses private/owner history, never excludes (a small podcast
  is never starved), ignored entirely when disabled.
- **Rollout modes** (`soundDiversityFlags.ts`) — `off` (prior behavior) /
  `observe` (compute + record, keep the plain selection) / `soft` (penalties +
  relaxations, never fail for diversity) / `enforce` (hard constraints). An
  invalid mode fails SAFE to off and records the raw value; enabled-but-unset
  defaults to observe. **Reproduce ignores the flags entirely** and replays the
  stored plan verbatim.
- **Snapshot decision:** NO v6. The diverse selection is already frozen in v5's
  soundProfile (and fingerprinted); the decision trace is stored
  non-fingerprinted in `production.diversityDecision`. Reproduce is unchanged.
- **Diagnostics + operator visibility** (`soundDiversityVisibility.ts`, render
  diagnostics) — mode, cue-decision count, per-role selection reasons, motif
  action/rate, relaxations, diversity fingerprint; podcast-level policy +
  cooldowns + motif bounds + similarity threshold + recent asset/family
  histograms. Safe names/counts/reasons only.
- **Typed failures/relaxations** — `DiversityFailure` /
  `DiversityRelaxation` enums; relaxations are explicit and deterministic (no
  hidden fallback). A failed render preserves the prior master and records no
  successful cue usage.

**Acceptance:** `npm run demo:sound-diversity` drives the engine over three
deterministic series (Sports 12ep, Documentary 8ep, System 10ep × 2 podcasts),
threading history, and asserts the catalog stays varied (no exact-pair streak
beyond policy, no prohibited family, system podcasts diverge, no asset monopoly,
streaks within limits, motif rate in band, deterministic replay) — writing a
safe `series-summary.json` (histograms + similarity matrix, no binaries) to
`samples/sound-diversity/`. `test:post-tts-render-gate` proves a real render
with diversity ENFORCE succeeds with audible bookends and that reproduce ignores
the flags.

**Known limitations:** "prefer the less-similar plan" is realized through
within-episode cue variation + a recorded similarity relaxation rather than
generating and ranking alternative full plans (the director stays a single
deterministic pass). The multi-episode harness proves SELECTION diversity;
per-episode audio + acoustic bookends under the engine are proven by the render
gate. Env: `SOUND_DIVERSITY_ENGINE_ENABLED`, `SOUND_DIVERSITY_ENFORCEMENT_MODE`,
`SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED`, plus `SOUND_DIVERSITY_HISTORY_WINDOW`,
`_HARD_ASSET_COOLDOWN`, `_SOFT_ASSET_COOLDOWN`, `_FAMILY_COOLDOWN`,
`_MAX_BED_STREAK`, `_MAX_SEQUENCE_SIMILARITY`.

See **docs/SOUND_DIVERSITY_ACCEPTANCE_MATRIX.md** for the full production
acceptance matrix mapping every scenario (formats, profiles, pools, modes,
render modes, failure paths, freeze-safety) to its concrete test evidence.

## PR 4 — sound diversity, anti-repetition & snapshot v6

A deterministic diversity engine stops the catalog sounding mechanically
repetitive across one episode, consecutive episodes, and a podcast's recent
history — without destroying branding. It never uses `Math.random`/wall-clock,
never selects outside the frozen pool, and never bypasses rights/ownership/
readiness/format/identity/family/role.

- **Policy** (`soundDiversityPolicy.ts`) — a typed, BOUNDED `SoundDiversityPolicy`
  (history window, hard/soft asset cooldowns, family cooldown, intro/outro/bed
  streak limits, min-variants-before-repeat, branded-motif rate band,
  within-episode asset/family caps, max cue-sequence similarity, system
  cross-podcast toggle). Every field is clamped on resolve AND on save; an
  invalid value fails safe to the nearest bound. Resolved from defaults + env +
  per-podcast overrides (`PodcastProductionConfig.diversityPolicy`, additive
  nullable JSON) — the per-podcast values win.
- **History** (`diversityHistory.ts`) — podcast/owner/system-scoped reader over
  SUCCESSFUL renders + frozen snapshots (intro/outro/bed) + stored plans
  (cue-family sequences). One entry per episode (reproduce/remix never
  double-counts); strict ownership isolation; deterministic recency ordering;
  bounded window; missing/corrupt data handled honestly. System scope is opt-in
  and shared-system-assets-only.
- **Pre-snapshot selection** (`soundDiversitySelection.ts`), **within-episode cue
  diversity** + **sequence similarity** (`soundDiversitySelection.ts` /
  director), **motif continuity** (`soundMotifContinuity.ts`), and **system
  cross-podcast diversity** are all deterministic and score-based; they record
  penalties, bonuses, and typed relaxations, and honestly report when a small
  pool makes diversity impossible.
- **Snapshot v6 — the freeze** (`episodeConfigurationSnapshot.ts`,
  `soundDiversity.ts`). Because within-episode cue diversity happens at RENDER
  time, an initial/delayed render could otherwise drift when later history / env
  / policy changes. v6 freezes the FULL render-influencing context (resolved
  policy, rollout mode at creation, bounded podcast+system cue history, the
  intro/outro/bed + motif decision, a fingerprint) INTO the snapshot and INCLUDES
  it in the v6 fingerprint. An INITIAL / `remix_episode_profile` render reads the
  FROZEN context; ONLY `remix_current_podcast` re-resolves current config
  (recorded as `contextSource: "current"`); `reproduce` replays the stored plan.
  v6 is stamped only when the engine was active at creation — otherwise the
  snapshot stays v5, byte/fingerprint identical. v1–v5 golden hashes unchanged.
- **Rollout** (`soundDiversityFlags.ts`) — `SOUND_DIVERSITY_ENGINE_ENABLED` +
  `SOUND_DIVERSITY_ENFORCEMENT_MODE` (`off`/`observe`/`soft`/`enforce`) +
  `SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED`. Invalid values fail safe. Reproduce
  ignores current flags.
- **Operator UI** — the podcast **Sound & Branding** screen
  (`/app/podcasts/[id]/sound`) has a bounded diversity-policy fieldset + a safe
  recent-usage summary, saved atomically via the existing `configVersion`
  optimistic concurrency (a stale save shows the conflict banner). The studio
  episode **Produce** surface shows the render's diversity decisions
  (`EpisodeDiversityPanel`): engine, mode, whether FROZEN or CURRENT config was
  used, fingerprint, per-role reasons, motif action, relaxations. Neither
  exposes URLs/keys/paths or another podcast's private usage.
- **Acceptance** — `npm run demo:sound-diversity` renders 30 real episodes
  (Sports 12 / Documentary 8 / System 2×5) through the pipeline with acoustic +
  diversity assertions; `docs/SOUND_DIVERSITY_ACCEPTANCE_MATRIX.md` maps every
  scenario to its test.

**Deterministic masters:** full-pipeline renders are byte-deterministic — the
same episode + inputs produce identical pre-master PCM and identical final MP3
(`test:render-determinism`, and the 30-episode harness asserts identical master
hashes across two complete runs). The one nondeterministic step, ffmpeg's
`sidechaincompress` (its sidechain float state is not bit-reproducible on this
build), was replaced with a JS-computed duck GAIN ENVELOPE applied via
`amultiply` in `mixBedUnderForeground` — same ducking behavior, byte-stable
output. Two-pass loudnorm + libmp3lame were already deterministic; the only mp3
tag is the static ffmpeg `encoder=Lavf…` string (no timestamp).

**Rollout mode is per-podcast:** the Sound & Branding screen exposes an
`inherit | off | observe | soft | enforce` override (stored in
`diversityPolicy`); the RESOLVED mode is frozen into v6. `remix_current_podcast`
re-resolves the latest override; `reproduce` ignores it. The render-detail panel
(`EpisodeDiversityPanel`) surfaces the full safe evidence: engine, configured +
effective mode, frozen-vs-current source, fingerprints, per-role selection
reasons + streaks + excluded candidates, motif action/rate/band, cue decisions,
sequence similarity, relaxations, and warnings.
