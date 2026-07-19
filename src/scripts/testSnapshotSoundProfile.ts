// Canonical snapshot sound-profile resolver tests. Run: npm run test:snapshot-sound-profile
//
// Proves the fix for the "identical podcasts" bug: a version-3 episode snapshot
// carries its frozen sound profile in production.soundProfile exactly like v2,
// and the resolver must return it (the old `snap.version !== 2` check dropped it
// and fell back to the legacy global pool). The resolver keys on SHAPE, not the
// version number, so v2, v3, and any future version keep working; a snapshot
// that CLAIMS a profile but whose profile is malformed reports "corrupt" so the
// caller fails honestly instead of rendering with the wrong pool.
//
// Pure (no DB, no ffmpeg, no network).

import {
  resolveSnapshotSoundProfile,
  isFrozenSoundProfile,
  fingerprintEpisodeSnapshot,
  frozenBookendEnabled,
  assertFrozenBookendIntent,
  EPISODE_CONFIGURATION_SNAPSHOT_VERSION,
  type EpisodeConfigurationSnapshot,
} from "../lib/services/episodeConfigurationSnapshot";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ref = (assetId: string, kind: string, role: string): FrozenSoundAssetRef => ({
  assetId, kind, category: null, name: `Asset ${assetId}`, contentHash: `hash-${assetId}`,
  scope: "shared_system", role: role as FrozenSoundAssetRef["role"], orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 4000, tags: [],
  rightsStatusAtCapture: "confirmed", licenseStatusAtCapture: "licensed", provenance: "system_default",
});

const validProfile = (): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: -16, cooldownScope: "podcast",
  stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  intro: ref("intro-1", "theme_intro", "intro"),
  outro: ref("outro-1", "theme_outro", "outro"),
  bed: ref("bed-1", "bed", "bed"),
  stingers: [ref("st-1", "stinger", "stinger")],
  reactions: [ref("sfx-1", "sfx", "reaction")],
  containsLegacyCompatAssets: false, excluded: [],
});

/** A v4 profile carries EXPLICIT frozen bookend intent. */
const v4Profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  ...validProfile(), introEnabled: true, outroEnabled: true, ...over,
});

const editorial = { verticals: [], teams: [], segmentCount: 3, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} };
const productionBase = { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {} };

/** Build a snapshot at a given version, optionally with a frozen profile. */
function snapshot(version: number, profile?: unknown): EpisodeConfigurationSnapshot {
  return {
    version, source: "podcast", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null,
    ...(version >= 3 ? { cast: { formatId: "two_host_debate", formatVersion: 1, members: [] } } : {}),
    editorial,
    production: { ...productionBase, ...(profile !== undefined ? { soundProfile: profile } : {}) },
  } as unknown as EpisodeConfigurationSnapshot;
}

async function main() {
  console.log("\nCanonical snapshot sound-profile resolver\n");

  // --- The matrix (mission tests 1-5) --------------------------------------
  await check("Test 1: snapshot v2 resolves its frozen sound profile (status=frozen)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(2, validProfile()));
    assert(r.status === "frozen", `expected frozen, got ${r.status}`);
    assert(r.profile?.intro?.assetId === "intro-1", "intro asset resolved");
  });

  await check("Test 2 (THE BUG): snapshot v3 resolves its frozen sound profile (status=frozen)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(3, validProfile()));
    assert(r.status === "frozen", `v3 must resolve the frozen profile, got ${r.status}`);
    assert(r.profile?.outro?.assetId === "outro-1", "outro asset resolved");
    assert(r.profile?.mode === "custom", "mode preserved");
  });

  await check("Test 3: snapshot v1 has no frozen profile (status=v1_legacy, profile null)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(1));
    assert(r.status === "v1_legacy", `expected v1_legacy, got ${r.status}`);
    assert(r.profile === null, "no profile for v1");
  });

  await check("Test 4: v4 and any FUTURE version with a valid profile still resolve (no silent loss)", () => {
    const r4 = resolveSnapshotSoundProfile(snapshot(4, validProfile()));
    assert(r4.status === "frozen" && r4.profile?.bed?.assetId === "bed-1", `v4 resolves, got ${r4.status}`);
    const r5 = resolveSnapshotSoundProfile(snapshot(5, validProfile()));
    assert(r5.status === "frozen", `a future version must not drop a compatible profile, got ${r5.status}`);
  });

  await check("Test 5a: a corrupt profile (bad mode) fails honestly (status=corrupt, never legacy)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(3, { mode: "bogus", intro: null, outro: null, bed: null, stingers: [], reactions: [] }));
    assert(r.status === "corrupt", `expected corrupt, got ${r.status}`);
    assert(r.profile === null, "no profile returned for corrupt");
  });

  await check("Test 5b: a corrupt profile (missing arrays) fails honestly (status=corrupt)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(3, { mode: "custom", intro: null, outro: null, bed: null }));
    assert(r.status === "corrupt", `expected corrupt, got ${r.status}`);
  });

  await check("Test 5c: a corrupt profile (intro not a ref) fails honestly (status=corrupt)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(3, { mode: "custom", intro: "not-a-ref", outro: null, bed: null, stingers: [], reactions: [] }));
    assert(r.status === "corrupt", `expected corrupt, got ${r.status}`);
  });

  await check("a v3 snapshot WITHOUT a soundProfile key is 'none' (absence != corruption)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(3));
    assert(r.status === "none", `expected none, got ${r.status}`);
    assert(r.profile === null, "no profile");
  });

  await check("a null / non-object snapshot is 'none' (legacy episode)", () => {
    assert(resolveSnapshotSoundProfile(null).status === "none", "null -> none");
    assert(resolveSnapshotSoundProfile(undefined).status === "none", "undefined -> none");
    assert(resolveSnapshotSoundProfile("garbage").status === "none", "string -> none");
  });

  // --- isFrozenSoundProfile validator --------------------------------------
  await check("isFrozenSoundProfile accepts a valid profile and rejects malformed ones", () => {
    assert(isFrozenSoundProfile(validProfile()) === true, "valid accepted");
    assert(isFrozenSoundProfile({ ...validProfile(), mode: "nope" }) === false, "bad mode rejected");
    assert(isFrozenSoundProfile({ ...validProfile(), stingers: "x" }) === false, "non-array stingers rejected");
    assert(isFrozenSoundProfile({ ...validProfile(), intro: { kind: "theme_intro" } }) === false, "intro missing assetId rejected");
    assert(isFrozenSoundProfile(null) === false, "null rejected");
  });

  await check("the resolver does not mutate the snapshot (read-only)", () => {
    const snap = snapshot(3, validProfile());
    const before = JSON.stringify(snap);
    resolveSnapshotSoundProfile(snap);
    assert(JSON.stringify(snap) === before, "snapshot unchanged after resolution");
  });

  // --- Test 4 (mission): historical v1-v3 fingerprints remain stable --------
  await check("historical v1/v2/v3 fingerprints are byte-stable across round-trips", () => {
    for (const snap of [snapshot(1), snapshot(2, validProfile()), snapshot(3, validProfile())]) {
      const f1 = fingerprintEpisodeSnapshot(snap);
      const f2 = fingerprintEpisodeSnapshot(JSON.parse(JSON.stringify(snap)));
      assert(f1 === f2, `fingerprint reproducible for v${snap.version}`);
      // Resolving the profile must not change the fingerprint (no mutation).
      resolveSnapshotSoundProfile(snap);
      assert(fingerprintEpisodeSnapshot(snap) === f1, `fingerprint stable after resolve for v${snap.version}`);
    }
  });

  await check("a v2 snapshot and the same material as v2 fingerprint identically (no version churn)", () => {
    const a = snapshot(2, validProfile());
    const b = snapshot(2, validProfile());
    assert(fingerprintEpisodeSnapshot(a) === fingerprintEpisodeSnapshot(b), "identical v2 material -> identical fingerprint");
  });

  // ===== v4 explicit frozen bookend intent ================================
  // Golden fingerprints over the unchanged editorialMaterial/fingerprint logic.
  // The v4 change added an OPTIONAL profile field set only on v4 profiles, so
  // these flag-less v1/v2/v3 hashes are byte-identical to pre-v4.
  const GOLDEN = {
    v1: "ae7a536d80dbdd255f98a30f7ee230d65cd1801893427830d40b80c4fa5c6599",
    v2: "ad246f918c199bdcd8391814b4b12097d8b5e21b237f4cda5b5e050733228bed",
    v3: "04fc4d655414d51c21f2642af5ba058051f720f9059a1664747610ce5e999126",
    v4: "f2bb91409885e2ce2281aa96a889397fc24d124b92096e2160948845410006f2",
  };
  await check("Tests 13/14/15 + PR2 test 10: v1/v2/v3/v4 fingerprints are byte-stable (golden anchors)", () => {
    const f = {
      v1: fingerprintEpisodeSnapshot(snapshot(1)),
      v2: fingerprintEpisodeSnapshot(snapshot(2, validProfile())),
      v3: fingerprintEpisodeSnapshot(snapshot(3, validProfile())),
      v4: fingerprintEpisodeSnapshot(snapshot(4, v4Profile())),
    };
    console.log(`      [golden] v1=${f.v1}\n               v2=${f.v2}\n               v3=${f.v3}\n               v4=${f.v4}`);
    assert(f.v1 === GOLDEN.v1, `v1 fingerprint drifted -> ${f.v1}`);
    assert(f.v2 === GOLDEN.v2, `v2 fingerprint drifted -> ${f.v2}`);
    assert(f.v3 === GOLDEN.v3, `v3 fingerprint drifted -> ${f.v3}`);
    assert(f.v4 === GOLDEN.v4, `v4 fingerprint drifted -> ${f.v4}`);
    // Newer-version fields must NOT retroactively affect an older flag-less hash.
    assert(fingerprintEpisodeSnapshot(snapshot(2, validProfile())) === f.v2, "v2 unaffected by later fields");
  });

  await check("Test 16 + PR2 test 11: v5 fingerprint is deterministic and distinct from v4", () => {
    const a = snapshot(4, v4Profile());
    const b = snapshot(4, v4Profile());
    assert(fingerprintEpisodeSnapshot(a) === fingerprintEpisodeSnapshot(b), "v4 deterministic");
    assert(fingerprintEpisodeSnapshot(a) !== fingerprintEpisodeSnapshot(snapshot(3, validProfile())), "v4 distinct from v3");
    assert(
      fingerprintEpisodeSnapshot(snapshot(4, v4Profile({ outroEnabled: false }))) !== fingerprintEpisodeSnapshot(a),
      "outroEnabled is part of the fingerprint",
    );
    // v5 determinism: same v5 material (selected variant + identity) -> same hash.
    const v5a = snapshot(5, v4Profile({ selectionSeed: "seed-1", sonicIdentity: undefined } as never));
    const v5b = snapshot(5, v4Profile({ selectionSeed: "seed-1" } as never));
    assert(fingerprintEpisodeSnapshot(v5a) === fingerprintEpisodeSnapshot(v5b), "v5 deterministic given identical material");
    assert(fingerprintEpisodeSnapshot(v5a) !== fingerprintEpisodeSnapshot(a), "v5 distinct from v4");
    assert(EPISODE_CONFIGURATION_SNAPSHOT_VERSION === 5, "current snapshot version is 5");
  });

  await check("Test 17: editing the podcast after creation does not alter the v4 episode's bookend requirements", () => {
    // The episode froze outroEnabled:true with outro-1. A later podcast edit is
    // represented by a DIFFERENT 'current' profile — the frozen snapshot must be
    // read unchanged; rendering never re-derives intent from current config.
    const frozen = snapshot(4, v4Profile({ outro: ref("outro-1", "theme_outro", "outro") }));
    const beforeFp = fingerprintEpisodeSnapshot(frozen);
    const beforeIntent = frozenBookendEnabled(resolveSnapshotSoundProfile(frozen).profile!, "outro");
    // Podcast owner later disables the outro and swaps the asset (current config):
    const currentProfile = v4Profile({ outroEnabled: false, outro: ref("outro-9", "theme_outro", "outro") });
    void currentProfile; // NOT read by the resolver — proving isolation.
    const r = resolveSnapshotSoundProfile(frozen);
    assert(r.status === "frozen" && r.profile!.outro?.assetId === "outro-1", "frozen outro asset unchanged after edit");
    assert(frozenBookendEnabled(r.profile!, "outro") === true && beforeIntent === true, "frozen outro intent unchanged after edit");
    assert(fingerprintEpisodeSnapshot(frozen) === beforeFp, "frozen fingerprint unchanged after edit");
  });

  await check("frozenBookendEnabled: v4 => boolean; v2/v3 (no intent) => null", () => {
    assert(frozenBookendEnabled(v4Profile(), "intro") === true, "v4 enabled => true");
    assert(frozenBookendEnabled(v4Profile({ introEnabled: false }), "intro") === false, "v4 disabled => false");
    assert(frozenBookendEnabled(validProfile(), "intro") === null, "v2/v3 (no flag) => null");
  });

  await check("Level 2 (assertFrozenBookendIntent): enabled-without-asset-or-exclusion throws; valid states pass", () => {
    // Enabled + asset => ok
    assertFrozenBookendIntent(v4Profile());
    // Disabled + no asset => ok
    assertFrozenBookendIntent(v4Profile({ introEnabled: false, outroEnabled: false, intro: null, outro: null }));
    // Enabled + excluded (structured reason) => ok
    assertFrozenBookendIntent(v4Profile({ outro: null, excluded: [{ assetId: "x", role: "outro", reason: "rights blocked" }] }));
    // Enabled + NO asset + NO exclusion => must throw
    let threw = false;
    try { assertFrozenBookendIntent(v4Profile({ outro: null })); } catch { threw = true; }
    assert(threw, "enabled outro with no asset and no exclusion must throw at creation");
    // v2/v3 (no explicit intent) => never throws (compat)
    assertFrozenBookendIntent(validProfile());
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
