// Chemistry audition: prompt carries the real host profile, normalisation is
// strict, measurements are honest, and no chemistry score exists.
// Pure. Run: npm run test:chemistry-audition
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { auditionShapeProblem, buildAuditionPrompt, normalizeScene, sceneFacts, subjectText, type AuditionHost } from "../lib/talent/chemistryAudition";

let passed = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); passed++; };

const host = (id: string, over: Partial<AuditionHost> = {}): AuditionHost => ({
  id, name: id.toUpperCase(), role: "analyst", worldview: `${id} believes defense wins`, speakingStyle: "clipped", catchphrases: [`${id}-catch`], argumentPatterns: [`${id} cites history`],
  likes: [], dislikes: [], bannedPhrases: [`${id}-never`],
  settings: { energy: "big", pace: "fast", humor: "dry", interruptions: "jumps_in", concessions: "stubborn", finish: "sharp", pressure: "louder_faster", extraInstructions: "" },
  ...over,
});
const a = host("a"), b = host("b", { settings: { ...host("b").settings, interruptions: "waits", concessions: "gracious", humor: "playful" } });

// ---- the prompt is built from the stored profile, not a generic voice
{
  const { prompt, systemPrompt } = buildAuditionPrompt([a, b], subjectText("trade", ""), "debate");
  for (const s of ["a believes defense wins", "a cites history", "interruptions: jumps_in", "interruptions: waits", "concedes: gracious", "humor playful", "Never says: a-never", "a-catch"]) ok(prompt.includes(s), `prompt carries "${s}"`);
  ok(/not simply alternate/.test(systemPrompt) && /concession/.test(systemPrompt), "the writer is told not to write alternating speeches");
  ok(/do not score/.test(systemPrompt), "the writer is told its notes are opinion, not a score");
  ok(/<user_input>/.test(prompt), "the subject is fenced as data");
  ok(subjectText("custom", "x".repeat(900)).length === 400, "custom subject is capped");
}

// ---- normalisation
{
  const raw = {
    lines: [
      { speakerHostId: "a", text: "Heist.", isInterruption: true, energy: "loud", pauseBefore: "x" },
      { speakerHostId: "b", text: "Panic move—", isInterruption: false },
      { speakerHostId: "a", text: "No—", isInterruption: true },
      { speakerHostId: "a", text: "Let me finish.", isInterruption: true },
      { speakerHostId: "ghost", text: "I am not cast." },
      { speakerHostId: "b", text: "  " },
      { speakerHostId: "b", text: "Fine, one point to you." },
    ],
    works: ["Contrast."], risks: ["Could get shouty."],
  };
  const s = normalizeScene(raw, { hostIds: ["a", "b"], subject: "x", style: "debate", model: "m" });
  ok(s.lines.length === 5, "uncast speakers and empty lines are dropped");
  ok(!s.lines[0].isInterruption, "the first line cannot interrupt");
  ok(s.lines[2].isInterruption && !s.lines[3].isInterruption, "a host cannot interrupt themself");
  ok(s.lines[0].energy === "medium" && s.lines[0].pauseBefore === "beat", "unknown delivery values fall back");
  ok(s.modelNotes.risks[0] === "Could get shouty.", "the writer's notes are kept, separately");
  ok(auditionShapeProblem(s, ["a", "b"]) !== null, "a too-short scene is refused");
}

// ---- measured facts
{
  const lines = (spk: string[], cut: number[] = []) => spk.map((id, i) => ({ speakerHostId: id, text: "one two three four five", tone: "x", energy: "medium" as const, isInterruption: cut.includes(i), pauseBefore: "beat" as const }));
  const alt = sceneFacts({ hostIds: ["a", "b"], lines: lines(["a", "b", "a", "b"]) });
  ok(alt.strictlyAlternating && alt.longestRun === 1, "strict turn-taking with no cut-ins is flagged");
  const real = sceneFacts({ hostIds: ["a", "b"], lines: lines(["a", "b", "b", "a"], [3]) });
  ok(!real.strictlyAlternating && real.longestRun === 2 && real.interruptions === 1, "runs and interruptions are counted");
  ok(real.words === 20 && real.estimatedSeconds === 8 && real.perHost[0].wordShare === 50, "word count, duration estimate and share are arithmetic on the text");
}

// ---- source checks: real voicing, real casting, no invented score
{
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const actions = src("app/studio/hosts/chemistryActions.ts");
  ok(/synthesizeDialogueScene\(input\)/.test(actions) && /providerSupportsSceneRendering\(sceneEngine\)/.test(actions), "voicing performs one native multi-speaker scene when the engine supports it");
  ok(/normalizeScene\(scene, \{ hostIds: ids/.test(actions), "a scene sent back from the browser is re-normalised before voicing");
  ok(/podcast\.update\(\{ where: \{ id: podcastId \}, data: \{ hostIds: ids \} \}\)[\s\S]{0,120}podcastProductionConfig\.updateMany/.test(actions), "casting writes the show and its production config together");
  ok(/ids\.length > 2\) return \{ success: false/.test(actions), "a three-host pairing cannot be applied (generation supports two)");
  ok(/roleHasRealProvider\(ROLE\)/.test(actions) && /maxTokens: MAX_TOKENS/.test(actions), "the writer uses role routing, checks availability and caps tokens");
  const ui = src("app/studio/hosts/ChemistryAudition.tsx");
  ok(!/chemistry score|chemistryScore|\/ ?10\b|rating/i.test(ui.replace(/There is no\s+\/\/ chemistry score[^\n]*/, "").replace(/no chemistry score/i, "")), "the interface shows no chemistry score or rating");
  ok(/subjective, not measured/.test(ui) && /Measured/.test(ui), "measurements and the writer's opinion are labelled apart");
}

console.log(`ok  chemistry audition: ${passed} passed, 0 failed`);
