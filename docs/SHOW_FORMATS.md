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
debate keeps its historical 25%/20% pair). `generationReady` gates NEW saves:
a registered-but-unready format is rejected honestly (all four are ready as of
the Prompt 7 finale).

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
  (`--host-max`, `--host-doc`, `--host-3`, `--host-4`); social-clip captions
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
