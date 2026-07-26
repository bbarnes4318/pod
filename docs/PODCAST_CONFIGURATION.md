# Podcast configuration — the canonical show source of truth

A **show** (`Podcast`) is a saved, versioned configuration. This document is the
contract for how that configuration is stored, resolved, and frozen into every
episode. It reflects the foundation delivered by the
`feat/podcast-as-show-source-of-truth` branch; UI, full recurring integration,
per-show reuse policy, private feeds, and per-show schedule times are explicitly
**out of scope here** and tracked as follow-ups.

## Current roster

Defined in `prisma/seed.ts`, which is the source of truth. Both hosts run on
Fish.

| Seat | Host | Slug | Intensity |
|------|------|------|-----------|
| A (index 0) | Bernadette "Line Two" Zabala | `bernie-line-two` | 8 |
| B (index 1) | Ray "Forty-One" Meachum | `ray-forty-one` | 7 |

**Seat order is load-bearing.** `worker.ts` builds the research brief assuming
seat B is the LOWER-intensity chair: the topic prompt asks why host A takes the
strong stance and why host B contradicts it from their own worldview. Swapping
the array order in the seed inverts that brief without any error. Keep the
higher-intensity host at index 0.

The gap is deliberately narrow (8 vs 7). Wide enough for the pipeline's A/B
chair convention, close enough that escalation can genuinely start from either
chair.

Retired hosts are listed in `RETIRED_HOST_SLUGS` and archived, never deleted.
`isArchived: true` removes a host from pickers and auto-casting;
`isActive` MUST stay true, because `resolveEpisodeCast` looks a **pinned**
`hostId` up by `isActive` alone. Deactivating a retired host makes episodes
that pinned them fall through to auto-fill and silently re-cast with the
current roster. `npm run test:seed` pins this behavior.

Seat colours (`--host-a` .. `--host-d`) and voice env vars
(`<PROVIDER>_HOST_A..D_VOICE_ID`) are keyed by the same chair index, so a
roster change never needs a code change.

## Data model

Identity lives on `Podcast`; settings live in three 1-1 config tables keyed by
`podcastId` (`onDelete: Cascade`):

| Table | Holds |
|-------|-------|
| `Podcast` (identity) | `name`, `slug` (unique, normalized, reserved-name-rejecting), `description`, `author`, `ownerName`, `ownerEmail` (**sensitive**), `websiteUrl`, `language`, `category`/`subcategory`, `explicit`, `copyright`, `coverImageUrl`, `visibility`, `configVersion` |
| `PodcastEditorialConfig` | `verticals`, `teams` (Team IDs), `segmentCount`, `format` (only `two_host_debate`), `minDebateScore`, `scriptStyle`, `maxWords` |
| `PodcastProductionConfig` | `hostIds` (≤2), `ttsProvider`, `ttsVoiceOverrides`, `productionStyle`, `sfxDensity` |
| `PodcastPublishingConfig` | `autoGenerateChapters`/`ShowNotes`/`Cover`, `includeTranscript`, `downloadsEnabled` |

The legacy `Podcast.verticals/teams/segmentCount/hostIds` columns are **kept**.
`loadPodcastConfiguration` is the single sanctioned reader of them: it prefers a
config-table row and falls back to the legacy column only when a row is missing
(flagging `usedLegacyFallback`). A contract test asserts the creation path never
reads those columns directly.

## Resolution: one resolver, precedence + provenance

`src/lib/services/podcastConfiguration.ts` is the ONE resolver used by Studio,
Admin, and the creation path. Authority (who may touch a show) differs by
surface; the business rules do not.

- **Podcast episode:** `episode_override > podcast > system_default`
- **Standalone episode:** `episode_override > system_default` — a standalone
  episode **never** inherits any Podcast's values.

Every resolved setting carries a `provenance` label describing *where* the value
came from — derived from the source, never inferred from whether the value looks
"empty". The final resolved values (inherited or overridden alike) are validated:
unsupported format, unknown TTS provider, invalid production style/density, and
>2 hosts are structured errors.

## Versioning + optimistic concurrency

`configVersion` starts at 1 and is bumped **exactly once** per accepted edit.
`savePodcastConfiguration` is a transactional compare-and-swap on the expected
version: a mismatch returns a structured `podcast_configuration_changed` conflict
and writes nothing (no partial saves). `fingerprintPodcastConfiguration` is a
deterministic, key-order-independent sha256 that **excludes** `ownerEmail`.

## Episode snapshot

`src/lib/services/episodeConfigurationSnapshot.ts` freezes the resolved config
onto the Episode at creation (`configurationSource`, `podcastConfigurationVersion`,
`configurationSnapshot`, `configurationFingerprint`), inside the SAME transaction
as the Episode + EpisodeTopic rows. Guarantees:

1. **No secrets** — `ownerEmail`/`ownerName` never enter a snapshot.
2. **No fabrication** — pre-snapshot episodes are `configurationSource = 'legacy'`
   with no stored snapshot; `reconstructLegacySnapshot` builds an explicitly
   `incomplete: true` view for display only.
3. **Deterministic** — the fingerprint covers the configuration material only
   (never `capturedAt`), so the same config always fingerprints the same way.

Sound-design *asset IDs* are not frozen: they are chosen by the production planner
at mix time from the shared, non-owned crate. The snapshot records the real
per-show inputs (`productionStyle`, `sfxDensity`).

## Migration + backfill

`prisma/migrations/20260716000000_add_podcast_configuration` is additive and
non-destructive. It backfills every existing Podcast with a deterministic unique
slug and one editorial/production/publishing row mirroring the legacy columns;
owner-less podcasts stay owner-less; existing Episodes are honestly marked
`legacy`. `migrationCheckpoints.ts` declares this migration data-bearing and adds
invariants (every podcast has each config row, unique non-null slugs, no orphans,
episodes carry a `configurationSource`).

## Tests

- `npm run test:podcast-configuration` — resolver/save/snapshot (pure + embedded Postgres)
- `npm run test:podcast-configuration-migration` — the backfill against embedded Postgres

## Prompt 6 addendum — the sound profile is part of the configuration

`PodcastProductionConfig` now carries the show's sound profile
(`soundProfileMode`, loudness, cooldown scope/windows, intro/outro flags) plus
normalized `PodcastSoundAssignment` rows. Sound-profile saves go through
`savePodcastSoundProfile` under the SAME optimistic-concurrency contract:
transactional, no partial saves, exactly ONE `configVersion` increment per
accepted save, structured `podcast_configuration_changed` on staleness. The
configuration fingerprint covers the sound profile, and Episode snapshots are
version 2 (frozen sound profile embedded; v1 snapshots stay readable and
byte-stable). See `docs/AUDIO_ASSET_ARCHITECTURE.md`.

## Prompt 7 addendum — the show format is part of the configuration

`PodcastEditorialConfig.format` now accepts any REGISTERED, SELECTABLE format
from the show-format registry (no longer only `two_host_debate`). Selectability
is derived: `generationReady && speakerMin <= MAX_HOSTS` — see
`docs/SHOW_FORMATS.md`. The effective host cap is
`min(format.speakerMax, MAX_HOSTS)`; a legacy stored format that is no longer
selectable degrades to the default at episode resolution with a named warning
instead of failing.
Episode snapshots are version 3 (frozen format + pinned cast; v1/v2 stay
byte-stable). See `docs/SHOW_FORMATS.md`.

## PR 2 — sonic identity + variant pools

`PodcastProductionConfig.sonicIdentity` (validated JSON) holds the show's
versioned sonic identity, and `PodcastSoundAssignment` becomes a VARIANT POOL per
role (cueFamily, weight, isBrandedMotif, per-episode use/cooldown limits, format
allow/deny). The old singleton intro/outro/bed constraint is dropped. The
episode configuration snapshot advances to **v5**, freezing the deterministically
selected intro/outro/bed variant + the permitted pools + the identity; v1–v4 stay
readable and fingerprint-stable. Full detail: docs/SOUND_DESIGN.md ("PR 2").

## PR 3 — post-TTS sound direction

`POST_TTS_SOUND_DIRECTION_ENABLED` (default off) makes the render plan cues AFTER
the real dialogue timing is measured, per the frozen v5 profile + format policy.
No schema change. Reproduce of a post-TTS episode re-runs the deterministic
director. Full detail: docs/SOUND_DESIGN.md ("PR 3").

## PR 4 — sound diversity

`SOUND_DIVERSITY_ENGINE_ENABLED` + `SOUND_DIVERSITY_ENFORCEMENT_MODE`
(off/observe/soft/enforce) layer deterministic anti-repetition onto the frozen
intro/outro/bed selection at episode creation, and within-episode cue selection
at render time. No schema change; the decision is frozen non-fingerprinted in
`production.diversityDecision`. Reproduce ignores the flags. Full detail:
docs/SOUND_DESIGN.md ("PR 4").

## PR 4 — sound diversity policy + snapshot v6

Each show can tune a BOUNDED sound-diversity policy (history window, asset/family
cooldowns, intro/outro/bed streak limits, min-variants-before-repeat, branded-
motif rate band, within-episode caps, max cue-sequence similarity, system
cross-podcast toggle) on the **Sound & Branding** screen. It persists to the
additive nullable `PodcastProductionConfig.diversityPolicy` JSON column (every
value re-clamped to its bound on save and on resolve), saved atomically via the
existing `configVersion` optimistic concurrency.

When the diversity engine is active at creation, the episode snapshot is stamped
**v6**: the fully resolved policy, the rollout mode, the bounded podcast (+ opt-in
shared-system) cue history, and the intro/outro/bed + motif decision are FROZEN
and fingerprinted, so a delayed/initial render is deterministic regardless of
later history/env/policy changes. Otherwise the snapshot stays v5 (identical to
before). Reproduce always replays the stored plan verbatim; `remix_current_
podcast` intentionally re-resolves current config. Full detail:
docs/SOUND_DESIGN.md ("PR 4") and docs/SOUND_DIVERSITY_ACCEPTANCE_MATRIX.md.
