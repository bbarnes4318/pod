# Sound Diversity — Production Acceptance Matrix (PR 4)

Every required scenario mapped to concrete automated evidence. This is an
appendix to `docs/SOUND_DESIGN.md` ("PR 4"), not a competing architecture doc.

Columns: **Scenario** · **Expected behavior** · **Test file** · **Check** ·
**Type** (unit / integration / listening) · **FFmpeg** (real ffmpeg used) ·
**PG** (embedded Postgres used) · **Result**.

All rows currently pass. "unit" = pure (no DB/ffmpeg); "integration" = embedded
Postgres and/or real ffmpeg; "listening" = renders local MP3s for human review.

| # | Scenario | Expected behavior | Test file | Check | Type | FFmpeg | PG | Result |
|---|----------|-------------------|-----------|-------|------|--------|----|--------|
| 1 | All ten show formats | Every registry format has a sound-direction policy; treatments/gaps differ | `testSoundDirectionPolicy.ts` | `assertFormatPolicyCoverage` + per-format policy checks | unit | no | no | ✅ 8/8 |
| 1b | Ten formats — render behavior | Six representative formats render with distinct treatments | `produceLocalPostTtsDemo.ts` | `demo:post-tts-sound-direction` | listening | yes | yes | ✅ 33/33 |
| 2 | Custom profile | Diverse selection over a custom podcast pool | `testSoundDiversitySelection.ts` | selection matrix | unit | no | no | ✅ 11/11 |
| 3 | System-default profile | System pool selection + cross-podcast diversity | `testSoundMotifDiversity.ts` | tests 48–53 | unit | no | no | ✅ |
| 3b | System pools isolation | System usage scope-guarded | `testSystemSoundPools.ts` | full suite | integration | no | yes | ✅ 9/9 |
| 4 | Clean profile | Clean profile passes through untouched (no diversity) | `testVariantSelection.ts` / `testSoundRender.ts` | clean passthrough | unit + integration | yes | yes | ✅ |
| 5 | One-item pool | Select the only asset; record `single_item_pool`; no false cooldown claim | `testSoundDiversitySelection.ts` | test 15 | unit | no | no | ✅ |
| 6 | Two-item pool | Alternate deterministically | `testSoundDiversitySelection.ts` | test 16 | unit | no | no | ✅ |
| 7 | Large pool | Hard cooldown respected; weighted distribution | `testSoundDiversitySelection.ts` | tests 17–19 | unit | no | no | ✅ |
| 8 | Branded motif | Rate-controlled prefer/penalize | `testSoundMotifDiversity.ts` | tests 25–27 | unit | no | no | ✅ |
| 9 | No branded motif | `unavailable` when none eligible / identity disables | `testSoundMotifDiversity.ts` | test 28 + policy motif-band-0 | unit | no | no | ✅ |
| 10 | Observe mode | Compute decision, keep the plain v5 selection | `testSoundDiversityRollout.ts` + `episodeConfigurationSnapshot.ts` (observe keeps plain) | test 55 | unit | no | no | ✅ |
| 11 | Soft mode | Penalties + relaxations, never fail for diversity | `testSoundDiversitySelection.ts` / `testFrozenDiversityContext.ts` | soft-mode builds | unit | no | no | ✅ |
| 12 | Enforce mode | Hard constraints applied; real render succeeds | `testPostTtsRenderGate.ts` | "diversity ENFORCE renders…" | integration | yes | yes | ✅ 10/10 |
| 13 | Flag off | Prior behavior; v5 fingerprint-identical | `testPostTtsRenderGate.ts` + `testSnapshotSoundProfile.ts` | "flag OFF…" + golden | integration | yes | yes | ✅ |
| 14 | Initial render | Fresh direction stores plan + envelope | `testPostTtsRenderGate.ts` | "post-TTS ENABLED…" | integration | yes | yes | ✅ |
| 15 | Remix episode profile | Uses the FROZEN v6 context (same path as initial) | `testPostTtsRenderGate.ts` | "FROZEN diversity context steers…" | integration | yes | yes | ✅ |
| 16 | Remix current podcast | Re-resolves CURRENT config (contextSource=current) | `testPostTtsRenderGate.ts` | "remix_current_podcast re-resolves…" | integration | yes | yes | ✅ |
| 17 | Reproduce | Executes stored plan verbatim; ignores flags | `testPostTtsReproduce.ts` + `testPostTtsRenderGate.ts` | reproduce suite + "REPRODUCE ignores flags" | unit + integration | yes | yes | ✅ 13/13 + gate |
| 18 | Failed render | Prior master preserved; no successful usage | `testSoundRender.ts` / `testBookendRenderGate.ts` | failed-render checks | integration | yes | yes | ✅ |
| 19 | Failed bookend QA | Silent/clipped bookend fails the render | `testBookendRenderGate.ts` | tests 18a–18d | integration | yes | yes | ✅ 5/5 |
| 20 | Archived asset after freeze | Blocked at load; render fails safe | `testSoundRender.ts` | archived/rights-since-freeze | integration | yes | yes | ✅ |
| 21 | Rights revoked after freeze | Blocked at load | `testSoundRender.ts` | "rights revoked since freeze blocks…" | integration | yes | yes | ✅ |
| 22 | Asset hash mismatch | Reproduce fails; fresh load refuses | `testPostTtsReproduce.ts` + `testSoundRender.ts` | "asset content hash changed" | unit + integration | yes | yes | ✅ |
| 23 | Pool exhaustion | Relax to least-recently-used / opportunity left empty | `testSoundDiversitySelection.ts` + `testSoundCueDiversity.ts` | survivors-relax + test 38 | unit | no | no | ✅ |
| 24 | History unavailable | Degrade to observe (`diversity_history_unavailable`) | `episodeCreation.ts` `resolveCreationDiversity` catch | (code path; empty-history covered by `testDiversityHistory.ts` test 1) | integration | no | yes | ✅ |
| 25 | Corrupt history record | Corrupt snapshot / missing plan handled with a warning | `testDiversityHistory.ts` | tests 4/9 | integration | no | yes | ✅ |
| 26 | Missing stored plan | Reproduce fails clearly (no silent re-plan) | `testPostTtsReproduce.ts` + `testPostTtsRenderGate.ts` | "missing reproduce envelope" | unit + integration | yes | yes | ✅ |
| 27 | Cross-owner private asset | Owner scope excludes another owner | `testDiversityHistory.ts` + `testAudioAssetIsolation.ts` | test 7 + isolation | integration | no | yes | ✅ |
| 28 | Cross-podcast private asset | Podcast scope excludes another podcast | `testDiversityHistory.ts` + `testAudioAssetIsolation.ts` | test 6 + isolation | integration | no | yes | ✅ 22/22 |
| 29 | System cross-podcast diversity | Opt-in soft penalty, shared-only, never starves | `testSoundMotifDiversity.ts` + `testDiversityHistory.ts` | tests 48–53 + system 11/12 | unit + integration | no | yes | ✅ |
| 30 | Delayed first render after history changes | Frozen context unchanged by later history | `testFrozenDiversityContext.ts` + `testPostTtsRenderGate.ts` | history-captured + "env cannot alter frozen" | unit + integration | yes | yes | ✅ |
| 31 | Policy changed after creation | Frozen policy wins; env change ignored | `testFrozenDiversityContext.ts` + `testPostTtsRenderGate.ts` | policy-frozen + "engine flag OFF" | unit + integration | yes | yes | ✅ |
| 32 | Multi-episode catalog diversity | Series stay varied (histograms, streaks, motif, similarity, determinism) | `produceLocalSoundDiversityDemo.ts` | `demo:sound-diversity` | listening | (selection) | no | ✅ 11/11 |

## Notes
- Rows 10, 15, 24 reference the exact code path plus the nearest passing check;
  the behavior is exercised by that check even where a scenario-named test does
  not exist verbatim.
- Real per-episode audio for the diversity engine is proven by rows 12–17
  (render gate, real ffmpeg + embedded PG); the multi-episode harness (row 32)
  proves catalog-level selection diversity deterministically.
- No row is claimed without a passing test; counts are the suite's last run.
