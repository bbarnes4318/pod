# Audio-asset architecture — ownership, immutability, rights, and delivery

Prompt 6 replaced the single global audio library with an owner- and
Podcast-scoped architecture. This is the contract. Delivered across PRs
#28 (scoped model), #29 (profiles + render isolation), #30 (management +
delivery), and the hardening PR.

## Scopes

| Scope | Owner | Podcast | Who sees it | Notes |
|---|---|---|---|---|
| `shared_system` | — | — | everyone | admin-managed; seeds + licensed crate; must carry valid licensing |
| `owner_private` | required | — | that owner | usable on any of the owner's shows |
| `podcast_private` | required | required (same owner) | that owner | usable only on that show |
| `legacy_global` | — | — | admin only | pre-Prompt-6 ambiguous assets; **blocked from NEW selection** until classified; the fail-closed column default |

Workspace scope belongs to Prompt 13 and deliberately does not exist.
DB enforcement: scope CHECK constraints + `AudioAsset_shared_system_unowned_chk`
+ `AudioAsset_podcast_scope_chk`; service enforcement in
`src/lib/services/audioAssetAccess.ts` (the ONE access contract — visibility,
assignability, render usability, classification, safe DTOs).

Rules that never bend: cross-owner reads answer **not found**; admin does not
see private user libraries; only admin creates `shared_system`; nobody creates
`legacy_global`; owners never change; duplicate-hash lookups are
visibility-scoped (no cross-owner existence leak).

## Immutable media

Once `processingStatus = "ready"`, `contentHash`/`storageKey`/`audioUrl` are
frozen by the `audio_asset_content_guard` DB trigger. Replacing audio creates a
NEW asset that **supersedes** the old (`supersededByAssetId`); the old asset is
archived, never rewritten, so historical snapshots and render records stay
auditable. The starter-pack seeder follows the same rule: changed generator
bytes upload to a new content-versioned key and repoint the system default for
FUTURE episodes only. Safe-to-edit metadata: name, tags, category, license
name/reference, rights notes, allowed use, archive state.

## Upload pipeline (`audioAssetUpload.ts`)

Magic bytes decide the format (MP3/WAV/FLAC/M4A only) — never the extension or
browser MIME; ffprobe proves decodability; sha256 + technical metadata are
computed server-side; storage keys derive from trusted identifiers
(`audio-assets/{system|owners/<ownerId>|podcasts/<podcastId>}/<assetId>/source.<ext>`);
temp files are server-owned and always cleaned. Limits: `AUDIO_ASSET_MAX_BYTES`
(default 35MB), `AUDIO_ASSET_MAX_DURATION_SECONDS` (15m), per-kind caps
(stinger 30s, sfx 20s, themes 120s), `HIGHLIGHT_MAX_DURATION_SECONDS` (60s).
Rights documents: PDF/PNG/JPEG magic bytes only, `RIGHTS_DOCUMENT_MAX_BYTES`,
private keys under `audio-assets/rights/`.

## License + rights

Structured states: `licenseStatus` (original/licensed/public_domain/cc0/
unknown/restricted/expired/revoked) and `rightsStatus` (not_required/pending/
confirmed/rejected/expired/revoked) with confirmation actor/time, expiry, and
private document reference. Legacy `license`/`rightsConfirmed` stay as compat
columns. Usability for NEW use (assign AND render — both checked):
expired/revoked/rejected block; `restricted` requires `allowedUse` covering
`podcast_production`; highlights additionally require `confirmed`. Highlights
never enter ordinary pools/planner catalogs — explicit episode selection only.
Revocation blocks new selection and re-renders; existing final audio and audit
records remain.

## Podcast sound profiles + Episode snapshot v2

`PodcastProductionConfig.soundProfileMode`: `system_default` (shared profile,
resolved to concrete asset ids/hashes at Episode creation), `custom` (the
show's `PodcastSoundAssignment` rows), `clean` (explicit empty profile).
Cooldown scope: `podcast` (default) or `owner` — never global. Episode
snapshot **v2** freezes the resolved profile (ids, hashes, gains/fades,
rights/license at capture, provenance); the planner and stitcher may only use
that frozen pool. v1 snapshots stay readable and fingerprint-stable; legacy
episodes use a scope-guarded compatibility pool. The system default may
resolve pre-Prompt-6 `legacy_global` assets ONLY as flagged `legacy_compat`
(documented compatibility, admin warning surfaced).

## Render versions + exact usage

Every render writes an `EpisodeAudioRender` (mode, planner seed, the exact
executed plan JSON, fingerprint, output, safe failure reason; unique per
episode+version). Every used asset writes a `SoundCueUsage` row with render
id, owner/podcast scope, frozen asset facts (kind/scope/hash/gain/fades), and
`selectionSource`. Versioned history is never deleted by a re-render. Render
modes: `initial`; `remix_episode_profile` (default for forced re-renders of
v2 episodes); `remix_current_podcast` (explicit action; snapshot NOT
rewritten); `reproduce` (re-executes the stored plan verbatim; fails clearly
without one). Downloads are bounded and sha256-verified — a hash mismatch is
refused, audit-flagged, and never silently substituted; a missing object
fails the render and preserves prior audio.

## Delivery

Private storage URLs never reach browsers for assets. Preview:
`/api/audio-assets/<id>/preview` (session or admin auth, canonical
authorization, 404 for other owners, proxied bytes, range support,
`private, no-store`, nosniff). Rights documents:
`/api/audio-assets/<id>/rights-document` (manager-only, attachment). The
storage provider has no genuine signed URLs, so the app proxies — it does not
pretend. A static test (`test:audio-upload-security`) forbids logging
`audioUrl`/`storageKey`/`signedUrl`/`rightsDocumentStorageKey` in production
asset paths.

## Legacy classification + tooling

Backfill (migration 22) classified from evidence only: seeds →
`shared_system` (confirmed rights); everything else → `legacy_global` +
`legacyScopeReviewRequired`, no fabricated owners. Admin classifies via the
console (audited). Tooling: `npm run audit:audio-assets` (read-only report:
scopes, violations, orphans, hash/metadata gaps — prints no URLs/keys) and
`npm run repair:audio-asset-metadata` (dry-run default, `--apply`,
`--asset-id`, bounded download + ffprobe + sha256, refuses to overwrite a
mismatched hash, never guesses ownership, never runs at startup or in a
migration).

## Archive vs deletion

Archive removes an asset from new selectors and planner catalogs while
history, snapshots, render records, and the storage object remain; historical
reproduction may still use it while rights stay valid. The admin console's
remove action archives. Hard deletion is not exposed; the only sanctioned
cases would be failed, never-referenced uploads.

## Deferred (explicitly)

Prompt 7 (formats beyond `two_host_debate`), Prompt 8 (private feeds — asset
preview URLs are NOT feed URLs), Prompt 9 (queue split), Prompt 10 (scheduled
profiles), Prompt 11 (waveform editor), Prompt 13 (Workspaces — until then:
user ownership + optional podcast association + shared system).

## Tests

`test:audio-asset-isolation` · `test:audio-asset-migration` ·
`test:sound-profile` · `test:sound-render` · `test:audio-upload-security` ·
`tests/e2e/audio-asset-isolation.spec.ts` (browser), plus the migration
baseline/adoption safeguards (`migrationCheckpoints.ts` invariants for
migrations 22 + 23).

## PR 2 — cue metadata + verification state

`AudioAsset` gains two additive fields for admin-reviewed creative metadata:

- `cueMetadata` (JSON) — cue family, genre, mood, energy, bpm, instrumentation,
  and per-slot suitability (broadcast/format/under-speech/intro/outro/bed/
  transition/reaction). Validated by `src/lib/audio/cueMetadata.ts`; nothing is
  fabricated.
- `metadataState` — `unclassified` | `suggested` | `verified` (DB CHECK).
  Metadata is authoritative for HARD compatibility decisions ONLY when
  `verified` (`verifiedCueMetadata`); `suggested` may be shown but is never
  silently trusted. Set via the admin `updateAssetCueMetadata` action. See
  docs/SOUND_DESIGN.md ("PR 2") for how selection consumes it.
