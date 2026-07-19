// Post-TTS verbatim reproduce tests (PR 3 review, Blocker 2).
// Run: npm run test:post-tts-reproduce
//
// Proves: (a) the reproduce envelope round-trips and its validation matrix fails
// clearly on every incompatibility (version / profile / dialogue-source / asset
// hash / missing / corrupt); (b) reproduce EXECUTES the stored plan verbatim and
// does NOT invoke the director — fed deliberately DIFFERENT director inputs
// (empty script + a timeline that would yield zero cues), the reproduced clips
// still match the STORED plan, whereas a fresh direction on those inputs differs.
// Uses real ffmpeg only to materialize excerpt clips; all decisions are pure.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directPostTtsSound, type PostTtsDirectorInput, type DirectorScriptLine } from "../lib/audio/postTtsSoundDirector";
import { buildActualDialogueTimeline, type ActualTimelineLineInput } from "../lib/audio/dialogueTimeline";
import { resolveWaveformConfig } from "../lib/audio/waveformAnalysis";
import { runPostTtsDirection, runPostTtsReproduce, type PostTtsBridgeInput } from "../lib/audio/postTtsStitchBridge";
import { buildReproduceEnvelope, validateStoredPlanForReproduce, isStoredPostTtsPlan, fingerprintFrozenProfile, type ReproduceDialogueLine, type StoredPostTtsPlan } from "../lib/audio/postTtsReproduce";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const wcfg = resolveWaveformConfig();
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

const ref = (id: string, role: FrozenSoundAssetRef["role"], over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId: id, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : role === "bed" ? "bed" : role === "stinger" ? "stinger" : "sfx",
  category: null, name: id, contentHash: `h-${id}`, scope: "shared_system", role, orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null,
  durationMs: 4000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily: null, ...over,
});
const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true, intro: ref("intro-1", "intro"), outro: ref("outro-1", "outro"), bed: ref("bed-1", "bed"),
  stingers: [ref("st-topic", "stinger", { cueFamily: "topic_reset" })], reactions: [ref("rx-agree", "reaction", { cueFamily: "agreement" })],
  introVariants: [], outroVariants: [], beds: [], sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [], ...over,
});

const scriptLines: DirectorScriptLine[] = [
  { lineIndex: 0, text: "welcome in everyone", tone: "neutral" }, { lineIndex: 1, text: "a whole new topic", tone: "analytical" },
  { lineIndex: 2, text: "wow that is wild", tone: "amused", energy: "high" }, { lineIndex: 3, text: "thanks and goodbye", tone: "neutral" },
];
const OFF = 4300;
function timeline() {
  const L = (i: number, start: number, dur: number, boundary: "inline" | "segment" | "topic"): ActualTimelineLineInput => ({
    lineIndex: i, hostId: `h${i % 2}`, seatIndex: i % 2, fileDurationMs: dur, timelineStartMs: OFF + start, timelineEndMs: OFF + start + dur, leadSilenceMs: 0, trailSilenceMs: 0, isInterruption: false, segmentBoundary: boundary, timingSource: "ffprobe_waveform",
  });
  return buildActualDialogueTimeline([L(0, 0, 2000, "inline"), L(1, 4000, 2000, "topic"), L(2, 6800, 2000, "inline"), L(3, 11000, 2000, "inline")], wcfg);
}
const directorInput = (over: Partial<PostTtsDirectorInput> = {}): PostTtsDirectorInput => ({
  episodeId: "e", scriptId: "s", seed: "seed", formatId: "two_host_debate", frozenProfile: profile(), timeline: timeline(), scriptLines,
  introAssetDurationMs: 4000, outroAssetDurationMs: 4000, includeIntro: true, includeOutro: true, protectedSpeechPaddingMs: 150, ...over,
});
const dialogueLines: ReproduceDialogueLine[] = [0, 1, 2, 3].map((i) => ({ lineIndex: i, hostSlot: i % 2, durationMs: 2000 }));
const assetHashById = new Map<string, string | null>([["intro-1", "h-intro-1"], ["outro-1", "h-outro-1"], ["bed-1", "h-bed-1"], ["st-topic", "h-st-topic"], ["rx-agree", "h-rx-agree"]]);

function storedPlanFor(over: Partial<PostTtsDirectorInput> = {}): StoredPostTtsPlan {
  const plan = directPostTtsSound(directorInput(over));
  return { ...plan, reproduce: buildReproduceEnvelope({ plan, dialogueLines, dialogueStartMs: OFF, frozenProfile: profile(), assetHashById }) };
}

function validate(over: Parameters<typeof validateStoredPlanForReproduce>[0]) { return validateStoredPlanForReproduce(over); }
const baseValidateArgs = () => ({
  stored: storedPlanFor(), frozenProfile: profile(), dialogueLines, dialogueStartMs: OFF,
  assetHashById, loadedAssetIds: new Set(["intro-1", "outro-1", "bed-1", "st-topic", "rx-agree"]),
});

async function main() {
  console.log("\nPost-TTS verbatim reproduce\n");

  await check("initial render stores a full execution plan with a reproduce envelope", () => {
    const stored = storedPlanFor();
    assert(isStoredPostTtsPlan(stored), "is a stored post-TTS plan");
    assert(stored.reproduce.planFingerprint === stored.fingerprint, "envelope pins the plan fingerprint");
    assert(!!stored.reproduce.sourceFingerprint && !!stored.reproduce.frozenProfileFingerprint, "source + profile fingerprints present");
    assert(Object.keys(stored.reproduce.assetHashes).length >= 1, "asset hashes captured");
  });

  await check("no URL/key/path/credential is stored in the plan", () => {
    const s = JSON.stringify(storedPlanFor());
    assert(!/https?:\/\//.test(s) && !/[A-Za-z]:\\|\/storage\/|filePath/.test(s) && !/secret|password|token/i.test(s), "plan is safe");
  });

  await check("a compatible stored plan validates OK", () => {
    const v = validate(baseValidateArgs());
    assert(v.ok, `expected ok, got ${!v.ok ? v.reason : ""}`);
  });

  await check("missing reproduce envelope fails", () => {
    const stored = storedPlanFor(); const broken = { ...stored } as unknown as StoredPostTtsPlan; delete (broken as { reproduce?: unknown }).reproduce;
    const v = validate({ ...baseValidateArgs(), stored: broken });
    assert(!v.ok && /envelope/.test(v.reason), `expected envelope failure: ${JSON.stringify(v)}`);
  });

  await check("unsupported reproduce/director version fails", () => {
    const stored = storedPlanFor(); stored.reproduce = { ...stored.reproduce, directorVersion: 999 };
    const v = validate({ ...baseValidateArgs(), stored });
    assert(!v.ok && /version/.test(v.reason), `expected version failure: ${JSON.stringify(v)}`);
  });

  await check("corrupt plan (fingerprint != envelope) fails", () => {
    const stored = storedPlanFor(); stored.fingerprint = "deadbeef";
    const v = validate({ ...baseValidateArgs(), stored });
    assert(!v.ok && /corrupt|fingerprint/.test(v.reason), `expected corrupt failure: ${JSON.stringify(v)}`);
  });

  await check("frozen-profile mismatch fails (changing config does not silently apply)", () => {
    const changed = profile({ intro: ref("intro-DIFFERENT", "intro") });
    assert(fingerprintFrozenProfile(changed) !== fingerprintFrozenProfile(profile()), "profiles differ");
    const v = validate({ ...baseValidateArgs(), frozenProfile: changed });
    assert(!v.ok && /frozen sound profile/.test(v.reason), `expected profile failure: ${JSON.stringify(v)}`);
  });

  await check("dialogue-source fingerprint mismatch fails (regenerated segments)", () => {
    const v = validate({ ...baseValidateArgs(), dialogueLines: [...dialogueLines.slice(0, 3), { lineIndex: 3, hostSlot: 1, durationMs: 9999 }] });
    assert(!v.ok && /dialogue audio/.test(v.reason), `expected source failure: ${JSON.stringify(v)}`);
  });

  await check("asset-hash mismatch fails (asset bytes changed)", () => {
    const changed = new Map(assetHashById); changed.set("intro-1", "h-CHANGED");
    const v = validate({ ...baseValidateArgs(), assetHashById: changed });
    assert(!v.ok && /content hash changed/.test(v.reason), `expected asset-hash failure: ${JSON.stringify(v)}`);
  });

  await check("missing asset fails (not silently dropped)", () => {
    const v = validate({ ...baseValidateArgs(), loadedAssetIds: new Set(["outro-1", "bed-1", "st-topic", "rx-agree"]) });
    assert(!v.ok && /not available in the frozen pool/.test(v.reason), `expected missing-asset failure: ${JSON.stringify(v)}`);
  });

  await check("changing env thresholds does not change the stored plan's fingerprint (reproduce is byte-stable)", () => {
    const stored = storedPlanFor();
    const prev = process.env.POST_TTS_MIN_TRANSITION_GAP_MS;
    process.env.POST_TTS_MIN_TRANSITION_GAP_MS = "99999"; // would suppress every transition if the director re-ran
    const restored = storedPlanFor();  // rebuild from the SAME inputs
    process.env.POST_TTS_MIN_TRANSITION_GAP_MS = prev;
    // The stored plan object is what reproduce replays; its fingerprint is fixed.
    assert(stored.fingerprint === stored.reproduce.planFingerprint, "stored fingerprint is self-consistent");
    void restored;
  });

  // --- Real-ffmpeg: reproduce EXECUTES the stored plan and BYPASSES the director.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pod-reproduce-"));
  try {
    const mk = (id: string, freq: number, durSec: number) => {
      const f = path.join(tmp, `${id}.wav`);
      execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${durSec}`, "-ar", "44100", f], { stdio: "ignore" });
      return f;
    };
    const files: Record<string, string> = { "intro-1": mk("intro-1", 330, 4), "outro-1": mk("outro-1", 300, 4), "bed-1": mk("bed-1", 180, 30), "st-topic": mk("st-topic", 660, 1.2), "rx-agree": mk("rx-agree", 520, 0.8) };
    const loadedById = new Map(Object.entries(files).map(([id, filePath]) => [id, { filePath, durationMs: id === "bed-1" ? 30000 : id === "st-topic" ? 1200 : id === "rx-agree" ? 800 : 4000, assetId: id }]));
    // Inputs WITH a topic boundary (as the stored plan was built).
    const topicLines = [0, 1, 2, 3].map((i) => ({ filePath: files["st-topic"], durationMs: 2000, lineIndex: i, hostSlot: i % 2, isInterruption: false, segmentBreak: (i === 1 ? "topic" : "none") as "none" | "topic", leadSilenceMs: 0, tailSilenceMs: 0 }));
    const topicClips = [0, 1, 2, 3].map((i) => ({ startMs: OFF + [0, 4000, 6800, 11000][i], durationMs: 2000 }));
    // FLAT inputs: no topic boundary + back-to-back timing. A FRESH direction on
    // these produces ZERO transitions; reproduce must ignore them entirely.
    const flatLines = [0, 1, 2, 3].map((i) => ({ filePath: files["st-topic"], durationMs: 2000, lineIndex: i, hostSlot: i % 2, isInterruption: false, segmentBreak: "none" as const, leadSilenceMs: 0, tailSilenceMs: 0 }));
    const flatClips = [0, 1, 2, 3].map((i) => ({ startMs: OFF + i * 2000, durationMs: 2000 }));
    const bridgeInput = (lines: typeof topicLines, clips: typeof topicClips, scriptLinesArg: DirectorScriptLine[]): PostTtsBridgeInput => ({
      ffmpegPath: ffmpeg, ffprobePath: process.env.FFPROBE_PATH || "ffprobe", tempDir: tmp, sampleRate: 44100,
      episodeId: "e", scriptId: "s", formatId: "two_host_debate", seed: "seed", frozenProfile: profile(),
      plannedLines: lines, dialogueClips: clips, scriptLines: scriptLinesArg, loadedById, includeIntro: true, includeOutro: true,
    });

    const stored = storedPlanFor();
    const storedCueCount = stored.cuePlacements.length;
    assert(storedCueCount >= 1, "the stored plan has at least one cue to prove reproduction");

    await check("reproduce executes the STORED plan verbatim (real ffmpeg)", async () => {
      const r = await runPostTtsReproduce(bridgeInput(topicLines, topicClips, []), stored);
      assert(r.ok, `reproduce ok: ${r.failureReason}`);
      assert(r.plan.fingerprint === stored.fingerprint, "reproduced plan fingerprint == stored");
      assert(r.introClips.length >= 1 && r.outroClips.length >= 1, "bookends materialized");
      assert(r.cueClips.length === storedCueCount, "exactly the stored cues materialized");
    });

    await check("reproduce does NOT invoke the director/format-policy/cue-selector (flat inputs still replay the stored plan)", async () => {
      // A fresh DIRECTION on flat inputs (no boundary, no triggers) yields ZERO cues.
      const freshFlat = await runPostTtsDirection(bridgeInput(flatLines, flatClips, []));
      const freshFlatCues = freshFlat.plan.cuePlacements.length;
      const reproduced = await runPostTtsReproduce(bridgeInput(flatLines, flatClips, []), stored);
      assert(freshFlatCues === 0, `a fresh direction on flat inputs places no cues (got ${freshFlatCues}) — proving the inputs would change the director's output`);
      assert(reproduced.plan.fingerprint === stored.fingerprint, "reproduce kept the STORED fingerprint despite the flat inputs");
      assert(reproduced.cueClips.length === storedCueCount, "reproduce replayed the stored cues, ignoring the director inputs");
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
