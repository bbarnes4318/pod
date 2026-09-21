// Production render-mode hardening + performance-direction delivery tests.
//
// Guards the two defects that produced "both hosts sound like they are reading
// the script cold":
//   1. A degraded render outcome (legacy_line / mixed_fallback) being reachable
//      in production, where each line is synthesized in isolation.
//   2. The compiled performance direction not actually REACHING the engine.
//      Fish has no `instructions` parameter — bracket cues inside `text` are the
//      only channel — and the old cue regex stopped exactly where the scene
//      shading began, so every scene of an episode rendered under one identical
//      cue and the episode had no dynamic range by construction.
//
// NETWORK-FREE. Run: npm run test:render-mode-hardening

import { buildFishScenePayload } from "../lib/providers/tts/fishDialogue";
import { SCRIPT_TAG_TO_FISH } from "../lib/providers/tts/fishFormat";
import type { DialogueSceneInput, DialogueSceneType, ScenePerformanceContext } from "../lib/providers/tts/sceneTypes";
import { degradedRenderModesAllowed, readRenderModeSetting } from "../lib/services/renderModePolicy";
import { buildPerformanceDirection } from "../lib/audio/performanceDirection";
import { resolveHostPerformanceProfile } from "../lib/hosts/performanceProfile";
import { SEED_HOSTS } from "../lib/hosts/roster";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const FISH_A = "0123456789abcdef0123456789abcdef";
const FISH_B = "fedcba9876543210fedcba9876543210";

function castCtx(over: Partial<ScenePerformanceContext> = {}): ScenePerformanceContext {
  return {
    speakerHostId: "hostA",
    formatRoleId: "chair_a",
    direction: 'You are "Test Host" on a two host debate episode. You are an equal protagonist in the argument. ' +
      "Delivery style: Fast, flat Northwest Indiana vowels, smoker's edge. Contractions always, endings bitten off. " +
      "This is the cold open: arrive mid-energy, hook fast, no throat-clearing. " +
      "Your intensity ranges 4/10 at baseline up to 9/10 at genuine peaks — most sentences sit near baseline. " +
      "When genuinely angry you get louder and faster.",
    intensityLevel: 9,
    angerStyle: "louder_faster",
    maxCueDensity: 1,
    profileVersion: 1,
    ...over,
  };
}

function sceneInput(sceneType: DialogueSceneType, over: Partial<DialogueSceneInput> = {}): DialogueSceneInput {
  return {
    episodeId: "ep1",
    scriptId: "s1",
    sceneId: `s1:0:${sceneType}`,
    sceneIndex: 0,
    sceneType,
    formatId: "two_host_debate",
    utterances: [
      { lineIndex: 0, speakerHostId: "hostA", speakerName: "A", seatIndex: 0, voiceId: FISH_A, spokenText: "You cannot be serious about that number.", isInterruption: false, segmentBoundary: "none" },
      { lineIndex: 1, speakerHostId: "hostB", speakerName: "B", seatIndex: 1, voiceId: FISH_B, spokenText: "I am. Look at who signed off on it.", isInterruption: false, segmentBoundary: "none" },
    ],
    cast: [castCtx(), castCtx({ speakerHostId: "hostB", formatRoleId: "chair_b", angerStyle: "slower_quieter" })],
    format: "mp3",
    wantTimestamps: false,
    ...over,
  } as DialogueSceneInput;
}

function main() {
  console.log("\nProduction render-mode hardening\n");

  check("production forces scene mode regardless of TTS_RENDER_MODE", () => {
    for (const v of ["legacy_line", "auto", "scene", "", "LEGACY_LINE", "garbage", undefined]) {
      const env = { NODE_ENV: "production", ...(v === undefined ? {} : { TTS_RENDER_MODE: v }) } as NodeJS.ProcessEnv;
      assert(readRenderModeSetting(env) === "scene", `TTS_RENDER_MODE=${String(v)} in production resolved to ${readRenderModeSetting(env)}, not scene`);
    }
  });

  check("the dev opt-out cannot re-enable degraded modes in production", () => {
    const env = { NODE_ENV: "production", TTS_RENDER_MODE: "legacy_line", TTS_ALLOW_DEGRADED_RENDER_MODES: "true" } as NodeJS.ProcessEnv;
    assert(!degradedRenderModesAllowed(env), "degraded modes must stay unreachable in production even with the dev flag set");
    assert(readRenderModeSetting(env) === "scene", "production must resolve to scene even with the dev flag set");
  });

  check("dev still needs an EXPLICIT opt-in to reach legacy_line", () => {
    const noFlag = { NODE_ENV: "development", TTS_RENDER_MODE: "legacy_line" } as NodeJS.ProcessEnv;
    assert(readRenderModeSetting(noFlag) === "scene", "dev without the opt-in must not silently select legacy_line");
    const withFlag = { NODE_ENV: "development", TTS_RENDER_MODE: "legacy_line", TTS_ALLOW_DEGRADED_RENDER_MODES: "true" } as NodeJS.ProcessEnv;
    assert(readRenderModeSetting(withFlag) === "legacy_line", "dev WITH the explicit opt-in may select legacy_line");
  });

  console.log("\nDirection is not prose: only script tags reach the engine\n");

  check("the Fish payload carries no bracket direction beyond script tags and [cutting in]", () => {
    // A/B 2026-09-20: the same lines with the scene cue + per-host delivery
    // paragraphs stripped were judged "way more human". Any bracket the script
    // did not write is a regression.
    const allowed = new Set(
      [...Object.values(SCRIPT_TAG_TO_FISH), "[cutting in]", "[breath]", "[break]"].filter(Boolean).map((c) => String(c).slice(1, -1))
    );
    for (const t of ["cold_open", "argument_escalation", "closing"] as DialogueSceneType[]) {
      const text = buildFishScenePayload(sceneInput(t)).body.text;
      const cues = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
      const rogue = cues.filter((c) => !allowed.has(c));
      assert(rogue.length === 0, `${t}: prose direction leaked into the request: ${JSON.stringify(rogue)}`);
      assert(text.startsWith("<|speaker:0|>"), `${t}: text must open on a speaker tag, got: ${text.slice(0, 40)}`);
    }
  });

  check("a scripted breath or dramatic beat on a speaker change is spoken as a Fish cue, sparsely", () => {
    const u = (lineIndex: number, host: "hostA" | "hostB", pauseBefore: "none" | "beat" | "breath" | "long") => ({
      lineIndex, speakerHostId: host, speakerName: host === "hostA" ? "A" : "B", seatIndex: host === "hostA" ? 0 : 1,
      voiceId: host === "hostA" ? FISH_A : FISH_B, spokenText: `Line ${lineIndex} of the argument goes here.`, isInterruption: false,
      segmentBoundary: "none" as const, pauseBefore,
    });
    const text = buildFishScenePayload(sceneInput("conversation", {
      utterances: [u(0, "hostA", "none"), u(1, "hostB", "breath"), u(2, "hostA", "long"), u(3, "hostB", "beat"), u(4, "hostA", "breath"), u(5, "hostB", "long"), u(6, "hostA", "breath")],
    })).body.text;
    const cues = [...text.matchAll(/\[(breath|break)\]/g)].map((m) => m[1]);
    assert(cues[0] === "breath", `the first breath on a speaker change must be spoken; got ${JSON.stringify(cues)} in ${text}`);
    assert(cues.length === 2, `pause cues must stay sparse (one per four lines): got ${cues.length} in ${text}`);
  });

  check("the same script renders the same request text regardless of scene type", () => {
    const texts = (["cold_open", "argument_escalation", "closing"] as DialogueSceneType[])
      .map((t) => buildFishScenePayload(sceneInput(t)).body.text);
    assert(new Set(texts).size === 1, "scene type must not inject direction into the spoken text");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
