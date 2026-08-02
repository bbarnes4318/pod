// LIVE-PROVIDER ACCEPTANCE EVIDENCE.
//
// Runs the REAL creative pipeline against REAL providers (Anthropic for
// writing/judging, Fish for speech at s2.1-pro-free) and measures the finished
// artifact against the acceptance criteria that failed on production episode
// e7867729. Nothing here is stubbed, and nothing is published.
//
// This does NOT require Postgres or Redis: generateOutlineDrivenScript is a
// pure function of (llm, args), so the creative path can be exercised for real
// without the production database.
//
// Usage: npx tsx --conditions=react-server src/scripts/runLiveQualityEvidence.ts

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { getRoleLLMProvider, roleHasRealProvider } from "../lib/providers/llm/routing";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { evaluateProductionInvariants } from "../lib/services/productionInvariants";
import { evaluateScriptEditorialGate } from "../lib/services/scriptEditorialGate";
import { retiredHostNameFragments } from "../lib/hosts/roster";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";
import type { DialogueSceneInput } from "../lib/providers/tts/sceneTypes";

const OUT = path.resolve(process.cwd(), "artifacts/live-quality-evidence");

const HOST_A = "Bernadette Zabala";
const HOST_B = 'Cal "Red Eye" Mercer';

// Three genuinely DIFFERENT events, deliberately chosen to contrast with the
// failed episode's three angles on one All-Star Game.
const TOPICS = `
TOPIC 1 — "The two-year extension nobody on the roster was told about"
EVIDENCE: A club announced a two-year contract extension for its head coach on a Tuesday. Three players told reporters they learned about it from the team's own social account. The general manager said the timing was "a scheduling matter". The club has missed the postseason in each of the last two seasons.

TOPIC 2 — "A 19-year-old was cleared to play 41 minutes on a sprained ankle"
EVIDENCE: A teenage guard logged 41 minutes two days after an ankle sprain was listed as day-to-day. The team's injury report changed designation three times in 36 hours. The player's agent declined comment. League rules require the report to be filed six hours before tip-off.

TOPIC 3 — "The stadium deal that priced out the neighbourhood that funded it"
EVIDENCE: A publicly financed stadium opened with a season-ticket floor of 1,900 dollars. The bond that paid for it is repaid through a county sales tax collected since 2011. Median household income in the two adjacent zip codes is 41,000 dollars. The club says 4,000 seats remain under 30 dollars for select games.
`.trim();

const SYSTEM_PROMPT = `You write a two-host sports debate podcast. ${HOST_A} measures a decision by who paid for it. ${HOST_B} spent seventeen years inside front offices and asks who panicked and who protected themselves. Neither question automatically wins. Write spoken language only.`;

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

function ffprobeSeconds(file: string): number | null {
  const r = spawnSync(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ], { encoding: "utf8" });
  const v = Number(String(r.stdout || "").trim());
  return Number.isFinite(v) ? v : null;
}

/** First sample above a silence floor — the real "when does a host start talking". */
function firstSpeechSeconds(wav: string): number | null {
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-i", wav, "-af", "silencedetect=noise=-45dB:d=0.15", "-f", "null", "-",
  ], { encoding: "utf8" });
  const err = String(r.stderr || "");
  // If the file opens with silence, silencedetect reports silence_start at ~0
  // and the matching silence_end is the moment speech begins.
  const startsSilent = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(err);
  if (startsSilent && Number(startsSilent[1]) <= 0.05) {
    const end = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(err);
    return end ? Number(end[1]) : 0;
  }
  return 0;
}

const words = (s: string) => s.replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean).length;

async function main() {
  loadEnvFile(path.resolve(process.cwd(), "../pod/.env"));
  loadEnvFile(path.resolve(process.cwd(), "../pod/.env.coolify.local"));
  fs.mkdirSync(OUT, { recursive: true });

  const evidence: Record<string, unknown> = { ranAt: new Date().toISOString(), published: false };

  // --- preflight, names only ------------------------------------------------
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.FISH_API_KEY) missing.push("FISH_API_KEY");
  evidence.missingConfiguration = missing;
  if (missing.length) {
    fs.writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.error(`MISSING CONFIGURATION: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log("Writer route:", process.env.SCRIPT_LLM_PROVIDER, process.env.SCRIPT_LLM_MODEL);
  console.log("Judge available:", roleHasRealProvider("quality_judge"));

  // --- 1. REAL creative pipeline -------------------------------------------
  console.log("\n[1/4] Running the real outline-driven creative pipeline (live Anthropic)…");
  const t0 = Date.now();
  const writer = getRoleLLMProvider("script_movement");
  const outlineLlm = getRoleLLMProvider("script_outline");
  const reasons: string[] = [];
  const result = await generateOutlineDrivenScript(writer, {
    systemPrompt: SYSTEM_PROMPT,
    episodeTitle: "Take Machine — live acceptance evidence",
    topicsPrompts: TOPICS,
    targetDuration: 9,
    version: 1,
    temperature: 0.85,
    maxTokens: 16000,
    speakerNames: [HOST_A, HOST_B],
    outlineLlm,
    log: (m: string) => { reasons.push(m); console.log("   ", m); },
  } as Parameters<typeof generateOutlineDrivenScript>[1]);
  const genMs = Date.now() - t0;
  console.log(`   creative pipeline completed in ${(genMs / 1000).toFixed(0)}s`);

  evidence.pipeline = {
    path: "outline_driven",
    privateAgendaCount: result.privateAgendas?.length ?? 0,
    coldOpenTournamentRan: Boolean(result.coldOpenTournament),
    coldOpenSelected: result.coldOpenTournament?.selectedId ?? null,
    coldOpenRejected: result.coldOpenTournament?.rejected ?? null,
    generationMs: genMs,
    reasons,
  };

  // --- 2. Invariants + judge + gate ----------------------------------------
  console.log("\n[2/4] Measuring production invariants and running the independent judge…");
  const invariants = evaluateProductionInvariants(result.segments, {
    activeHostNames: [HOST_A, HOST_B],
    retiredHostNames: retiredHostNameFragments(),
  });
  const judge = roleHasRealProvider("quality_judge") ? getRoleLLMProvider("quality_judge") : null;
  const quality = await assessScriptQuality(judge, result.segments, {
    episodeTitle: "Take Machine — live acceptance evidence",
    hostNames: [HOST_A, HOST_B],
  });
  const gate = evaluateScriptEditorialGate(quality, { ...process.env, NODE_ENV: "production" } as NodeJS.ProcessEnv, {
    invariants,
    provenance: {
      path: "outline_driven",
      stages: [],
      privateAgendaCount: result.privateAgendas?.length ?? 0,
      coldOpenTournamentRan: Boolean(result.coldOpenTournament),
      judgeRan: Boolean(quality.judge),
    },
  });
  evidence.invariants = invariants;
  evidence.judge = { overall: quality.judge?.overall ?? null, error: quality.judgeError ?? null };
  evidence.gate = { decision: gate.decision, downstreamBlocked: gate.downstreamBlocked, failedCriticalAxes: gate.failedCriticalAxes, reasons: gate.reasons };
  console.log(`   invariants=${invariants.worstSeverity} judge=${quality.judge?.overall ?? "n/a"} gate=${gate.decision}`);

  // --- 3. REAL Fish speech for the cold open --------------------------------
  console.log("\n[3/4] Voicing the selected cold open with live Fish TTS…");
  const sceneModel = resolveFishSceneModel();
  evidence.fishSceneModel = sceneModel;
  const coldOpen = result.segments.find((s: { type?: string }) => s.type === "cold_open");
  const voiceA = (process.env.CANARY_FISH_VOICE_A || process.env.FISH_VOICE_A || "").trim();
  const voiceB = (process.env.CANARY_FISH_VOICE_B || process.env.FISH_VOICE_B || "").trim();

  let audioPath: string | null = null;
  let audioSeconds: number | null = null;
  let speechStart: number | null = null;
  if (!coldOpen) {
    evidence.ttsSkipped = "no cold_open segment";
  } else if (!voiceA || !voiceB) {
    evidence.ttsSkipped = "no Fish voice reference ids configured (CANARY_FISH_VOICE_A/B)";
    console.warn("   SKIPPED: no Fish voice reference ids available in this environment.");
  } else {
    const input: DialogueSceneInput = {
      episodeId: "live-evidence", scriptId: "live-evidence", sceneId: "cold-open",
      sceneIndex: 0, sceneType: "cold_open", formatId: "two_host_debate",
      utterances: coldOpen.lines.map((l: { speakerName: string; text: string; tone?: string }, i: number) => ({
        lineIndex: i,
        speakerHostId: l.speakerName === HOST_A ? "a" : "b",
        speakerName: l.speakerName,
        seatIndex: l.speakerName === HOST_A ? 0 : 1,
        voiceId: l.speakerName === HOST_A ? voiceA : voiceB,
        text: l.text, spokenText: l.text,
        tone: l.tone || "neutral", energy: "medium" as const,
        isInterruption: false, pauseBefore: "none",
      })),
      cast: [
        { speakerHostId: "a", formatRoleId: "chair_a", direction: "Distinct live podcast host.", intensityLevel: 7, angerStyle: "louder_faster", maxCueDensity: 1, profileVersion: 1 },
        { speakerHostId: "b", formatRoleId: "chair_b", direction: "Distinct live podcast host.", intensityLevel: 6, angerStyle: "slower_quieter", maxCueDensity: 1, profileVersion: 1 },
      ],
      format: "mp3",
    } as unknown as DialogueSceneInput;
    const audio = await new FishTTSProvider().synthesizeDialogueScene(input);
    audioPath = path.join(OUT, "cold-open.mp3");
    fs.writeFileSync(audioPath, audio.audioBuffer);
    audioSeconds = ffprobeSeconds(audioPath);
    speechStart = firstSpeechSeconds(audioPath);
    console.log(`   rendered ${audio.model} → ${(audio.audioBuffer.length / 1024).toFixed(0)}KB, ${audioSeconds?.toFixed(1)}s, speech starts ${speechStart?.toFixed(2)}s`);
    evidence.coldOpenAudio = { model: audio.model, bytes: audio.audioBuffer.length, seconds: audioSeconds, speechStartSeconds: speechStart };
  }

  // --- 4. Acceptance criteria ----------------------------------------------
  console.log("\n[4/4] Acceptance criteria\n");
  const coldOpenWords = coldOpen ? coldOpen.lines.reduce((n: number, l: { text: string }) => n + words(l.text), 0) : 0;
  const criteria: Array<{ name: string; pass: boolean | null; detail: string }> = [
    { name: "Fish scene model is s2.1-pro-free", pass: sceneModel === "s2.1-pro-free", detail: sceneModel },
    { name: "Cold open is 80-120 spoken words after all passes", pass: coldOpenWords >= 80 && coldOpenWords <= 120, detail: `${coldOpenWords} words` },
    { name: "Cold open performs in 30-45s", pass: audioSeconds === null ? null : audioSeconds >= 30 && audioSeconds <= 45, detail: audioSeconds === null ? "not voiced" : `${audioSeconds.toFixed(1)}s` },
    { name: "First host speech within 2s", pass: speechStart === null ? null : speechStart <= 2, detail: speechStart === null ? "not voiced" : `${speechStart.toFixed(2)}s` },
    { name: "No retired-host names", pass: !invariants.failedCriticalAxes.includes("castIntegrity"), detail: "castIntegrity" },
    { name: "No speaker position swaps", pass: invariants.measurements.positionSwapCount === 0, detail: `${invariants.measurements.positionSwapCount} swaps` },
    { name: "Strict alternation below 65%", pass: invariants.measurements.strictAlternationRatio < 0.65, detail: `${(invariants.measurements.strictAlternationRatio * 100).toFixed(1)}%` },
    { name: "No exact 50/50 line allocation", pass: (() => { const c = Object.values(invariants.measurements.perSpeakerLines); return !(c.length === 2 && c[0] === c[1]); })(), detail: JSON.stringify(invariants.measurements.perSpeakerLines) },
    { name: "At least one genuine position/understanding change", pass: !invariants.failedCriticalAxes.includes("argumentProgression"), detail: "argumentProgression" },
    { name: "Independent judge ran", pass: Boolean(quality.judge), detail: quality.judge ? `overall ${quality.judge.overall}` : (quality.judgeError || "no judge") },
    { name: "Private agendas generated per host", pass: (result.privateAgendas?.length ?? 0) === 2, detail: `${result.privateAgendas?.length ?? 0} packets` },
    { name: "Cold-open tournament ran with 3 candidates", pass: (result.coldOpenTournament?.variants?.length ?? 0) === 3, detail: `${result.coldOpenTournament?.variants?.length ?? 0} variants, selected ${result.coldOpenTournament?.selectedId}` },
    { name: "Script receives pass (not review/hold)", pass: gate.decision === "pass", detail: `${gate.decision}${gate.reasons.length ? `: ${gate.reasons.join(" | ")}` : ""}` },
  ];
  for (const c of criteria) {
    console.log(`  ${c.pass === null ? "SKIP" : c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  }
  evidence.criteria = criteria;

  fs.writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT, "script.json"), JSON.stringify(result.segments, null, 2));
  fs.writeFileSync(path.join(OUT, "transcript.txt"),
    result.segments.map((s: { type?: string; title?: string; lines: Array<{ speakerName: string; text: string }> }) =>
      `==== ${s.type} | ${s.title} ====\n` + s.lines.map((l) => `${l.speakerName}: ${l.text}`).join("\n")
    ).join("\n\n"));

  const failed = criteria.filter((c) => c.pass === false).length;
  console.log(`\nArtifacts written to ${OUT}`);
  console.log(failed === 0 ? "\nALL MEASURED CRITERIA PASSED\n" : `\n${failed} CRITERION/CRITERIA FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "evidence-error.json"), JSON.stringify({ error: String(err?.message || err) }, null, 2));
  console.error("\nLIVE EVIDENCE RUN FAILED:", err?.message || err);
  process.exit(1);
});
