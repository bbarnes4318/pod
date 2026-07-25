// Scene provider contract tests — payload builders, capability gating,
// eligibility, direction compilation, performance profiles, scene QA.
// NETWORK-FREE: the one adapter execution test stubs global fetch.
// Run: npm run test:scene-contracts

import { buildElevenLabsDialoguePayload, synthesizeElevenLabsDialogueScene } from "../lib/providers/tts/elevenlabsDialogue";
import { buildFishScenePayload } from "../lib/providers/tts/fishDialogue";
import { getTtsProviderCapabilities, providerSupportsSceneRendering } from "../lib/providers/tts/capabilities";
import { SceneGenerationError, type DialogueSceneInput } from "../lib/providers/tts/sceneTypes";
import { decideSceneEligibility, readRenderModeSetting, readSceneProviderAllowlist, stableSceneSeed } from "../lib/services/ttsSceneService";
import type { ResolvedTtsVoice } from "../lib/providers/tts/voiceResolution";
import { buildPerformanceDirection } from "../lib/audio/performanceDirection";
import { deriveProfileFromHostFields, resolveHostPerformanceProfile, hostPerformanceProfileSchema } from "../lib/hosts/performanceProfile";
import { analyzeSceneAudioRows } from "../lib/audio/sceneAudioQa";

let passed = 0, failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  const done = (err?: Error) => {
    if (err) { failed++; console.error(`  ✗ ${name}\n      ${err.message}`); }
    else { passed++; console.log(`  ✓ ${name}`); }
  };
  try {
    const r = fn();
    if (r instanceof Promise) { pending.push(r.then(() => done(), (e) => done(e as Error))); }
    else done();
  } catch (err) { done(err as Error); }
}
const pending: Promise<void>[] = [];
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const FISH_A = "0123456789abcdef0123456789abcdef";
const FISH_B = "fedcba9876543210fedcba9876543210";

function sceneInput(over: Partial<DialogueSceneInput> = {}): DialogueSceneInput {
  return {
    episodeId: "ep1",
    scriptId: "s1",
    sceneId: "s1:0:v1",
    sceneIndex: 0,
    sceneType: "conversation",
    formatId: "two_host_debate",
    utterances: [
      { lineIndex: 0, speakerHostId: "hA", speakerName: "A", seatIndex: 0, voiceId: "elevenA", spokenText: "First turn." , tone: "setup", energy: "medium" },
      { lineIndex: 1, speakerHostId: "hB", speakerName: "B", seatIndex: 1, voiceId: "elevenB", spokenText: "Second turn!", tone: "heated", energy: "high" },
      { lineIndex: 2, speakerHostId: "hA", speakerName: "A", seatIndex: 0, voiceId: "elevenA", spokenText: "Third turn.", tone: "analytical", energy: "low" },
    ],
    cast: [
      { speakerHostId: "hA", formatRoleId: "chair_a", direction: "", intensityLevel: 8, maxCueDensity: 1, profileVersion: 1 },
      { speakerHostId: "hB", formatRoleId: "chair_b", direction: "", intensityLevel: 6, maxCueDensity: 1, profileVersion: 1 },
    ],
    seed: 12345,
    format: "mp3",
    ...over,
  };
}

async function main() {
  console.log("\nScene provider contracts\n");

  delete process.env.ELEVENLABS_DIALOGUE_MODEL_ID;
  delete process.env.ELEVENLABS_MODEL_ID;
  delete process.env.ELEVENLABS_MODEL;
  delete process.env.FISH_SCENE_MODEL;

  check("Eleven dialogue payload contains ordered text/voice pairs", () => {
    const p = buildElevenLabsDialoguePayload(sceneInput());
    assert(p.body.inputs.length === 3, "expected 3 inputs");
    assert(p.body.inputs[0].voice_id === "elevenA" && p.body.inputs[1].voice_id === "elevenB", "voice order wrong");
    assert(p.body.inputs.map((i) => i.text).join("|") === "First turn.|Second turn!|Third turn.", "text order wrong");
    assert(p.body.model_id === "eleven_v3", "default model must be eleven_v3");
    assert(p.body.seed === 12345, "seed not forwarded");
  });

  check("Eleven scene mode uses the dialogue endpoint (not per-voice TTS)", () => {
    const p = buildElevenLabsDialoguePayload(sceneInput());
    assert(p.url.startsWith("https://api.elevenlabs.io/v1/text-to-dialogue"), `url=${p.url}`);
    assert(!p.url.includes("/text-to-speech/"), "must not use the single-speaker endpoint");
    const pt = buildElevenLabsDialoguePayload(sceneInput({ wantTimestamps: true }));
    assert(pt.url.includes("/text-to-dialogue/with-timestamps"), "timestamps variant not used");
  });

  check("Eleven scene mode does not send unsupported continuity/SSML fields", () => {
    const p = buildElevenLabsDialoguePayload(sceneInput());
    const json = JSON.stringify(p.body);
    for (const banned of ["previous_text", "next_text", "previous_request_ids", "ssml", "pronunciation_dictionary"]) {
      assert(!json.includes(banned), `payload contains unsupported field '${banned}'`);
    }
  });

  check("Eleven scene rejects non-v3 models and >10 voices", () => {
    process.env.ELEVENLABS_DIALOGUE_MODEL_ID = "eleven_multilingual_v2";
    try {
      buildElevenLabsDialoguePayload(sceneInput());
      throw new Error("non-v3 model accepted");
    } catch (e) {
      assert(e instanceof SceneGenerationError && e.category === "unsupported_model", "wrong error for non-v3 model");
    } finally {
      delete process.env.ELEVENLABS_DIALOGUE_MODEL_ID;
    }
    const many = sceneInput();
    many.utterances = Array.from({ length: 11 }, (_, i) => ({
      lineIndex: i, speakerHostId: `h${i}`, speakerName: `S${i}`, seatIndex: 0, voiceId: `v${i}`, spokenText: "x.",
    }));
    try {
      buildElevenLabsDialoguePayload(many);
      throw new Error("11 voices accepted");
    } catch (e) {
      assert(e instanceof SceneGenerationError && e.category === "request_too_large", "wrong error for too many voices");
    }
  });

  check("Eleven adapter (stubbed fetch) posts to the dialogue endpoint and returns audio", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-not-real";
    const calls: Array<{ url: string; body: string }> = [];
    const realFetch = global.fetch;
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    try {
      const res = await synthesizeElevenLabsDialogueScene(sceneInput({ wantTimestamps: false }));
      assert(calls.length === 1, "expected exactly ONE request for the whole scene");
      assert(calls[0].url.includes("/v1/text-to-dialogue"), "wrong endpoint");
      const body = JSON.parse(calls[0].body);
      assert(Array.isArray(body.inputs) && body.inputs.length === 3, "scene not sent as one request");
      assert(res.renderUnit === "multi_speaker_scene", "renderUnit must be multi_speaker_scene");
      assert(res.audioBuffer.length === 4, "audio buffer lost");
    } finally {
      global.fetch = realFetch;
      delete process.env.ELEVENLABS_API_KEY;
    }
  });

  check("Fish scene payload uses <|speaker:N|> syntax with aligned reference_id array", () => {
    const input = sceneInput();
    input.utterances = input.utterances.map((u) => ({ ...u, voiceId: u.speakerHostId === "hA" ? FISH_A : FISH_B }));
    const p = buildFishScenePayload(input);
    assert(p.model === "s2-pro", `scene model default must be s2-pro (got ${p.model})`);
    assert(Array.isArray(p.body.reference_id) && p.body.reference_id.length === 2, "reference_id must be a 2-entry array");
    assert(p.body.reference_id[0] === FISH_A && p.body.reference_id[1] === FISH_B, "reference order must match speaker indexes");
    assert(p.body.text.startsWith("<|speaker:0|>"), "text must open with speaker 0");
    // The hottest line may carry the scene's ONE optional accent cue.
    assert(/<\|speaker:1\|>(\[[^\]]+\] )?Second turn!/.test(p.body.text), "speaker 1 tag misplaced");
    assert((p.body.text.match(/<\|speaker:/g) || []).length === 3, "every turn needs a speaker tag");
    // hA speaks turns 0 and 2 → both must be speaker 0.
    assert(p.body.text.indexOf("<|speaker:0|>Third turn.") > -1, "same host must keep the same speaker index");
  });

  check("Fish scene validates every reference id before sending", () => {
    const input = sceneInput(); // eleven-style ids are NOT 32-hex
    try {
      buildFishScenePayload(input);
      throw new Error("invalid fish reference id accepted");
    } catch (e) {
      assert(e instanceof SceneGenerationError && e.category === "invalid_voice", "wrong error for invalid fish voice");
    }
  });

  check("Fish scene does not stamp a tone cue on every hot line (max one accent per scene)", () => {
    const input = sceneInput();
    input.utterances = [
      { lineIndex: 0, speakerHostId: "hA", speakerName: "A", seatIndex: 0, voiceId: FISH_A, spokenText: "Hot take one!", tone: "heated", energy: "high" },
      { lineIndex: 1, speakerHostId: "hB", speakerName: "B", seatIndex: 1, voiceId: FISH_B, spokenText: "Hot take two!", tone: "heated", energy: "high" },
      { lineIndex: 2, speakerHostId: "hA", speakerName: "A", seatIndex: 0, voiceId: FISH_A, spokenText: "Hot take three!", tone: "excited", energy: "high" },
    ];
    const p = buildFishScenePayload(input);
    const angryCues = (p.body.text.match(/\[(angry|excited|building to a shout)\]/g) || []).length;
    assert(angryCues <= 1, `expected at most 1 tone accent in the scene, found ${angryCues}`);
  });

  check("Fish scene keeps interruption markers and approved [tags] within the cue cap", () => {
    const input = sceneInput();
    input.utterances = [
      { lineIndex: 0, speakerHostId: "hA", speakerName: "A", seatIndex: 0, voiceId: FISH_A, spokenText: "Setup line ending mid-thought—", tone: "setup" },
      { lineIndex: 1, speakerHostId: "hB", speakerName: "B", seatIndex: 1, voiceId: FISH_B, spokenText: "No way. [laughs] Not tonight.", tone: "amused", isInterruption: true },
    ];
    const p = buildFishScenePayload(input);
    assert(p.body.text.includes("[cutting in]"), "interruption marker lost");
    assert(p.body.text.includes("[laugh]"), "approved script tag lost");
  });

  check("provider control syntax never leaks into the approved input text", () => {
    const input = sceneInput();
    input.utterances = input.utterances.map((u) => ({ ...u, voiceId: u.speakerHostId === "hA" ? FISH_A : FISH_B }));
    buildFishScenePayload(input);
    for (const u of input.utterances) {
      assert(!u.spokenText.includes("<|speaker:"), "builder mutated approved spokenText");
    }
  });

  check("capability matrix: scenes only for elevenlabs+fish; others single_line", () => {
    assert(providerSupportsSceneRendering("elevenlabs"), "elevenlabs must support scenes");
    assert(providerSupportsSceneRendering("fish"), "fish must support scenes");
    for (const p of ["openai", "cartesia", "boson", "stub"]) {
      assert(!providerSupportsSceneRendering(p), `${p} must NOT claim scene support`);
      const caps = getTtsProviderCapabilities(p);
      assert(caps.renderUnits.join(",") === "single_line", `${p} renderUnits wrong`);
    }
    const el = getTtsProviderCapabilities("elevenlabs");
    assert(el.recommendedMaxCharacters === 2000 && el.maxSpeakers === 10, "elevenlabs documented limits wrong");
    assert(el.supportsSeed && el.supportsWordTimestamps && !el.supportsContinuation, "elevenlabs capability flags wrong");
    const fish = getTtsProviderCapabilities("fish");
    assert(!fish.supportsSeed && !fish.supportsWordTimestamps, "fish capability flags wrong");
  });

  check("eligibility: unsupported/mixed/blocked providers return explicit fallback", () => {
    const mk = (providers: string[]) =>
      new Map<string, ResolvedTtsVoice>(providers.map((p, i) => [`h${i}`, { provider: p, voiceId: `v${i}`, voiceSource: "host_default" }]));
    const allow = new Set(["elevenlabs", "fish"]);
    assert(decideSceneEligibility({ resolvedByHostId: mk(["elevenlabs", "elevenlabs"]), allowlist: allow }).eligible, "uniform elevenlabs must be eligible");
    const mixed = decideSceneEligibility({ resolvedByHostId: mk(["elevenlabs", "fish"]), allowlist: allow });
    assert(!mixed.eligible && mixed.reason.includes("multiple engines"), "mixed engines must fall back with a reason");
    const openai = decideSceneEligibility({ resolvedByHostId: mk(["openai", "openai"]), allowlist: allow });
    assert(!openai.eligible, "openai must fall back (not allowlisted / no scenes)");
    const blocked = decideSceneEligibility({ resolvedByHostId: mk(["fish", "fish"]), allowlist: new Set(["elevenlabs"]) });
    assert(!blocked.eligible && blocked.reason.includes("ALLOWLIST"), "allowlist block must be explicit");
  });

  check("render-mode flag parsing + allowlist default", () => {
    const env = {} as NodeJS.ProcessEnv;
    assert(readRenderModeSetting(env) === "legacy_line", "default must be legacy_line");
    assert(readRenderModeSetting({ TTS_RENDER_MODE: "scene" } as never) === "scene", "scene setting lost");
    assert(readRenderModeSetting({ TTS_RENDER_MODE: "garbage" } as never) === "legacy_line", "garbage must fall back to legacy_line");
    const allow = readSceneProviderAllowlist(env);
    assert(allow.has("elevenlabs") && allow.has("fish") && allow.size === 2, "default allowlist wrong");
  });

  check("stable seeds derive deterministically from fingerprints", () => {
    assert(stableSceneSeed("abc", 0) === stableSceneSeed("abc", 0), "seed not deterministic");
    assert(stableSceneSeed("abc", 0) !== stableSceneSeed("abc", 1), "candidates must get distinct seeds");
    const s = stableSceneSeed("abc", 0);
    assert(s >= 0 && s <= 4294967295, "seed out of documented range");
  });

  check("no provider receives another provider's voice id (fish gate)", () => {
    const input = sceneInput();
    input.utterances[0].voiceId = "21m00Tcm4TlvDq8ikWAM"; // an ElevenLabs-style id
    input.utterances = input.utterances.map((u, i) => (i === 0 ? u : { ...u, voiceId: FISH_B }));
    try {
      buildFishScenePayload(input);
      throw new Error("cross-provider voice id accepted");
    } catch (e) {
      assert(e instanceof SceneGenerationError && e.category === "invalid_voice", "wrong gate for cross-provider id");
    }
  });

  check("directions are format- and role-aware (no universal sports-debate brief)", () => {
    const profile = deriveProfileFromHostFields({ role: "anchor", speakingStyle: "measured, precise", intensityLevel: 4 });
    const anchor = buildPerformanceDirection({ formatId: "news_roundup", roleId: "news_anchor", host: { name: "Dana", speakingStyle: "measured, precise" }, profile, sceneType: "news_block" });
    assert(!/sports debate podcast host/i.test(anchor), "news anchor still gets the sports-debate direction");
    assert(/facts/i.test(anchor) && /interpretation/i.test(anchor), "anchor direction must separate facts from interpretation");
    const narrator = buildPerformanceDirection({ formatId: "documentary", roleId: "narrator", host: { name: "Sam" }, profile, sceneType: "documentary_narration" });
    assert(/narrat/i.test(narrator) && narrator !== anchor, "narrator direction must differ from anchor");
    const interviewer = buildPerformanceDirection({ formatId: "interview", roleId: "interviewer", host: { name: "Kim" }, profile, sceneType: "interview_exchange" });
    assert(/interested in the answer/i.test(interviewer), "interviewer direction must value the answer");
    const moderator = buildPerformanceDirection({ formatId: "three_person_panel", roleId: "moderator", host: { name: "Lee" }, profile, sceneType: "conversation" });
    assert(/never dominate/i.test(moderator), "moderator must control traffic without dominating");
  });

  check("performance profiles: bounds, derivation, and intensity-as-range", () => {
    const hot = deriveProfileFromHostFields({ role: "driver", speakingStyle: "loud", intensityLevel: 9 });
    assert(hot.peakIntensity === 9 && hot.baselineIntensity === 7, "intensity 9 must be the CEILING with a lower baseline");
    const stored = { ...hot, providerOverrides: { elevenlabs: { stability: 0.4 } } };
    const r = resolveHostPerformanceProfile(stored, { intensityLevel: 2 });
    assert(r.source === "stored" && r.profile.providerOverrides.elevenlabs?.stability === 0.4, "valid stored profile must win");
    const bad = resolveHostPerformanceProfile({ version: 99, junk: true }, { intensityLevel: 2 });
    assert(bad.source === "derived", "invalid stored profile must derive");
    assert(!hostPerformanceProfileSchema.safeParse({ ...hot, baselinePace: 9 }).success, "out-of-bounds pace must fail validation");
  });

  check("scene QA: coverage, duplicate fingerprints, honest not_run transcript status", () => {
    const row = (i: number, over: Record<string, unknown> = {}) => ({
      sceneIndex: i, status: "ready", selected: true, renderUnit: "multi_speaker_scene",
      provider: "elevenlabs", model: "eleven_v3", requestFingerprint: `fp${i}`,
      lineIndexes: [i * 2, i * 2 + 1], durationMs: 8000, audioUrl: `https://x/${i}.mp3`,
      timingStatus: "provider_timestamps", voiceMap: { h1: "v1" }, characterCount: 200, ...over,
    });
    const ok = analyzeSceneAudioRows({ scenes: [row(0), row(1)], expectedLineIndexes: [0, 1, 2, 3], expectedProvider: "elevenlabs" });
    assert(ok.passed, `clean rows must pass: ${JSON.stringify(ok.checks.filter((c) => c.status === "fail"))}`);
    assert(ok.checks.find((c) => c.name.startsWith("Transcript fidelity"))!.status === "not_run", "transcript QA must be not_run without a configured service");
    const missing = analyzeSceneAudioRows({ scenes: [row(0)], expectedLineIndexes: [0, 1, 2, 3] });
    assert(!missing.passed, "missing lines must fail coverage");
    const dupFp = analyzeSceneAudioRows({ scenes: [row(0), row(1, { requestFingerprint: "fp0" })], expectedLineIndexes: [0, 1, 2, 3] });
    assert(!dupFp.passed, "duplicate fingerprints across scenes must fail");
    const noTiming = analyzeSceneAudioRows({ scenes: [row(0, { timingStatus: "timing_unavailable" }), row(1)], expectedLineIndexes: [0, 1, 2, 3], timingRequired: true });
    assert(!noTiming.passed, "required-but-missing timing must fail");
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
