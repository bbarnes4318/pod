# Show formats — the 1-4 speaker format engine

Prompt 7 replaced the hardcoded two-host debate with a versioned show-format
engine. `two_host_debate` is now registered format #1, not the architecture.

## Registry (`src/lib/formats/showFormatRegistry.ts`)

| Format | Voices | Roles (seat order) | Ready |
|---|---|---|---|
| `two_host_debate` | 2 | chair_a, chair_b | yes |
| `solo_briefing` | 1 | anchor | yes |
| `interview` | 2 | interviewer, guest | yes |
| `roundtable` | 3-4 | moderator, panelist_1, panelist_2, panelist_3 (optional) | yes |

Each format declares speaker bounds, ordered roles with directions, and
per-chair line-share floors (approval floor; generation gate = 0.8x — the
debate keeps its historical 25%/20% pair).

### Selectability is DERIVED, not a flag alone

A format is selectable for NEW shows/episodes (`isGenerationReadyFormat`) only
when **both** hold:

1. `generationReady === true` (the format's own flag), and
2. `speakerMin <= MAX_HOSTS` (`src/lib/episodeLimits.ts`, currently 2) — the
   generation pipeline casts at most `MAX_HOSTS` voices, and `hostCasting`
   throws below a format's `speakerMin`, so a format whose *minimum* exceeds
   the cap cannot be produced.

Consequences today:

- **Blocked:** `three_person_panel` (min 3) and its historical alias
  `roundtable`. The UI shows it disabled with "Needs 3 voices — coming soon";
  `savePodcastConfiguration` rejects it with `unsupported_format`.
- **Selectable despite a larger `speakerMax`:** `sports_radio` (2–3),
  `betting_desk` (2–3), `documentary` (1–4), `rapid_fire` (2–4) — their
  minimum casts fit the cap; optional seats above the cast simply stay
  unfilled. The UI caps the host picker at `min(speakerMax, MAX_HOSTS)`.
- **Raising `MAX_HOSTS` re-enables larger formats automatically** — the gate
  is derived from the registry + the cap, never a hardcoded list.

**Legacy stored formats:** a show saved on a now-blocked format before the
derived gate does NOT break — `resolveEpisodeConfiguration` degrades the
inherited value to `two_host_debate` with a named warning (and clamps an
oversized stored cast), so episode creation never fails on a value the owner
can no longer select. `npm run migrate:legacy-formats` reports/moves such rows
(reversible; priors recorded in a JobLog).

## Cast

`Episode.formatId` + normalized `EpisodeCastMember` rows (seat-ordered,
role-carrying, unique per seat and per host) written atomically at creation;
`Episode.hostIds` remains the legacy seat-order mirror. `resolveEpisodeCast`
seats 1-4 by pin order then roster fill (the debate delegates to the legacy
pair resolver — byte-identical casting). Snapshot v3 freezes
`{formatId, formatVersion, pinned seats}`; v1/v2 snapshots stay byte-stable.

## Pipeline

- **Script**: per-format prompt pieces (`formatScriptPrompts.ts`; the debate's
  text is verbatim legacy), N-speaker schema/validation via `makeCastMatchers`,
  format-driven balance gates, format-aware approval floors, pairwise-averaged
  quality personality axis. Research-brief `argumentForHostA/B` stay as debate
  stances; other formats consume them as unbound Case FOR/AGAINST material.
- **TTS**: voices the resolved cast; per-host overrides unchanged.
- **Audio**: `hostSlot` = seat index; `seatPan()` seats 1-4 across the stereo
  field (two-seat = the exact legacy left/right pair).
- **Presentation**: transcripts/mix color by seat across four tokens
  (`--host-a`, `--host-b`, `--host-c`, `--host-d`); social-clip captions
  use four seat colours and cast-derived labels.

## Surfaces

Studio create: format picker (ready formats only) + seat-numbered host picker
capped/floored by the format. Podcast wizard: two-seat cap fixed (server and
UI agree). Admin `setcast`: validated via `validatePinnedCast` against the
episode's format. Standalone episodes may pass a `format` override through the
canonical resolver; podcast episodes inherit the show's `editorial.format`.

## Tests

`test:show-format` · `test:show-format-migration` · `test:format-script` ·
`test:format-audio` · `tests/e2e/show-format.spec.ts` (browser proof of the
solo flow + the debate default).
