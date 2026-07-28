// Regression guard for the failure where production had a scene-capable Fish
// pipeline but silently defaulted to one request per stored script line, while
// chair B was hardcoded as a restrained analytical counterweight and Fish told
// every high-energy line to build to a shout.
//
// Run: npx tsx --conditions=react-server src/scripts/testPerformancePipelineRegression.ts

import fs from "node:fs";
import path from "node:path";
import { buildPerformanceDirection } from "../lib/audio/performanceDirection";
import { formatLineForFish } from "../lib/providers/tts/fishFormat";
import { buildFishScenePayload } from "../lib/providers/tts/fishDialogue";
import { CAL_PROFILE, ZABALA_PROFILE, SEED_HOSTS } from "../lib/hosts/roster";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const calDirection = buildPerformanceDirection({
  formatId: "two_host_debate",
  roleId: "chair_b",
  host: { name: 'Cal "Red Eye" Mercer', speakingStyle: SEED_HOSTS[1].speakingStyle },
  profile: CAL_PROFILE as any,
  sceneType: "argument_escalation",
});

const zabalaDirection = buildPerformanceDirection({
  formatId: "two_host_debate",
  roleId: "chair_a",
  host: { name: "Bernadette Zabala", speakingStyle: SEED_HOSTS[0].speakingStyle },
  profile: ZABALA_PROFILE as any,
  sceneType: "argument_escalation",
});

console.log("\nPerformance pipeline regression:\n");

check("chair B is an equal protagonist, not the generic calm analyst", () => {
  assert(/equal protagonist/i.test(calDirection), "chair B lost equal-protagonist direction");
  assert(/never the designated analyst/i.test(calDirection), "chair B can regress into the analytical-counterweight template");
  assert(!/analytical counterweight: listen, correct/i.test(calDirection), "retired generic chair-B direction survived");
});

check("Cal's high-energy Fish fallback gets quieter, not louder", () => {
  const text = formatLineForFish({
    text: "You keep calling that context because the other word costs somebody a job.",
    tone: "heated",
    energy: "high",
    voiceDirection: calDirection,
  });
  assert(/slower, quieter/i.test(text), `Cal cue was '${text}'`);
  assert(!/shout|louder/i.test(text), `Cal was still instructed to get loud: '${text}'`);
});

check("Zabala and Cal receive genuinely different pressure signatures", () => {
  const z = formatLineForFish({ text: "Then name who paid for it.", tone: "heated", energy: "high", voiceDirection: zabalaDirection });
  const c = formatLineForFish({ text: "Listen to the word they chose.", tone: "heated", energy: "high", voiceDirection: calDirection });
  assert(z !== c, "both hosts received the same high-energy cue");
  assert(/faster/i.test(z), `Zabala did not receive her faster pressure signature: '${z}'`);
  assert(/quieter/i.test(c), `Cal did not receive his quieter pressure signature: '${c}'`);
});

check("Fish scene payload performs a conversation and carries authored delivery style", () => {
  const payload = buildFishScenePayload({
    episodeId: "ep",
    scriptId: "script",
    sceneId: "script:0:v1",
    sceneIndex: 0,
    sceneType: "argument_escalation",
    formatId: "two_host_debate",
    utterances: [
      {
        lineIndex: 0,
        speakerHostId: "cal",
        speakerName: 'Cal "Red Eye" Mercer',
        seatIndex: 1,
        voiceId: "11111111111111111111111111111111",
        spokenText: "That is the public version.",
        tone: "analytical",
        energy: "medium",
      },
      {
        lineIndex: 1,
        speakerHostId: "zabala",
        speakerName: "Bernadette Zabala",
        seatIndex: 0,
        voiceId: "22222222222222222222222222222222",
        spokenText: "Public for who?",
        tone: "incredulous",
        energy: "medium",
      },
      {
        lineIndex: 2,
        speakerHostId: "cal",
        speakerName: 'Cal "Red Eye" Mercer',
        seatIndex: 1,
        voiceId: "11111111111111111111111111111111",
        spokenText: "For the people who wrote it.",
        tone: "heated",
        energy: "high",
      },
    ],
    cast: [
      {
        speakerHostId: "cal",
        formatRoleId: "chair_b",
        direction: calDirection,
        intensityLevel: 7,
        angerStyle: "slower_quieter",
        maxCueDensity: 1,
        profileVersion: 1,
      },
      {
        speakerHostId: "zabala",
        formatRoleId: "chair_a",
        direction: zabalaDirection,
        intensityLevel: 8,
        angerStyle: "louder_faster",
        maxCueDensity: 1,
        profileVersion: 1,
      },
    ],
    format: "mp3",
  });

  assert(payload.body.reference_id.length === 2, "scene did not carry both voices in one request");
  assert(payload.body.text.includes("<|speaker:0|>"), "scene is missing speaker 0 tag");
  assert(payload.body.text.includes("<|speaker:1|>"), "scene is missing speaker 1 tag");
  assert(/conversational, responsive, reacting in the moment/i.test(payload.body.text), "authored delivery style never reached Fish");
  assert(/slow, quiet, cold and precise/i.test(payload.body.text), "Cal's emotional peak was not character-aware");
  assert(!/building to a shout/i.test(payload.body.text), "retired universal shout cue survived");
});

check("the active roster contains no literal Line Two gimmick", () => {
  const zabala = SEED_HOSTS[0];
  assert(zabala.name === "Bernadette Zabala", `active name is still '${zabala.name}'`);
  assert(zabala.catchphrases.length === 0, "Zabala still has prewritten catchphrases");
  assert(zabala.bannedPhrases.some((p) => /line two/i.test(p)), "Line Two is not explicitly banned from dialogue");
});

check("new productions default to scene rendering and prompts silence production metadata", () => {
  const root = process.cwd();
  const dispatch = fs.readFileSync(path.join(root, "src/lib/services/stitchDispatch.ts"), "utf8");
  const prompts = fs.readFileSync(path.join(root, "src/lib/formats/formatScriptPrompts.ts"), "utf8");
  assert(/process\.env\.TTS_RENDER_MODE\s*=\s*"auto"/.test(dispatch), "unset render mode no longer defaults to auto scenes");
  assert(/Production metadata is SILENT/.test(prompts), "prompt does not prohibit spoken labels");
  assert(!/max 2-3 per episode/.test(prompts), "numeric catchphrase allowance survived");
});

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
