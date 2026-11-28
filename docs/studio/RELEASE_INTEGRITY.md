# Release integrity

What must be true before an episode can go out, where that is decided, and how
the app knows a recording still matches its script.

Status (2026-11-28): built on `release/integrity-gate`, draft PR #171, **not
merged**. Validated in a cloud session only, on commit `386650f`:

- **CI `full`: FAIL**, exit 1: `full: FAIL  44 passed, 2 failed, 0 blocked`.
  The two failures (`script-queue-tracking`, `business-engine`) fail the same
  way on `main` at `bb69ac9` (`quality: FAIL  32 passed, 2 failed, 0 blocked`)
  and are not touched by this branch. Every other step passed, including
  migrate, the integration suites, the build and the booted Docker image.
- **Database (real PostgreSQL 16)**: `npm run test:integration-release-integrity`
  -> `Release integrity (database): 19/19 checks passed`. It found one defect,
  fixed on this branch: a script edit waiting on the release lock gave up after
  5 seconds instead of landing (section 5).
- **Browser (Playwright, Chromium, local app)**: `release-integrity.spec.ts`
  -> `21 passed`. Screenshots: `docs/ux-audit/release-integrity/`.
- **Unit**: `npm run test:release-integrity` -> `32 passed, 0 failed`.

Not proven: no audio was voiced or mixed and no provider was called. The
database and browser fixtures write the recording and mix rows themselves,
using the same provenance helpers the voicing and mixing services call. That
the real services write those keys during a real run is covered only by the
source checks in the unit test. Nothing was run against production data.

## 1. One gate

Every route to "published" ends in the same function:

```
Script editor "Publish"   attemptPublish ----.
Release panel "Publish"   publishOwnedEpisode +--> prepareEpisodeForPublishing --.
Admin console             admin/rss/actions --'    publishEpisode ---------------+--> validateEpisodeForRss
Admin HTTP route          admin/publish-episode ---'                              (inside withReleaseLock)
```

- `validateEpisodeForRss` (`src/lib/services/rssPublishingService.ts`) is the
  only decision. The release checklist (`/studio/publish`), the Release panel
  (`getPublishState`) and the quality inspector (`getEpisodeQuality`) all READ
  that same function, so the screen cannot say "ready" when the gate will refuse.
- `rssPublishingService.ts` is the only file that writes `publish_ready` or
  `published`. The regression test fails if any other file does.
- There is no automated publisher: no worker job or scheduler publishes.
- Unpublishing is never blocked.

What was wrong before: the editor's button checked unresolved claims and stale
line audio; the Release panel and both admin routes did not. An episode the
editor refused could be published from the next tab. In the other direction,
an edited line stayed "pending re-check" forever (nothing ever cleared the
mark), so the editor's button could never publish an edited episode at all.

## 2. What the gate now requires (added)

| Check | Meaning |
| --- | --- |
| `factCheckCurrent` | The latest fact check read today's words (no line edited or added since), and no sports claim is unverified. Business claims are judged by `evaluateBusinessRelease` as before. |
| `audioMatchesScript` | No recorded line and no recorded scene says something the script no longer says. |
| `finalMixCurrent` | The final mix is the mix of this script and these exact recordings, and is not being rebuilt. |

## 3. Provenance: what is recorded, and where

No migration. Everything is written into JSON columns that already exist.

| Artifact | Recorded at creation | Column |
| --- | --- | --- |
| Fact check | hash of each line's text it read | `FactCheckResult.summary.checkedLines` |
| Line audio | the words it recorded (already existed) | `AudioSegment.text` |
| Scene audio | hash of the scene's lines and speakers | `DialogueSceneAudio.providerMetadata.provenance.turnsHash` |
| Final mix | script fingerprint + fingerprint of the exact recordings mixed, both taken from what the mixer read at the START of the mix | `EpisodeAudioRender.diagnostics.provenance` |
| Published episode | audio file, script fingerprint, how the mix was proven | `JobLog.output.released` of `rss:publish-episode` |

`evaluateArtifactIntegrity` (`src/lib/services/artifactProvenance.ts`, pure)
compares those against the current script.

Invalidation is as narrow as the pipeline allows:

- Edit one line of a line-voiced episode: that one line is stale.
- Edit one line of a scene-voiced episode: that one scene is stale. "Re-voice"
  queues one job per stale scene (the existing scene-aware line re-voice), not
  the whole episode.
- Any re-voice makes the final mix stale until it is re-mixed. Regenerated
  recordings never make an old mix current.

## 4. Episodes made before this was recorded

Nothing is claimed that was never recorded.

- **Scene audio without a recorded hash**: its existing `requestFingerprint`
  already covers text and speakers. It is recomputed from the row's own stored
  settings; a match proves the scene, no match refuses it.
- **Scene-voiced final mix without provenance**: scene rows are append-only, so
  "the mix finished after every scene it uses was created" is real proof. The
  gate reports this as proof by `timestamps`, not as a recorded fingerprint.
- **Line-voiced final mix without provenance**: line audio is rewritten in
  place and leaves no trail. Refused, with the remedy: re-mix once (no voice
  cost), which records provenance.
- **Fact check without recorded lines**: falls back to the edit mark, which is
  all older checks have. Running the fact check again records the lines.

Consequence to expect after deploy: an older, not-yet-published, line-voiced
episode will ask for one re-mix before it can publish.

## 5. Races

- **Publish vs edit / publish vs finishing re-mix**: `withReleaseLock` locks the
  Script and Episode rows, runs the gate, and writes the status in one
  transaction. An edit or a finishing mix waits, and the next gate read sees it.
- **Two editors**: `editScriptContent` does the read-modify-write under the
  Script row lock, and waits up to 75 seconds for it (a release may hold it for
  60). It first ran with the database client's default 5-second limit, so an
  edit queued behind a slow release failed instead of landing; the database
  test caught that. The second edit applies to the first one's saved result
  instead of overwriting it. AI passage revision compares "what the creator was
  shown" and writes under the same lock.
- **Publish during a rebuild**: a running mix (started within 30 minutes)
  refuses publish. A scene being re-voiced has no selected finished recording,
  which the gate reports as unvoiced lines.
- **Edit during a mix**: the mix records the script it STARTED from, so the
  finished mix is correctly stale against the edited script.

## 6. Known limitations

- The Release panel in the episode workspace shows the gate's reasons as
  sentences, not the three named checklist lines; those appear on
  `/studio/publish` and the admin feed console.
- On `/studio/publish`, an open claim now appears twice on a blocked episode:
  as the blocker "Fact check covers the current script, no open claims" and
  as the older "Claims review" warning.
- The episode header's "Publish to the feed" button is a link to the Release
  tab, shown by episode status. It still looks live on a blocked episode
  (same on `main`); the real button inside the panel is disabled.
- A legacy scene row whose stored `model` differs from the model it was
  fingerprinted with would be refused (fail closed) and need a re-voice. Not
  expected for Fish; unverified against production rows.
- (Fixed in section 7) Admin script edits now take the lock.
- Editing the script of an already-published episode does not unpublish it. The
  live audio still matches what was checked when it went out; a re-publish is
  gated, and since section 7 a re-mix cannot change the live audio either.
- Scene re-voice follows the CURRENT scene plan, so an edit that moves scene
  boundaries can re-voice a neighbouring scene too.

## 7. Part 3 follow-up: immutable identity, full lock coverage, immutable releases

Branch `release/immutable-artifacts` (2026-11-27). Closes the three gaps the
independent review found in PR #171. No migration, no environment variable.

**A. Immutable recording identity.** Every audio file is now stored under a
content-addressed key, `name-<first 16 hex of sha256(bytes)>.ext`
(`immutableStorageKey`, `artifactProvenance.ts`): line recordings
(`ttsSegmentService`), every scene candidate (`ttsSceneService`), and both
final masters (`audioStitchingService`, `sceneStitchingService`). Different
bytes can never share a URL, so a regenerated take with the same words and the
same duration still changes the mix's `sourcesFingerprint` (the URL is part of
it) and makes the old mix stale. The full sha256 is also recorded
(`providerMetadata.contentSha256` on line and scene rows,
`diagnostics.provenance.contentSha256` on a master). The provenance version is
unchanged: existing recorded fingerprints stay valid.
"Audio variants" in the pipeline are scene candidates; they are covered.

**B. Every script write takes the lock.** New `scriptLock.ts`:
`lockScriptRow` (FOR UPDATE, then re-read), `lockScriptUnchanged` (also refuses
if the content hash differs from what the caller based its change on) and
`SCRIPT_LOCK_TX` (75 s, so a writer waits out a release instead of failing at
5 s). Lock order is always Script, then Episode. Now locked:
admin save (optimistic: the editor sends the hash it loaded; a save over a
newer Studio edit is refused with "reload"), admin approve / reject / needs
revision, Studio approve (`scriptApproval`), human release / revoke
(`scriptRelease`), the line tone change (`create/actions`), the TTS line
renumber self-heal, the sports fact-check transaction, and the business
re-audit, fact-check and human review (the business fact-check used to write
its verdict onto the content it read minutes earlier, dropping any edit made
while the judge ran). A source check in the unit test fails if any
`script.update` that writes `content` is not preceded by a lock in the same
function.

**C. Published audio is immutable.** A re-mix of a **published** episode no
longer writes `Episode.audioUrl` (or duration or size): the feed and the
download keep serving the audio that passed the gate. The new master waits on
its render record. `releaseCandidate` makes it the file the gate judges, and
only `publishEpisode`, inside `withReleaseLock` and after the gate passed on
that exact file, promotes it (URL, duration, size) and records
`released.promotedNewMaster`. Because keys are content-addressed, the old
published object is never overwritten in storage either.

Tests: `npm run test:release-integrity` -> `54 passed, 0 failed` (run locally
with `npx tsx`, 2026-11-27). Mutation check: reverting the line stitcher's
published guard, the admin save lock, or the human-release lock each makes the
test fail. Three database checks were added to `testReleaseIntegrityDb.ts`
(promotion, stale candidate refused, stale admin save refused): **not run**,
they need PostgreSQL (server or cloud session; standing rule 1).

Limits: superseded audio objects are kept in storage (no sweeper). The admin
editor's "Save as New Version" creates a new row and needs no lock. A re-mix of
a published episode is invisible to listeners until someone re-publishes; the
Release panel does not yet say "a newer mix is waiting".

## 8. Rollback

Revert the merge commit of this branch. No migration, no environment variable
and no data change to undo: the extra JSON keys are ignored by older code.
