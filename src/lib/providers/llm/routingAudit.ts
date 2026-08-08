// WHO IS ACTUALLY WRITING THIS SHOW, role by role.
//
// WHY THIS EXISTS. Every role in this repository can be routed independently,
// and for a while none of them were. Production runs `LLM_ROUTING_PROFILE`
// unset — which means `legacy` — and under legacy every role collapses onto one
// of three grouped variables (LLM_*, SCRIPT_LLM_*, VERIFY_*). With
// `SCRIPT_LLM_PROVIDER=anthropic` and `SCRIPT_LLM_MODEL=claude-opus-5`, five
// distinct creative roles resolve to a byte-identical endpoint — including BOTH
// host writers, whose entire purpose is to be two different minds.
//
// Nothing in the code said so. `SCRIPT_LLM_MODEL` was a setting for "the script
// model" back when there was one script call; it was never a decision that one
// model should play the story editor, the debate architect, both hosts and the
// dialogue director at once. The collapse was inherited, not chosen.
//
// This module does not change any route. It makes the routes VISIBLE, and it
// turns three specific silent degradations into recorded, checkable facts:
//
//   COLLAPSE       two or more roles resolving to the identical endpoint
//   HOST COLLISION host A's writer and host B's writer on the same endpoint
//   JUDGE CAPTURE  the editorial judge sharing a provider with the writer it
//                  grades, while another credentialed provider was available
//
// It is pure and env-driven: no I/O, no provider construction, so readiness, the
// canary and the tests all read the same answer without spending anything.

import { ALL_ROLES, LLMRole, roleDefinition } from "./roles";
import { readRoutingEnv, roleOverrideKeys } from "./routingEnv";
import {
  candidateKey,
  endpointIdentity,
  providerCredentialPresent,
  resolveRolePlan,
  type CandidateSource,
} from "./routing";
import { SUPPORTED_LLM_PROVIDERS } from "./factory";

/**
 * The nine roles this show's editorial quality actually rests on.
 *
 * Deliberately NOT `ALL_ROLES`: show notes and episode metadata can share a
 * model with anything without hurting anyone. These nine cannot — five of them
 * write the words a listener hears, and three of them are supposed to judge
 * those words from outside.
 */
export const PRODUCTION_WRITING_ROLES: readonly LLMRole[] = [
  "script_story_editor",
  "script_debate_architect",
  "script_host_a_writer",
  "script_host_b_writer",
  "script_dialogue_director",
  "script_continuity_editor",
  "fact_check",
  "cold_open_judge",
  "quality_judge",
] as const;

/** The roles that produce listener-facing dialogue. A judge must sit outside these. */
export const AUTHORING_ROLES: readonly LLMRole[] = [
  "script_story_editor",
  "script_debate_architect",
  "script_host_a_writer",
  "script_host_b_writer",
  "script_dialogue_director",
] as const;

/** The three roles that are supposed to grade, not write. */
export const JUDGING_ROLES: readonly LLMRole[] = ["fact_check", "cold_open_judge", "quality_judge"] as const;

export interface RoleRouteRow {
  role: LLMRole;
  /** provider/model, for humans. Never a credential. */
  label: string;
  provider: string;
  model: string | null;
  /** provider + normalized base URL + model. Equality here means "same call". */
  identity: string;
  /** Which resolution rung produced this route. */
  source: CandidateSource | "unresolved";
  /** The two variables an operator would set to route this role explicitly. */
  envProvider: string;
  envModel: string;
  /** True when a role-level override is actually set for this role. */
  explicit: boolean;
  /** Is there a usable credential for this provider? Presence only, never a value. */
  credentialPresent: boolean;
}

/**
 * Resolve every role's FIRST candidate without calling anything.
 *
 * The first candidate is the honest answer to "who writes this on the healthy
 * path". Fallbacks matter for resilience, but a table of fallbacks would hide
 * the thing being audited: what normally happens.
 */
export function roleRoutingTable(roles: readonly LLMRole[] = ALL_ROLES): RoleRouteRow[] {
  return roles.map((role) => {
    const plan = resolveRolePlan(role);
    const first = plan.candidates[0];
    const { providerKey, modelKey } = roleOverrideKeys(role);
    if (!first) {
      return {
        role,
        label: "(unresolved)",
        provider: "(none)",
        model: null,
        identity: `unresolved|${role}`,
        source: "unresolved" as const,
        envProvider: providerKey,
        envModel: modelKey,
        explicit: Boolean(readRoutingEnv(providerKey)),
        credentialPresent: false,
      };
    }
    return {
      role,
      label: candidateKey(first),
      provider: first.provider,
      model: first.model ?? null,
      identity: endpointIdentity(first),
      source: first.source,
      envProvider: providerKey,
      envModel: modelKey,
      explicit: Boolean(readRoutingEnv(providerKey)),
      credentialPresent: providerCredentialPresent(first.provider),
    };
  });
}

/** Two or more roles sharing one endpoint. */
export interface RoutingCollapse {
  identity: string;
  label: string;
  roles: LLMRole[];
}

/**
 * Roles that resolve to the SAME endpoint.
 *
 * Not automatically wrong — the continuity editor and the fact checker sharing
 * a cheap grader is a reasonable choice. It is only wrong where the roles exist
 * to disagree with each other, which is what the checks below are for. This
 * function reports; it does not judge.
 */
export function detectRoutingCollapse(rows: RoleRouteRow[]): RoutingCollapse[] {
  const byIdentity = new Map<string, RoleRouteRow[]>();
  for (const row of rows) {
    if (row.source === "unresolved") continue;
    const list = byIdentity.get(row.identity) ?? [];
    list.push(row);
    byIdentity.set(row.identity, list);
  }
  return [...byIdentity.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([identity, list]) => ({ identity, label: list[0].label, roles: list.map((r) => r.role) }));
}

/** How many of the audited roles each provider holds. */
export function providerConcentration(rows: RoleRouteRow[]): Array<{ provider: string; roles: LLMRole[] }> {
  const byProvider = new Map<string, LLMRole[]>();
  for (const row of rows) {
    if (row.source === "unresolved") continue;
    const list = byProvider.get(row.provider) ?? [];
    list.push(row.role);
    byProvider.set(row.provider, list);
  }
  return [...byProvider.entries()]
    .map(([provider, roles]) => ({ provider, roles }))
    .sort((a, b) => b.roles.length - a.roles.length);
}

/**
 * LLM providers this deployment could actually call right now.
 *
 * Credential PRESENCE only — never a value, never a length. `stub` is excluded
 * deliberately: it is not an alternative opinion, it is the absence of one, and
 * counting it would let "the judge has somewhere else to go" be satisfied by a
 * fixture generator.
 */
export function configuredLlmProviders(): string[] {
  return SUPPORTED_LLM_PROVIDERS.filter((p) => p !== "stub").filter((p) => providerCredentialPresent(p));
}

// ---------------------------------------------------------------- independence

/**
 * How far apart the judge and the writer actually are.
 *
 *   provider  different companies, different weights, different failure modes.
 *             The only level that earns the word "independent".
 *   model     same provider, different model. Better than nothing and often all
 *             that is available — but two models from one lab share training
 *             data, alignment and blind spots, so this is a DEGRADED state that
 *             gets recorded rather than a passing one that gets forgotten.
 *   none      the identical endpoint. The judge is grading its own output.
 */
export type IndependenceLevel = "provider" | "model" | "none";

/** The minimum a route must expose to be graded. Keeps the rule usable by the
 *  canary, readiness and the tests without any of them resolving routes twice. */
export interface GradableRoute {
  role: string;
  label: string;
  provider: string;
  identity: string;
}

export interface IndependenceGrade {
  level: IndependenceLevel;
  independent: boolean;
  acceptable: boolean;
  providerCollisions: string[];
  endpointCollisions: string[];
  reason: string | null;
  remedy: string | null;
}

/**
 * THE RULE, in one place.
 *
 * `assessJudgeIndependence` (env-driven) and the canary's pre-spend check (route
 * driven) both call this, so the answer cannot differ between "will this
 * deploy?" and "did this run?" — which is exactly how the previous check drifted
 * into passing a judge that shared a provider with every writer it graded.
 *
 * `alternativesAvailable` is what makes the provider requirement conditional: a
 * deployment with one credentialed provider physically cannot put the judge
 * elsewhere, and refusing to run at all would be a worse answer than running
 * with the degradation on the record.
 */
export function gradeIndependence(args: {
  judge: GradableRoute;
  authoring: GradableRoute[];
  alternativesAvailable: string[];
  /** Env vars an operator would set to fix it. */
  envVars?: string[];
}): IndependenceGrade {
  const { judge, authoring } = args;
  const alternatives = args.alternativesAvailable.filter((p) => p !== judge.provider);
  const fix = args.envVars?.length ? args.envVars.join(" / ") : "the judge's _LLM_PROVIDER / _LLM_MODEL";

  // A judge that resolves to nothing collides with nobody, and "collides with
  // nobody" is how the naive rule spells "independent". It is the opposite:
  // there is no judge at all, so nothing is grading the script.
  if (!judge.provider || judge.provider === "(none)" || judge.label === "(unresolved)") {
    return {
      level: "none",
      independent: false,
      acceptable: false,
      providerCollisions: [],
      endpointCollisions: [],
      reason: `The judge route does not resolve to any provider, so nothing is judging this script.`,
      remedy: `Set ${fix}.`,
    };
  }

  // `stub` is not a model, so "the stub judge shares an endpoint with the stub
  // writers" is not self-judging — it is an unconfigured deployment, which is a
  // different fault with a different fix. Saying "a model cannot judge dialogue
  // it wrote" about a fixture generator would send an operator to change a
  // routing variable when what is missing is a credential.
  if (judge.provider === "stub") {
    return {
      level: "none",
      independent: false,
      acceptable: false,
      providerCollisions: [],
      endpointCollisions: [],
      reason: `The judge resolves to the stub provider. Stub returns fixtures, so nothing is grading this script.`,
      remedy: `Configure a real provider and set ${fix}.`,
    };
  }

  const endpointCollisions = authoring.filter((r) => r.identity === judge.identity).map((r) => r.role);
  const providerCollisions = authoring.filter((r) => r.provider === judge.provider).map((r) => r.role);

  if (endpointCollisions.length) {
    return {
      level: "none",
      independent: false,
      acceptable: false,
      providerCollisions,
      endpointCollisions,
      reason:
        `The judge resolves to ${judge.label}, the SAME endpoint as ${endpointCollisions.join(", ")}. ` +
        `A model cannot independently judge dialogue it wrote.`,
      remedy: `Point ${fix} at a different provider.`,
    };
  }

  if (providerCollisions.length) {
    const acceptable = alternatives.length === 0;
    return {
      level: "model",
      independent: false,
      acceptable,
      providerCollisions,
      endpointCollisions: [],
      reason:
        `The judge resolves to ${judge.label}, a different model but the SAME PROVIDER (${judge.provider}) as ` +
        `${providerCollisions.join(", ")}. Two models from one lab share training data, alignment and blind ` +
        `spots, so this is model-level separation, not independence.` +
        (acceptable
          ? ` No other provider is credentialed, so it is the best available separation — recorded, not approved.`
          : ` ${alternatives.length} other credentialed provider(s) were available and unused: ${alternatives.join(", ")}.`),
      remedy: acceptable
        ? `Credential a second provider to make the editorial judge genuinely independent.`
        : `Point ${fix} at one of: ${alternatives.join(", ")}.`,
    };
  }

  return {
    level: "provider",
    independent: true,
    acceptable: true,
    providerCollisions: [],
    endpointCollisions: [],
    reason: null,
    remedy: null,
  };
}

export interface JudgeIndependence {
  level: IndependenceLevel;
  /** True ONLY at provider level. This is the flag that gets persisted. */
  independent: boolean;
  /**
   * Was this the best available outcome? False when another credentialed
   * provider existed and was simply not used — that is a fixable configuration
   * mistake, not a constraint.
   */
  acceptable: boolean;
  judgeRole: LLMRole;
  judgeLabel: string;
  /** Authoring roles the judge shares a PROVIDER with. */
  providerCollisions: LLMRole[];
  /** Authoring roles the judge shares an ENDPOINT with. Always the worse case. */
  endpointCollisions: LLMRole[];
  /** Credentialed providers that are not the judge's. Names only. */
  alternativesAvailable: string[];
  reason: string | null;
  /** What an operator should do. Null when nothing is wrong. */
  remedy: string | null;
}

/**
 * Grade a judge route against the routes that wrote the thing it judges.
 *
 * THE RULE, and why it is conditional. A judge on a different provider is the
 * requirement. But a deployment with exactly one credentialed provider cannot
 * satisfy it, and refusing to ship at all would be a worse answer than shipping
 * with the degradation recorded — so the demand is "different provider WHEN
 * another configured provider is available", and the absence of an alternative
 * is itself reported so it can be fixed rather than discovered later.
 *
 * The identical-endpoint case is never acceptable at any level. There is no
 * deployment shape in which a model grading its own output is informative.
 */
export function assessJudgeIndependence(args: {
  judgeRole: LLMRole;
  rows: RoleRouteRow[];
  authoringRoles?: readonly LLMRole[];
  configuredProviders?: string[];
}): JudgeIndependence {
  const authoringRoles = args.authoringRoles ?? AUTHORING_ROLES;
  const byRole = new Map(args.rows.map((r) => [r.role, r]));
  const judge = byRole.get(args.judgeRole);
  const authoring = authoringRoles.map((r) => byRole.get(r)).filter((r): r is RoleRouteRow => Boolean(r));

  const providers = args.configuredProviders ?? configuredLlmProviders();
  const envVars = roleOverrideKeys(args.judgeRole);

  if (!judge || judge.source === "unresolved") {
    return {
      level: "none",
      independent: false,
      acceptable: false,
      judgeRole: args.judgeRole,
      judgeLabel: judge?.label ?? "(unresolved)",
      providerCollisions: [],
      endpointCollisions: [],
      alternativesAvailable: providers,
      reason: `${args.judgeRole} resolves to no candidate at all, so nothing is judging this script.`,
      remedy: `Set ${envVars.providerKey} / ${envVars.modelKey}.`,
    };
  }

  const grade = gradeIndependence({
    judge,
    authoring,
    alternativesAvailable: providers,
    envVars: [envVars.providerKey, envVars.modelKey],
  });

  return {
    ...grade,
    judgeRole: args.judgeRole,
    judgeLabel: judge.label,
    providerCollisions: grade.providerCollisions as LLMRole[],
    endpointCollisions: grade.endpointCollisions as LLMRole[],
    alternativesAvailable: providers.filter((p) => p !== judge.provider),
  };
}

// ---------------------------------------------------------------- host writers

export interface HostWriterSeparation {
  /** True when the two host writers are not the same call. */
  separate: boolean;
  sameEndpoint: boolean;
  sameProvider: boolean;
  hostA: string;
  hostB: string;
  reason: string | null;
  remedy: string | null;
}

/**
 * Are host A and host B being written by two different minds?
 *
 * This is the check the routing table exists for. The seven-role pipeline
 * already guarantees the two writers get ISOLATED PROMPTS — neither can see the
 * other's private brief, and authorship is filtered on the way back. That
 * protects against leakage. It does nothing about sameness: one model, given two
 * isolated briefs, writes two versions of itself, and the result is two hosts
 * with one voice — which is the exact failure the show is trying to avoid.
 *
 * Same provider with different models is a real, if partial, separation and is
 * reported as such. The identical endpoint is not separation at all.
 */
export function assessHostWriterRoutes(rows: RoleRouteRow[]): HostWriterSeparation {
  const byRole = new Map(rows.map((r) => [r.role, r]));
  const a = byRole.get("script_host_a_writer");
  const b = byRole.get("script_host_b_writer");
  if (!a || !b) {
    return {
      separate: false,
      sameEndpoint: false,
      sameProvider: false,
      hostA: a?.label ?? "(unresolved)",
      hostB: b?.label ?? "(unresolved)",
      reason: "One or both host writer routes do not resolve.",
      remedy: "Set SCRIPT_HOST_A_WRITER_LLM_PROVIDER and SCRIPT_HOST_B_WRITER_LLM_PROVIDER.",
    };
  }
  const sameEndpoint = a.identity === b.identity;
  const sameProvider = a.provider === b.provider;
  if (sameEndpoint) {
    return {
      separate: false,
      sameEndpoint: true,
      sameProvider,
      hostA: a.label,
      hostB: b.label,
      reason:
        `Both host writers resolve to ${a.label}. The prompts are isolated, but one model writing both ` +
        `characters produces two versions of itself — the hosts will converge no matter how the briefs differ.`,
      remedy:
        `Point SCRIPT_HOST_B_WRITER_LLM_PROVIDER / _MODEL at a different route from ` +
        `SCRIPT_HOST_A_WRITER_LLM_PROVIDER / _MODEL.`,
    };
  }
  return {
    separate: true,
    sameEndpoint: false,
    sameProvider,
    hostA: a.label,
    hostB: b.label,
    reason: sameProvider
      ? `The host writers use different models on the same provider (${a.provider}). Separated, but from one lab.`
      : null,
    remedy: null,
  };
}

// ---------------------------------------------------------------- cold open

export const COLD_OPEN_ANGLE_IDS = ["accusation", "consequence", "contradiction"] as const;

/**
 * Routes the cold-open tournament may draw its candidates from.
 *
 * The two host writers and the story editor, because those are the routes an
 * operator has already made a decision about. Inventing a fourth variable for
 * "who writes cold opens" would be one more thing to leave unset.
 */
export const COLD_OPEN_WRITER_ROLES: readonly LLMRole[] = [
  "script_host_a_writer",
  "script_host_b_writer",
  "script_story_editor",
] as const;

export interface ColdOpenWriterRoute {
  variantId: (typeof COLD_OPEN_ANGLE_IDS)[number];
  llmRole: LLMRole;
  label: string;
}

/**
 * Spread the three cold-open angles across the DISTINCT routes available.
 *
 * Returns an empty array when fewer than two distinct endpoints exist — the
 * caller then runs the single-writer path, which is exactly today's behaviour.
 * That is the whole compatibility story: a deployment with one provider notices
 * nothing, and a deployment with two or three gets a genuinely contested field
 * without anyone setting a new variable.
 *
 * Round-robin rather than one-angle-per-role: with two routes the third angle
 * goes back to the first, which is better than dropping an angle, and it keeps
 * the assignment deterministic so a tournament can be reproduced from its record.
 */
export function planColdOpenWriterRoutes(rows?: RoleRouteRow[]): ColdOpenWriterRoute[] {
  const table = rows ?? roleRoutingTable(COLD_OPEN_WRITER_ROLES);
  const seen = new Set<string>();
  const distinct: RoleRouteRow[] = [];
  for (const role of COLD_OPEN_WRITER_ROLES) {
    const row = table.find((r) => r.role === role);
    if (!row || row.source === "unresolved" || !row.credentialPresent) continue;
    if (seen.has(row.identity)) continue;
    seen.add(row.identity);
    distinct.push(row);
  }
  if (distinct.length < 2) return [];
  return COLD_OPEN_ANGLE_IDS.map((variantId, i) => {
    const row = distinct[i % distinct.length];
    return { variantId, llmRole: row.role, label: row.label };
  });
}

// ---------------------------------------------------------------- whole report

export interface RoutingAuditReport {
  rows: RoleRouteRow[];
  collapses: RoutingCollapse[];
  concentration: Array<{ provider: string; roles: LLMRole[] }>;
  configuredProviders: string[];
  hostWriters: HostWriterSeparation;
  judges: JudgeIndependence[];
  /** True when every audited role is served by ONE provider. */
  singleProvider: boolean;
  /** Roles with no usable credential — these fail at call time, loudly. */
  uncredentialed: LLMRole[];
}

export function auditRoleRouting(roles: readonly LLMRole[] = PRODUCTION_WRITING_ROLES): RoutingAuditReport {
  const rows = roleRoutingTable(roles);
  const configuredProviders = configuredLlmProviders();
  const concentration = providerConcentration(rows);
  return {
    rows,
    collapses: detectRoutingCollapse(rows),
    concentration,
    configuredProviders,
    hostWriters: assessHostWriterRoutes(rows),
    judges: JUDGING_ROLES.filter((r) => roles.includes(r)).map((judgeRole) =>
      assessJudgeIndependence({ judgeRole, rows, configuredProviders })
    ),
    singleProvider: concentration.length === 1,
    uncredentialed: rows.filter((r) => !r.credentialPresent).map((r) => r.role),
  };
}

/** Human-readable table. Contains provider and model names only — never a key. */
export function renderRoutingTable(rows: RoleRouteRow[]): string {
  const width = Math.max(...rows.map((r) => r.role.length), 4);
  const lines = rows.map(
    (r) =>
      `  ${r.role.padEnd(width)}  ${r.label.padEnd(34)} ${r.source.padEnd(17)} ` +
      `${r.explicit ? "explicit" : "inherited"}${r.credentialPresent ? "" : "  [NO CREDENTIAL]"}`
  );
  return [`  ${"role".padEnd(width)}  ${"provider/model".padEnd(34)} ${"source".padEnd(17)} origin`, ...lines].join("\n");
}
