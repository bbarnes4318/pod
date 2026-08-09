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

import { buildFishScenePayload, compactFishDeliveryCue, sceneShadingCue } from "../lib/providers/tts/fishDialogue";
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

  console.log("\nPerformance direction actually reaches the engine\n");

  check("scene shading differs across scene types", () => {
    const types: DialogueSceneType[] = ["cold_open", "argument_escalation", "closing", "conversation"];
    const cues = types.map(sceneShadingCue);
    assert(new Set(cues).size === cues.length, `scene shading must differ per scene type, got: ${JSON.stringify(cues)}`);
  });

  check("the Fish payload carries DIFFERENT direction for cold_open vs argument_escalation vs closing", () => {
    const texts = (["cold_open", "argument_escalation", "closing"] as DialogueSceneType[])
      .map((t) => buildFishScenePayload(sceneInput(t)).body.text);
    assert(new Set(texts).size === 3,
      "identical request text across scene types means the episode has no dynamic range by construction");
    assert(texts[0].includes("cold open"), "cold_open text must carry its shading");
    assert(texts[1].includes("disagreement is building"), "argument_escalation text must carry its shading");
  });

  check("the scene cue is emitted once, at the head of the scene", () => {
    const payload = buildFishScenePayload(sceneInput("cold_open"));
    const occurrences = payload.body.text.split(payload.sceneCue).length - 1;
    assert(occurrences === 1, `scene cue appeared ${occurrences} times; expected exactly 1`);
    assert(payload.body.text.indexOf(payload.sceneCue) < 30, "scene cue must lead the scene text");
  });

  check("a timbre-first delivery style still reaches Fish with manner direction", () => {
    // Regression: the old cue took only the FIRST sentence, so a host whose
    // style opens on accent reached the engine with no performance instruction
    // at all — which is precisely how one host ends up flatter than the other.
    const cue = compactFishDeliveryCue(castCtx())!;
    assert(cue.includes("Northwest Indiana"), "the timbre clause should survive");
    assert(cue.includes("Contractions always"), "the manner clause must ALSO survive, not be truncated away");
    assert(cue.includes("never reading"), "the universal anti-narration clause must be present");
  });

  check("the anger signature reaches the engine from the profile, not from prose", () => {
    const quiet = compactFishDeliveryCue(castCtx({ angerStyle: "slower_quieter" }))!;
    const loud = compactFishDeliveryCue(castCtx({ angerStyle: "louder_slower" }))!;
    assert(quiet.includes("never louder"), "slower_quieter signature must reach the cue");
    assert(loud.includes("stretching words out"), "louder_slower signature must reach the cue");
    assert(quiet !== loud, "two hosts with different anger signatures must not receive the same cue");
  });

  check("both rostered hosts receive real performance direction, not just accent", () => {
    for (const host of SEED_HOSTS.filter((h) => h.isActive)) {
      const { profile } = resolveHostPerformanceProfile(host.performanceProfile, host);
      const direction = buildPerformanceDirection({
        formatId: "two_host_debate",
        roleId: "chair_a",
        host: { name: host.name, speakingStyle: host.speakingStyle },
        profile,
        sceneType: "argument_escalation",
      });
      const cue = compactFishDeliveryCue({
        speakerHostId: host.slug, formatRoleId: "chair_a", direction,
        intensityLevel: profile.peakIntensity, angerStyle: profile.angerStyle,
        maxCueDensity: profile.maxCueDensity, profileVersion: 1,
      })!;
      assert(!!cue, `${host.name} produced no delivery cue at all`);
      // An accent-only cue is a voice description, not a performance direction.
      const mannerWords = /contraction|fragment|blunt|dry|clipped|react|interrupt|stack|laugh|quiet|never/i;
      assert(mannerWords.test(cue), `${host.name}'s cue carries no manner direction — only timbre: ${cue}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
