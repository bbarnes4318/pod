// Blind A/B audition harness: legacy line-mode vs native scene-mode audio
// from the SAME approved fixture script.
//
// Run: npm run sample:human-dialogue
//
// Produces, under ./audition-output/:
//   blind/<scenario>-<1|2>.mp3   ← what you LISTEN to. The 1/2 assignment is a
//                                  deterministic per-scenario hash; nothing in
//                                  the filename or tags reveals which pipeline
//                                  produced it.
//   manifest.json                ← the full unblinded record (render mode,
//                                  provider, model, seed, QA) — open it only
//                                  AFTER listening.
//
// HONESTY RULES BAKED IN:
//   - No provider key → the harness EXITS with instructions. It never ships
//     silence or synthetic placeholders as "samples".
//   - There is NO automatic "human-sounding score" and no declared winner.
//     The output exists for genuine blind human listening.
//   - Technical QA numbers included in the manifest are labeled technical QA;
//     they do not measure human realism.
//
// Requirements: ELEVENLABS_API_KEY + two ElevenLabs voice ids
// (AUDITION_VOICE_A / AUDITION_VOICE_B, falling back to
// ELEVENLABS_MAX_VOLTAGE_VOICE_ID / ELEVENLABS_DR_LINEBREAK_VOICE_ID),
// ffmpeg on PATH (or FFMPEG_PATH/FFPROBE_PATH). Fish scene samples are also
// generated when FISH_API_KEY + 32-hex AUDITION_FISH_VOICE_A/_B are set.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ElevenLabsTTSProvider } from "../lib/providers/tts/elevenlabs";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import type { DialogueSceneInput, SceneUtterance } from "../lib/providers/tts/sceneTypes";
import { planConversationTimeline, renderTimelineToWav, masterToMp3, standardizeClipToWav, getFileDurationMs, type PlannedLine } from "../lib/audio/assembly";
import { analyzeEpisodeAudio } from "../lib/audio/audioQa";
import { stableSceneSeed } from "../lib/services/ttsSceneService";
import { FISH_REFERENCE_ID_RE } from "../lib/providers/tts/providerIds";

interface FixtureLine {
  lineIndex: number;
  speaker: "A" | "B";
  text: string;
  tone?: string;
  energy?: "low" | "medium" | "high";
  isInterruption?: boolean;
  pauseBefore?: "none" | "beat" | "breath" | "long";
}

interface Scenario {
  id: string;
  title: string;
  sceneType: DialogueSceneInput["sceneType"];
  lines: FixtureLine[];
}

// Ten scenarios exercising the exact failure modes of spliced TTS.
const SCENARIOS: Scenario[] = [
  {
    id: "01-cold-open",
    title: "Cold open",
    sceneType: "cold_open",
    lines: [
      { lineIndex: 0, speaker: "A", text: "No warm-up tonight, none, because what happened in that fourth quarter changes the whole series.", tone: "excited", energy: "high" },
      { lineIndex: 1, speaker: "B", text: "It changes the rotation. It does not change the series.", tone: "analytical", energy: "medium" },
      { lineIndex: 2, speaker: "A", text: "Oh, here we go. Twelve straight points and you're telling me nothing changed?", tone: "incredulous", energy: "high" },
    ],
  },
  {
    id: "02-normal-setup",
    title: "Normal conversational setup",
    sceneType: "conversation",
    lines: [
      { lineIndex: 0, speaker: "B", text: "Let's set the table first. Three road games, two on short rest, and the schedule doesn't soften until the twentieth.", tone: "setup", energy: "medium" },
      { lineIndex: 1, speaker: "A", text: "Right, and that stretch is exactly where good teams bank wins.", tone: "analytical", energy: "medium", pauseBefore: "beat" },
      { lineIndex: 2, speaker: "B", text: "So the question is whether the bench survives it.", tone: "setup", energy: "medium" },
    ],
  },
  {
    id: "03-rapid-interruption",
    title: "Rapid interruption",
    sceneType: "conversation",
    lines: [
      { lineIndex: 0, speaker: "A", text: "If they just run the same action they ran in game two, the switch never—", tone: "heated", energy: "high" },
      { lineIndex: 1, speaker: "B", text: "They can't! That's the point — the personnel is different now.", tone: "heated", energy: "high", isInterruption: true },
      { lineIndex: 2, speaker: "A", text: "Let me finish. The switch never comes because the corner shooter drags the help away.", tone: "heated", energy: "medium" },
    ],
  },
  {
    id: "04-heated-exchange",
    title: "Heated exchange",
    sceneType: "argument_escalation",
    lines: [
      { lineIndex: 0, speaker: "A", text: "You are rewriting history in real time. He was invisible when it mattered.", tone: "heated", energy: "high" },
      { lineIndex: 1, speaker: "B", text: "Invisible? Nine assists in the second half is invisible?", tone: "incredulous", energy: "high" },
      { lineIndex: 2, speaker: "A", text: "Assists against a bench unit! Put on the film from the last six minutes and say that again.", tone: "heated", energy: "high" },
      { lineIndex: 3, speaker: "B", text: "I've watched it three times. Have you?", tone: "dismissive", energy: "medium" },
    ],
  },
  {
    id: "05-quiet-correction",
    title: "Quiet analytical correction",
    sceneType: "conversation",
    lines: [
      { lineIndex: 0, speaker: "A", text: "And everyone knows they've been the worst defense in the league since January.", tone: "excited", energy: "medium" },
      { lineIndex: 1, speaker: "B", text: "Small correction — they're twenty-second since January, not thirtieth. Bad, but not historic.", tone: "analytical", energy: "low", pauseBefore: "breath" },
      { lineIndex: 2, speaker: "A", text: "Fine. Twenty-second. My point stands.", tone: "conceding", energy: "medium" },
    ],
  },
  {
    id: "06-sarcastic-line",
    title: "Sarcastic line",
    sceneType: "conversation",
    lines: [
      { lineIndex: 0, speaker: "B", text: "Their plan, as far as I can tell, is to hope the other team misses.", tone: "sarcastic", energy: "medium" },
      { lineIndex: 1, speaker: "A", text: "Bold strategy. Revolutionary, even.", tone: "sarcastic", energy: "low", pauseBefore: "beat" },
    ],
  },
  {
    id: "07-reluctant-concession",
    title: "Reluctant concession",
    sceneType: "argument_resolution",
    lines: [
      { lineIndex: 0, speaker: "B", text: "Say it. Say the trade worked.", tone: "amused", energy: "medium" },
      { lineIndex: 1, speaker: "A", text: "The trade... okay. The trade worked. This month. Ask me again after the road trip.", tone: "conceding", energy: "low", pauseBefore: "breath" },
    ],
  },
  {
    id: "08-stat-heavy",
    title: "Statistic-heavy explanation",
    sceneType: "news_block",
    lines: [
      { lineIndex: 0, speaker: "B", text: "The numbers are stark: forty-eight point three percent from the field, thirty-nine point one from three, and a plus-eleven point four net rating over the last fifteen games.", tone: "analytical", energy: "medium" },
      { lineIndex: 1, speaker: "A", text: "And the eleven-point-four is the one that matters — that's a sixty-win pace.", tone: "excited", energy: "medium" },
    ],
  },
  {
    id: "09-difficult-names",
    title: "Difficult player and team names",
    sceneType: "conversation",
    lines: [
      { lineIndex: 0, speaker: "A", text: "Giannis Antetokounmpo against Nikola Jokic is the matchup, but keep an eye on Kristaps Porzingis and Shai Gilgeous-Alexander down the stretch.", tone: "setup", energy: "medium" },
      { lineIndex: 1, speaker: "B", text: "And don't forget Wembanyama — San Antonio's spacing warps everything around him.", tone: "analytical", energy: "medium" },
    ],
  },
  {
    id: "10-low-energy-close",
    title: "Low-energy closing",
    sceneType: "closing",
    lines: [
      { lineIndex: 0, speaker: "B", text: "That's the show. Tomorrow we'll know if any of this mattered.", tone: "reflective", energy: "low", pauseBefore: "breath" },
      { lineIndex: 1, speaker: "A", text: "It mattered. It always matters. Good night, everybody.", tone: "reflective", energy: "low", pauseBefore: "long" },
    ],
  },
];

const OUT_DIR = path.resolve(process.cwd(), "audition-output");
const BLIND_DIR = path.join(OUT_DIR, "blind");
const TMP_DIR = path.join(OUT_DIR, "tmp");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function voiceFor(speaker: "A" | "B"): string {
  return speaker === "A"
    ? process.env.AUDITION_VOICE_A || process.env.ELEVENLABS_MAX_VOLTAGE_VOICE_ID || ""
    : process.env.AUDITION_VOICE_B || process.env.ELEVENLABS_DR_LINEBREAK_VOICE_ID || "";
}

interface ManifestEntry {
  blindFile: string;
  sampleLabel: string; // e.g. "01-cold-open/A-legacy-line-mode"
  fixtureId: string;
  lineRange: [number, number];
  provider: string;
  model: string;
  voiceAliases: Record<string, string>; // safe aliases only
  seed: number | null;
  renderMode: "legacy_line" | "multi_speaker_scene";
  renderDescription: string;
  characterCount: number;
  sceneDurationMs: number | null;
  generationTimeMs: number;
  technicalQa: unknown;
  transcriptQaStatus: "not_run";
}

async function synthLegacyLineMode(scn: Scenario, eleven: ElevenLabsTTSProvider, outPath: string): Promise<void> {
  // One request PER LINE (the current production behavior), then the legacy
  // assembler's gaps/jitter/overlap reconstruction — exactly the pipeline
  // under audit, at miniature scale.
  const planned: PlannedLine[] = [];
  for (const line of scn.lines) {
    const res = await eleven.synthesizeSpeech({
      text: line.text,
      voiceId: voiceFor(line.speaker),
      speakerName: line.speaker === "A" ? "Host A" : "Host B",
      tone: line.tone,
      energy: line.energy,
      isInterruption: line.isInterruption,
      format: "mp3",
    });
    const raw = path.join(TMP_DIR, `${scn.id}-line-${line.lineIndex}.mp3`);
    fs.writeFileSync(raw, res.audioBuffer);
    const wav = path.join(TMP_DIR, `${scn.id}-line-${line.lineIndex}.wav`);
    await standardizeClipToWav(FFMPEG, raw, wav, {});
    planned.push({
      filePath: wav,
      durationMs: await getFileDurationMs(FFPROBE, wav),
      lineIndex: line.lineIndex,
      hostSlot: line.speaker === "A" ? 0 : 1,
      pauseBefore: line.pauseBefore,
      isInterruption: line.isInterruption,
      segmentBreak: "none",
    });
  }
  const clips = planConversationTimeline(planned, {});
  const mixWav = path.join(TMP_DIR, `${scn.id}-legacy-mix.wav`);
  await renderTimelineToWav(FFMPEG, clips, mixWav, {});
  await masterToMp3(FFMPEG, mixWav, outPath, {});
}

async function synthSceneMode(scn: Scenario, provider: ElevenLabsTTSProvider | FishTTSProvider, providerId: "elevenlabs" | "fish", outPath: string): Promise<{ seed: number | null; model: string }> {
  const utterances: SceneUtterance[] = scn.lines.map((l) => ({
    lineIndex: l.lineIndex,
    speakerHostId: l.speaker === "A" ? "host-a" : "host-b",
    speakerName: l.speaker === "A" ? "Host A" : "Host B",
    seatIndex: l.speaker === "A" ? 0 : 1,
    voiceId: providerId === "fish"
      ? (l.speaker === "A" ? process.env.AUDITION_FISH_VOICE_A || "" : process.env.AUDITION_FISH_VOICE_B || "")
      : voiceFor(l.speaker),
    spokenText: l.text,
    tone: l.tone,
    energy: l.energy,
    isInterruption: l.isInterruption,
    pauseBefore: l.pauseBefore,
  }));
  const seed = providerId === "elevenlabs" ? stableSceneSeed(`audition:${scn.id}`, 0) : null;
  const input: DialogueSceneInput = {
    episodeId: "audition",
    scriptId: "audition-fixture",
    sceneId: `audition:${scn.id}`,
    sceneIndex: 0,
    sceneType: scn.sceneType,
    formatId: "two_host_debate",
    utterances,
    cast: ["host-a", "host-b"].map((hostId, i) => ({
      speakerHostId: hostId,
      formatRoleId: i === 0 ? "chair_a" : "chair_b",
      direction: "",
      intensityLevel: i === 0 ? 8 : 6,
      maxCueDensity: 1,
      profileVersion: 1,
    })),
    seed: seed ?? undefined,
    format: "mp3",
    wantTimestamps: false,
  };
  const res = await provider.synthesizeDialogueScene(input);
  // Loudness-match the scene to the legacy sample so listeners compare the
  // PERFORMANCE, not the level.
  const raw = path.join(TMP_DIR, `${scn.id}-scene-raw.mp3`);
  fs.writeFileSync(raw, res.audioBuffer);
  await masterToMp3(FFMPEG, raw, outPath, {});
  return { seed, model: res.model };
}

async function main() {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) {
    console.error(
      "\nThis harness makes REAL provider calls — it never fabricates audio samples." +
        "\nMissing: ELEVENLABS_API_KEY (plus AUDITION_VOICE_A/AUDITION_VOICE_B or the" +
        "\nELEVENLABS_*_VOICE_ID pair). Set them and re-run: npm run sample:human-dialogue\n"
    );
    process.exit(2);
  }
  if (!voiceFor("A") || !voiceFor("B")) {
    console.error("\nMissing ElevenLabs voice ids: set AUDITION_VOICE_A and AUDITION_VOICE_B (or the ELEVENLABS_*_VOICE_ID pair).\n");
    process.exit(2);
  }

  const fishEnabled =
    !!process.env.FISH_API_KEY &&
    FISH_REFERENCE_ID_RE.test(process.env.AUDITION_FISH_VOICE_A || "") &&
    FISH_REFERENCE_ID_RE.test(process.env.AUDITION_FISH_VOICE_B || "");

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(BLIND_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const eleven = new ElevenLabsTTSProvider();
  const fish = new FishTTSProvider();
  const manifest: ManifestEntry[] = [];
  const voiceAliases = { "host-a": "voice-1", "host-b": "voice-2" };

  for (const scn of SCENARIOS) {
    const characterCount = scn.lines.reduce((a, l) => a + l.text.length, 0);
    const lineRange: [number, number] = [scn.lines[0].lineIndex, scn.lines[scn.lines.length - 1].lineIndex];

    // Blind assignment: deterministic coin flip per scenario decides whether
    // legacy is file "-1" or "-2".
    const flip = crypto.createHash("sha256").update(`blind:${scn.id}`).digest()[0] % 2 === 0;

    const jobs: Array<{ label: string; renderMode: ManifestEntry["renderMode"]; run: (out: string) => Promise<{ seed: number | null; model: string }>; provider: string; description: string }> = [
      {
        label: `${scn.id}/A-legacy-line-mode`,
        renderMode: "legacy_line",
        provider: "elevenlabs",
        description: "Each line independently synthesized (one TTS request per line), then re-assembled with planned gaps/jitter/overlaps — the legacy pipeline.",
        run: async (out) => {
          await synthLegacyLineMode(scn, eleven, out);
          return { seed: null, model: process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_v3" };
        },
      },
      {
        label: `${scn.id}/B-scene-mode`,
        renderMode: "multi_speaker_scene",
        provider: "elevenlabs",
        description: "Whole exchange generated as ONE native Text-to-Dialogue request; the model's own turn-taking/timing preserved.",
        run: (out) => synthSceneMode(scn, eleven, "elevenlabs", out),
      },
    ];

    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const blindIndex = (j === 0) === flip ? 1 : 2;
      const blindFile = path.join("blind", `${scn.id}-${blindIndex}.mp3`);
      const outPath = path.join(OUT_DIR, blindFile);
      const started = Date.now();
      try {
        const { seed, model } = await job.run(outPath);
        const generationTimeMs = Date.now() - started;
        let technicalQa: unknown = null;
        let sceneDurationMs: number | null = null;
        try {
          sceneDurationMs = await getFileDurationMs(FFPROBE, outPath);
          const qa = await analyzeEpisodeAudio(FFMPEG, outPath, { targetLufs: -16 });
          technicalQa = { note: "technical QA only — NOT a human-realism measure", checks: qa.checks.map((c) => ({ name: c.name, status: c.status, value: c.value })) };
        } catch { /* QA optional */ }
        manifest.push({
          blindFile,
          sampleLabel: job.label,
          fixtureId: "audition-fixture-v1",
          lineRange,
          provider: job.provider,
          model,
          voiceAliases,
          seed,
          renderMode: job.renderMode,
          renderDescription: job.description,
          characterCount,
          sceneDurationMs,
          generationTimeMs,
          technicalQa,
          transcriptQaStatus: "not_run",
        });
        console.log(`✓ ${job.label} → ${blindFile} (${generationTimeMs}ms)`);
      } catch (err) {
        console.error(`✗ ${job.label} FAILED: ${(err as Error).message}`);
      }
    }

    // Optional third sample: Fish native multi-speaker scene.
    if (fishEnabled) {
      const blindFile = path.join("blind", `${scn.id}-3.mp3`);
      const started = Date.now();
      try {
        const { seed, model } = await synthSceneMode(scn, fish, "fish", path.join(OUT_DIR, blindFile));
        manifest.push({
          blindFile,
          sampleLabel: `${scn.id}/C-scene-mode-fish`,
          fixtureId: "audition-fixture-v1",
          lineRange,
          provider: "fish",
          model,
          voiceAliases,
          seed,
          renderMode: "multi_speaker_scene",
          renderDescription: "Whole exchange generated as ONE Fish S2-Pro multi-speaker request (<|speaker:N|> tags).",
          characterCount,
          sceneDurationMs: await getFileDurationMs(FFPROBE, path.join(OUT_DIR, blindFile)).catch(() => null),
          generationTimeMs: Date.now() - started,
          technicalQa: null,
          transcriptQaStatus: "not_run",
        });
        console.log(`✓ ${scn.id}/C-scene-mode-fish → ${blindFile}`);
      } catch (err) {
        console.error(`✗ ${scn.id}/C-scene-mode-fish FAILED: ${(err as Error).message}`);
      }
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({
    fixtureId: "audition-fixture-v1",
    note: "Listen to blind/ FIRST. This manifest unblinds the samples. There is deliberately no automatic winner — human ears decide.",
    samples: manifest,
  }, null, 2));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\nDone. ${manifest.length} samples in ${BLIND_DIR}`);
  console.log(`Unblinding manifest: ${path.join(OUT_DIR, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
