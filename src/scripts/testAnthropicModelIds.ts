// Anthropic model-id allowlist + parameter classification.
//
//   npm run test:anthropic-model-ids
//
// NETWORK-FREE and credential-free. This is the guard that an invalid Anthropic
// model id can never ship silently.
//
// WHY IT EXISTS. An Anthropic model id is only ever wrong at the worst moment.
// The paid Anthropic rung is a BACKUP: it fires when the free chain has already
// failed, which is exactly when a 404 "model not found" is least recoverable and
// least likely to have been exercised in testing. A wrong id costs nothing on
// the happy path and everything on the unhappy one, so it has to be caught here
// rather than in production.
//
// It also pins the PARAMETER CLASSIFICATION per id. Getting that wrong is the
// same class of failure with a different error code: send `temperature` to a
// model that removed sampling params and every call 400s. The two classifiers
// are substring matchers, so a newly added id can silently land in the wrong
// bucket — the table below makes each id's bucket an asserted fact.
//
// AUDIT NOTE, 2026-08-11. A hardening audit recorded `claude-opus-5` as "not a
// valid Anthropic API model id" and asked for a downgrade to `claude-sonnet-4-6`.
// That was checked against Anthropic's current catalog and did not hold:
// claude-opus-5 is current and served ($5/$25 per MTok, 1M context), while
// sonnet-4-6 and opus-4-8 are real but OLDER generations. The default was
// therefore left on Opus 5 and this guard was built instead, which is the part
// of that audit item that carries real value.

import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODEL_ALLOWLIST,
  anthropicModelsWithShadowedThinking,
  anthropicSupportsAdaptiveThinking,
  anthropicSupportsSampling,
  anthropicTuningMode,
  type AnthropicTuningMode,
} from "../lib/providers/llm/anthropic";
import { isAllowedAnthropicModel } from "../lib/providers/llm/anthropic";
import { allRegisteredModels } from "../lib/providers/llm/capabilities";

let passed = 0,
  failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

/** Assert the branch buildBody takes for a model, by name rather than by flags. */
function assertMode(model: string, expected: AnthropicTuningMode) {
  const got = anthropicTuningMode(model);
  assert(
    got === expected,
    `${model} takes the "${got}" branch, expected "${expected}". ` +
      (expected === "adaptive-thinking"
        ? "This model is running WITHOUT adaptive thinking and without thinking headroom."
        : "The request shape sent to this model has changed.")
  );
}

/**
 * The asserted classification for every id this repo may send.
 *
 * `sampling` — false means the model REMOVED temperature/top_p/top_k and returns
 *   400 if they are sent. `adaptiveThinking` — true means `thinking:{type:
 *   "adaptive"}` is the supported quality lever.
 *
 * The four ids the audit named are all present, plus the two the pipeline
 * actually runs on today.
 */
const CLASSIFICATION: Array<{
  model: string;
  sampling: boolean;
  adaptiveThinking: boolean;
  why: string;
}> = [
  {
    model: "claude-opus-5",
    sampling: false,
    adaptiveThinking: true,
    why: "current Opus; sampling params removed, thinking on by default",
  },
  {
    model: "claude-sonnet-5",
    sampling: false,
    adaptiveThinking: true,
    why: "current Sonnet; sampling params removed",
  },
  {
    model: "claude-fable-5",
    sampling: false,
    adaptiveThinking: true,
    why: "thinking is always on; sampling params removed",
  },
  {
    model: "claude-opus-4-8",
    sampling: false,
    adaptiveThinking: true,
    why: "sampling params removed at 4.7; adaptive is the only on-mode",
  },
  {
    model: "claude-sonnet-4-6",
    sampling: true,
    adaptiveThinking: true,
    why: "older generation — still ACCEPTS temperature, and supports adaptive thinking",
  },
  {
    model: "claude-haiku-4-5-20251001",
    sampling: true,
    adaptiveThinking: false,
    why: "pre-adaptive: accepts temperature, uses budget_tokens rather than adaptive thinking",
  },
];

function main() {
  console.log("\nAnthropic model ids — allowlist and parameter classification\n");

  // ---- the guard itself ----------------------------------------------------

  check("the in-code default model id is on the allowlist", () => {
    assert(
      isAllowedAnthropicModel(ANTHROPIC_DEFAULT_MODEL),
      `ANTHROPIC_DEFAULT_MODEL is "${ANTHROPIC_DEFAULT_MODEL}", which is not in ANTHROPIC_MODEL_ALLOWLIST. ` +
        `A default that is not a real catalog id 404s the moment the paid backup rung fires. ` +
        `Allowed: ${ANTHROPIC_MODEL_ALLOWLIST.join(", ")}`
    );
  });

  check("the allowlist has no duplicate or blank entries", () => {
    const seen = new Set<string>();
    for (const id of ANTHROPIC_MODEL_ALLOWLIST) {
      assert(id.trim().length > 0, "the allowlist contains a blank id");
      assert(!seen.has(id), `duplicate allowlist entry: ${id}`);
      seen.add(id);
    }
  });

  check("every Anthropic model in the capability registry is on the allowlist", () => {
    const registered = allRegisteredModels()
      .filter((c) => c.provider === "anthropic")
      .map((c) => c.model);
    assert(registered.length > 0, "the capability registry lists no Anthropic models at all");
    const stray = registered.filter((m) => !isAllowedAnthropicModel(m));
    assert(
      stray.length === 0,
      `capabilities.ts routes to Anthropic ids that the allowlist does not recognise: ${stray.join(", ")}. ` +
        `One of the two is wrong — reconcile them rather than adding a second source of truth.`
    );
  });

  check("an obviously invalid id is rejected", () => {
    // Guards the guard: a matcher that accepts everything asserts nothing.
    for (const bogus of ["claude-opus-6", "claude-4-opus", "opus-5", "", "gpt-4o"]) {
      assert(!isAllowedAnthropicModel(bogus), `"${bogus}" was accepted as a valid Anthropic model id`);
    }
  });

  // ---- classification ------------------------------------------------------

  for (const row of CLASSIFICATION) {
    check(`${row.model} is on the allowlist`, () => {
      assert(
        isAllowedAnthropicModel(row.model),
        `${row.model} is classified below but is not an allowed id — the two lists have drifted`
      );
    });

    check(`${row.model} sampling=${row.sampling} (${row.why})`, () => {
      const got = anthropicSupportsSampling(row.model);
      assert(
        got === row.sampling,
        `expected supportsSampling=${row.sampling}, got ${got}. ` +
          (row.sampling
            ? "Classifying an older model as sampling-free silently drops temperature."
            : "Classifying a 4.7+/5-family model as sampling-capable sends temperature and every call 400s.")
      );
    });

    check(`${row.model} adaptiveThinking=${row.adaptiveThinking}`, () => {
      const got = anthropicSupportsAdaptiveThinking(row.model);
      assert(got === row.adaptiveThinking, `expected supportsAdaptiveThinking=${row.adaptiveThinking}, got ${got}`);
    });
  }

  // ---- the collisions the substring matcher could plausibly make -----------

  check("'opus-5' does not match the legacy opus-4-5 ids", () => {
    // The matcher's own comment claims this; assert it rather than trust it.
    for (const legacy of ["claude-opus-4-5", "claude-opus-4-5-20251101"]) {
      assert(
        anthropicSupportsSampling(legacy),
        `${legacy} was classified as sampling-free — the "opus-5" substring collided with "opus-4-5"`
      );
    }
  });

  check("the haiku 4.5 dated id classifies the same as its alias", () => {
    assert(
      anthropicSupportsSampling("claude-haiku-4-5") === anthropicSupportsSampling("claude-haiku-4-5-20251001") &&
        anthropicSupportsAdaptiveThinking("claude-haiku-4-5") ===
          anthropicSupportsAdaptiveThinking("claude-haiku-4-5-20251001"),
      "the alias and the dated id classify differently, so behaviour depends on which spelling was configured"
    );
  });

  check("every allowlisted id has at least one quality lever", () => {
    // A model that rejects sampling AND has no adaptive-thinking path has no
    // way to be tuned at all — that combination means a missing classifier row,
    // not a real model.
    const stranded = ANTHROPIC_MODEL_ALLOWLIST.filter(
      (m) => !anthropicSupportsSampling(m) && !anthropicSupportsAdaptiveThinking(m)
    );
    assert(
      stranded.length === 0,
      `these ids reject sampling and have no adaptive-thinking path, so they have no tuning lever at all — ` +
        `they are almost certainly missing from one of the two matchers: ${stranded.join(", ")}`
    );
  });

  // ---- documented consequence of the current wiring ------------------------

  // ---- which quality lever each model actually gets ------------------------
  //
  // buildBody is an if/else, so a model that is BOTH sampling-capable and
  // adaptive-capable never reaches the thinking branch: it gets temperature, no
  // thinking, and no thinking headroom. Worth knowing exactly who that is.

  check("THE SCRIPT MODEL GETS ADAPTIVE THINKING — it is not shadowed", () => {
    // The question that prompted this section was whether Opus 5 — the script
    // model — was silently running without its main quality lever. It is not:
    // Opus 5 rejects sampling params, so supportsSampling() is false, the
    // if/else falls through to the adaptive branch, and thinking IS enabled
    // along with LLM_THINKING_HEADROOM_TOKENS of max_tokens headroom.
    assertMode(ANTHROPIC_DEFAULT_MODEL, "adaptive-thinking");
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      assertMode(m, "adaptive-thinking");
    }
  });

  check("the pre-adaptive models take neither branch's thinking path", () => {
    assertMode("claude-haiku-4-5", "sampling");
    assertMode("claude-haiku-4-5-20251001", "sampling");
  });

  check("exactly the 4.6 pair is shadowed by the if/else, and nothing newer", () => {
    // These two are sampling-capable AND adaptive-capable, so the adaptive
    // branch is unreachable for them. Neither is the script model, and neither
    // is routed to by any profile — so this is a latent trap for whoever pins
    // SCRIPT_LLM_MODEL to one of them, not a live regression. Recorded in
    // docs/known-defects.md rather than fixed, because changing it alters what
    // is sent to a model and that is a decision, not a cleanup.
    const shadowed = [...anthropicModelsWithShadowedThinking()].sort().join(",");
    assert(
      shadowed === "claude-opus-4-6,claude-sonnet-4-6",
      `the set of models whose adaptive thinking is shadowed by buildBody's if/else has CHANGED: [${shadowed}]. ` +
        `If a CURRENT model has joined it, that model is now running without thinking and without thinking headroom, ` +
        `and the if/else needs to become two independent checks. See docs/known-defects.md.`
    );
    for (const m of shadowed) assertMode(m, "sampling");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
