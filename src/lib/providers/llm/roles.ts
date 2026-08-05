// Role definitions for role-based LLM routing.
//
// A ROLE is one production responsibility that a model is asked to perform.
// Roles exist so the strongest appropriate model can be assigned per job
// instead of one model being forced across the whole pipeline.
//
// Every role in this file corresponds to something the application actually
// does. `callSites` names the real code that runs the role — an empty
// `callSites` array means the responsibility exists in the product but is
// currently DETERMINISTIC (no LLM call), and the role is declared so routing,
// readiness and experiments can address it the day it becomes a model call.
// The readiness role map reports that state honestly rather than implying a
// model is doing work nothing calls.
//
// TWO LEGACY FIELDS, ON PURPOSE:
//
//   legacyRollback — the grouped config this role uses TODAY, and therefore
//     what LLM_ROUTING_PROFILE=legacy must resolve to. This is the rollback
//     contract: with the profile set to legacy, routing is byte-for-byte the
//     behavior that shipped before this feature.
//
//   legacyBackup — the role-APPROPRIATE paid rung in the non-legacy profiles
//     (resolution step 5). For most roles these are the same. They differ for
//     script_rewrite: today dialogue repairs run on the VERIFY provider, but a
//     dialogue repair belongs to the creative writer, so the frontier profiles
//     back it with the SCRIPT provider while legacy keeps today's verifier.

export type LLMRole =
  | "topic_generation"
  | "topic_classification"
  | "topic_ranking"
  | "research_brief"
  | "evidence_extraction"
  | "script_outline"
  | "script_story_editor"
  | "script_debate_architect"
  | "script_host_a_writer"
  | "script_host_b_writer"
  | "script_dialogue_director"
  | "script_continuity_editor"
  | "script_movement"
  | "script_verification"
  | "script_rewrite"
  | "continuity_report"
  | "fact_check"
  | "show_notes"
  | "episode_metadata"
  | "cold_open_judge"
  | "quality_judge";

/** The three grouped provider configurations that exist today. */
export type LegacyFamily = "global" | "script" | "verify";

export interface RoleDefinition {
  role: LLMRole;
  /** Human label for readiness tables and logs. */
  label: string;
  purpose: string;
  /** Env prefix: `${envPrefix}_LLM_PROVIDER` / `${envPrefix}_LLM_MODEL`. */
  envPrefix: string;
  legacyRollback: LegacyFamily;
  legacyBackup: LegacyFamily;
  /** This role's calls return structured JSON that the app parses. */
  structured: boolean;
  /** Reasoning posture requested for this role where the model supports it. */
  reasoning: "off" | "on";
  /** Sampling temperature for this role where the model accepts it. */
  temperature?: number;
  /** The role's output reaches listener-facing dialogue or TTS. */
  userFacingDialogue: boolean;
  /** Real code that performs this role. Empty = declared, not yet an LLM call. */
  callSites: string[];
}

export const ROLE_DEFINITIONS: Record<LLMRole, RoleDefinition> = {
  topic_generation: {
    role: "topic_generation",
    label: "Topic generation",
    purpose:
      "Generate varied episode candidates from ingested evidence, avoid near-duplicate stories, and find topics that can sustain disagreement.",
    envPrefix: "TOPIC_GENERATION",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "off",
    temperature: 0.25,
    userFacingDialogue: false,
    callSites: ["src/lib/queue/worker.ts → topics:generate"],
  },
  topic_classification: {
    role: "topic_classification",
    label: "Topic classification",
    purpose:
      "Label a topic with an enum-compatible story category. Deterministic, schema-validated, never repaired with creative prose.",
    envPrefix: "TOPIC_CLASSIFICATION",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "off",
    temperature: 0.1,
    userFacingDialogue: false,
    callSites: ["src/lib/queue/worker.ts → topics:classify"],
  },
  topic_ranking: {
    role: "topic_ranking",
    label: "Topic ranking / episode selection",
    purpose:
      "Compare candidate topics on evidence availability, conflict potential, novelty, relevance and the ability to sustain the target duration.",
    envPrefix: "TOPIC_RANKING",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "on",
    temperature: 0.2,
    userFacingDialogue: false,
    // Ranking is deterministic today: talkabilityService.scoreTopicTalkability
    // plus topicEligibility. No LLM call exists to route.
    callSites: [],
  },
  research_brief: {
    role: "research_brief",
    label: "Research brief",
    purpose:
      "Consolidate source material into the exact downstream brief structure: claims, provenance, disputed items, missing information.",
    envPrefix: "RESEARCH",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "on",
    temperature: 0.2,
    userFacingDialogue: false,
    callSites: ["src/lib/queue/worker.ts → topics:research-brief"],
  },
  evidence_extraction: {
    role: "evidence_extraction",
    label: "Evidence extraction / compression",
    purpose:
      "Convert source material into atomic, traceable claims; drop duplicates; keep contradictions; never delete a material fact.",
    envPrefix: "EVIDENCE",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "on",
    temperature: 0,
    userFacingDialogue: false,
    // Deterministic today: src/lib/services/evidenceContext.ts and
    // src/lib/research/articleText.ts do the extraction without a model.
    callSites: [],
  },
  script_outline: {
    role: "script_outline",
    label: "Script outline",
    purpose:
      "Design the episode's conversational architecture: beats, movement split, evidence assignment, host positions, escalation, callbacks, payoff.",
    envPrefix: "SCRIPT_OUTLINE",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "on",
    // The engine already clamps outline temperature to min(caller, 0.7).
    temperature: 0.7,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptOutlineEngine.ts → script:outline"],
  },
  // ---------------------------------------------------------------------
  // THE SEVEN-ROLE WRITING PIPELINE (src/lib/services/scriptSevenRolePipeline.ts)
  //
  // These six roles plus `quality_judge` are the seven separated writing
  // responsibilities. They exist as distinct ROLES — not distinct prompts on one
  // role — so the two host writers can be routed to different model families.
  // That is the only configuration in which "the hosts do not sound like one
  // model" is a structural fact rather than a hope.
  //
  // `script_movement` is deliberately retained: it still backs the legacy
  // outline-driven path and the single-shot fallback, both of which remain
  // reachable when the seven-role pipeline cannot complete.
  // ---------------------------------------------------------------------
  script_story_editor: {
    role: "script_story_editor",
    label: "Story editor (role 1/7)",
    purpose:
      "Name what the episode is actually about and the ONE unresolved question the hosts cannot settle by agreeing. Structural judgement, never dialogue.",
    envPrefix: "SCRIPT_STORY_EDITOR",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "on",
    temperature: 0.5,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:story_editor"],
  },
  script_debate_architect: {
    role: "script_debate_architect",
    label: "Debate architect (role 2/7)",
    purpose:
      "Build the movement structure from the spine, assign every fact to exactly one beat, allocate turns, and issue each host an asymmetric private brief.",
    envPrefix: "SCRIPT_DEBATE_ARCHITECT",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "on",
    temperature: 0.6,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:debate_architect"],
  },
  script_host_a_writer: {
    role: "script_host_a_writer",
    label: "Host A writer (role 3/7)",
    purpose:
      "Write host A's lines only, from host A's private brief. Never receives host B's brief, and its output is filtered to host A's assigned turns.",
    envPrefix: "SCRIPT_HOST_A_WRITER",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "off",
    temperature: 0.85,
    userFacingDialogue: true,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:host_a_writer"],
  },
  script_host_b_writer: {
    role: "script_host_b_writer",
    label: "Host B writer (role 4/7)",
    purpose:
      "Write host B's lines only, from host B's private brief. Never receives host A's brief, and its output is filtered to host B's assigned turns.",
    envPrefix: "SCRIPT_HOST_B_WRITER",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "off",
    temperature: 0.85,
    userFacingDialogue: true,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:host_b_writer"],
  },
  script_dialogue_director: {
    role: "script_dialogue_director",
    label: "Dialogue director (role 5/7)",
    purpose:
      "Repair causality and transitions BETWEEN turns after two writers worked without each other's words. Bounded: it may not collapse the cast into one voice.",
    envPrefix: "SCRIPT_DIALOGUE_DIRECTOR",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "off",
    temperature: 0.55,
    userFacingDialogue: true,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:dialogue_director"],
  },
  script_continuity_editor: {
    role: "script_continuity_editor",
    label: "Continuity editor (role 6/7)",
    purpose:
      "Report on callbacks, character history and running bits across the finished draft. A report, never a rewrite.",
    envPrefix: "SCRIPT_CONTINUITY_EDITOR",
    legacyRollback: "script",
    legacyBackup: "verify",
    structured: true,
    reasoning: "off",
    temperature: 0,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptSevenRolePipeline.ts → seven-role:continuity_editor"],
  },
  script_movement: {
    role: "script_movement",
    label: "Script movement / dialogue",
    purpose:
      "Write the spoken dialogue itself. The most quality-sensitive role in the application.",
    envPrefix: "SCRIPT_MOVEMENT",
    legacyRollback: "script",
    legacyBackup: "script",
    structured: true,
    reasoning: "off",
    temperature: 0.85,
    userFacingDialogue: true,
    callSites: [
      "src/lib/services/scriptOutlineEngine.ts → script:acts",
      "src/lib/services/scriptService.ts → script:single-shot-fallback",
    ],
  },
  script_verification: {
    role: "script_verification",
    label: "Script verification",
    purpose:
      "Diagnose unsupported claims, contradictions, continuity failures, repetition and character violations, and name the exact lines to fix. Never rewrites dialogue.",
    envPrefix: "SCRIPT_VERIFY",
    legacyRollback: "verify",
    legacyBackup: "verify",
    structured: true,
    reasoning: "on",
    temperature: 0,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptService.ts → script:selfverify-semantic"],
  },
  script_rewrite: {
    role: "script_rewrite",
    label: "Corrective script rewrite",
    purpose:
      "Rewrite only the defective lines the verifier named, preserving character voice and surrounding continuity.",
    envPrefix: "SCRIPT_REWRITE",
    // Today both rewrite call sites use getVerifyLLMProvider(); legacy must
    // keep that. The frontier profiles back it with the SCRIPT provider,
    // because a dialogue repair is creative writing, not grading.
    legacyRollback: "verify",
    legacyBackup: "script",
    structured: true,
    reasoning: "off",
    temperature: 0.5,
    userFacingDialogue: true,
    callSites: [
      "src/lib/services/scriptOutlineEngine.ts → script:selfverify-rewrite",
      "src/lib/services/scriptService.ts → antithesis pass rewrite",
    ],
  },
  continuity_report: {
    role: "continuity_report",
    label: "Continuity report",
    purpose:
      "Audit the finished transcript and report which running-bit beats literally landed. Deterministic extraction, never inference.",
    envPrefix: "CONTINUITY_REPORT",
    // Today this call reuses the SCRIPT provider instance in scriptService.
    legacyRollback: "script",
    legacyBackup: "verify",
    structured: true,
    reasoning: "off",
    temperature: 0,
    userFacingDialogue: false,
    callSites: ["src/lib/services/continuityReport.ts → continuity:report"],
  },
  fact_check: {
    role: "fact_check",
    label: "Semantic fact-check",
    purpose:
      "Classify each claim against the evidence packet without treating opinion as error or 'not explicitly stated' as false.",
    envPrefix: "FACT_CHECK",
    legacyRollback: "verify",
    legacyBackup: "verify",
    structured: true,
    reasoning: "on",
    temperature: 0,
    userFacingDialogue: false,
    callSites: ["src/lib/services/factCheckService.ts → factcheck:semantic-review"],
  },
  show_notes: {
    role: "show_notes",
    label: "Show notes",
    purpose:
      "Summarize the FINAL verified script into notes, chapters and takeaways without introducing a fact the script does not contain.",
    envPrefix: "SHOW_NOTES",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "off",
    temperature: 0.2,
    userFacingDialogue: false,
    callSites: ["src/lib/services/contentAssetService.ts → content-assets:show-notes"],
  },
  episode_metadata: {
    role: "episode_metadata",
    label: "Episode metadata / promo copy",
    purpose:
      "Title, description, teaser, platform summary, search metadata. Must never change the approved script.",
    envPrefix: "EPISODE_METADATA",
    legacyRollback: "global",
    legacyBackup: "global",
    structured: true,
    reasoning: "off",
    temperature: 0.6,
    userFacingDialogue: false,
    // Deterministic today: publishAssetsService derives titles/descriptions/
    // chapters from the script and show notes without a model call.
    callSites: [],
  },
  cold_open_judge: {
    role: "cold_open_judge",
    label: "Cold-open judge",
    purpose:
      "Blind-ranks the three cold-open candidates before a word of the episode body is written. Separate from " +
      "the final editorial judge on purpose: this one decides which of three openings survives, on craft alone, " +
      "and it must never be the model that wrote them.",
    envPrefix: "COLD_OPEN_JUDGE",
    // Same grouped families as the final judge, so an unset COLD_OPEN_JUDGE_*
    // resolves exactly where the cold-open judge resolved before this role
    // existed. Declaring the role changes nothing until someone routes it.
    legacyRollback: "verify",
    legacyBackup: "verify",
    structured: true,
    reasoning: "on",
    temperature: 0,
    userFacingDialogue: false,
    callSites: ["src/lib/services/scriptCreativePipeline.ts → script:cold-open-judge"],
  },
  quality_judge: {
    role: "quality_judge",
    label: "Quality judge",
    purpose:
      "Cross-model evaluation of a finished script. Never the writer of the script it judges, and never the only signal — it runs alongside the deterministic scorer.",
    envPrefix: "QUALITY_JUDGE",
    legacyRollback: "verify",
    legacyBackup: "verify",
    structured: true,
    reasoning: "on",
    temperature: 0,
    userFacingDialogue: false,
    callSites: [
      "src/lib/services/scriptQualityJudge.ts → quality:judge",
      "src/scripts/testRoleExperiments.ts (development harness)",
    ],
  },
};

export const ALL_ROLES: LLMRole[] = Object.keys(ROLE_DEFINITIONS) as LLMRole[];

export function roleDefinition(role: LLMRole): RoleDefinition {
  const def = ROLE_DEFINITIONS[role];
  if (!def) throw new Error(`[LLMRouting] Unknown role '${role}'.`);
  return def;
}

/** Roles whose output reaches listener-facing dialogue or the TTS input. */
export function dialogueRoles(): LLMRole[] {
  return ALL_ROLES.filter((r) => ROLE_DEFINITIONS[r].userFacingDialogue);
}
