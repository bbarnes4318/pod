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

Tests: `npm run test:sound-design` (planner rules + measured ducking proof)
and `npm run test:sound-pack` (synthesizes and validates the starter pack).
