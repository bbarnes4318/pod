// Post-render bookend verification tests. Run: npm run test:bookend-qa
//
// REAL ffmpeg. Builds actual masters through the same render+master path the
// stitcher uses (renderTimelineToWav -> masterToMp3), then runs verifyBookends
// against the finished waveform. Also unit-tests the pure requirement +
// absence-reason logic that decides WHEN a bookend is required and, when a
// required bookend never became a clip, WHY (stage-specific).
//
// Covers all ten mandated cases: enabled-but-unconfigured, genre-rejected,
// rights-excluded, missing-from-plan, planned-but-not-loaded, loaded-but-not-
// executed, executed-but-silent, clipped-during-mastering, disabled, and clean.
//
// No DB, no network, no paid APIs — only local synthesized audio + ffmpeg.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runFfmpeg, renderTimelineToWav, masterToMp3, type TimelineClip } from "../lib/audio/assembly";
import { verifyBookends, resolveBookendRequirement, describeBookendAbsence } from "../lib/audio/bookendQa";

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
const SR = 44100;

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function synthSpeech(file: string, durationSec: number, band = 900) {
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi",
    "-i", `anoisesrc=color=pink:amplitude=0.25:seed=7:duration=${durationSec}`,
    "-af", `bandpass=f=${band}:width_type=h:w=1200,volume=12dB,aformat=channel_layouts=stereo`,
    "-ar", String(SR), "-c:a", "pcm_s16le", file,
  ]);
}
async function synthTone(file: string, durationSec: number, freq = 330) {
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi",
    "-i", `sine=frequency=${freq}:duration=${durationSec}`,
    "-af", "aformat=channel_layouts=stereo,volume=0.5",
    "-ar", String(SR), "-c:a", "pcm_s16le", file,
  ]);
}
const music = (filePath: string, startMs: number, durationMs: number, fadeOutMs: number): TimelineClip => ({
  filePath, startMs, durationMs, kind: "music", pan: 0, fadeInMs: 20, fadeOutMs, gainDb: -2,
});
const speech = (filePath: string, startMs: number, durationMs: number): TimelineClip => ({
  filePath, startMs, durationMs, kind: "speech", pan: 0, fadeInMs: 5, fadeOutMs: 5, gainDb: 0,
});
async function master(dir: string, tag: string, clips: TimelineClip[]): Promise<string> {
  const wav = path.join(dir, `${tag}-fg.wav`);
  await renderTimelineToWav(ffmpegPath, clips, wav, { sampleRate: SR });
  const mp3 = path.join(dir, `${tag}.mp3`);
  await masterToMp3(ffmpegPath, wav, mp3, { targetLufs: -16, bitrate: "192k" });
  return mp3;
}

// Shared fixture geometry
const introDurMs = 2000, dialogueStartMs = 1200;
const speechEndMs = dialogueStartMs + 4600 + 2000; // 7800
const outroStartMs = speechEndMs - 450, outroDurMs = 2500; // 7350 .. 9850

async function main() {
  console.log("\nPost-render bookend verification (real ffmpeg) + requirement logic\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-bookend-"));

  try {
    const introFile = path.join(dir, "intro.wav"), outroFile = path.join(dir, "outro.wav");
    const l1 = path.join(dir, "l1.wav"), l2 = path.join(dir, "l2.wav"), l3 = path.join(dir, "l3.wav");
    await synthTone(introFile, 2.0, 330);
    await synthTone(outroFile, 2.5, 300);
    await synthSpeech(l1, 2.0, 700); await synthSpeech(l2, 2.0, 1100); await synthSpeech(l3, 2.0, 700);
    const dialogue: TimelineClip[] = [
      speech(l1, dialogueStartMs, 2000),
      speech(l2, dialogueStartMs + 2300, 2000),
      speech(l3, dialogueStartMs + 4600, 2000),
    ];
    const introClip = music(introFile, 0, introDurMs, 800);
    const outroClip = music(outroFile, outroStartMs, outroDurMs, 400);

    const goodMaster = await master(dir, "good", [introClip, ...dialogue, outroClip]);
    const noOutroMaster = await master(dir, "no-outro", [introClip, ...dialogue]); // outro NOT mixed
    const cleanMaster = await master(dir, "clean", [...dialogue]);

    // ============ Real-waveform measurement (executed cases) =================
    await check("Test 8/9/10: enabled intro AND outro are audible; master extends beyond speech", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, goodMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(r.ok, `verification failed: ${r.failures.join("; ")}`);
      assert(r.introVerified && r.outroVerified, "both bookends verified");
      assert(r.outroTailMs > 300, `master extends beyond speech (tail ${r.outroTailMs} ms)`);
    });

    await check("Case 'executed but silent': placed outro that is silent in the master FAILS", async () => {
      // noOutroMaster has NO outro audio after speech, but we assert one was placed.
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(!r.ok && !r.outroVerified, "silent outro must fail");
      assert(r.failures.some((f) => /outro/i.test(f)), `names the outro: ${r.failures.join("; ")}`);
    });

    await check("Case 'clipped during mastering': truncated master FAILS QA", async () => {
      const clipped = path.join(dir, "clipped.mp3");
      await runFfmpeg(ffmpegPath, ["-y", "-i", goodMaster, "-t", "8.2", "-c", "copy", clipped]);
      const r = await verifyBookends(ffmpegPath, ffprobePath, clipped, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(!r.ok && r.failures.some((f) => /truncat/i.test(f)), `flags truncation: ${r.failures.join("; ")}`);
    });

    // ============ Required-but-never-placed cases (the fixed gap) ============
    // Any REQUIRED bookend that never became a clip must FAIL, with a
    // stage-specific reason — proven here on a real master (noOutroMaster) that
    // genuinely has no outro after the last spoken word.
    const requiredButAbsent = async (reason: string) =>
      verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: false, outroStartMs: null, outroDurationMs: null,
        outroAbsenceReason: reason, speechEndMs,
      });

    await check("Case 'enabled but unconfigured outro' FAILS with a safe reason", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: false,
        frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(req.required && req.code === "legacy_unconfigured", `unconfigured => required (${req.code})`);
      const detail = describeBookendAbsence("outro", { req, planHasCue: null, assetLoaded: null, loadWarning: null, themesExcluded: 0 });
      const r = await requiredButAbsent(detail);
      assert(!r.ok && r.failures.some((f) => /no outro asset is configured/i.test(f)), `unconfigured fails: ${r.failures.join("; ")}`);
    });

    await check("Case 'configured outro rejected by genre gate' FAILS (no cue)", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: "outro-1", frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(req.required && req.code === "frozen_asset", "frozen outro required");
      const detail = describeBookendAbsence("outro", { req, planHasCue: false, assetLoaded: null, loadWarning: null, themesExcluded: 1 });
      assert(/genre gate|not planned/i.test(detail), `genre reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "genre-rejected outro fails");
    });

    await check("Case 'outro excluded by invalid rights' FAILS at resolution", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: null, frozenExcludedReason: "rights blocked (rights_revoked)",
        legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(req.required && req.code === "excluded_at_resolution", "rights-excluded outro required");
      const detail = describeBookendAbsence("outro", { req, planHasCue: null, assetLoaded: null, loadWarning: null, themesExcluded: 0 });
      assert(/excluded at profile resolution.*rights/i.test(detail), `rights reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "rights-excluded outro fails");
    });

    await check("Case 'outro missing from plan' FAILS", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: "outro-1", frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      const detail = describeBookendAbsence("outro", { req, planHasCue: false, assetLoaded: null, loadWarning: null, themesExcluded: 0 });
      assert(/no cue|not planned/i.test(detail), `missing-from-plan reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "missing-from-plan outro fails");
    });

    await check("Case 'outro planned but not loaded' FAILS with a load reason", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: "outro-1", frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      const detail = describeBookendAbsence("outro", {
        req, planHasCue: true, assetLoaded: false,
        loadWarning: "Sound asset 'Close Theme' skipped: rights invalid (rights_revoked).", themesExcluded: 0,
      });
      assert(/failed to load/i.test(detail), `load reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "planned-but-not-loaded outro fails");
    });

    await check("Case 'outro loaded but not executed' FAILS with an execution reason", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: "outro-1", frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      const detail = describeBookendAbsence("outro", { req, planHasCue: true, assetLoaded: true, loadWarning: null, themesExcluded: 0 });
      assert(/not placed on the final timeline|execution/i.test(detail), `execution reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "loaded-but-not-executed outro fails");
    });

    // ============ Cases that must NOT fail ===================================
    await check("Case 'outro intentionally disabled' succeeds without one", async () => {
      const req = resolveBookendRequirement({
        kind: "outro", clean: false, enabled: false, hasFrozenProfile: true,
        frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(!req.required && req.code === "disabled", "disabled => not required");
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null, speechEndMs,
      });
      assert(r.ok && !r.outroVerified && r.introVerified, `disabled outro passes: ${r.failures.join("; ")}`);
    });

    await check("Case 'clean profile without outro' passes with no bookends required", async () => {
      const introReq = resolveBookendRequirement({
        kind: "intro", clean: true, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: "intro-1", frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(!introReq.required && introReq.code === "clean", "clean => not required");
      const r = await verifyBookends(ffmpegPath, ffprobePath, cleanMaster, {
        introRequired: false, introPlaced: false, introDurationMs: null,
        outroRequired: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null, speechEndMs,
      });
      assert(r.ok, `clean render passes: ${r.failures.join("; ")}`);
    });

    // ============ Requirement resolution matrix =============================
    await check("resolveBookendRequirement: frozen profile is authoritative; legacy path is strict", () => {
      const frozen = (assetId: string | null, excl: string | null) => resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: true,
        frozenRefAssetId: assetId, frozenExcludedReason: excl, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
      });
      assert(frozen("a", null).required, "frozen asset => required");
      assert(frozen(null, "rights blocked").required, "frozen excluded => required");
      assert(!frozen(null, null).required, "frozen profile with no bookend and no exclusion => not required");

      const legacy = (id: string | null, env: boolean) => resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: false,
        frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: id, legacyEnvConfigured: env,
      });
      assert(legacy("a", false).code === "legacy_configured" && legacy("a", false).required, "legacy configured => required");
      assert(legacy(null, true).required, "legacy env fallback => required");
      assert(legacy(null, false).code === "legacy_unconfigured" && legacy(null, false).required, "legacy unconfigured => required (must fail)");

      // Disabled/clean short-circuit regardless of configuration.
      assert(!resolveBookendRequirement({ kind: "outro", clean: true, enabled: true, hasFrozenProfile: false, frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: "a", legacyEnvConfigured: true }).required, "clean => not required");
      assert(!resolveBookendRequirement({ kind: "outro", clean: false, enabled: false, hasFrozenProfile: false, frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: "a", legacyEnvConfigured: true }).required, "disabled => not required");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
