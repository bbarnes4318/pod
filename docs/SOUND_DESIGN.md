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
