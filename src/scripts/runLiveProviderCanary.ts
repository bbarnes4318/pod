// Private scheduled live-provider canary. It publishes nothing. A fixed
// fixture isolates voice/model drift while a live LLM generation catches
// structured-output and routing regressions.

import fs from "node:fs";
import path from "node:path";
import { getRoleLLMProvider } from "../lib/providers/llm/routing";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { ElevenLabsTTSProvider } from "../lib/providers/tts/elevenlabs";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { analyzeSpokenPerformanceBuffer } from "../lib/audio/spokenPerformanceQa";
import type { DialogueSceneInput } from "../lib/providers/tts/sceneTypes";
import { FISH_REFERENCE_ID_RE } from "../lib/providers/tts/providerIds";

const FIXED_LINES = [
  { lineIndex: 0, speakerHostId: "a", speakerName: "A", text: "You keep calling it patience. Who paid for that patience?", tone: "incredulous", energy: "high" as const, isInterruption: false },
  { lineIndex: 1, speakerHostId: "b", speakerName: "B", text: "The people who never controlled the decision. That's the problem.", tone: "analytical", energy: "medium" as const, isInterruption: false },
  { lineIndex: 2, speakerHostId: "a", speakerName: "A", text: "Then stop defending the timeline—", tone: "heated", energy: "high" as const, isInterruption: false },
  { lineIndex: 3, speakerHostId: "b", speakerName: "B", text: "I'm not defending it. I'm telling you when the trap closed.", tone: "dismissive", energy: "medium" as const, isInterruption: true },
];

interface CanaryProviderResult {
  model: string;
  latencyMs: number;
  bytes: number;
  performanceScore: number;
  passed: boolean;
  failures: string[];
  metrics: unknown;
}

interface CanaryReport {
  version: 1;
  ranAt: string;
  private: true;
  published: false;
  llm: Awaited<ReturnType<typeof liveScriptCheck>>;
  providers: Record<string, CanaryProviderResult>;
  comparison?: Record<string, { scoreDelta: number; latencyRatio: number }>;
}

function input(provider: "fish" | "elevenlabs"): DialogueSceneInput {
  const voice = (host: "A" | "B") => provider === "fish"
    ? process.env[`CANARY_FISH_VOICE_${host}`] || ""
    : process.env[`CANARY_ELEVENLABS_VOICE_${host}`] || "";
  return {
    episodeId: "private-canary",
    scriptId: "private-canary",
    sceneId: `${provider}-canary`,
    sceneIndex: 0,
    sceneType: "cold_open",
    formatId: "two_host_debate",
    utterances: FIXED_LINES.map((line) => ({ ...line, seatIndex: line.speakerHostId === "a" ? 0 : 1, voiceId: voice(line.speakerHostId === "a" ? "A" : "B"), spokenText: line.text, pauseBefore: "none" })),
    cast: ["a", "b"].map((speakerHostId, i) => ({ speakerHostId, formatRoleId: i ? "chair_b" : "chair_a", direction: "Distinct live podcast host reacting in the moment.", intensityLevel: i ? 6 : 8, angerStyle: i ? "slower_quieter" : "louder_faster", maxCueDensity: 1, profileVersion: 1 })),
    format: "mp3",
    wantTimestamps: provider === "elevenlabs",
  };
}

async function liveScriptCheck() {
  const writer = getRoleLLMProvider("script_movement");
  const result = await writer.generateStructuredOutput<{ segments: Array<{ lines?: unknown[]; [key: string]: unknown }> }>({
    systemPrompt: "Write grounded spoken podcast dialogue. Two distinct hosts, no greetings, no invented facts, no generic recap.",
    prompt: `Write a 4-6 turn cold open from this supplied fact only: A team publicly blamed chemistry after losing four consecutive games. Host A thinks leadership shifted blame downward. Host B thinks the public statement hides an earlier decision. Return JSON {"segments":[{"type":"cold_open","lines":[{"lineIndex":0,"speakerName":"A|B","text":"...","tone":"...","energy":"low|medium|high","pauseBefore":"none|beat|breath|long","isInterruption":false,"evidenceRefs":[],"isFactualClaim":false}]}]}`,
    temperature: 0.7,
    maxTokens: 2500,
    validate: (value) => {
      const parsed = value as { segments?: Array<{ lines?: unknown[] }> };
      return Array.isArray(parsed?.segments) && parsed.segments.flatMap((segment) => segment.lines || []).length >= 4
        ? null
        : "Canary script needs at least four lines.";
    },
  });
  const judge = getRoleLLMProvider("quality_judge");
  const quality = await assessScriptQuality(judge, result.segments, { episodeTitle: "Private provider canary", hostNames: ["A", "B"] });
  return { segments: result.segments, judgeOverall: quality.judge?.overall ?? null };
}

async function main() {
  const outDir = path.resolve(process.cwd(), "artifacts/live-provider-canary");
  fs.mkdirSync(outDir, { recursive: true });
  const required = (process.env.CANARY_REQUIRED_PROVIDERS || "fish,elevenlabs").split(",").map((x) => x.trim()).filter(Boolean);
  const report: CanaryReport = { version: 1, ranAt: new Date().toISOString(), private: true, published: false, llm: await liveScriptCheck(), providers: {} };

  for (const provider of required) {
    if (provider !== "fish" && provider !== "elevenlabs") throw new Error(`Unknown required canary provider ${provider}.`);
    if (provider === "fish") {
      if (!process.env.FISH_API_KEY || !FISH_REFERENCE_ID_RE.test(process.env.CANARY_FISH_VOICE_A || "") || !FISH_REFERENCE_ID_RE.test(process.env.CANARY_FISH_VOICE_B || "")) throw new Error("Fish canary credentials/voice ids are incomplete.");
    } else if (!process.env.ELEVENLABS_API_KEY || !process.env.CANARY_ELEVENLABS_VOICE_A || !process.env.CANARY_ELEVENLABS_VOICE_B) throw new Error("ElevenLabs canary credentials/voice ids are incomplete.");
    const adapter = provider === "fish" ? new FishTTSProvider() : new ElevenLabsTTSProvider();
    const started = Date.now();
    const audio = await adapter.synthesizeDialogueScene(input(provider));
    const qa = await analyzeSpokenPerformanceBuffer(audio.audioBuffer, { expectedTurnCount: FIXED_LINES.length, sceneType: "cold_open", format: "mp3", strict: true });
    fs.writeFileSync(path.join(outDir, `${provider}.mp3`), audio.audioBuffer);
    report.providers[provider] = { model: audio.model, latencyMs: Date.now() - started, bytes: audio.audioBuffer.length, performanceScore: qa.score, passed: qa.passed, failures: qa.failures, metrics: qa.metrics };
    if (!qa.passed) throw new Error(`${provider} live performance QA failed: ${qa.failures.join(" ")}`);
  }

  const baselinePath = process.env.CANARY_BASELINE_PATH || path.join(outDir, "../live-provider-canary-baseline/report.json");
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as { providers?: Record<string, CanaryProviderResult> };
    report.comparison = {};
    for (const [provider, now] of Object.entries(report.providers)) {
      const before = baseline.providers?.[provider];
      if (!before) continue;
      const scoreDelta = now.performanceScore - before.performanceScore;
      const latencyRatio = now.latencyMs / Math.max(1, before.latencyMs);
      report.comparison[provider] = { scoreDelta, latencyRatio };
      if (scoreDelta < -12) throw new Error(`${provider} performance score regressed ${Math.abs(scoreDelta)} points.`);
      if (latencyRatio > 2.5) throw new Error(`${provider} latency regressed to ${latencyRatio.toFixed(1)}x baseline.`);
    }
  }
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
