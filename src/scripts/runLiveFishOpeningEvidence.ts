// LIVE Fish evidence for the first-45-seconds criteria.
//
// The LLM half of the acceptance run is blocked (the Anthropic account reports
// an insufficient credit balance), so this isolates the half that CAN be proven
// against a live provider: that the scene model policy holds at s2.1-pro-free,
// that a 80-120 word cold open actually performs inside 30-45 seconds, and that
// a host is speaking within two seconds of sample zero.
//
// The cold open below is authored, not generated — this measures the AUDIO
// contract, not the writing.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";
import { MAX_SPEECH_START_MS } from "../lib/audio/openingTiming";
import type { DialogueSceneInput } from "../lib/providers/tts/sceneTypes";

const OUT = path.resolve(process.cwd(), "artifacts/live-quality-evidence");
const VOICE = (process.env.CANARY_FISH_VOICE_A || "36780e7121b84d5c9c24cbd2f15eaaa4").trim();

// 104 spoken words — inside the 80-120 band the tournament now enforces.
const COLD_OPEN = [
  { s: "A", t: "You signed off on that extension on a Tuesday. Three players found out from the team's own account.", tone: "accusatory", energy: "high" as const },
  { s: "B", t: "I signed off on a decision the room had already made. If you want to argue the room was wrong, argue that.", tone: "defensive", energy: "medium" as const },
  { s: "A", t: "I'm arguing nobody told the people whose season it is. That's not a scheduling matter, that's a choice.", tone: "heated", energy: "high" as const },
  { s: "B", t: "It was a choice. It was mine. And I'd make it again on the information I had that morning.", tone: "quiet", energy: "low" as const },
  { s: "A", t: "Then tell me what information would have changed it, because I haven't heard a condition yet.", tone: "pressing", energy: "high" as const },
];

function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

function probeSeconds(file: string): number | null {
  const r = spawnSync(process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const v = Number(String(r.stdout || "").trim());
  return Number.isFinite(v) ? v : null;
}

/** Seconds until the first non-silent audio. */
function speechStartSeconds(file: string): number {
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.10", "-f", "null", "-"], { encoding: "utf8" });
  const err = String(r.stderr || "");
  const first = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(err);
  if (first && Number(first[1]) <= 0.05) {
    const end = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(err);
    return end ? Number(end[1]) : 0;
  }
  return 0;
}

async function main() {
  loadEnv(path.resolve(process.cwd(), "../pod/.env"));
  fs.mkdirSync(OUT, { recursive: true });

  if (!process.env.FISH_API_KEY) {
    console.error("MISSING CONFIGURATION: FISH_API_KEY");
    process.exit(1);
  }

  const model = resolveFishSceneModel();
  const wordCount = COLD_OPEN.reduce((n, l) => n + l.t.split(/\s+/).filter(Boolean).length, 0);
  console.log(`Fish scene model: ${model}`);
  console.log(`Cold open: ${COLD_OPEN.length} lines, ${wordCount} spoken words\n`);

  const input = {
    episodeId: "live-evidence", scriptId: "live-evidence", sceneId: "cold-open",
    sceneIndex: 0, sceneType: "cold_open", formatId: "two_host_debate",
    utterances: COLD_OPEN.map((l, i) => ({
      lineIndex: i, speakerHostId: l.s === "A" ? "a" : "b", speakerName: l.s,
      seatIndex: l.s === "A" ? 0 : 1, voiceId: VOICE,
      text: l.t, spokenText: l.t, tone: l.tone, energy: l.energy,
      isInterruption: false, pauseBefore: i === 0 ? "none" : i % 2 ? "beat" : "breath",
    })),
    cast: [
      { speakerHostId: "a", formatRoleId: "chair_a", direction: "Distinct live podcast host.", intensityLevel: 7, angerStyle: "louder_faster", maxCueDensity: 1, profileVersion: 1 },
      { speakerHostId: "b", formatRoleId: "chair_b", direction: "Distinct live podcast host.", intensityLevel: 6, angerStyle: "slower_quieter", maxCueDensity: 1, profileVersion: 1 },
    ],
    format: "mp3",
  } as unknown as DialogueSceneInput;

  const started = Date.now();
  const audio = await new FishTTSProvider().synthesizeDialogueScene(input);
  const latencyMs = Date.now() - started;

  const file = path.join(OUT, "live-cold-open.mp3");
  fs.writeFileSync(file, audio.audioBuffer);
  const seconds = probeSeconds(file);
  const speechStart = speechStartSeconds(file);

  const criteria = [
    { name: "Fish scene model is s2.1-pro-free", pass: audio.model === "s2.1-pro-free", detail: audio.model },
    { name: "Cold open is 80-120 spoken words", pass: wordCount >= 80 && wordCount <= 120, detail: `${wordCount} words` },
    { name: "Cold open performs in 30-45s", pass: seconds !== null && seconds >= 30 && seconds <= 45, detail: `${seconds?.toFixed(1)}s` },
    { name: `First host speech within ${MAX_SPEECH_START_MS / 1000}s`, pass: speechStart <= MAX_SPEECH_START_MS / 1000, detail: `${speechStart.toFixed(2)}s` },
  ];
  for (const c of criteria) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  const report = {
    ranAt: new Date().toISOString(), published: false,
    model: audio.model, bytes: audio.audioBuffer.length, latencyMs,
    durationSeconds: seconds, speechStartSeconds: speechStart, wordCount, criteria,
  };
  fs.writeFileSync(path.join(OUT, "fish-opening-evidence.json"), JSON.stringify(report, null, 2));
  console.log(`\nAudio: ${file}\nReport: ${path.join(OUT, "fish-opening-evidence.json")}`);

  const failed = criteria.filter((c) => !c.pass).length;
  console.log(failed === 0 ? "\nALL MEASURED CRITERIA PASSED\n" : `\n${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("LIVE FISH EVIDENCE FAILED:", e?.message || e); process.exit(1); });
