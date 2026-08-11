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

import { MODEL_IDS, isRoutableByDefault, modelCapabilities, type ModelCapabilities } from "./capabilities";
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
 * The role-experiment run whose measurements order the five measured roles
 * below. Extractable for the same reason the probe date is — see
 * LLM_CONTRACT_PROBE_DATE. Re-running `npm run test:role-experiments` means
 * updating this in the same commit, or `npm run routing:staleness` will keep
 * reporting the age of a run that has been superseded.
 */
export const ROLE_EXPERIMENT_DATE = "2026-07-26";

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
    case "script_story_editor":
    case "script_debate_architect":
      return [NV.glm(), NV.nemotron(), ZAI_FLASH()];

    // THE TWO HOST WRITERS ARE DELIBERATELY ORDERED DIFFERENTLY.
    //
    // This is the one routing decision that makes "the hosts do not sound like
    // one model" structural instead of aspirational: under this profile host A's
    // writer reaches for Mistral first and host B's writer for Kimi first, so on
    // the healthy path two different model families write the two characters. If
    // one family is unreachable the chains converge and the pipeline still
    // completes — with the convergence visible in the role trace rather than
    // hidden, because both records name the model that actually served them.
    //
    // HOST B'S FALLBACK ORDER IS INVERTED TOO, and that is the actual fix rather
    // than a tidiness. The declared inversion above was not enough: Kimi is 404
    // for this account, so with `kimi -> mistral -> zai` the filter deleted the
    // primary and BOTH hosts resolved to Mistral first. The inversion was still
    // there on the page, and the property it exists to create — two families
    // writing two characters — was silently not happening. Nothing errored; the
    // episode was just written twice by one model.
    //
    // Putting Z.ai ahead of Mistral in host B's fallbacks means the chain
    // survives Kimi's absence with a DIFFERENT family still leading: host A
    // resolves to Mistral, host B to Z.ai. The declared intent (Kimi first) is
    // preserved for the day Kimi becomes reachable, and until then the runnable
    // chains keep the two hosts apart. testRoutingChainHealth asserts the
    // runnable side, not just the declared one.
    case "script_host_a_writer":
      return [NV.mistral(), NV.kimi(), ZAI_FLASH()];
    case "script_host_b_writer":
      return [NV.kimi(), ZAI_FLASH(), NV.mistral()];

    // Repairing seams between two writers is creative writing, so it stays in
    // the dialogue family rather than moving to a grader.
    case "script_dialogue_director":
      return [NV.mistral(), NV.kimi(), ZAI_FLASH()];

    // A literal audit of callbacks and running bits — cheap and structured.
    case "script_continuity_editor":
      return [NV.deepseekFlash(), NV.deepseekPro(), ZAI_FLASH()];

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

    // The cold-open judge grades three openings the WRITERS produced, so it
    // shares no model with the dialogue family either. Its order is inverted
    // against quality_judge on purpose: the opening and the finished script are
    // two different judgements, and having them land on the same model by
    // default would make one of the two verdicts redundant for free.
    case "cold_open_judge":
      return [NV.glm(), NV.nemotron()];
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
      // Nemotron replaces deepseek-v4-pro as the secondary. Without it these two
      // filter down to Z.ai alone, and Z.ai is the model that was rate-limited
      // in production — a single-candidate chain whose one member is the known
      // flaky one is not a chain.
      return [ZAI_FLASH(), NV.nemotron()];
    case "episode_metadata":
      return [ZAI_FLASH(), NV.mistral()];

    // Judgement under comparison.
    case "topic_ranking":
      return [NV.glm(), NV.nemotron()];

    // Long-context consolidation and traceable extraction.
    case "research_brief":
    case "evidence_extraction":
      // Production logs showed DeepSeek V4 Pro repeatedly consuming 4-12
      // minutes before returning an empty response or timing out. Nemotron was
      // the fallback that actually completed the same briefs, so it must be the
      // primary instead of paying the known-failing attempt on every topic.
      // The middle rung is now GLM-5.2 rather than deepseek-v4-pro: same
      // reasoning-capable tier, and it is a THIRD family, so the chain does not
      // collapse to one lab if Nemotron has a bad day.
      return [NV.nemotron(), NV.glm(), ZAI_FLASH()];

    // Literal transcript audit. deepseek-v4-pro held the PRIMARY here and is
    // now non-routable, so every continuity report was starting one guaranteed
    // failure down. Z.ai leads (cheap, and this is a literal audit rather than
    // a judgement call) with Nemotron behind it.
    case "continuity_report":
      return [ZAI_FLASH(), NV.nemotron()];

    // Never shares a model with script_movement.
    case "quality_judge":
      return [NV.nemotron(), NV.glm()];

    // Neither judge shares a model with the dialogue family, and the two judges
    // do not share a primary with each other — see the frontier profile.
    case "cold_open_judge":
      return [NV.glm(), NV.nemotron()];

    // ---- roles below are MEASURED (see the findings block above)

    // Outline: Nemotron 7 beats / 3 shifts / 21 s beat GLM-5.2's 7 / 2 / 118 s.
    // The story editor and the debate architect are the same kind of work —
    // structure under reasoning — so they inherit the measured outline order.
    case "script_outline":
    case "script_story_editor":
    case "script_debate_architect":
      return [NV.nemotron(), NV.glm(), ZAI_FLASH()];

    // Dialogue: Z.ai judge 79 at 143 s beat Mistral's 76 at 536 s. Mistral is
    // kept as a different-family fallback, not as a co-primary.
    case "script_movement":
    case "script_rewrite":
    case "script_dialogue_director":
      return [ZAI_FLASH(), NV.mistral()];

    // THE TWO HOST WRITERS GET INVERTED CHAINS ON PURPOSE — see the frontier
    // profile for the full reasoning. Host A leads with the measured winner
    // (Z.ai, judge 79 / 143 s); host B leads with Mistral, which measured close
    // on quality (76) and lost on latency alone. Paying Mistral's latency for
    // ONE host is the price of two genuinely different minds, and it is a
    // per-host call rather than three sequential movements, so the episode floor
    // moves far less than the 536 s dialogue figure suggests. Set
    // SCRIPT_HOST_B_WRITER_LLM_PROVIDER to collapse them if that trade stops
    // being worth it — the role trace will show the collapse either way.
    case "script_host_a_writer":
      return [ZAI_FLASH(), NV.mistral()];
    case "script_host_b_writer":
      return [NV.mistral(), ZAI_FLASH()];

    // Literal transcript audit of callbacks and running bits. Same story as
    // continuity_report: deepseek-v4-pro was primary and is now non-routable.
    case "script_continuity_editor":
      return [ZAI_FLASH(), NV.nemotron()];

    // Grading against evidence, independent of the writer. Nemotron: 5/5
    // in-scope, 0 false positives, 13 s. DeepSeek measured 0 false positives at
    // 468 s and was the secondary on that strength; it is now non-routable, so
    // GLM-5.2 takes the rung. Z.ai stays deliberately excluded from BOTH
    // verification chains — its structured response omitted required top-level
    // fields even after a repair pass, and a reviewer that cannot return its
    // verdict cannot gate a publish. That exclusion is why the replacement had
    // to be GLM-5.2 rather than the Z.ai flash model used elsewhere.
    case "script_verification":
    case "fact_check":
      return [NV.nemotron(), NV.glm()];
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

/**
 * Why a candidate was removed, in words an operator can act on.
 *
 * Each non-routable state gets its OWN sentence because they call for different
 * responses: a 404 is a credential or catalog problem, a 503 clears itself, and
 * a model that passes a probe but fails every real request needs a human to
 * decide which of the two measurements to believe. These were once collapsed
 * into one string, and the result was a chain filter reporting "503 capacity"
 * for a model that had never returned a 503.
 */
function filterReasonFor(availability: ModelCapabilities["availability"]): string {
  switch (availability) {
    case "unavailable-for-account":
      return "the model ID does not resolve for the credential in use (404) — reachable only via an explicit role override";
    case "capacity-limited":
      return "the endpoint would not serve this account (503 capacity) — reachable only via an explicit role override";
    case "broken-in-production":
      return (
        "a contract probe passed but real pipeline traffic failed on every attempt (see the capability record for the " +
        "observation and its date) — reachable only via an explicit role override, which is how it gets retested"
      );
    case "available":
      // Not reachable: available candidates never enter the filtered list.
      return "routable";
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
      reason: filterReasonFor(caps.availability),
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
