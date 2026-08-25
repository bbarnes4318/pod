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

import { AsyncLocalStorage } from "node:async_hooks";
import { MODEL_IDS, isRoutableByDefault, modelCapabilities, type ModelCapabilities } from "./capabilities";
import { ALL_ROLES, LLMRole } from "./roles";
import { readRoutingEnv } from "./routingEnv";

export type RoutingProfile =
  | "legacy"
  | "verified_development"
  | "frontier_development"
  | "free_independent"
  | "balanced"
  | "premium"
  | "custom";

export const ROUTING_PROFILES: RoutingProfile[] = [
  "legacy",
  "verified_development",
  "frontier_development",
  "free_independent",
  "balanced",
  "premium",
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
 * DIRECT non-NVIDIA dialogue models, added when Mistral was retired.
 *
 * These exist because the free routable pool had collapsed to two GLM models
 * (Z.ai GLM-4.7-flash and GLM-5.2 via NVIDIA) plus Nemotron — and Nemotron is
 * the quality_judge primary, so using it for a host writer would put a judge on
 * the chain it grades. Grok and Kimi are the only genuinely different families
 * this account can currently reach. Both were smoke-verified live on 2026-08-12.
 */
const XAI_GROK = (): ProviderModelRef => ({
  provider: "xai",
  model: readRoutingEnv("XAI_MODEL") || MODEL_IDS.xai.grok43,
});

const MOONSHOT_KIMI = (): ProviderModelRef => ({
  provider: "moonshot",
  model: readRoutingEnv("MOONSHOT_MODEL") || MODEL_IDS.moonshot.kimiK3,
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
      return [NV.nemotron(), NIM_DEEPSEEK(), ZAI_FLASH()];

    // Long-context consolidation and traceable extraction — reasoning mode.
    case "research_brief":
    case "evidence_extraction":
      return [NV.nemotron(), NV.deepseekPro(), ZAI_FLASH()];

    // Conversational architecture — reasoning mode.
    case "script_outline":
    case "script_story_editor":
    case "script_debate_architect":
      return [NV.nemotron(), NIM_DEEPSEEK(), ZAI_FLASH()];

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
    // Mistral was retired (410, EOL 2026-08-07) and Kimi was never reachable
    // through NVIDIA for this account. Both halves of the intended inversion are
    // now DIRECT integrations that actually answer: Grok for host A, Kimi via
    // Moonshot for host B. This is closer to the original intent than the map it
    // replaces — host B was always meant to lead with Kimi.
    case "script_host_a_writer":
      return [XAI_GROK(), NV.kimi(), ZAI_FLASH()];
    case "script_host_b_writer":
      return [NV.kimi(), ZAI_FLASH(), XAI_GROK()];

    // Repairing seams between two writers is creative writing, so it stays in
    // the dialogue family rather than moving to a grader.
    case "script_dialogue_director":
      return [XAI_GROK(), NV.kimi(), ZAI_FLASH()];

    // A literal audit of callbacks and running bits — cheap and structured.
    case "script_continuity_editor":
      return [NV.deepseekFlash(), NV.deepseekPro(), ZAI_FLASH()];

    // The creative dialogue roles. Same family for writing and repair, so a
    // repair keeps the writer's voice instead of flattening it into analysis.
    case "script_movement":
    case "script_rewrite":
    case "episode_metadata":
      return [XAI_GROK(), NV.kimi(), ZAI_FLASH()];

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
      return [NV.nemotron(), NIM_DEEPSEEK()];

    // The cold-open judge grades three openings the WRITERS produced, so it
    // shares no model with the dialogue family either. Its order is inverted
    // against quality_judge on purpose: the opening and the finished script are
    // two different judgements, and having them land on the same model by
    // default would make one of the two verdicts redundant for free.
    case "cold_open_judge":
      return [NIM_DEEPSEEK(), NV.nemotron()];
  }
}

/** Every role on Z.ai's free general-purpose API — deliberately role-agnostic:
 *  the point of this profile is to test one provider across the whole chain. */
const CEREBRAS_OSS = (): ProviderModelRef => ({
  provider: "cerebras",
  model: readRoutingEnv("CEREBRAS_MODEL") || "gpt-oss-120b",
});

const GROQ_OSS = (): ProviderModelRef => ({
  provider: "groq",
  model: readRoutingEnv("GROQ_MODEL") || "openai/gpt-oss-120b",
});

const GROQ_OSS_SMALL = (): ProviderModelRef => ({
  provider: "groq",
  model: "openai/gpt-oss-20b",
});

/** GLM-5.2 via NVIDIA NIM — slow, but the only free route that honours a schema. */
/** Nemotron 3 SUPER (not Ultra). 4,663 ms and schema-valid; Ultra took 584,006 ms. */
const NV_NEMOTRON_SUPER = (): ProviderModelRef => ({
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
});

/**
 * GLM-5.2 via NVIDIA NIM — RETIRED BY THE PROVIDER 2026-08-21, kept only as the
 * record of what these chains used to reach for.
 *
 *   HTTP 410 Gone — "The model 'z-ai/glm-5.2' has reached its end of life on
 *   2026-08-21T09:00:00Z and is no longer available."
 *
 * It is referenced by no chain any more. Every rung it held has been reassigned
 * (see the block comment above verifiedDevelopmentChain). Do NOT wire it back:
 * capabilities.ts marks it `retired`, so it would be filtered out of any chain
 * that declared it, and the chain-health suite fails a production role that
 * declares a model it cannot run.
 *
 * If a successor lands on NIM, that is a ONE-VARIABLE change and not this
 * constant: `NVIDIA_MODEL_GLM=z-ai/glm-5.3` overrides MODEL_IDS.nvidia.glm, and
 * an id absent from the registry resolves to the conservative generic-NIM
 * record, which is routable. Probe it with `npm run probe:llm-contract` before
 * putting it in verified_development — that profile is the observed-working
 * map, not the intended one.
 */
const NIM_GLM52_RETIRED = (): ProviderModelRef => ({ provider: "nvidia", model: "z-ai/glm-5.2" });
void NIM_GLM52_RETIRED;

/** DeepSeek V4 Flash via NIM. A different lab from GLM — that is the whole point. */
const NIM_DEEPSEEK = (): ProviderModelRef => ({
  provider: "nvidia",
  model: "deepseek-ai/deepseek-v4-flash-0731",
});

/**
 * THE FREE TIER — every rung measured on 2026-08-15, none inherited from a
 * "best free LLM" article.
 *
 * The previous version of this function returned `[ZAI_FLASH()]` for every role:
 * one flaky model doing structural planning, creative dialogue and judging at
 * once, with no fallback and no separation between the writers and the judge.
 *
 * WHAT THE PROBES ESTABLISHED, and why the split below looks the way it does:
 *
 * 1. PROVIDER DOMINATES MODEL. The same `gpt-oss-120b` weights answered a
 *    strict-schema call in 703 ms on Cerebras, 5,238 ms on Groq, and TIMED OUT
 *    at 300,775 ms on NVIDIA. The old free tier was not slow because its models
 *    were weak; it was slow because it was all on NVIDIA.
 *
 * 2. SCHEMA SUPPORT IS NARROW AND UNADVERTISED. On Groq, only the two gpt-oss
 *    models honour `json_schema`. `llama-3.3-70b-versatile` — the model that
 *    headlines every free-tier listicle — returns HTTP 400 for it outright.
 *
 * 3. FAST-AND-BROKEN LOSES TO SLOW-AND-CORRECT. GLM-5.2 answers in 5.9 s on
 *    Z.ai and 50.5 s on NVIDIA, but only the NVIDIA route returns output that
 *    matches the schema. Z.ai's structured responses omit required fields — the
 *    same defect that already excluded it from both verification chains.
 *
 * 4. THE BEST FREE WRITER IS UNREACHABLE. `moonshotai/kimi-k2.6` (78.5 on
 *    EQ-Bench longform, the top open model) is listed in NVIDIA's catalogue and
 *    returns 404 for this account, exactly like Kimi K3 before it.
 *
 * TWO WRITER FAMILIES ARE PRESERVED. Host A gets GLM-5.2 (Zhipu, 77.9 creative,
 * 16.5 slop); Host B gets DeepSeek V4 Flash (DeepSeek, 66.0). One model writing
 * both hosts is the convergence failure this pipeline keeps rediscovering, and a
 * free tier is not an excuse to reintroduce it.
 *
 * NEITHER WRITER SHARES A MODEL WITH A JUDGE. Judges run gpt-oss, which scores
 * 35.8 on creative writing and is therefore disqualified from ever writing a
 * line — but is superb at emitting a verdict that parses.
 *
 * THE HONEST COST: the writers take 50 s and 32 s per call against roughly 1 s
 * on Opus 5, so a free episode spends about 8-10 minutes in the writing stages.
 * Free is slow. Surfaces that offer it should say so before a user picks it.
 */
const OR_KIMI = (): ProviderModelRef => ({
  provider: "openrouter",
  model: readRoutingEnv("OPENROUTER_MODEL") || "moonshotai/kimi-k2.6",
});

const ANTHROPIC_HAIKU = (): ProviderModelRef => ({ provider: "anthropic", model: "claude-haiku-4-5" });

/** The models the PREMIUM tier's copy actually promises. Env-overridable like
 *  every other id here, so a re-pin is one variable rather than a code change. */
const ANTHROPIC_OPUS = (): ProviderModelRef => ({
  provider: "anthropic",
  model: readRoutingEnv("ANTHROPIC_PREMIUM_MODEL") || "claude-opus-5",
});
const ANTHROPIC_SONNET = (): ProviderModelRef => ({ provider: "anthropic", model: "claude-sonnet-5" });

/**
 * BALANCED — Kimi writes, Haiku supports. The tier between free and premium.
 *
 * The premium tier puts Opus 5 on both host writers at $0.89 an episode, and the
 * free tier puts GLM-5.2 and DeepSeek there for nothing but takes 8-10 minutes
 * doing it. Neither is the right default for most episodes, and the gap between
 * them is a cliff rather than a choice.
 *
 * Kimi K2.6 closes it, and the numbers are measured rather than argued.
 * On 2026-08-15, one identical schema-constrained dialogue request:
 *
 *   openrouter  moonshotai/kimi-k2.6      420 ms   schema OK   95 words
 *   moonshot    kimi-k2.6              45,443 ms   schema OK   47 words
 *
 * Priced against the real token counts of episode ade82ba1, K2.6 writes both
 * hosts for about $0.16 where Opus 5 costs $0.89 — 83% off the single largest
 * line in the bill. It scores 78.5 on EQ-Bench longform creative writing against
 * Opus 5's 86.3 and Sonnet 5's 78.3: a real 7.8-point drop on the audible
 * content, and better prose than anything in the free tier.
 *
 * WHY THIS WAS NOT AVAILABLE BEFORE. Kimi was written off twice as unreachable.
 * It never was: the Moonshot credential was stale, and every call sent a
 * creative temperature to a model that rejects anything but 1 with a 400. Both
 * are fixed (moonshot.ts, openrouter.ts) and Kimi answers on both routes.
 *
 * SUPPORT ROLES RUN HAIKU 4.5, not gpt-oss. This tier is paid, so it buys the
 * schema reliability of a frontier-lab small model rather than depending on the
 * free rungs' constrained decoding. Haiku scores 65.0 on creative writing, which
 * is why it is nowhere near a host writer.
 *
 * The invariants hold as everywhere else: two writer families (Moonshot vs
 * Anthropic), and no judge shares a model with a writer.
 */
function balancedChain(role: LLMRole): ProfileRoleChain {
  switch (role) {
    // AUDIBLE DIALOGUE — TWO LABS, NOT ONE MODEL TWICE.
    //
    // Host A leads with Kimi K2.6 (Moonshot, 78.5 creative) and host B with
    // GLM-5.2 (Zhipu, 77.9). Those scores are within a point of each other, so
    // the split costs almost nothing in quality and buys the thing that actually
    // makes two hosts sound like two people. Putting Kimi on both — which is
    // what the first draft of this function did — is precisely the convergence
    // failure the rest of this file exists to prevent, and it is tempting
    // exactly because Kimi is the better model.
    //
    // The trade is latency, and it is asymmetric on purpose: Kimi answers in
    // 420 ms on OpenRouter, GLM-5.2 takes ~50 s on NVIDIA. Host B is therefore
    // the slow side of every movement. That is worth it here because GLM-5.2 is
    // free and near-identical in quality; a tier that paid twice for one lab's
    // voice would be worse on both axes.
    //
    // HAIKU IS DELIBERATELY *NOT* A WRITER RUNG HERE, for two reasons that
    // reinforce each other. It scores 65.0 on creative writing — a 13-point drop
    // that a listener would hear. And it is the primary for every judging and
    // verification role in this tier, so listing it under a writer would let a
    // judge grade prose it had written. `npm run test:free-profile` caught
    // exactly that when Haiku was the third rung, which is the reason this
    // comment exists rather than a third rung.
    //
    // So the writers have two rungs and no further safety net: if both Moonshot
    // and NVIDIA are down the role fails loudly. That is the right outcome — a
    // silent downgrade to a judge's model is worse than a visible failure.
    case "script_host_a_writer":
      return [OR_KIMI(), ZAI_FLASH()];
    case "script_host_b_writer":
      return [ZAI_FLASH(), OR_KIMI()];

    // DIALOGUE REPAIR is kept clear of the judging chain for the same reason as
    // in the free tier: these roles rewrite lines, and a judge that shares their
    // model grades its own edits.
    case "script_movement":
    case "script_rewrite":
    case "script_dialogue_director":
      return [ANTHROPIC_HAIKU(), CEREBRAS_OSS()];

    // Judges: disjoint from the above, and distinct from each other at the
    // primary so the cold-open verdict and the whole-script verdict are two
    // judgements rather than one model asked twice.
    case "quality_judge":
      return [GROQ_OSS(), GROQ_OSS_SMALL()];
    case "cold_open_judge":
      return [GROQ_OSS_SMALL(), GROQ_OSS()];

    // Everything else runs Haiku with the free strict-schema rungs behind it, so
    // a billing failure degrades to slow rather than to nothing.
    default:
      return [ANTHROPIC_HAIKU(), CEREBRAS_OSS(), GROQ_OSS()];
  }
}

/**
 * PREMIUM — the tier whose copy says "Claude Opus 5 (both hosts)" at ~$1.75 an
 * episode. Until this profile existed it said that and delivered something
 * else.
 *
 * THE BUG THIS FIXES. `premium` pointed at `verified_development`, whose host
 * writers are ZAI_FLASH and MOONSHOT_KIMI. Resolved, the tier read:
 *
 *   claims : Claude Opus 5 (both hosts) | $1.75
 *   host A : zai/glm-4.7-flash  ->  xai/grok-4.3
 *   host B : moonshot/kimi-k3   ->  zai/glm-4.7-flash
 *
 * Opus was in no chain at all. Anthropic appeared only as a legacyBackup rung,
 * which is why the sole Anthropic lines in a production episode log are
 * `PAID FALLBACK ... claude-haiku-4-5` — never Opus, and only ever because a
 * free model had already failed. A user choosing the paid tier was paying
 * attention to a promise the router could not keep.
 *
 * BOTH HOSTS ON ONE MODEL IS DELIBERATE HERE, and it is why this profile is
 * absent from MULTI_MODEL_PROFILES in test:routing-chain-health. Everywhere
 * else, two families writing the two characters is what stops the hosts
 * sounding identical — a structural fix for models that are individually
 * mediocre at voice. The premium tier makes the opposite trade on purpose: one
 * model good enough to hold two distinct voices from persona prompts alone,
 * which is exactly what the tier's copy sells. Do not "fix" this by splitting
 * the hosts across families without changing the copy first.
 *
 * Sonnet 5 is the second rung rather than a free model: a paid tier must not
 * silently degrade into the free one on a single failure, which is the failure
 * mode the whole tier exists to let a user buy their way out of.
 *
 * THE SECOND BUG, AND WHY THIS PROFILE NOW COVERS THE WHOLE SCRIPT JOB. The
 * first version of premiumChain overrode five roles — the audible dialogue —
 * and sent everything else to verifiedDevelopmentChain on the reasoning that
 * "the tier sells WRITING quality and there is no reason to bill Opus rates for
 * classifying a topic". The economics were right and the LATENCY was not
 * considered at all, so a Premium episode advertising 2-4 minutes ran for
 * twenty. Every remaining role in generate:script resolved to Nemotron at
 * 60-200 s per call or to the Z.ai account that answers 429 (1302/1305) under
 * this workload.
 *
 * The measured cold open recorded in scriptBudget.ts is that bill itemised:
 *
 *   story-spine 10s · outline 124s · private-agendas 38s · accusation 11s ·
 *   contradiction 167s · consequence 199s · cold-open judge 70s = ~10.3 min
 *
 * Not one of those roles was in this switch, and not one line of dialogue had
 * been written when those ten minutes were gone. Opus answers in ~1 s. Buying
 * the fast writer and leaving the rest of the job on the slow free chain bought
 * nothing a user could perceive.
 *
 * So the whole generate:script role set is Anthropic here. The split between
 * Opus and Haiku is NOT a fresh guess — it is the configuration costed against
 * real token counts in docs/verification/tiering-option-a.md (episode ade82ba1,
 * 22 calls, scoped ledger): Opus for the audible prose, Haiku 4.5 for the
 * structural and audit roles, $1.26/episode against a $2.34 all-Opus baseline.
 * The deltas from that document to this map are itemised in qualityTiers.ts,
 * where the price a user is shown has to add up.
 *
 * TWO DEPARTURES FROM THAT DOCUMENT, both deliberate:
 *
 *   script_debate_architect is on SONNET, not Haiku. The document flags it as
 *   "the untested risk" — it owns the outline, the private agendas and the turn
 *   plan, which is structural reasoning rather than transcription, and names
 *   escalating exactly this role to Sonnet 5 (+$0.23) as the first move if
 *   structure degrades. Premium is the tier that should not be gambling episode
 *   structure on the smallest model to save twenty cents.
 *
 *   The two judges do NOT both land on Haiku. The document is right that the
 *   constraint it checked still holds (no judge shares a model with the writers
 *   it grades), but the other judge rule matters too: two judges leading with
 *   one model makes one of the two verdicts redundant for free. Neither judge
 *   may contain Opus or Sonnet, and Haiku is the only Anthropic model left, so
 *   the second primary is Groq's small OSS route — sub-second, schema-proven in
 *   the free profile's judge slot, and a different family from everything it
 *   grades.
 *
 * WHAT STAYS ON verifiedDevelopmentChain: topic generation, classification and
 * ranking, research_brief, evidence_extraction, show_notes and
 * episode_metadata. Those run in OTHER jobs — the background topic sweep and
 * research:generate-brief — so they are not what a user watches a Premium
 * episode spend its minutes on, and the ledger scope that priced this map does
 * not cover them. research_brief on Nemotron is still slow and is called out as
 * a remaining latency source rather than silently folded into this change.
 */
function premiumChain(role: LLMRole): ProfileRoleChain {
  switch (role) {
    // ---- the audible dialogue: the roles the tier's promise is about.
    case "script_host_a_writer":
    case "script_host_b_writer":
    case "script_movement":
    case "script_rewrite":
    case "script_dialogue_director":
      return [ANTHROPIC_OPUS(), ANTHROPIC_SONNET()];

    // ---- the cold-open tournament and the turn plan.
    //
    // SONNET LED THIS FOR ONE DEPLOY AND KILLED EVERY PREMIUM EPISODE:
    //
    //   [LLMRouting] Role 'script_debate_architect' STOPPED at 1 candidate(s)
    //   under profile 'premium'. programming_error on anthropic/claude-sonnet-5
    //
    // `programming_error` is TERMINAL in the taxonomy — the router does not
    // advance past it, on the reasoning that a malformed request will be
    // malformed for the next model too. So the Haiku rung behind Sonnet was
    // never tried and role 2 of 7 ended the run, at 55 minutes.
    //
    // WHAT THE RUN PROVES. script_story_editor is role 1 and is the same shape
    // as this role — structured: true, reasoning: "on" (roles.ts) — and it
    // SUCCEEDED on Haiku in that same episode, which is how the pipeline
    // reached role 2 at all. Haiku serving a structured reasoning call on this
    // deployment is therefore observed, not assumed. Sonnet was the one
    // ingredient in this profile that nothing had exercised.
    //
    // So Haiku takes the role, which is exactly what tiering-option-a.md
    // costed. Escalating to Sonnet was my own departure from that document, to
    // avoid the structural risk it flags on Haiku here; it traded a quality
    // risk for a total outage. The quality risk is still open and still
    // documented there — reopen it with EVIDENCE (a structure comparison),
    // not with another swap.
    //
    // Nemotron rather than Sonnet takes the failover: it is the model this role
    // ran on before, so the degraded path is slow-but-known, and it is a
    // different provider, which a same-family rung cannot be.
    //
    // THE SONNET 400 ITSELF IS UNDIAGNOSED. Its body was truncated in the job
    // log the failure surfaced in, and nothing here should be read as a claim
    // about the cause. It matters beyond this role: Sonnet is still the second
    // rung for all five dialogue roles, so if the fault is the model's contract
    // rather than this call, that failover is dead too and Opus is alone. Read
    // the full `[Anthropic]`/400 line off the worker before changing anything
    // else on the strength of a guess.
    case "script_debate_architect":
      return [ANTHROPIC_HAIKU(), NV.nemotron()];

    // ---- structure and audit. Haiku leads; the model this role used to run on
    // stays as the rung behind it, so a billing failure degrades to the old
    // slow path rather than to nothing.
    case "script_outline":
    case "script_story_editor":
      return [ANTHROPIC_HAIKU(), NV.nemotron()];
    case "script_verification":
    case "fact_check":
      // Z.ai stays out of both verification chains for the same schema reason
      // it is excluded everywhere else, so the fallback is Nemotron.
      return [ANTHROPIC_HAIKU(), NV.nemotron()];
    case "script_continuity_editor":
    case "continuity_report":
      return [ANTHROPIC_HAIKU(), ZAI_FLASH()];

    // ---- judgement. Distinct primaries, and neither chain contains a model
    // that writes anything it grades.
    case "quality_judge":
      return [ANTHROPIC_HAIKU(), GROQ_OSS_SMALL()];
    case "cold_open_judge":
      return [GROQ_OSS_SMALL(), ANTHROPIC_HAIKU()];

    // Topics, research and publishing metadata — a different job, and priced
    // outside this map's ledger scope.
    default:
      return verifiedDevelopmentChain(role);
  }
}

function freeIndependentChain(role: LLMRole): ProfileRoleChain {
  switch (role) {
    // ---- audible dialogue: the only roles where prose quality is the product
    //
    // GLM-5.2 via NIM led host A until NVIDIA retired it on 2026-08-21 (410
    // Gone). Its replacement is Z.ai's GLM-4.7-flash — same lab, still free —
    // but it takes the SECOND rung here rather than the first, and the order
    // matters for a reason outside this profile: glm-4.7-flash is also the
    // premium tier's host-A primary. Leading with it here would make the free
    // and premium tiers open with the identical model on the identical
    // character, which is a user who paid more getting the same product.
    // test:quality-tiers enforces exactly that and caught this.
    //
    // So DeepSeek leads host A and Z.ai leads host B. The two families and the
    // inversion — the property that stops one model writing both characters —
    // are preserved; only which of the two goes first changed.
    case "script_host_a_writer":
      return [NIM_DEEPSEEK(), ZAI_FLASH()];
    case "script_host_b_writer":
      return [ZAI_FLASH(), NIM_DEEPSEEK()];

    // ---- structure and judgement: schema fidelity and latency, not prose.
    // Cerebras leads everywhere it can; Groq is the same model on a different
    // company, so a failover changes the endpoint and not the output shape.
    case "script_story_editor":
    case "script_outline":
    case "script_debate_architect":
    case "script_dialogue_director":
    case "script_movement":
    case "script_rewrite":
    case "script_continuity_editor":
    case "continuity_report":
      return [CEREBRAS_OSS(), GROQ_OSS()];

    // VERIFICATION shares the structural rungs; nothing forbids that, and the
    // rule it must satisfy — never a host writer's model — holds.
    case "script_verification":
    case "fact_check":
      return [CEREBRAS_OSS(), GROQ_OSS()];

    // THE TWO JUDGES ARE FULLY DISJOINT FROM THE DIALOGUE ROLES, and from each
    // other at the primary. Both properties are enforced by
    // test:routing-chain-health, and both were VIOLATED by the first draft of
    // this profile: every structural role and both judges led with
    // cerebras/gpt-oss-120b, so a model graded scripts it had helped rewrite and
    // the two judgements collapsed into one.
    //
    // Fixing it needed a fourth schema-capable free route, since three cannot
    // give two judges distinct primaries AND keep them clear of the dialogue
    // chain. nemotron-3-super-120b is that route: measured 4,663 ms with valid
    // schema output on 2026-08-15 — unlike nemotron-3-ULTRA, the incumbent that
    // took 584,006 ms and then failed validation. Judging is one call per
    // episode, so 4.7 s is immaterial where it would be fatal on a writer.
    case "quality_judge":
      return [GROQ_OSS_SMALL(), NV_NEMOTRON_SUPER()];
    case "cold_open_judge":
      return [NV_NEMOTRON_SUPER(), GROQ_OSS_SMALL()];

    // ---- cheap, high-volume, structured. gpt-oss-20b is 1,344 ms and still
    // schema-strict, which is the right trade for per-topic work.
    case "topic_generation":
    case "topic_classification":
    case "topic_ranking":
    case "show_notes":
    case "episode_metadata":
      return [CEREBRAS_OSS(), GROQ_OSS()];

    // ---- long-context consolidation into typed evidence refs.
    case "research_brief":
    case "evidence_extraction":
      return [CEREBRAS_OSS(), GROQ_OSS()];
  }
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
      return [ZAI_FLASH(), NV.nemotron()];
    case "topic_classification":
    case "show_notes":
      // Nemotron replaces deepseek-v4-pro as the secondary. Without it these two
      // filter down to Z.ai alone, and Z.ai is the model that was rate-limited
      // in production — a single-candidate chain whose one member is the known
      // flaky one is not a chain.
      return [ZAI_FLASH(), NV.nemotron()];
    case "episode_metadata":
      // Mistral retired; Nemotron takes the rung. Metadata is structured
      // extraction rather than dialogue, so it does not need a creative family.
      return [ZAI_FLASH(), NV.nemotron()];

    // Judgement under comparison.
    case "topic_ranking":
      return [NV.nemotron(), NIM_DEEPSEEK()];

    // Long-context consolidation and traceable extraction.
    case "research_brief":
    case "evidence_extraction":
      // Production logs showed DeepSeek V4 Pro repeatedly consuming 4-12
      // minutes before returning an empty response or timing out. Nemotron was
      // the fallback that actually completed the same briefs, so it must be the
      // primary instead of paying the known-failing attempt on every topic.
      // The middle rung WAS GLM-5.2, chosen as a third family so the chain did
      // not collapse to one lab. NVIDIA retired it on 2026-08-21 (410 Gone), so
      // the rung is Z.ai's GLM-4.7-flash: still Zhipu, still a different lab
      // from Nemotron, and reachable on a credential this deployment already
      // uses. The three-family property survives the retirement; the specific
      // model did not.
      return [NV.nemotron(), ZAI_FLASH()];

    // Literal transcript audit. deepseek-v4-pro held the PRIMARY here and is
    // now non-routable, so every continuity report was starting one guaranteed
    // failure down. Z.ai leads (cheap, and this is a literal audit rather than
    // a judgement call) with Nemotron behind it.
    case "continuity_report":
      return [ZAI_FLASH(), NV.nemotron()];

    // Never shares a model with script_movement.
    case "quality_judge":
      return [NV.nemotron(), NIM_DEEPSEEK()];

    // Neither judge shares a model with the dialogue family, and the two judges
    // do not share a primary with each other — see the frontier profile.
    case "cold_open_judge":
      return [NIM_DEEPSEEK(), NV.nemotron()];

    // ---- roles below are MEASURED (see the findings block above)

    // Outline: Nemotron 7 beats / 3 shifts / 21 s beat GLM-5.2's 7 / 2 / 118 s.
    // The story editor and the debate architect are the same kind of work —
    // structure under reasoning — so they inherit the measured outline order.
    //
    // NEMOTRON 3 SUPER IS A CANDIDATE HERE, AND IS DELIBERATELY NOT WIRED YET.
    //
    // Probed live against production's NVIDIA account on 2026-08-16, on a
    // turn-plan schema shaped like what this role emits: super 52,583 ms vs
    // ultra 108,444 ms, both schema-valid; on a small schema, 2,420 ms vs
    // 23,385 ms. That is 2x-10x of wall-clock on the critical path of every
    // episode, so it is worth having.
    //
    // It is not wired because this profile is the OBSERVED-WORKING map, and
    // Super has not been through `npm run probe:llm-contract`. Two ad-hoc curls
    // are not that gate, and the gate is what stopped an unverified model
    // reaching the verified profile — which is precisely its job. Run the
    // contract probe, record the result, then make the swap.
    case "script_outline":
    case "script_story_editor":
    case "script_debate_architect":
      return [NV.nemotron(), ZAI_FLASH()];

    // Dialogue: Z.ai judge 79 at 143 s beat Mistral's 76 at 536 s, so Z.ai leads
    // and that measurement still stands. What changed is the FALLBACK: Mistral
    // was retired by its provider on 2026-08-07 (410 Gone), so the
    // different-family rung behind Z.ai is now Grok. That is a reachability
    // repair, not a re-ordering of the measurement — Grok is UNMEASURED on this
    // role and sits second precisely because nothing has compared it yet.
    case "script_movement":
    case "script_rewrite":
    case "script_dialogue_director":
      return [ZAI_FLASH(), XAI_GROK()];

    // THE TWO HOST WRITERS GET INVERTED CHAINS ON PURPOSE — two model families
    // writing the two characters is what makes "the hosts do not sound like one
    // model" structural rather than aspirational.
    //
    // Host B led with Mistral until its provider retired it on 2026-08-07 (410
    // Gone), which left BOTH hosts resolving to Z.ai — one model writing both
    // characters, silently, with nothing erroring. Kimi K3 via Moonshot takes the
    // primary: smoke-verified live on 2026-08-12, a genuinely different family,
    // and it collides with neither judge.
    //
    // The judge-collision rule that shaped this is unchanged, only the models
    // moved: DeepSeek V4 Flash now holds the cold_open_judge primary and the
    // quality_judge secondary (GLM-5.2 held both until NVIDIA retired it on
    // 2026-08-21), so DeepSeek may not appear on a writer chain. Nemotron is
    // still excluded for the same reason — it is the quality_judge primary.
    //
    // WHAT IS AND IS NOT MEASURED. Z.ai leading host A is measured (judge 79 /
    // 143 s). Kimi leading host B is NOT — it is reachable, different-family and
    // unproven, chosen because the alternative was no second family at all.
    // `npm run test:role-experiments dialogue` can now actually run this
    // comparison: MOONSHOT_API_KEY and XAI_API_KEY are both present on the
    // worker. Promotion still happens on Jimmy's read of the judge and latency
    // columns, not here.
    case "script_host_a_writer":
      return [ZAI_FLASH(), XAI_GROK()];
    case "script_host_b_writer":
      return [MOONSHOT_KIMI(), ZAI_FLASH()];

    // Literal transcript audit of callbacks and running bits. Same story as
    // continuity_report: deepseek-v4-pro was primary and is now non-routable.
    case "script_continuity_editor":
      return [ZAI_FLASH(), NV.nemotron()];

    // Grading against evidence, independent of the writer. Nemotron: 5/5
    // in-scope, 0 false positives, 13 s. DeepSeek measured 0 false positives at
    // 468 s and was the secondary on that strength; it is now non-routable, so
    // DeepSeek V4 Flash takes the rung. Z.ai stays deliberately excluded from
    // BOTH verification chains — its structured response omitted required
    // top-level fields even after a repair pass, and a reviewer that cannot
    // return its verdict cannot gate a publish. That exclusion is why the rung
    // could not simply become the Z.ai flash model used elsewhere when NVIDIA
    // retired GLM-5.2 on 2026-08-21; it had to be a third option.
    //
    // The production log of 2026-08-24 re-confirms the exclusion from both
    // sides: `[zai] structured output rejected (schema_violation)` on a writer
    // call, and Nemotron itself returning "Required array 'unsupportedClaims'
    // is missing" on this very role. Structured output is the weak point here,
    // so the chain needs two models that can hold a schema, not two that are
    // merely reachable.
    case "script_verification":
    case "fact_check":
      return [NV.nemotron(), NIM_DEEPSEEK()];
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
      return freeIndependentChain(role);
    case "balanced":
      return balancedChain(role);
    case "premium":
      return premiumChain(role);
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
    case "retired":
      return (
        "the provider has END-OF-LIFED this model and it returns 410 Gone — this is permanent, so unlike every other " +
        "removal here no probe or credential change will restore it; the chain needs a different model"
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
/**
 * A profile chosen for ONE unit of work, overriding the env default.
 *
 * WHY THIS EXISTS. `activeRoutingProfile()` read the environment and nothing
 * else, which is correct for a single-tenant deployment and useless the moment
 * a tier becomes a per-podcast choice: one worker process serves every
 * podcast, so an env var cannot express "this episode is Free and that one is
 * Premium". A UI toggle without this seam would have had nowhere to write.
 *
 * AsyncLocalStorage rather than a parameter threaded through twenty call sites,
 * for the same reason withLlmJob and withLlmStage use it: the profile is
 * ambient context that every provider construction deep in the stack needs, and
 * threading it would mean touching every intermediate signature to carry a
 * value none of them use.
 *
 * Scope is one job. `withRoutingProfile(tier, () => generateScript(...))` wraps
 * the whole generation, so every role resolved inside it — including retries and
 * fallbacks — sees the same tier, and concurrent jobs on different tiers do not
 * bleed into each other. That last property is not theoretical: the cost ledger
 * shipped a bug of exactly this shape, where concurrent jobs shared a
 * process-wide watermark and one episode was billed for another's tokens.
 */
const profileStorage = new AsyncLocalStorage<RoutingProfile>();

export function withRoutingProfile<T>(profile: RoutingProfile, fn: () => T): T {
  return profileStorage.run(profile, fn);
}

/** The profile chosen for the current job, if any. Exported for diagnostics. */
export function currentRoutingProfileOverride(): RoutingProfile | undefined {
  return profileStorage.getStore();
}

/**
 * Resolution order: per-job override → environment → legacy.
 *
 * The override wins because it is the more specific statement of intent: an
 * operator sets LLM_ROUTING_PROFILE for the deployment, a user picks a tier for
 * their podcast, and the user's choice is about their episode.
 */
export function activeRoutingProfile(): RoutingProfile {
  const override = profileStorage.getStore();
  if (override) return override;
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
