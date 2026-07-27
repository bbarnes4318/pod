// Routing profiles: which provider/model plays each role.
//
//   legacy               — the application's current behavior, exactly. Empty
//                          chains: every role resolves straight to the grouped
//                          configuration it uses today (LLM_*, SCRIPT_LLM_*,
//                          VERIFY_*). THE DEFAULT, so deploying this code
//                          changes nothing for an existing deployment.
//   frontier_development — role-specific NVIDIA-hosted primaries, Z.ai
//                          secondary/tertiary, existing providers as the
//                          role-appropriate paid backup. Recommended while the
//                          application is in development.
//   free_independent     — Z.ai's free general-purpose API for the whole chain,
//                          with no dependence on NVIDIA hosted capacity.
//   custom               — explicit per-role overrides only.
//
// Model ids are resolved through env so a catalog rename never requires a code
// change. See capabilities.ts for the verified/unverified honesty rule.

import { MODEL_IDS, isRoutableByDefault, modelCapabilities } from "./capabilities";
import { ALL_ROLES, LLMRole } from "./roles";
import { readRoutingEnv } from "./routingEnv";

export type RoutingProfile =
  | "legacy"
  | "verified_development"
  | "frontier_development"
  | "free_independent"
  | "custom";

export const ROUTING_PROFILES: RoutingProfile[] = [
  "legacy",
  "verified_development",
  "frontier_development",
  "free_independent",
  "custom",
];

export interface ProviderModelRef {
  provider: string;
  model: string;
}

/** Ordered primary → secondary → tertiary for one role under one profile. */
export type ProfileRoleChain = ProviderModelRef[];

function nv(key: keyof typeof MODEL_IDS.nvidia, envKey: string): ProviderModelRef {
  return { provider: "nvidia", model: readRoutingEnv(envKey) || MODEL_IDS.nvidia[key] };
}

const NV = {
  deepseekFlash: () => nv("deepseekFlash", "NVIDIA_MODEL_DEEPSEEK_FLASH"),
  deepseekPro: () => nv("deepseekPro", "NVIDIA_MODEL_DEEPSEEK_PRO"),
  glm: () => nv("glm", "NVIDIA_MODEL_GLM"),
  nemotron: () => nv("nemotron", "NVIDIA_MODEL_NEMOTRON"),
  mistral: () => nv("mistral", "NVIDIA_MODEL_MISTRAL"),
  kimi: () => nv("kimi", "NVIDIA_MODEL_KIMI"),
};

const ZAI_FLASH = (): ProviderModelRef => ({
  provider: "zai",
  model: readRoutingEnv("ZAI_MODEL_GLM_FLASH") || MODEL_IDS.zai.glmFlash,
});

/**
 * LIVE CONTRACT FINDINGS — 2026-07-26 (artifacts/*-contract-report.json)
 *
 * The map below is UNCHANGED from the specification's initial assignments,
 * deliberately: promotion requires role-specific comparative evidence and none
 * exists yet (`npm run test:role-experiments` has not been run against these
 * models). But the contract probe surfaced three things that the dialogue
 * decision will have to answer, recorded here so they are read at the point of
 * decision rather than buried in a report:
 *
 * 1. MISTRAL MEDIUM 3.5 IS SLOW. 30-88 seconds for one-sentence answers
 *    (66s, 88s, 55s, 58s, 34s, 77s, 66s, 30s, 82s). It holds script_movement,
 *    where the real call is a 16,000-token movement, three per episode. This is
 *    promotion-rule violation #5 (unacceptable latency) on its face and is the
 *    strongest argument against keeping it primary. Do not resolve this by
 *    guessing — run the dialogue experiment and read the latency column.
 *
 * 2. KIMI K2.6 IS NOT AVAILABLE to the NVIDIA account in use: 404 "Not found
 *    for account". It is the SECONDARY for script_movement, script_rewrite and
 *    episode_metadata and the default SCRIPT_CHALLENGER_MODEL. Until access is
 *    sorted (or NVIDIA_MODEL_KIMI is pointed elsewhere), the dialogue chain is
 *    effectively mistral -> zai, with Kimi contributing a wasted attempt that
 *    routing correctly classifies as a configuration failure.
 *
 * 3. DEEPSEEK V4 FLASH WAS RATE-LIMITED throughout (503 ResourceExhausted,
 *    worker 48/48). It is primary for topic generation, topic classification,
 *    show notes and continuity, so those roles should be expected to fall
 *    through to Z.ai under load. Not a capability problem — a capacity one.
 *
 * Also verified and already reflected in capabilities.ts: native JSON works on
 * all four reachable NVIDIA models, GLM-5.2 genuinely reasons (reasoning_content
 * observed), and reasoning_budget is Nemotron's alone.
 */

/**
 * Frontier development map. Read as: strongest appropriate model per job.
 * Rationale per role lives in roles.ts (`purpose`).
 */
function frontierChain(role: LLMRole): ProfileRoleChain {
  switch (role) {
    // Fast, high-volume, structured. Never the slow script configuration.
    case "topic_generation":
    case "topic_classification":
    case "show_notes":
      return [NV.deepseekFlash(), ZAI_FLASH()];

    // Judgement under comparison — reasoning mode.
    case "topic_ranking":
      return [NV.glm(), NV.nemotron(), ZAI_FLASH()];

    // Long-context consolidation and traceable extraction — reasoning mode.
    case "research_brief":
    case "evidence_extraction":
      return [NV.nemotron(), NV.deepseekPro(), ZAI_FLASH()];

    // Conversational architecture — reasoning mode.
    case "script_outline":
      return [NV.glm(), NV.nemotron(), ZAI_FLASH()];

    // The creative dialogue roles. Same family for writing and repair, so a
    // repair keeps the writer's voice instead of flattening it into analysis.
    case "script_movement":
    case "script_rewrite":
    case "episode_metadata":
      return [NV.mistral(), NV.kimi(), ZAI_FLASH()];

    // Grading against evidence — reasoning mode, independent of the writer.
    case "script_verification":
    case "fact_check":
      return [NV.deepseekPro(), NV.nemotron(), ZAI_FLASH()];

    // Cheap literal transcript audit.
    case "continuity_report":
      return [NV.deepseekFlash(), NV.deepseekPro(), ZAI_FLASH()];

    // A writing model must never be the sole judge of its own output, so the
    // judge chain deliberately shares no model with script_movement.
    case "quality_judge":
      return [NV.nemotron(), NV.glm()];
  }
}

/** Every role on Z.ai's free general-purpose API — deliberately role-agnostic:
 *  the point of this profile is to test one provider across the whole chain. */
function freeIndependentChain(): ProfileRoleChain {
  return [ZAI_FLASH()];
}

/**
 * ROLE-EXPERIMENT FINDINGS — `npm run test:role-experiments`
 * (artifacts/role-experiment-{dialogue,outline,verification}.json)
 *
 * These are measurements, not preferences. Five roles below are now set by
 * them; the rest still rest on contract-probe reachability alone and say so.
 *
 * DIALOGUE (role: script_movement / script_rewrite)
 *   Z.ai GLM-4.7 Flash   judge 79, average episode 143 s
 *   Mistral Medium 3.5   judge 76, average episode 536 s
 *   Z.ai wins on both axes at once, and the latency gap is the decisive one:
 *   movements are SEQUENTIAL, so 536 s is a nine-minute floor per episode
 *   against Z.ai's two and a half. Mistral drops to secondary — it is retained
 *   rather than removed because it is a different family from Z.ai, so it is a
 *   real fallback rather than a second copy of the same failure mode. This
 *   reverses the contract-probe-era assignment; finding #1 below predicted it.
 *
 * OUTLINE (role: script_outline)
 *   Nemotron 3 Ultra     7 beats, 3 position shifts,  21 s
 *   GLM-5.2              7 beats, 2 position shifts, 118 s
 *   Z.ai GLM-4.7 Flash   6 beats, 1 position shift,   35 s
 *   Nemotron produces the strongest structure AND is five times faster than
 *   GLM-5.2, so it takes the role GLM-5.2 held on intent alone. Position shifts
 *   are the discriminator here: an outline with one shift is a topic list.
 *
 * VERIFICATION (roles: script_verification / fact_check)
 *   Nemotron 3 Ultra     5/5 in-scope defects, 0 false positives,  13 s
 *   DeepSeek V4 Pro      4/7 raw, 0 false positives,              468 s
 *   Z.ai GLM-4.7 Flash   structured response FAILED after one repair
 *
 *   SCORING NOTE, and it changed the answer. The seeded set carries defects
 *   from three pipeline stages. Only five of its seven are inside the semantic
 *   reviewer's production contract; `duplicate_argument` belongs to the
 *   repetition checker and `character_violation` to character/continuity
 *   validation, and the reviewer's own prompt forbids it from flagging the
 *   latter at all. Nemotron's "5/7" was 5/5 on its actual job with a clean
 *   false-positive record — see SCOPE_BY_CATEGORY in roleExperimentFixtures.ts.
 *   DeepSeek's corrected in-scope count is NOT recorded here: which of its
 *   three misses were out-of-scope is only decidable from the stored raw
 *   response, so run `npm run rescore:verification` against the existing
 *   artifact rather than assuming. It does not change this assignment — 468 s
 *   against 13 s decides the order on its own, and DeepSeek is retained as
 *   secondary because it produced zero false positives, which is the failure
 *   mode that damages a script.
 *
 *   Z.ai is deliberately absent from BOTH verification chains. Its response
 *   omitted required top-level fields even after a repair pass: a schema
 *   failure, not a quality score. A reviewer that cannot return its verdict
 *   cannot gate a publish.
 *
 * Each chain still ends in the role-appropriate legacy provider as the paid
 * backup — appended by routing, not listed here.
 */

/**
 * VERIFIED DEVELOPMENT — the observed-working map.
 *
 * Built ONLY from models that passed the live contract probe of 2026-07-26:
 * DeepSeek V4 Pro, Nemotron 3 Ultra, GLM-5.2 (via NVIDIA), Mistral Medium 3.5 and
 * Z.ai GLM-4.7 Flash. DeepSeek V4 Flash (503) and Kimi K2.6 (404 for this
 * account) appear nowhere, so no production-chain run wastes an attempt failing
 * its way down to a usable model.
 *
 * Reachability is no longer the only evidence behind it. The five roles covered
 * by the role experiments — script_movement, script_rewrite, script_outline,
 * script_verification, fact_check — are now ordered by measured quality and
 * latency (see the findings block above). The remaining roles still rest on
 * contract acceptance alone and are marked as such; they are unproven, not
 * endorsed. `frontier_development` is kept alongside this as the documented
 * INTENT, so what we wanted and what measurement produced stay separately
 * readable.
 *
 * Z.ai is primary for the cheap high-volume roles, and the probe result behind
 * that choice matters: GLM-4.7 Flash reasons by default and will spend an entire
 * small allowance doing it, so those roles set reasoning OFF explicitly and the
 * zai profile sends the disable control rather than relying on a default.
 */
function verifiedDevelopmentChain(role: LLMRole): ProfileRoleChain {
  switch (role) {
    // ---- roles below rest on contract reachability only; no quality experiment
    // Cheap, high-volume, structured. Reasoning explicitly off (roles.ts).
    case "topic_generation":
      return [ZAI_FLASH(), NV.glm()];
    case "topic_classification":
    case "show_notes":
      return [ZAI_FLASH(), NV.deepseekPro()];
    case "episode_metadata":
      return [ZAI_FLASH(), NV.mistral()];

    // Judgement under comparison.
    case "topic_ranking":
      return [NV.glm(), NV.nemotron()];

    // Long-context consolidation and traceable extraction.
    case "research_brief":
    case "evidence_extraction":
      return [NV.deepseekPro(), NV.nemotron()];

    // Literal transcript audit.
    case "continuity_report":
      return [NV.deepseekPro(), ZAI_FLASH()];

    // Never shares a model with script_movement.
    case "quality_judge":
      return [NV.nemotron(), NV.glm()];

    // ---- roles below are MEASURED (see the findings block above)

    // Outline: Nemotron 7 beats / 3 shifts / 21 s beat GLM-5.2's 7 / 2 / 118 s.
    case "script_outline":
      return [NV.nemotron(), NV.glm(), ZAI_FLASH()];

    // Dialogue: Z.ai judge 79 at 143 s beat Mistral's 76 at 536 s. Mistral is
    // kept as a different-family fallback, not as a co-primary.
    case "script_movement":
    case "script_rewrite":
      return [ZAI_FLASH(), NV.mistral()];

    // Grading against evidence, independent of the writer. Nemotron: 5/5
    // in-scope, 0 false positives, 13 s. DeepSeek: 0 false positives but 468 s.
    // Z.ai is excluded — its structured response failed after repair.
    case "script_verification":
    case "fact_check":
      return [NV.nemotron(), NV.deepseekPro()];
  }
}

/**
 * The chain a profile DECLARES for a role, before availability filtering.
 * Exposed so readiness can show what a profile intends alongside what it can
 * actually run.
 */
export function declaredProfileChainFor(profile: RoutingProfile, role: LLMRole): ProfileRoleChain {
  switch (profile) {
    case "verified_development":
      return verifiedDevelopmentChain(role);
    case "frontier_development":
      return frontierChain(role);
    case "free_independent":
      return freeIndependentChain();
    case "legacy":
    case "custom":
      // No profile-supplied candidates: legacy resolves to today's grouped
      // configuration; custom resolves to explicit role overrides.
      return [];
  }
}

/** A candidate the availability filter removed, and why. */
export interface FilteredCandidate {
  ref: ProviderModelRef;
  availability: string;
  reason: string;
}

/**
 * The chain a profile can actually RUN: declared, minus anything a live probe
 * showed this account cannot reach.
 *
 * Filtering here rather than at call time is the point. A 503-limited or
 * 404-for-this-account model left in the chain costs a real attempt on every
 * single request — and on a role whose primary already takes 30-88s, burning
 * attempts before reaching a usable model makes every production-chain test
 * slower and every failure harder to read.
 *
 * The model is NOT deleted and its integration is untouched: an explicit role
 * override still reaches it (see routing.ts), which is how it gets retested. It
 * comes back to the default profiles when its capability record says
 * availability: "available" — i.e. when a probe passes.
 */
export function profileChainFor(
  profile: RoutingProfile,
  role: LLMRole
): ProfileRoleChain {
  return filterProfileChain(profile, role).usable;
}

export function filterProfileChain(
  profile: RoutingProfile,
  role: LLMRole
): { usable: ProfileRoleChain; filtered: FilteredCandidate[] } {
  const declared = declaredProfileChainFor(profile, role);
  const usable: ProfileRoleChain = [];
  const filtered: FilteredCandidate[] = [];
  for (const ref of declared) {
    const caps = modelCapabilities(ref.provider, ref.model);
    if (isRoutableByDefault(caps)) {
      usable.push(ref);
      continue;
    }
    filtered.push({
      ref,
      availability: caps.availability,
      reason:
        caps.availability === "unavailable-for-account"
          ? "the model ID does not resolve for the credential in use (404) — reachable only via an explicit role override"
          : "the endpoint would not serve this account (503 capacity) — reachable only via an explicit role override",
    });
  }
  return { usable, filtered };
}

/** The configured profile. Unset or unrecognized → legacy. */
export function activeRoutingProfile(): RoutingProfile {
  const raw = (readRoutingEnv("LLM_ROUTING_PROFILE") || "").trim().toLowerCase();
  if ((ROUTING_PROFILES as string[]).includes(raw)) return raw as RoutingProfile;
  return "legacy";
}

/** True when LLM_ROUTING_PROFILE holds a value that is not a known profile. */
export function routingProfileIsUnrecognized(): { unrecognized: boolean; raw: string } {
  const raw = (readRoutingEnv("LLM_ROUTING_PROFILE") || "").trim();
  if (!raw) return { unrecognized: false, raw: "" };
  return { unrecognized: !(ROUTING_PROFILES as string[]).includes(raw.toLowerCase()), raw };
}

/** Full profile map, for readiness display and tests. */
export function profileRoleMap(profile: RoutingProfile): Record<LLMRole, ProfileRoleChain> {
  const out = {} as Record<LLMRole, ProfileRoleChain>;
  for (const role of ALL_ROLES) out[role] = profileChainFor(profile, role);
  return out;
}
