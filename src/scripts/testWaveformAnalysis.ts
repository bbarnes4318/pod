// Waveform silence/gap analysis tests (PR 3, REAL ffmpeg).
// Run: npm run test:waveform-analysis
//
// Synthesized local WAV fixtures + real ffmpeg/ffprobe. No network/paid APIs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../lib/audio/assembly";
import { analyzeSegmentSilence, resolveWaveformConfig } from "../lib/audio/waveformAnalysis";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const cfg = resolveWaveformConfig();

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

async function main() {
  console.log("\nWaveform silence analysis (real ffmpeg)\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-wf-"));
  try {
    // 400ms lead silence + 1000ms clearly-audible "speech" (a sine body, well
    // above the -40 dB threshold with crisp edges) + 300ms trail silence.
    const speech = path.join(dir, "speech.wav");
    await runFfmpeg(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=420:duration=1",
      "-af", "volume=0.5,adelay=400|400,apad=pad_dur=0.3,aformat=channel_layouts=stereo", "-ar", "44100", "-c:a", "pcm_s16le", speech]);
    // Pure digital silence.
    const silent = path.join(dir, "silent.wav");
    await runFfmpeg(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1.0", "-c:a", "pcm_s16le", silent]);
    // Speech with NO edge silence (full-length audible tone).
    const full = path.join(dir, "full.wav");
    await runFfmpeg(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=520:duration=1.2",
      "-af", "volume=0.5,aformat=channel_layouts=stereo", "-ar", "44100", "-c:a", "pcm_s16le", full]);

    await check("leading + trailing silence measured; spoken duration != file duration", async () => {
      const r = await analyzeSegmentSilence(ffmpeg, ffprobe, speech, cfg);
      assert(near(r.durationMs, 1700, 120), `file dur ~1700 (${r.durationMs})`);
      assert(near(r.leadSilenceMs, 400, 150), `lead ~400 (${r.leadSilenceMs})`);
      assert(near(r.trailSilenceMs, 300, 180), `trail ~300 (${r.trailSilenceMs})`);
      assert(r.speechDurationMs < r.durationMs && r.speechDurationMs > 700, `spoken window ${r.speechDurationMs}`);
    });

    await check("pure digital silence -> ~zero spoken duration", async () => {
      const r = await analyzeSegmentSilence(ffmpeg, ffprobe, silent, cfg);
      assert(r.speechDurationMs < 150, `near-zero speech (${r.speechDurationMs})`);
    });

    await check("continuous speech with no edge silence -> ~no lead/trail", async () => {
      const r = await analyzeSegmentSilence(ffmpeg, ffprobe, full, cfg);
      assert(r.leadSilenceMs < 120 && r.trailSilenceMs < 200, `no edge silence (${r.leadSilenceMs}/${r.trailSilenceMs})`);
      assert(r.speechDurationMs > r.durationMs - 250, "almost all audible");
    });

    await check("measured silence never exceeds the file duration", async () => {
      const r = await analyzeSegmentSilence(ffmpeg, ffprobe, silent, cfg);
      assert(r.leadSilenceMs + r.trailSilenceMs <= r.durationMs + 1, "bounded by file");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
