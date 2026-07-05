// Starter sports sound pack — every asset SYNTHESIZED from scratch with
// ffmpeg (sine/noise sources + envelopes), so the pack is 100% original
// work with zero licensing exposure: no downloaded music, no sampled
// broadcast audio. License on every seeded row:
// "Original (generated in-house) — no third-party rights".
//
// It's a deliberately punchy synth-sports aesthetic (think arena electro),
// good enough to prove the produced-audio layer end to end; the operator
// can replace any piece with licensed material via /admin/sound-design.
//
// NOTE: laughter is NOT seeded — convincing human laughter can't be
// synthesized from primitives and we refuse to fake-source it. The "laugh"
// SFX category stays empty until the operator uploads a licensed laugh pack.

import fs from "fs";
import path from "path";
import os from "os";
import { runFfmpeg } from "./assembly";

export interface GeneratedAssetSpec {
  name: string;
  kind: "theme_intro" | "theme_outro" | "stinger" | "bed" | "sfx";
  category: string | null;
  tags: string[];
  fileName: string;
  /** aevalsrc expression pair [left,right] OR a full lavfi input string. */
  lavfi: string;
  durationSec: number;
  /** Post filters applied after synthesis (EQ/reverb-ish polish). */
  post?: string;
}

// -- Synthesis building blocks (aevalsrc expressions) ------------------------
// t = seconds. Patterns are built from gated oscillators + exponential decays.

// Four-on-the-floor kick at 128bpm (beat = 0.46875s).
const KICK = "0.9*sin(2*PI*52*t)*exp(-mod(t,0.46875)*22)";
// Offbeat hat ticks.
const HAT = "0.12*(random(0)-0.5)*exp(-mod(t+0.234375,0.46875)*90)";
// Gated eighth-note synth bass on E (82.4Hz), square-ish via tanh drive.
const BASS = "0.5*tanh(3*sin(2*PI*82.41*t))*(0.55+0.45*sin(2*PI*4.2667*t))";
// Power-chord pad: E3+B3+E4 with slow swell.
const PAD = "(0.16*sin(2*PI*164.81*t)+0.16*sin(2*PI*246.94*t)+0.12*sin(2*PI*329.63*t))";
// Rising lead arp for the intro's back half.
const ARP =
  "0.22*sin(2*PI*(329.63+mod(floor(t*4),4)*82.4)*t)*exp(-mod(t,0.25)*10)*gt(t,3.75)";

export const STARTER_PACK: GeneratedAssetSpec[] = [
  {
    name: "Arena Charge (intro theme)",
    kind: "theme_intro",
    category: null,
    tags: ["sports", "electro", "upbeat", "seed"],
    fileName: "theme-intro-arena-charge.mp3",
    durationSec: 8.5,
    lavfi:
      `aevalsrc=exprs='${KICK}+${HAT}+${BASS}+${PAD}*min(t/2,1)+${ARP}` +
      `|${KICK}+${HAT}+${BASS}+${PAD}*min(t/2,1)+${ARP}':s=44100`,
    post: "highpass=f=35,lowpass=f=9000,acompressor=threshold=-14dB:ratio=3:attack=8:release=120:makeup=3dB,afade=t=out:st=7.2:d=1.3",
  },
  {
    name: "Final Whistle (outro theme)",
    kind: "theme_outro",
    category: null,
    tags: ["sports", "electro", "resolving", "seed"],
    fileName: "theme-outro-final-whistle.mp3",
    durationSec: 7,
    lavfi:
      `aevalsrc=exprs='${KICK}*max(1-t/5,0)+${PAD}+0.2*sin(2*PI*220*t)*exp(-mod(t,0.9375)*6)` +
      `|${KICK}*max(1-t/5,0)+${PAD}+0.2*sin(2*PI*220*t)*exp(-mod(t,0.9375)*6)':s=44100`,
    post: "highpass=f=35,lowpass=f=8000,acompressor=threshold=-14dB:ratio=3:attack=8:release=150:makeup=2.5dB,afade=t=out:st=5:d=2",
  },
  {
    name: "Slam Riser (stinger)",
    kind: "stinger",
    category: null,
    tags: ["riser", "impact", "transition", "seed"],
    fileName: "stinger-slam-riser.mp3",
    durationSec: 1.8,
    // Chirp riser into a sub impact + noise splash.
    lavfi:
      "aevalsrc=exprs='0.35*sin(2*PI*(180+900*t*t)*t)*min(t/1.1,1)*lt(t,1.15)" +
      "+0.9*sin(2*PI*46*t)*exp(-max(t-1.15,0)*16)*gt(t,1.15)" +
      "+0.5*(random(0)-0.5)*exp(-max(t-1.15,0)*22)*gt(t,1.15)" +
      "|0.35*sin(2*PI*(180+900*t*t)*t)*min(t/1.1,1)*lt(t,1.15)" +
      "+0.9*sin(2*PI*46*t)*exp(-max(t-1.15,0)*16)*gt(t,1.15)" +
      "+0.5*(random(0)-0.5)*exp(-max(t-1.15,0)*22)*gt(t,1.15)':s=44100",
    post: "highpass=f=30,lowpass=f=10000,afade=t=out:st=1.55:d=0.25",
  },
  {
    name: "Drum Hit (stinger)",
    kind: "stinger",
    category: null,
    tags: ["drum", "punchy", "transition", "seed"],
    fileName: "stinger-drum-hit.mp3",
    durationSec: 1.2,
    // Tom pattern: three descending hits then a crash of noise.
    lavfi:
      "aevalsrc=exprs='0.8*sin(2*PI*180*t)*exp(-mod(t,0.22)*30)*lt(t,0.22)" +
      "+0.8*sin(2*PI*140*t)*exp(-mod(t-0.22,0.22)*30)*between(t,0.22,0.44)" +
      "+0.8*sin(2*PI*100*t)*exp(-mod(t-0.44,0.22)*30)*between(t,0.44,0.66)" +
      "+0.45*(random(0)-0.5)*exp(-max(t-0.66,0)*9)*gt(t,0.66)" +
      "|0.8*sin(2*PI*180*t)*exp(-mod(t,0.22)*30)*lt(t,0.22)" +
      "+0.8*sin(2*PI*140*t)*exp(-mod(t-0.22,0.22)*30)*between(t,0.22,0.44)" +
      "+0.8*sin(2*PI*100*t)*exp(-mod(t-0.44,0.22)*30)*between(t,0.44,0.66)" +
      "+0.45*(random(0)-0.5)*exp(-max(t-0.66,0)*9)*gt(t,0.66)':s=44100",
    post: "highpass=f=40,lowpass=f=11000,afade=t=out:st=0.95:d=0.25",
  },
  {
    name: "Whoosh Cut (stinger)",
    kind: "stinger",
    category: null,
    tags: ["whoosh", "fast", "transition", "seed"],
    fileName: "stinger-whoosh-cut.mp3",
    durationSec: 1.0,
    lavfi:
      "aevalsrc=exprs='0.6*(random(0)-0.5)*exp(-abs(t-0.45)*7)" +
      "|0.6*(random(0)-0.5)*exp(-abs(t-0.5)*7)':s=44100",
    post: "bandpass=f=1400:width_type=h:w=1800,afade=t=in:d=0.15,afade=t=out:st=0.7:d=0.3",
  },
  {
    name: "Fast Break (music bed)",
    kind: "bed",
    category: null,
    tags: ["bed", "instrumental", "upbeat", "loop", "seed"],
    fileName: "bed-fast-break.mp3",
    durationSec: 24,
    // Pulsing minor pad + soft kick — engineered to sit UNDER speech:
    // narrow spectrum, no transients above 5k, steady rhythm.
    lavfi:
      "aevalsrc=exprs='0.35*sin(2*PI*49*t)*exp(-mod(t,0.9375)*10)" +
      "+(0.14*sin(2*PI*146.83*t)+0.12*sin(2*PI*196*t)+0.1*sin(2*PI*293.66*t))*(0.7+0.3*sin(2*PI*1.0667*t))" +
      "+0.05*(random(0)-0.5)" +
      "|0.35*sin(2*PI*49*t)*exp(-mod(t,0.9375)*10)" +
      "+(0.14*sin(2*PI*146.83*t)+0.12*sin(2*PI*196*t)+0.1*sin(2*PI*293.66*t))*(0.7+0.3*sin(2*PI*1.0667*t+0.5))" +
      "+0.05*(random(0)-0.5)':s=44100",
    post: "highpass=f=45,lowpass=f=5200,acompressor=threshold=-18dB:ratio=2.5:attack=20:release=300",
  },
  {
    name: "Air Horn Blast (sfx)",
    kind: "sfx",
    category: "airhorn",
    tags: ["hype", "reaction", "seed"],
    fileName: "sfx-air-horn.mp3",
    durationSec: 1.4,
    // Three detuned reeds with vibrato — the classic stadium horn cluster.
    lavfi:
      "aevalsrc=exprs='(0.3*tanh(4*sin(2*PI*415*t+4*sin(2*PI*6*t)))" +
      "+0.3*tanh(4*sin(2*PI*440*t+4*sin(2*PI*6.3*t)))" +
      "+0.25*tanh(4*sin(2*PI*466*t+4*sin(2*PI*5.8*t))))*min(t/0.05,1)" +
      "|(0.3*tanh(4*sin(2*PI*415*t+4*sin(2*PI*6*t)))" +
      "+0.3*tanh(4*sin(2*PI*440*t+4*sin(2*PI*6.3*t)))" +
      "+0.25*tanh(4*sin(2*PI*466*t+4*sin(2*PI*5.8*t))))*min(t/0.05,1)':s=44100",
    post: "highpass=f=200,lowpass=f=7000,afade=t=out:st=1.0:d=0.4",
  },
  {
    name: "Wrong Answer Buzzer (sfx)",
    kind: "sfx",
    category: "buzzer",
    tags: ["buzzer", "reaction", "seed"],
    fileName: "sfx-buzzer.mp3",
    durationSec: 0.9,
    lavfi:
      "aevalsrc=exprs='0.5*tanh(8*sin(2*PI*138*t))*(0.8+0.2*sin(2*PI*47*t))" +
      "|0.5*tanh(8*sin(2*PI*138*t))*(0.8+0.2*sin(2*PI*47*t))':s=44100",
    post: "highpass=f=80,lowpass=f=4500,afade=t=out:st=0.65:d=0.25",
  },
  {
    name: "Rimshot (sfx)",
    kind: "sfx",
    category: "rimshot",
    tags: ["comedy", "reaction", "seed"],
    fileName: "sfx-rimshot.mp3",
    durationSec: 0.8,
    // ba-dum-tss: two toms then a noise "cymbal".
    lavfi:
      "aevalsrc=exprs='0.8*sin(2*PI*190*t)*exp(-mod(t,0.14)*45)*lt(t,0.14)" +
      "+0.8*sin(2*PI*150*t)*exp(-(t-0.14)*45)*between(t,0.14,0.3)" +
      "+0.4*(random(0)-0.5)*exp(-max(t-0.3,0)*7)*gt(t,0.3)" +
      "|0.8*sin(2*PI*190*t)*exp(-mod(t,0.14)*45)*lt(t,0.14)" +
      "+0.8*sin(2*PI*150*t)*exp(-(t-0.14)*45)*between(t,0.14,0.3)" +
      "+0.4*(random(0)-0.5)*exp(-max(t-0.3,0)*7)*gt(t,0.3)':s=44100",
    post: "highpass=f=90,lowpass=f=12000",
  },
  {
    name: "Crowd Surge (sfx)",
    kind: "sfx",
    category: "crowd",
    tags: ["crowd", "reaction", "swell", "seed"],
    fileName: "sfx-crowd-surge.mp3",
    durationSec: 2.2,
    // Band-limited noise swell shaped like a crowd roar rising and settling.
    lavfi:
      "aevalsrc=exprs='(random(0)-0.5)*min(t/0.6,1)*max(1-max(t-1.2,0)/1.0,0)*0.9" +
      "|(random(0)-0.5)*min(t/0.7,1)*max(1-max(t-1.3,0)/0.9,0)*0.9':s=44100",
    post: "bandpass=f=900:width_type=h:w=1400,lowpass=f=3400,highpass=f=250,acompressor=threshold=-20dB:ratio=3:attack=40:release=200",
  },
  {
    name: "Big Impact (sfx)",
    kind: "sfx",
    category: "impact",
    tags: ["impact", "reaction", "seed"],
    fileName: "sfx-big-impact.mp3",
    durationSec: 1.3,
    lavfi:
      "aevalsrc=exprs='0.95*sin(2*PI*44*t)*exp(-t*7)+0.4*(random(0)-0.5)*exp(-t*14)" +
      "|0.95*sin(2*PI*44*t)*exp(-t*7)+0.4*(random(0)-0.5)*exp(-t*14)':s=44100",
    post: "highpass=f=28,lowpass=f=6000",
  },
  {
    name: "Whoosh Pass (sfx)",
    kind: "sfx",
    category: "whoosh",
    tags: ["whoosh", "reaction", "seed"],
    fileName: "sfx-whoosh-pass.mp3",
    durationSec: 0.9,
    lavfi:
      "aevalsrc=exprs='0.55*(random(0)-0.5)*exp(-abs(t-0.4)*9)" +
      "|0.55*(random(0)-0.5)*exp(-abs(t-0.45)*9)':s=44100",
    post: "bandpass=f=1800:width_type=h:w=2200,afade=t=in:d=0.12,afade=t=out:st=0.62:d=0.28",
  },
];

export const SEED_LICENSE = "Original (generated in-house with ffmpeg synthesis) — no third-party rights; CC0 equivalent";

/** Synthesize one spec to an MP3 file. Returns { filePath, durationMs }. */
export async function generatePackAsset(
  ffmpegPath: string,
  spec: GeneratedAssetSpec,
  outDir: string
): Promise<{ filePath: string; durationMs: number }> {
  const outPath = path.join(outDir, spec.fileName);
  const chain = [spec.post, "alimiter=limit=0.891"].filter(Boolean).join(",");
  await runFfmpeg(ffmpegPath, [
    "-y",
    "-f", "lavfi",
    "-i", spec.lavfi,
    "-t", String(spec.durationSec),
    "-af", chain,
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    outPath,
  ]);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error(`Failed to synthesize ${spec.name}`);
  }
  return { filePath: outPath, durationMs: Math.round(spec.durationSec * 1000) };
}

/** Synthesize the whole pack into a temp dir. */
export async function generateStarterPack(
  ffmpegPath: string
): Promise<{ dir: string; assets: Array<GeneratedAssetSpec & { filePath: string; durationMs: number }> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-soundpack-"));
  const assets: Array<GeneratedAssetSpec & { filePath: string; durationMs: number }> = [];
  for (const spec of STARTER_PACK) {
    const { filePath, durationMs } = await generatePackAsset(ffmpegPath, spec, dir);
    assets.push({ ...spec, filePath, durationMs });
  }
  return { dir, assets };
}
