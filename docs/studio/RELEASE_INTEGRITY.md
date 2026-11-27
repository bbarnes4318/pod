# Release integrity

What must be true before an episode can go out, where that is decided, and how
the app knows a recording still matches its script.

Status: built on `release/integrity-gate`. Unit-tested (`npm run
test:release-integrity`, 32 checks, no database). **Not yet run against a
database, CI or a browser.**

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
  Script row lock. The second edit applies to the first one's saved result
  instead of overwriting it. AI passage revision compares "what the creator was
  shown" and writes under the same lock.
- **Publish during a rebuild**: a running mix (started within 30 minutes)
  refuses publish. A scene being re-voiced has no selected finished recording,
  which the gate reports as unvoiced lines.
- **Edit during a mix**: the mix records the script it STARTED from, so the
  finished mix is correctly stale against the edited script.

## 6. Known limitations

- Not run against Postgres. The two `SELECT ... FOR UPDATE` statements and the
  new queries are type-checked only.
- A legacy scene row whose stored `model` differs from the model it was
  fingerprinted with would be refused (fail closed) and need a re-voice. Not
  expected for Fish; unverified against production rows.
- Admin script edits outside the Studio editor do not take the edit lock. They
  are still caught by the fingerprints at publish time.
- Editing the script of an already-published episode does not unpublish it. The
  live audio still matches what was checked when it went out; a re-publish is
  gated.
- Scene re-voice follows the CURRENT scene plan, so an edit that moves scene
  boundaries can re-voice a neighbouring scene too.

## 7. Rollback

Revert the merge commit of this branch. No migration, no environment variable
and no data change to undo: the extra JSON keys are ignored by older code.
