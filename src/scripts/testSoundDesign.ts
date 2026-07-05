// Sound-design test suite. Run: npm run test:sound-design
//
// Part 1 — pure placement-planner unit tests (no ffmpeg needed).
// Part 2 — real ffmpeg verification: renders a synthetic dialogue timeline
//          with a stinger + reaction SFX, ducks a bed under it, and MEASURES
//          that the bed is quieter under speech than in gaps (sidechain
//          proof), and that speech dominates the final mix.

import fs from "fs";
import os from "os";
import path from "path";
import {
  ReactionPlacement,
  SfxCategory,
  SfxLineContext,
  mixBedUnderForeground,
  planReactionSfx,
  planStingers,
  shiftTimelineForInsert,
} from "../lib/audio/soundDesign";
import { parseEpisodeSoundDesign } from "../lib/audio/soundDesignShared";
import { TimelineClip, getFileDurationMs, renderTimelineToWav, runFfmpeg } from "../lib/audio/assembly";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    });
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const ALL_CATEGORIES = new Set<SfxCategory>(["laugh", "crowd", "airhorn", "buzzer", "rimshot", "whoosh", "impact"]);

/** A synthetic episode: alternating lines with known tones, 5s apart. */
function makeLines(count: number, tone: string, energy: string): SfxLineContext[] {
  return Array.from({ length: count }, (_, i) => ({
    lineIndex: i,
    tone,
    energy,
    startMs: i * 5000,
    durationMs: 4000,
  }));
}

async function unitTests() {
  console.log("Placement planner:");

  await check("no reactions on calm analytical lines", () => {
    const r = planReactionSfx(makeLines(20, "analytical", "medium"), "hype", { availableCategories: ALL_CATEGORIES });
    assert(r.length === 0, `expected 0, got ${r.length}`);
  });

  await check("subtle density spaces reactions at least 45s apart", () => {
    const r = planReactionSfx(makeLines(60, "heated", "high"), "subtle", { availableCategories: ALL_CATEGORIES });
    assert(r.length > 0, "expected some reactions");
    for (let i = 1; i < r.length; i++) {
      assert(r[i].atMs - r[i - 1].atMs >= 40_000, `reactions ${i - 1}/${i} closer than spacing floor`);
    }
  });

  await check("hype density places more reactions than subtle", () => {
    const lines = makeLines(60, "heated", "high");
    const subtle = planReactionSfx(lines, "subtle", { availableCategories: ALL_CATEGORIES });
    const hype = planReactionSfx(lines, "hype", { availableCategories: ALL_CATEGORIES });
    assert(hype.length > subtle.length, `hype (${hype.length}) should exceed subtle (${subtle.length})`);
  });

  await check("air horn only appears at hype density", () => {
    const lines = makeLines(60, "heated", "high");
    const medium = planReactionSfx(lines, "medium", { availableCategories: ALL_CATEGORIES });
    assert(medium.every((p) => !p.categories.includes("airhorn")), "medium density must never air-horn");
    const hype = planReactionSfx(lines, "hype", { availableCategories: ALL_CATEGORIES });
    assert(hype.some((p) => p.categories.includes("airhorn")), "hype density should allow air horns");
  });

  await check("never places a reaction on the opening line", () => {
    const r = planReactionSfx(makeLines(60, "amused", "high"), "hype", { availableCategories: ALL_CATEGORIES });
    assert(r.every((p) => p.lineIndex !== 0), "line 0 must stay clean");
  });

  await check("unavailable categories are never planned", () => {
    const onlyRimshot = new Set<SfxCategory>(["rimshot"]);
    const r = planReactionSfx(makeLines(60, "heated", "high"), "hype", { availableCategories: onlyRimshot });
    assert(r.length === 0, "heated beats want crowd/airhorn/impact — rimshot-only library can't voice them");
    const laughs = planReactionSfx(makeLines(60, "amused", "medium"), "hype", { availableCategories: onlyRimshot });
    assert(laughs.length > 0 && laughs.every((p) => p.categories[0] === "rimshot"), "amused should fall back to rimshot");
  });

  await check("planner is deterministic", () => {
    const lines = makeLines(40, "excited", "high");
    const a = JSON.stringify(planReactionSfx(lines, "medium", { availableCategories: ALL_CATEGORIES }));
    const b = JSON.stringify(planReactionSfx(lines, "medium", { availableCategories: ALL_CATEGORIES }));
    assert(a === b, "same input must produce the same plan");
  });

  await check("stingers: light style marks topic breaks only, full marks both", () => {
    const slots = [
      { lineIndex: 10, breakKind: "segment" as const, lineStartMs: 60_000 },
      { lineIndex: 20, breakKind: "topic" as const, lineStartMs: 120_000 },
    ];
    const light = planStingers(slots, "light", [1500]);
    assert(light.length === 1 && light[0].lineIndex === 20, "light should stinger only the topic break");
    const full = planStingers(slots, "full", [1500]);
    assert(full.length === 2, "full should stinger both breaks");
    const clean = planStingers(slots, "clean", [1500]);
    assert(clean.length === 0, "clean should place nothing");
  });

  await check("stinger ends before the opening line starts", () => {
    const p = planStingers([{ lineIndex: 5, breakKind: "topic", lineStartMs: 30_000 }], "full", [1800]);
    assert(p[0].atMs + 1800 <= 30_000, "stinger must finish before the line");
  });

  await check("stingers rotate through the configured set", () => {
    const slots = [0, 1, 2, 3].map((i) => ({ lineIndex: i * 10, breakKind: "topic" as const, lineStartMs: i * 60_000 + 10_000 }));
    const p = planStingers(slots, "full", [1000, 1400]);
    assert(p[0].stingerIndex === 0 && p[1].stingerIndex === 1 && p[2].stingerIndex === 0, "rotation broken");
  });

  await check("highlight insert shifts only later clips", () => {
    const clips = [
      { startMs: 0 },
      { startMs: 10_000 },
      { startMs: 20_000 },
    ];
    const at = shiftTimelineForInsert(clips, 10_000 + 4000, 6000, 350);
    assert(at === 14_350, `insert point should be lineEnd+pad, got ${at}`);
    assert(clips[0].startMs === 0 && clips[1].startMs === 10_000, "earlier clips must not move");
    assert(clips[2].startMs === 20_000 + 6000 + 700, "later clips must shift by clip+2*pad");
  });

  await check("parseEpisodeSoundDesign tolerates junk", () => {
    assert(JSON.stringify(parseEpisodeSoundDesign(null)) === "{}", "null → {}");
    assert(JSON.stringify(parseEpisodeSoundDesign({ style: "bogus" })) === "{}", "bad style dropped");
    const ok = parseEpisodeSoundDesign({ style: "full", sfxDensity: "hype", highlights: [{ lineIndex: 3, assetId: "a" }, { bad: true }] });
    assert(ok.style === "full" && ok.sfxDensity === "hype" && ok.highlights?.length === 1, "valid fields kept, junk dropped");
  });
}

/** Measure mean RMS (dB) of a window of an audio file via ffmpeg astats. */
async function windowRmsDb(ffmpegPath: string, file: string, fromSec: number, toSec: number): Promise<number> {
  const out = await runFfmpeg(ffmpegPath, [
    "-i", file,
    "-af", `atrim=${fromSec}:${toSec},astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none`,
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  const m = out.match(/RMS level dB:\s*(-?[\d.]+)/);
  if (!m) throw new Error("astats RMS not found");
  return parseFloat(m[1]);
}

async function ffmpegTests() {
  console.log("FFmpeg mix verification:");
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-sd-test-"));

  try {
    // Synthetic "speech": band-limited noise bursts (speech-shaped envelope).
    const speechPath = path.join(dir, "speech.wav");
    await runFfmpeg(ffmpegPath, [
      "-y", "-f", "lavfi",
      "-i", "anoisesrc=color=pink:amplitude=0.25:seed=7:duration=3",
      // width_type=h: Hz units (default is Q-factor). volume lifts the band
      // to ≈-20dB RMS, matching real standardized speech clips.
      "-af", "bandpass=f=800:width_type=h:w=1200,volume=12dB,aformat=channel_layouts=stereo",
      "-ar", "44100", "-c:a", "pcm_s16le", speechPath,
    ]);
    // A short "stinger"/sfx tone.
    const tonePath = path.join(dir, "tone.wav");
    await runFfmpeg(ffmpegPath, [
      "-y", "-f", "lavfi",
      "-i", "sine=frequency=660:duration=1",
      "-af", "aformat=channel_layouts=stereo,volume=0.5",
      "-ar", "44100", "-c:a", "pcm_s16le", tonePath,
    ]);
    // A steady "bed".
    const bedPath = path.join(dir, "bed.wav");
    await runFfmpeg(ffmpegPath, [
      "-y", "-f", "lavfi",
      "-i", "sine=frequency=220:duration=8",
      "-af", "aformat=channel_layouts=stereo,volume=0.4",
      "-ar", "44100", "-c:a", "pcm_s16le", bedPath,
    ]);

    // Foreground timeline: speech at 0-3s and 8-11s, tone (sfx) at 4s.
    // The 3-8s window is a GAP where the bed should swell back up.
    const clips: TimelineClip[] = [
      { filePath: speechPath, startMs: 0, durationMs: 3000, kind: "speech", pan: 0, fadeInMs: 5, fadeOutMs: 10, gainDb: 0 },
      { filePath: tonePath, startMs: 4000, durationMs: 1000, kind: "sfx", pan: 0, fadeInMs: 10, fadeOutMs: 50, gainDb: -12 },
      { filePath: speechPath, startMs: 8000, durationMs: 3000, kind: "speech", pan: 0, fadeInMs: 5, fadeOutMs: 10, gainDb: 0 },
    ];
    const foreground = path.join(dir, "foreground.wav");

    await check("timeline with speech + sfx clips renders", async () => {
      await renderTimelineToWav(ffmpegPath, clips, foreground, { sampleRate: 44100 });
      const dur = await getFileDurationMs(ffprobePath, foreground);
      assert(Math.abs(dur - 11700) < 500, `foreground duration ${dur}ms, expected ~11700ms`);
    });

    const bedded = path.join(dir, "bedded.wav");
    await check("bed mixes under foreground (looped, faded)", async () => {
      await mixBedUnderForeground(ffmpegPath, foreground, bedPath, bedded, {
        sampleRate: 44100,
        totalMs: 11700,
        bedGainDb: -18,
      });
      const dur = await getFileDurationMs(ffprobePath, bedded);
      assert(Math.abs(dur - 11700) < 500, `bedded duration ${dur}ms`);
    });

    await check("bed DUCKS under speech and swells back in the gap (≥5dB)", async () => {
      // Isolate the ducked bed (same sidechain, no amix) and compare RMS
      // during speech (0.5-2.5s) vs during the gap (5.8-7.6s).
      const duckedBedOnly = path.join(dir, "ducked-bed-only.wav");
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-i", foreground,
        "-stream_loop", "-1",
        "-i", bedPath,
        "-filter_complex",
        `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:11.7,volume=-18dB[bed];` +
          `[bed][0:a]sidechaincompress=threshold=0.02:ratio=10:attack=150:release=750[out]`,
        "-map", "[out]",
        "-t", "11.7",
        "-c:a", "pcm_s16le",
        duckedBedOnly,
      ]);
      const duringSpeech = await windowRmsDb(ffmpegPath, duckedBedOnly, 0.5, 2.5);
      const duringGap = await windowRmsDb(ffmpegPath, duckedBedOnly, 5.8, 7.6);
      const duckDb = duringGap - duringSpeech;
      console.log(`      bed RMS under speech: ${duringSpeech.toFixed(1)}dB, in gap: ${duringGap.toFixed(1)}dB → duck depth ${duckDb.toFixed(1)}dB`);
      assert(duckDb >= 5, `expected ≥5dB of ducking, measured ${duckDb.toFixed(1)}dB`);
    });

    await check("speech dominates the bedded mix (voice ≥10dB over gap floor)", async () => {
      const speechRms = await windowRmsDb(ffmpegPath, bedded, 0.5, 2.5);
      const gapRms = await windowRmsDb(ffmpegPath, bedded, 5.8, 7.6);
      const headroom = speechRms - gapRms;
      console.log(`      mix RMS during speech: ${speechRms.toFixed(1)}dB, gap floor: ${gapRms.toFixed(1)}dB → voice headroom ${headroom.toFixed(1)}dB`);
      assert(headroom >= 10, `voice should sit ≥10dB above the gap floor, measured ${headroom.toFixed(1)}dB`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await unitTests();
  await ffmpegTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
