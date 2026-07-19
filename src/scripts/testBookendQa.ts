// Post-render bookend verification tests. Run: npm run test:bookend-qa
//
// REAL ffmpeg. Builds actual masters through the same render+master path the
// stitcher uses (renderTimelineToWav -> masterToMp3), then runs verifyBookends
// against the finished waveform. Also unit-tests the pure requirement +
// absence-reason logic (Level 3 render gate) that decides WHEN a bookend is
// required — using EXPLICIT frozen v4 intent — and, when a required bookend
// never became a clip, WHY (stage-specific).
//
// No DB, no network, no paid APIs — only local synthesized audio + ffmpeg.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runFfmpeg, renderTimelineToWav, masterToMp3, type TimelineClip } from "../lib/audio/assembly";
import { verifyBookends, resolveBookendRequirement, describeBookendAbsence, type BookendRequirementInput } from "../lib/audio/bookendQa";

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

// A v4 frozen-profile requirement input for `outro`, with overridable fields.
const outroReqInput = (over: Partial<BookendRequirementInput>): BookendRequirementInput => ({
  kind: "outro", clean: false, enabled: true, hasFrozenProfile: true, frozenIntent: true,
  frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: null, legacyEnvConfigured: false,
  ...over,
});

const introDurMs = 2000, dialogueStartMs = 1200;
const speechEndMs = dialogueStartMs + 4600 + 2000; // 7800
const outroStartMs = speechEndMs - 450, outroDurMs = 2500; // 7350 .. 9850

async function main() {
  console.log("\nPost-render bookend verification (real ffmpeg) + v4 requirement logic\n");
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
    const noOutroMaster = await master(dir, "no-outro", [introClip, ...dialogue]);
    const cleanMaster = await master(dir, "clean", [...dialogue]);

    // ===== Waveform measurement (executed cases) ============================
    await check("Test 12: enabled valid intro AND outro are audible; master extends beyond speech", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, goodMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(r.ok && r.introVerified && r.outroVerified, `both verified: ${r.failures.join("; ")}`);
      assert(r.outroTailMs > 300, `master extends beyond speech (tail ${r.outroTailMs} ms)`);
    });

    await check("Test 10: enabled valid outro that is silent in the master FAILS", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(!r.ok && !r.outroVerified && r.failures.some((f) => /outro/i.test(f)), `silent outro fails: ${r.failures.join("; ")}`);
    });

    await check("Test 11: enabled valid outro clipped during mastering FAILS", async () => {
      const clipped = path.join(dir, "clipped.mp3");
      await runFfmpeg(ffmpegPath, ["-y", "-i", goodMaster, "-t", "8.2", "-c", "copy", clipped]);
      const r = await verifyBookends(ffmpegPath, ffprobePath, clipped, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs, speechEndMs,
      });
      assert(!r.ok && r.failures.some((f) => /truncat/i.test(f)), `flags truncation: ${r.failures.join("; ")}`);
    });

    // A required-but-never-placed outro must FAIL — proven on a real master that
    // genuinely has no outro after the last spoken word.
    const requiredButAbsent = (reason: string) =>
      verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: true, outroPlaced: false, outroStartMs: null, outroDurationMs: null,
        outroAbsenceReason: reason, speechEndMs,
      });

    // ===== v4 requirement matrix (the fixed frozen-custom gap) ==============
    await check("v4 frozen custom: outro ENABLED with a valid asset => required", () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenRefAssetId: "outro-1" }));
      assert(req.required && req.code === "frozen_asset", `enabled+asset => required (${req.code})`);
    });

    await check("v4 frozen custom: outro ENABLED with NO asset assigned => required and FAILS (the fixed gap)", async () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenRefAssetId: null, frozenExcludedReason: null }));
      assert(req.required && req.code === "frozen_enabled_no_asset", `enabled+no-asset => required (${req.code})`);
      const detail = describeBookendAbsence("outro", { req, planHasCue: null, assetLoaded: null, loadWarning: null, themesExcluded: 0 });
      assert(/enabled in the frozen \(v4\) sound profile but no outro asset/i.test(detail), `reason: ${detail}`);
      const r = await requiredButAbsent(detail);
      assert(!r.ok, "enabled-but-unassigned outro fails the render");
    });

    await check("v4 frozen custom: outro DISABLED (intent false) => NOT required (valid absence)", () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: false, frozenRefAssetId: null }));
      assert(!req.required && req.code === "frozen_disabled", `disabled => not required (${req.code})`);
    });

    await check("Tests 5/6: v4 ENABLED bookend excluded by rights => required, fails with the exclusion reason", async () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenExcludedReason: "rights blocked (rights_revoked)" }));
      assert(req.required && req.code === "excluded_at_resolution", "rights-excluded => required");
      const detail = describeBookendAbsence("outro", { req, planHasCue: null, assetLoaded: null, loadWarning: null, themesExcluded: 0 });
      assert(/excluded at profile resolution.*rights/i.test(detail), `rights reason: ${detail}`);
      assert(!(await requiredButAbsent(detail)).ok, "rights-excluded outro fails");
    });

    await check("Test 7: v4 enabled valid outro MISSING FROM PLAN (genre gate / not planned) => fails", async () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenRefAssetId: "outro-1" }));
      const detail = describeBookendAbsence("outro", { req, planHasCue: false, assetLoaded: null, loadWarning: null, themesExcluded: 1 });
      assert(/no cue|not planned|genre/i.test(detail), `missing-from-plan reason: ${detail}`);
      assert(!(await requiredButAbsent(detail)).ok, "missing-from-plan outro fails");
    });

    await check("Test 8: v4 enabled valid outro PLANNED BUT NOT LOADED => fails with a load reason", async () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenRefAssetId: "outro-1" }));
      const detail = describeBookendAbsence("outro", {
        req, planHasCue: true, assetLoaded: false,
        loadWarning: "Sound asset 'Close Theme' skipped: rights invalid (rights_revoked).", themesExcluded: 0,
      });
      assert(/failed to load/i.test(detail), `load reason: ${detail}`);
      assert(!(await requiredButAbsent(detail)).ok, "planned-but-not-loaded outro fails");
    });

    await check("Test 9: v4 enabled valid outro LOADED BUT NOT EXECUTED => fails with an execution reason", async () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: true, frozenRefAssetId: "outro-1" }));
      const detail = describeBookendAbsence("outro", { req, planHasCue: true, assetLoaded: true, loadWarning: null, themesExcluded: 0 });
      assert(/not placed on the final timeline|execution/i.test(detail), `execution reason: ${detail}`);
      assert(!(await requiredButAbsent(detail)).ok, "loaded-but-not-executed outro fails");
    });

    // ===== v2/v3 compatibility: no fabricated intent ========================
    await check("v2/v3 compat (frozenIntent null): no asset, no exclusion => NOT required (never fabricate intent)", () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: null, frozenRefAssetId: null, frozenExcludedReason: null }));
      assert(!req.required && req.code === "profile_no_bookend", `compat no-asset => not required (${req.code})`);
    });
    await check("v2/v3 compat (frozenIntent null): a resolved asset => required", () => {
      const req = resolveBookendRequirement(outroReqInput({ frozenIntent: null, frozenRefAssetId: "outro-1" }));
      assert(req.required && req.code === "frozen_asset", "compat with asset => required");
    });

    // ===== Legacy / clean / disabled short-circuits =========================
    await check("legacy path: configured => required; env => required; unconfigured => required (must fail)", () => {
      const legacy = (id: string | null, env: boolean) => resolveBookendRequirement({
        kind: "outro", clean: false, enabled: true, hasFrozenProfile: false, frozenIntent: null,
        frozenRefAssetId: null, frozenExcludedReason: null, legacyConfiguredAssetId: id, legacyEnvConfigured: env,
      });
      assert(legacy("a", false).required && legacy("a", false).code === "legacy_configured", "legacy configured => required");
      assert(legacy(null, true).required, "legacy env fallback => required");
      assert(legacy(null, false).required && legacy(null, false).code === "legacy_unconfigured", "legacy unconfigured => required");
    });

    await check("clean and disabled short-circuit to NOT required regardless of configuration", () => {
      assert(!resolveBookendRequirement(outroReqInput({ clean: true, frozenRefAssetId: "a" })).required, "clean => not required");
      assert(!resolveBookendRequirement(outroReqInput({ enabled: false, frozenIntent: true, frozenRefAssetId: "a" })).required, "disabled toggle => not required");
    });

    await check("Test 12 (disabled/clean success): verifyBookends passes when no bookend is required", async () => {
      const disabled = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introRequired: true, introPlaced: true, introDurationMs: introDurMs,
        outroRequired: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null, speechEndMs,
      });
      assert(disabled.ok && !disabled.outroVerified && disabled.introVerified, `disabled outro passes: ${disabled.failures.join("; ")}`);
      const clean = await verifyBookends(ffmpegPath, ffprobePath, cleanMaster, {
        introRequired: false, introPlaced: false, introDurationMs: null,
        outroRequired: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null, speechEndMs,
      });
      assert(clean.ok, `clean render passes: ${clean.failures.join("; ")}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
