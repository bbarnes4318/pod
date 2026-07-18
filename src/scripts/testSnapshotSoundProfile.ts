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

  await check("Test 4: a FUTURE version (v4) with a valid profile still resolves (no silent loss)", () => {
    const r = resolveSnapshotSoundProfile(snapshot(4, validProfile()));
    assert(r.status === "frozen", `future version must not drop a compatible profile, got ${r.status}`);
    assert(r.profile?.bed?.assetId === "bed-1", "bed resolved on v4");
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
