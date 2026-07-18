// Post-render bookend verification tests. Run: npm run test:bookend-qa
//
// REAL ffmpeg. Builds actual masters through the same render+master path the
// stitcher uses (renderTimelineToWav -> masterToMp3), then runs verifyBookends
// against the finished waveform. Proves an enabled intro/outro is audible in
// the master, that the master extends beyond the last spoken word by the outro
// tail, that a missing/clipped outro FAILS (never ships as success), and that
// an intentionally absent outro succeeds without one.
//
// No DB, no network, no paid APIs — only local synthesized audio + ffmpeg.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runFfmpeg, renderTimelineToWav, masterToMp3, type TimelineClip } from "../lib/audio/assembly";
import { verifyBookends } from "../lib/audio/bookendQa";

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
const SR = 44100;

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Band-limited pink noise shaped to ~-20 dB RMS — stands in for speech. */
async function synthSpeech(file: string, durationSec: number, band = 900) {
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi",
    "-i", `anoisesrc=color=pink:amplitude=0.25:seed=7:duration=${durationSec}`,
    "-af", `bandpass=f=${band}:width_type=h:w=1200,volume=12dB,aformat=channel_layouts=stereo`,
    "-ar", String(SR), "-c:a", "pcm_s16le", file,
  ]);
}

/** A clear musical tone — stands in for an intro/outro theme. */
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

async function main() {
  console.log("\nPost-render bookend verification (real ffmpeg)\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-bookend-"));

  try {
    const introFile = path.join(dir, "intro.wav");
    const outroFile = path.join(dir, "outro.wav");
    const l1 = path.join(dir, "l1.wav"), l2 = path.join(dir, "l2.wav"), l3 = path.join(dir, "l3.wav");
    await synthTone(introFile, 2.0, 330);
    await synthTone(outroFile, 2.5, 300);
    await synthSpeech(l1, 2.0, 700);
    await synthSpeech(l2, 2.0, 1100);
    await synthSpeech(l3, 2.0, 700);

    // Timeline: intro [0,2000], dialogue starts under the intro tail at 1200.
    const introDurMs = 2000, dialogueStartMs = 1200;
    const dialogue: TimelineClip[] = [
      speech(l1, dialogueStartMs, 2000),
      speech(l2, dialogueStartMs + 2300, 2000),
      speech(l3, dialogueStartMs + 4600, 2000),
    ];
    const speechEndMs = dialogueStartMs + 4600 + 2000; // 7800
    const outroStartMs = speechEndMs - 450, outroDurMs = 2500; // 7350 .. 9850
    const introClip = music(introFile, 0, introDurMs, 800);
    const outroClip = music(outroFile, outroStartMs, outroDurMs, 400);

    // --- Full, correct render ------------------------------------------------
    const goodMaster = await master(dir, "good", [introClip, ...dialogue, outroClip]);
    let good!: Awaited<ReturnType<typeof verifyBookends>>;
    await check("Test 8/9/10: enabled intro AND outro are audible; master extends beyond speech", async () => {
      good = await verifyBookends(ffmpegPath, ffprobePath, goodMaster, {
        introEnabled: true, introPlaced: true, introDurationMs: introDurMs,
        outroEnabled: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs,
        speechEndMs,
      });
      assert(good.ok, `verification failed: ${good.failures.join("; ")}`);
      assert(good.introVerified, `intro not verified (head RMS ${good.headRmsDb})`);
      assert(good.outroVerified, `outro not verified (tail RMS ${good.tailRmsDb})`);
      assert(good.outroTailMs > 300, `master must extend beyond speech (tail ${good.outroTailMs} ms)`);
    });

    // --- Missing outro (disappeared during mixing/encoding) ------------------
    const noOutroMaster = await master(dir, "no-outro", [introClip, ...dialogue]); // outro NOT mixed
    await check("Test 11: an enabled+placed outro that is missing from the master FAILS", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introEnabled: true, introPlaced: true, introDurationMs: introDurMs,
        // the plan intended an outro here, but it never reached the mix
        outroEnabled: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs,
        speechEndMs,
      });
      assert(!r.ok, "a missing outro must fail verification");
      assert(!r.outroVerified, "outro must not be reported verified");
      assert(r.failures.some((f) => /outro/i.test(f)), `failure must name the outro: ${r.failures.join("; ")}`);
    });

    // --- Clipped outro (master truncated before the outro completes) ---------
    const clippedMaster = path.join(dir, "clipped.mp3");
    await runFfmpeg(ffmpegPath, ["-y", "-i", goodMaster, "-t", "8.2", "-c", "copy", clippedMaster]);
    await check("Test 12: a master truncated before the outro completes FAILS QA", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, clippedMaster, {
        introEnabled: true, introPlaced: true, introDurationMs: introDurMs,
        outroEnabled: true, outroPlaced: true, outroStartMs, outroDurationMs: outroDurMs,
        speechEndMs,
      });
      assert(!r.ok, "a clipped outro must fail verification");
      assert(r.failures.some((f) => /truncat/i.test(f)), `failure must flag truncation: ${r.failures.join("; ")}`);
    });

    // --- Intentionally absent outro (clean/disabled) -------------------------
    await check("Test 13: an intentionally disabled outro succeeds without one", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introEnabled: true, introPlaced: true, introDurationMs: introDurMs,
        outroEnabled: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null,
        speechEndMs,
      });
      assert(r.ok, `disabled outro must pass: ${r.failures.join("; ")}`);
      assert(!r.outroVerified, "no outro to verify");
      assert(r.introVerified, "intro still verified");
    });

    await check("an enabled outro with no asset placed is an honest skip (not a failure)", async () => {
      const r = await verifyBookends(ffmpegPath, ffprobePath, noOutroMaster, {
        introEnabled: true, introPlaced: true, introDurationMs: introDurMs,
        outroEnabled: true, outroPlaced: false, outroStartMs: null, outroDurationMs: null,
        speechEndMs,
      });
      assert(r.ok, `honest no-asset skip must pass: ${r.failures.join("; ")}`);
      assert(r.checks.some((c) => c.name === "outro" && c.status === "skip"), "outro recorded as skip");
    });

    await check("a fully clean (dialogue-only) render passes with no bookends required", async () => {
      const cleanMaster = await master(dir, "clean", [...dialogue]);
      const r = await verifyBookends(ffmpegPath, ffprobePath, cleanMaster, {
        introEnabled: false, introPlaced: false, introDurationMs: null,
        outroEnabled: false, outroPlaced: false, outroStartMs: null, outroDurationMs: null,
        speechEndMs,
      });
      assert(r.ok, `clean render must pass: ${r.failures.join("; ")}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
