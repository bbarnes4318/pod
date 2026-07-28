// Network-free regression for customer-authored show bibles and storylines.
// Run: npx tsx --conditions=react-server src/scripts/testShowForgeCapabilities.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultShowForgeState,
  decodeShowForgeState,
  encodeShowForgeState,
  renderShowForgePrompt,
  storylineSequence,
  templateBible,
  type ShowForgeState,
} from "../lib/shows/showForge";

let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const source = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

async function main() {
  console.log("Show Forge customer experience + production wiring\n");

  await check("all five creative templates produce valid show bibles", () => {
    for (const template of ["rivalry_room", "insider_room", "fan_court", "season_story", "custom"] as const) {
      const bible = templateBible(template);
      assert(bible.templateId === template, `template ${template} changed identity`);
      assert(bible.premise.length >= 8, `template ${template} has no usable premise`);
      assert(bible.audiencePromise.length >= 8, `template ${template} has no listener promise`);
      assert(bible.recurringSegments.length > 0, `template ${template} has no episode DNA`);
    }
  });

  await check("encoded show bibles round-trip while old script styles remain readable", () => {
    const state = defaultShowForgeState();
    const encoded = encodeShowForgeState(state);
    const decoded = decodeShowForgeState(encoded);
    assert(decoded.state?.bible.premise === state.bible.premise, "show bible did not round-trip");
    assert(decoded.legacyScriptStyle === state.scriptStyle, "script style was lost inside the envelope");

    const legacy = decodeShowForgeState("sports-radio");
    assert(legacy.state === null, "a legacy style was misread as a Show Forge envelope");
    assert(legacy.legacyScriptStyle === "sports-radio", "legacy script style was not preserved");
  });

  await check("active storylines interleave deterministically across episodes", () => {
    const base = defaultShowForgeState();
    const state: ShowForgeState = {
      ...base,
      storylines: [
        {
          id: "arc-a", title: "Trust", premise: "Trust changes.", status: "active", priority: 5, featuredHostIds: [],
          beats: [
            { title: "A1", direction: "Plant the disagreement." },
            { title: "A2", direction: "Force a costly choice." },
          ],
        },
        {
          id: "arc-b", title: "Pressure", premise: "Pressure reveals character.", status: "active", priority: 3, featuredHostIds: [],
          beats: [
            { title: "B1", direction: "Expose the pressure point." },
            { title: "B2", direction: "Pay off the pressure point." },
          ],
        },
        {
          id: "paused", title: "Paused", premise: "Not currently moving.", status: "paused", priority: 5, featuredHostIds: [],
          beats: [{ title: "P1", direction: "Do not schedule." }, { title: "P2", direction: "Do not schedule." }],
        },
      ],
    };
    const sequence = storylineSequence(state.storylines);
    assert(sequence.map((beat) => beat.beatTitle).join(",") === "A1,B1,A2,B2", `unexpected storyline order: ${sequence.map((beat) => beat.beatTitle).join(",")}`);
  });

  await check("writer prompt receives the show promise, episode DNA, arc beat, and factual boundary", () => {
    const base = defaultShowForgeState();
    const state: ShowForgeState = {
      ...base,
      storylines: [{
        id: "arc", title: "The Cost of Loyalty", premise: "Loyalty keeps changing meaning.", status: "active", priority: 5, featuredHostIds: [],
        beats: [
          { title: "Plant it", direction: "Let the hosts discover the disagreement." },
          { title: "Make it cost", direction: "A position should now cost one host something." },
        ],
      }],
    };
    const rendered = renderShowForgePrompt(state, 1);
    assert(rendered.prompt.includes(state.bible.premise), "show premise did not reach the writer");
    assert(rendered.prompt.includes(state.bible.audiencePromise), "listener promise did not reach the writer");
    assert(rendered.prompt.includes(state.bible.recurringSegments[0].name), "recurring segment library did not reach the writer");
    assert(rendered.prompt.includes("Make it cost"), "scheduled storyline beat did not reach the writer");
    assert(/may NEVER create a real-world fact/i.test(rendered.prompt), "storyline factual boundary is missing");
  });

  await check("Show Forge presents the complete beginner-facing creation experience", () => {
    const ui = source("app/app/podcasts/new/PodcastWizard.tsx");
    for (const label of ["Spark", "Promise", "World", "Cast", "Episode DNA", "Storylines", "Schedule", "Launch"]) {
      assert(ui.includes(label), `missing Show Forge step: ${label}`);
    }
    for (const feature of ["The Rivalry Room", "Inside the Building", "Fan Court", "The Season Story", "Build season storylines", "Recurring segment library"]) {
      assert(ui.includes(feature), `missing customer-facing capability: ${feature}`);
    }
  });

  await check("podcast save writes canonical configuration, cast, publishing, and continuity together", () => {
    const actions = source("app/app/podcasts/actions.ts");
    for (const marker of ["encodeShowForgeState", "podcastEditorialConfig.create", "podcastProductionConfig.create", "podcastPublishingConfig.create", "showContinuity.create"]) {
      assert(actions.includes(marker), `podcast save is missing ${marker}`);
    }
    assert(actions.includes("db.$transaction"), "show creation is not transactional");
  });

  await check("the real script compositor loads and injects Show Forge state", () => {
    const service = source("lib/services/showContinuityService.ts");
    assert(service.includes("decodeShowForgeState"), "production prompt does not load the show bible");
    assert(service.includes("renderShowForgePrompt"), "production prompt does not render the show bible");
    assert(service.includes("showForge.prompt"), "rendered Show Forge prompt is not composed into generation");
    const script = source("lib/services/scriptService.ts");
    assert(script.includes("continuityForGeneration"), "script generation does not call the continuity compositor");
    assert(script.includes("continuity?.promptBlock"), "composed show prompt does not reach the script system prompt");
  });

  await check("show headquarters surfaces promise, upcoming movement, arcs, episodes, and editing", () => {
    const page = source("app/app/podcasts/[id]/page.tsx");
    for (const label of ["Show Headquarters", "The show promise", "Next storyline movement", "Storyline board", "Episodes in this show", "Edit in Show Forge"]) {
      assert(page.includes(label), `show headquarters is missing: ${label}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
