// LIVE evidence that meaning-aware audio QA can actually RUN.
//
// Before this branch, `audioSemanticQa` had exactly one transcription backend
// (OpenAI) and this deployment has no funded OpenAI account — so semantic QA
// could only ever fail closed, never verify anything. Production already carries
// a DEEPGRAM_API_KEY, so a Deepgram diarized backend was added.
//
// This script proves the backend end to end against REAL providers:
//   1. render real speech with Fish (s2.1-pro-free)
//   2. concatenate to one master with ffmpeg
//   3. transcribe it with live Deepgram diarization
//   4. run the real QA comparison against the approved lines
//
// It publishes nothing.
//
//   node ../pod/node_modules/tsx/dist/cli.mjs --conditions=react-server src/scripts/runLiveSemanticQaEvidence.ts

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { runAudioSemanticQa, resolveSemanticQaRequirement } from "../lib/audio/audioSemanticQa";
import type { ExpectedSpokenLine } from "../lib/audio/audioSemanticQa";

const OUT = path.resolve(process.cwd(), "artifacts/live-quality-evidence");
const VOICE = (process.env.LIVE_QA_VOICE_ID || "36780e7121b84d5c9c24cbd2f15eaaa4").trim();

// Deliberately loaded with the things semantic QA is supposed to protect:
// proper names, numbers, and a score. If ASR or TTS mangles any of these, the
// critical-token check must notice.
const LINES: ExpectedSpokenLine[] = [
  { lineIndex: 0, speakerHostId: "a", speakerName: "Zabala", text: "The American League won four to nothing, and the National League managed exactly three hits all night." },
  { lineIndex: 1, speakerHostId: "b", speakerName: "Mercer", text: "Eleven pitchers combined for that shutout. Dylan Cease started it and threw twelve pitches." },
  { lineIndex: 2, speakerHostId: "a", speakerName: "Zabala", text: "Mike Trout got the loudest ovation of the evening in Philadelphia." },
  { lineIndex: 3, speakerHostId: "b", speakerName: "Mercer", text: "Fifteen strikeouts in nine innings ties the record set back in two thousand twelve." },
];

function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} failed: ${String(r.stderr || "").slice(-400)}`);
  return r;
}

async function main() {
  loadEnv(path.resolve(process.cwd(), "../pod/.env"));
  loadEnv(path.resolve(process.cwd(), "../pod/.env.coolify.local"));
  fs.mkdirSync(OUT, { recursive: true });

  // Force the Deepgram path on for this evidence run. NODE_ENV stays unset so
  // this script never depends on the fail-closed branch.
  process.env.TTS_TRANSCRIPT_QA_ENABLED = "true";
  process.env.TRANSCRIPT_QA_PROVIDER = "deepgram";

  const req = resolveSemanticQaRequirement();
  console.log(`Semantic QA provider: ${req.provider} (supported=${req.providerSupported})`);
  if (req.missing.length) {
    console.error(`MISSING CONFIGURATION: ${req.missing.join(", ")}`);
    process.exit(1);
  }
  if (!process.env.FISH_API_KEY) {
    console.error("MISSING CONFIGURATION: FISH_API_KEY");
    process.exit(1);
  }

  // --- 1. Render each line with live Fish -----------------------------------
  console.log("\n[1/3] Rendering real speech with Fish…");
  const fish = new FishTTSProvider();
  const parts: string[] = [];
  for (const line of LINES) {
    const res = await fish.synthesizeSpeech({
      text: line.text,
      voiceId: VOICE,
      format: "mp3",
    } as Parameters<FishTTSProvider["synthesizeSpeech"]>[0]);
    const buf = (res as { audioBuffer: Buffer }).audioBuffer;
    const f = path.join(OUT, `qa-line-${line.lineIndex}.mp3`);
    fs.writeFileSync(f, buf);
    parts.push(f);
    console.log(`   line ${line.lineIndex}: ${(buf.length / 1024).toFixed(0)}KB`);
  }

  // --- 2. Concatenate -------------------------------------------------------
  const listFile = path.join(OUT, "qa-concat.txt");
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const master = path.join(OUT, "semantic-qa-master.mp3");
  run(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", master]);
  const bytes = fs.statSync(master).size;
  console.log(`\n[2/3] Master: ${master} (${(bytes / 1024).toFixed(0)}KB)`);

  // --- 3. Live semantic QA --------------------------------------------------
  console.log("\n[3/3] Running live diarized semantic QA…");
  const report = await runAudioSemanticQa({
    audio: fs.readFileSync(master),
    mimeType: "audio/mpeg",
    expected: LINES,
  });

  console.log(`   status=${report.status} provider=${report.provider} model=${report.model}`);
  console.log(`   wordErrorRate=${report.wordErrorRate}`);
  console.log(`   criticalTokenMissRate=${report.criticalTokenMissRate}`);
  console.log(`   speakerAttributionErrorRate=${report.speakerAttributionErrorRate}`);
  console.log(`   speakerMap=${JSON.stringify(report.speakerMap)}`);
  if (report.failures.length) console.log(`   failures: ${report.failures.join(" | ")}`);
  if (report.warnings.length) console.log(`   warnings: ${report.warnings.join(" | ")}`);
  console.log(`\n   TRANSCRIPT: ${(report.transcript || "").slice(0, 600)}`);

  fs.writeFileSync(path.join(OUT, "semantic-qa-report.json"), JSON.stringify({ ranAt: new Date().toISOString(), published: false, expected: LINES, report }, null, 2));

  const ranForReal = report.status !== "not_run" && report.provider === "deepgram";
  console.log(`\n${ranForReal ? "SEMANTIC QA RAN AGAINST LIVE PROVIDERS" : "SEMANTIC QA DID NOT RUN"}`);
  process.exit(ranForReal ? 0 : 1);
}

main().catch((e) => {
  console.error("LIVE SEMANTIC QA EVIDENCE FAILED:", e?.message || e);
  process.exit(1);
});
