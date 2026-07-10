// A/B sample generator: renders the same fixture dialogue through the OLD
// pipeline (isolated per-line TTS, fixed 450ms silence, hard MP3 concat,
// single-pass loudnorm) and the NEW pipeline (delivery-aware TTS, planned
// conversational timeline, room tone, stereo seating, two-pass master), so
// the difference can be heard side by side.
//
//   npx tsx src/scripts/abSample.ts            # uses TTS_PROVIDER if configured
//   npx tsx src/scripts/abSample.ts --offline  # Windows SAPI voices, no API keys
//
// Output: samples/before.mp3 and samples/after.mp3 (+ QA report for both).

import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  PlannedLine,
  getFileDurationMs,
  masterToMp3,
  planConversationTimeline,
  renderTimelineToWav,
  runFfmpeg,
  standardizeClipToWav,
} from "../lib/audio/assembly";
import { analyzeEpisodeAudio } from "../lib/audio/audioQa";
import { stripAudioTags } from "../lib/audio/speechText";
import { ElevenLabsTTSProvider } from "../lib/providers/tts/elevenlabs";
import { CartesiaTTSProvider } from "../lib/providers/tts/cartesia";
import { OpenAITTSProvider } from "../lib/providers/tts/openai";
import { SynthesizeSpeechInput, TTSProvider } from "../lib/providers/tts/types";

interface FixtureLine {
  lineIndex: number;
  speaker: string;
  text: string;
  tone: string;
  energy: "low" | "medium" | "high";
  pauseBefore: "none" | "beat" | "breath" | "long";
  isInterruption: boolean;
}

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

const fixturePath = path.join(__dirname, "fixtures", "abSampleScript.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const lines: FixtureLine[] = fixture.lines;

const offline =
  process.argv.includes("--offline") ||
  !process.env.TTS_PROVIDER ||
  process.env.TTS_PROVIDER === "stub";

const outDir = path.join(process.cwd(), "samples");
const workDir = path.join(os.tmpdir(), "take-machine-ab-sample");

function resolveProvider(): TTSProvider {
  switch ((process.env.TTS_PROVIDER || "").toLowerCase()) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider();
    case "cartesia":
      return new CartesiaTTSProvider();
    case "openai":
      return new OpenAITTSProvider();
    default:
      throw new Error("No real TTS_PROVIDER configured — run with --offline.");
  }
}

function voiceIdFor(speaker: string): string {
  const isA = speaker === "Max Voltage";
  return (
    (isA ? process.env.SAMPLE_VOICE_A : process.env.SAMPLE_VOICE_B) ||
    (isA
      ? process.env.ELEVENLABS_MAX_VOLTAGE_VOICE_ID || process.env.CARTESIA_MAX_VOLTAGE_VOICE_ID
      : process.env.ELEVENLABS_DR_LINEBREAK_VOICE_ID || process.env.CARTESIA_DR_LINEBREAK_VOICE_ID) ||
    (isA ? "ash" : "onyx") // openai fallback voices
  );
}

/** Offline synthesis via Windows SAPI — same voices for before & after so
 * only the pipeline differences are audible. `expressive` adds the rate
 * variation the new pipeline requests from real engines. */
async function sapiSynthesize(
  items: { text: string; speaker: string; rate: number; outPath: string }[]
): Promise<void> {
  const manifestPath = path.join(workDir, "sapi-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(items));
  const ps1Path = path.join(workDir, "sapi-render.ps1");
  fs.writeFileSync(
    ps1Path,
    `
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw "${manifestPath.replace(/\\/g, "\\\\")}" | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
foreach ($item in $items) {
  $target = if ($item.speaker -eq "Max Voltage") { $voices | Where-Object { $_ -match "David" } | Select-Object -First 1 } else { $voices | Where-Object { $_ -match "Zira" } | Select-Object -First 1 }
  if ($target) { $synth.SelectVoice($target) }
  $synth.Rate = $item.rate
  $synth.SetOutputToWaveFile($item.outPath)
  $synth.Speak($item.text)
}
$synth.SetOutputToNull()
$synth.Dispose()
`
  );
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`SAPI render failed (${code}): ${stderr}`))
    );
  });
}

async function synthesizeAll(mode: "before" | "after"): Promise<Map<number, string>> {
  const files = new Map<number, string>();

  if (offline) {
    const items = lines.map((line) => {
      const outPath = path.join(workDir, `${mode}-${line.lineIndex}.wav`);
      files.set(line.lineIndex, outPath);
      // Before: flat default rate for every line (legacy behavior).
      // After: rate follows the script's energy, like a steerable engine would.
      const rate =
        mode === "before" ? 0 : line.energy === "high" ? 2 : line.energy === "low" ? -2 : 0;
      return { text: stripAudioTags(line.text), speaker: line.speaker, rate, outPath };
    });
    await sapiSynthesize(items);
    return files;
  }

  const provider = resolveProvider();
  for (const line of lines) {
    const outPath = path.join(workDir, `${mode}-${line.lineIndex}.bin`);

    let input: SynthesizeSpeechInput;
    if (mode === "before") {
      // Legacy call shape: bare text, no context, no delivery metadata.
      input = {
        text: stripAudioTags(line.text),
        voiceId: voiceIdFor(line.speaker),
        format: "mp3",
      };
    } else {
      const sameSpeaker = lines.filter((l) => l.speaker === line.speaker);
      const idx = sameSpeaker.findIndex((l) => l.lineIndex === line.lineIndex);
      input = {
        text: line.text,
        voiceId: voiceIdFor(line.speaker),
        speakerName: line.speaker,
        tone: line.tone,
        energy: line.energy,
        isInterruption: line.isInterruption,
        previousText: idx > 0 ? stripAudioTags(sameSpeaker[idx - 1].text) : undefined,
        nextText:
          idx < sameSpeaker.length - 1 ? stripAudioTags(sameSpeaker[idx + 1].text) : undefined,
        voiceDirection: `You are "${line.speaker}", a sports debate podcast host mid-episode, talking to your co-host.`,
        format: "mp3",
      };
    }

    console.log(`  [${mode}] synthesizing line ${line.lineIndex} (${line.speaker})...`);
    const result = await provider.synthesizeSpeech(input);
    fs.writeFileSync(outPath, result.audioBuffer);
    files.set(line.lineIndex, outPath);
  }
  return files;
}

/** Legacy assembly: standardize to MP3, fixed 450ms silences, concat -c copy,
 * single-pass dynamic loudnorm. Deliberately reproduces the old sound. */
async function renderBefore(files: Map<number, string>, outPath: string): Promise<void> {
  const parts: string[] = [];
  const silPath = path.join(workDir, "before-sil.mp3");
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "0.45", "-c:a", "libmp3lame", "-b:a", "192k", silPath,
  ]);

  for (const line of lines) {
    const std = path.join(workDir, `before-std-${line.lineIndex}.mp3`);
    await runFfmpeg(ffmpegPath, [
      "-y", "-i", files.get(line.lineIndex)!,
      "-ar", "44100", "-ac", "2", "-b:a", "192k", std,
    ]);
    if (parts.length > 0) parts.push(silPath);
    parts.push(std);
  }

  const concatTxt = path.join(workDir, "before-concat.txt");
  fs.writeFileSync(concatTxt, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const rawPath = path.join(workDir, "before-raw.mp3");
  await runFfmpeg(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", concatTxt, "-c", "copy", rawPath]);
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", rawPath, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "libmp3lame", "-b:a", "192k", outPath,
  ]);
}

/** New assembly: conversational timeline + room tone + two-pass master. */
async function renderAfter(files: Map<number, string>, outPath: string): Promise<void> {
  const planned: PlannedLine[] = [];
  for (const line of lines) {
    const wav = path.join(workDir, `after-std-${line.lineIndex}.wav`);
    await standardizeClipToWav(ffmpegPath, files.get(line.lineIndex)!, wav);
    planned.push({
      filePath: wav,
      durationMs: await getFileDurationMs(ffprobePath, wav),
      lineIndex: line.lineIndex,
      hostSlot: line.speaker === "Max Voltage" ? 0 : 1,
      pauseBefore: line.pauseBefore,
      isInterruption: line.isInterruption,
      segmentBreak: "none",
    });
  }
  const clips = planConversationTimeline(planned);
  const mixWav = path.join(workDir, "after-mix.wav");
  await renderTimelineToWav(ffmpegPath, clips, mixWav);
  await masterToMp3(ffmpegPath, mixWav, outPath, { targetLufs: -16 });
}

async function report(label: string, filePath: string): Promise<void> {
  const qa = await analyzeEpisodeAudio(ffmpegPath, filePath, {
    scriptedPauses: lines.map((l) => l.pauseBefore),
  });
  console.log(`\n=== QA: ${label} (${path.basename(filePath)}) ===`);
  for (const c of qa.checks) {
    console.log(`  ${c.status.toUpperCase().padEnd(7)} ${c.name}: ${c.value}`);
  }
}

async function main() {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Mode: ${offline ? "OFFLINE (Windows SAPI voices)" : `TTS provider '${process.env.TTS_PROVIDER}'`}`);
  if (offline) {
    console.log("Note: offline mode demonstrates script pacing + assembly changes.");
    console.log("Configure a real TTS_PROVIDER to hear the full voice/delivery upgrade.\n");
  }

  console.log("Synthesizing BEFORE (legacy pipeline)...");
  const beforeFiles = await synthesizeAll("before");
  const beforePath = path.join(outDir, "before.mp3");
  await renderBefore(beforeFiles, beforePath);

  console.log("Synthesizing AFTER (new pipeline)...");
  const afterFiles = await synthesizeAll("after");
  const afterPath = path.join(outDir, "after.mp3");
  await renderAfter(afterFiles, afterPath);

  await report("BEFORE — legacy", beforePath);
  await report("AFTER — overhauled", afterPath);

  console.log(`\nDone. Listen and compare:\n  ${beforePath}\n  ${afterPath}`);
}

main().catch((err) => {
  console.error("A/B sample generation failed:", err);
  process.exit(1);
});
