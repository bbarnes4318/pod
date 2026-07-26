// Phase 3 — controls must not lie about what they will do.
//
// Three defects from the customer run, all the same shape: the SERVER knew the
// truth and the SCREEN contradicted it.
//
//   D-06  "Publish is blocked. Not fact-checked yet. 31 unresolved claims."
//         rendered beside a fully enabled "Publish to feed" button. The gate was
//         correct; the only way to discover it was to press a live-looking
//         control and read the failure.
//   D-04  "🎬 Episode created" was the headline on a screen where NOTHING was
//         running — the studio was waiting for a second click. It cost 25
//         minutes of watching a static screen for progress that was never
//         coming.
//   D-13  The engine picker offered ElevenLabs, Cartesia and OpenAI on a
//         deployment that only has Fish credentials. Three of four choices were
//         accepted at selection and could only fail later, after the customer
//         had already paid for a script.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ttsEngineOptions, isTtsEngineAvailable } from "../lib/providers/tts/availability";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

console.log("Honest controls\n");

const publishPanel = src("app/studio/PublishPanel.tsx");
const actions = src("app/app/create/actions.ts");
const builder = src("app/studio/create/RundownBuilder.tsx");

check("D-06: the publish button is disabled when the server gate says no", () => {
  assert(/disabled=\{busy === "publish" \|\| !st\.canPublish\}/.test(publishPanel),
    "the button must reflect canPublish, not be permanently enabled");
});

check("D-06: blockers are readable BEFORE pressing anything", () => {
  // The old panel only had `reasons`, populated from a FAILED attempt.
  assert(/st\.publishBlockers/.test(publishPanel), "the panel must render blockers from the initial state read");
  assert(/publish-blockers/.test(publishPanel), "blockers need an addressable region");
});

check("D-06: the state read runs the same gate the publish action enforces", () => {
  const fn = actions.slice(actions.indexOf("export async function getPublishState"));
  const body = fn.slice(0, fn.indexOf("\nexport async function", 1));
  assert(/validateEpisodeForRss\(/.test(body),
    "getPublishState must run the real validator — a second, parallel notion of readiness would drift from the gate");
  assert(/canPublish/.test(body) && /publishBlockers/.test(body), "it must return both the verdict and the reasons");
});

check("D-06: the readiness check validates the action the button ACTUALLY performs", () => {
  // Regression from the Phase 4 run: the first version of this fix always
  // validated "publish", but publishOwnedEpisode promotes a content_ready
  // episode to publish_ready itself first. The panel therefore reported
  // "must be 'publish_ready'" and disabled the button on a publishable episode.
  // A readiness check that disagrees with the action it guards blocks real work.
  const fn = actions.slice(actions.indexOf("export async function getPublishState"));
  const body = fn.slice(0, fn.indexOf("\nexport async function", 1));
  assert(/ep\.status === "content_ready" \? "prepare" : "publish"/.test(body),
    "a content_ready episode must be validated against 'prepare', which is what the publish path does to it");
  const pub = actions.slice(actions.indexOf("export async function publishOwnedEpisode"));
  assert(/status === "content_ready"\) await prepareEpisodeForPublishing/.test(pub.slice(0, 1200)),
    "this test's premise: the publish action auto-prepares a content_ready episode");
});

check("D-04: the created screen says nothing is running yet", () => {
  assert(!/🎬 Episode created<\/h2>/.test(builder), "the terminal-sounding headline must be gone");
  assert(/not started yet/i.test(builder), "the heading must name the actual state");
  assert(/Nothing is generating yet/i.test(builder), "the screen must state that no work has begun");
  assert(/not-started-notice/.test(builder), "the notice needs an addressable region");
});

check("D-04: the forward action is still the primary control", () => {
  const at = builder.indexOf('data-testid="start-debate"');
  assert(at !== -1, "the start control must still exist");
  assert(/btnPrimary/.test(builder.slice(at - 200, at + 200)), "starting the debate must be the primary button");
});

check("D-13: the engine list is resolved from real credentials", () => {
  assert(!/const TTS = \[/.test(builder), "the hard-coded engine list must be gone");
  assert(/ttsEngines\.map/.test(builder), "the picker must render the server-provided list");
  assert(/disabled=\{!t\.available\}/.test(builder), "unavailable engines must not be selectable");
});

check("D-13: availability follows the provider's env var", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.FISH_API_KEY = "test-key";
    const opts = ttsEngineOptions();
    const fish = opts.find((o) => o.key === "fish")!;
    const el = opts.find((o) => o.key === "elevenlabs")!;
    assert(fish.available, "a configured provider must be selectable");
    assert(!el.available, "an unconfigured provider must be blocked");
    assert(!!el.reason, "a blocked provider must explain itself, not just vanish");
    assert(isTtsEngineAvailable("fish"), "isTtsEngineAvailable must agree with the option list");
    assert(!isTtsEngineAvailable("elevenlabs"), "isTtsEngineAvailable must agree with the option list");
    assert(isTtsEngineAvailable(""), "host default must always be allowed");
  } finally {
    process.env = saved;
  }
});

check("D-13: the host default is always offered first", () => {
  const opts = ttsEngineOptions();
  assert(opts[0].key === "" && opts[0].available, "auto/host-default must lead the list and always be available");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
