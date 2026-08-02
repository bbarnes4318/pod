// The SEVEN WRITING ROLES: the registry that names them, and the stage runner
// that executes one role and records what actually happened.
//
// WHY THIS EXISTS
//
// The creative pipeline already split "plan the episode" from "write the
// dialogue" (script_outline vs script_movement). That is two roles, and it left
// one model writing BOTH hosts, repairing its own transitions, and checking its
// own continuity. A single mind writing both sides of an argument is exactly the
// failure the quality judge keeps reporting as `singleModelSmell`.
//
// So the writing job is decomposed into seven responsibilities that are
// genuinely separate PROCESSES, not seven paragraphs in one prompt:
//
//   1 story_editor       what is this episode actually about, what is unresolved
//   2 debate_architect   movement structure + which beat carries which evidence
//   3 host_a_writer      host A's lines. Only host A's lines.
//   4 host_b_writer      host B's lines. Only host B's lines.
//   5 dialogue_director   causality and transitions BETWEEN turns
//   6 continuity_editor  callbacks, character history, running bits
//   7 independent_judge  scores the finished script (the existing quality_judge)
//
// SEPARATION IS STRUCTURAL, NOT PROMPTED. Roles 3 and 4 receive different
// private briefs (enforced by redaction + an isolation check on the composed
// prompt), and their output is FILTERED to the lines they own (enforced by the
// authorship filter in scriptSevenRolePipeline). A prompt that says "only write
// host A" is a request; a filter that drops host B's lines is a guarantee.
//
// PROVENANCE IS THE POINT. Every stage records role, provider, REQUESTED model,
// ACTUAL model, whether a fallback fired and why, input/output artifact refs,
// timing and status. A fallback that leaves the record claiming the primary ran
// is the specific dishonesty this module exists to prevent — when the actual
// model cannot be observed, the record says "unobserved", never "the requested
// one".

import { createHash } from "crypto";
import type { LLMProvider } from "../providers/llm/interface";
import type { LLMRole } from "../providers/llm/roles";
import { getRoleLLMProvider, resolveRolePlan, candidateKey } from "../providers/llm/routing";
import { llmCostMark, llmCostSince, withLlmStage } from "../providers/llm/costLedger";
import type { ScriptPipelineProvenance } from "./scriptEditorialGate";

// ---------------------------------------------------------------- the registry

export type SevenRole =
  | "story_editor"
  | "debate_architect"
  | "host_a_writer"
  | "host_b_writer"
  | "dialogue_director"
  | "continuity_editor"
  | "independent_judge";

export interface SevenRoleDefinition {
  role: SevenRole;
  /** Position in the pipeline, 1-based. Roles run in this order, always. */
  order: number;
  label: string;
  purpose: string;
  /** The routing role this stage's LLM calls are resolved through. */
  llmRole: LLMRole;
  /**
   * A required role that FAILS holds production. An optional role that fails is
   * recorded as failed in the role trace and projected into the gate-compatible
   * stage list as non-blocking — see `compatStages()` for exactly how, and why
   * that projection is stated rather than hidden.
   */
  required: boolean;
  /** Whose dialogue this role is permitted to author. Enforced, not advisory. */
  authors: "host_a" | "host_b" | "none";
}

export const SEVEN_ROLE_DEFINITIONS: Record<SevenRole, SevenRoleDefinition> = {
  story_editor: {
    role: "story_editor",
    order: 1,
    label: "Story editor",
    purpose:
      "Decide what the episode is actually about and name the ONE unresolved question the hosts cannot settle by agreeing.",
    llmRole: "script_story_editor",
    required: true,
    authors: "none",
  },
  debate_architect: {
    role: "debate_architect",
    order: 2,
    label: "Debate architect",
    purpose:
      "Build the movement structure from the spine, assign each piece of evidence to exactly one beat, allocate turns, and issue each host a private, asymmetric brief.",
    llmRole: "script_debate_architect",
    required: true,
    authors: "none",
  },
  host_a_writer: {
    role: "host_a_writer",
    order: 3,
    label: "Host A writer",
    purpose:
      "Write host A's lines from host A's private brief and the public turn plan. Never sees host B's private brief.",
    llmRole: "script_host_a_writer",
    required: true,
    authors: "host_a",
  },
  host_b_writer: {
    role: "host_b_writer",
    order: 4,
    label: "Host B writer",
    purpose:
      "Write host B's lines from host B's private brief and the public turn plan. Never sees host A's private brief.",
    llmRole: "script_host_b_writer",
    required: true,
    authors: "host_b",
  },
  dialogue_director: {
    role: "dialogue_director",
    order: 5,
    label: "Dialogue director",
    purpose:
      "Repair causality and transitions BETWEEN turns after two writers worked without each other's words. Bounded: it may not rewrite the cast into one voice.",
    llmRole: "script_dialogue_director",
    required: true,
    authors: "none",
  },
  continuity_editor: {
    role: "continuity_editor",
    order: 6,
    label: "Continuity editor",
    purpose:
      "Report on callbacks, character history and running bits. A report, never a rewrite.",
    // Continuity in this product is OPTIONAL and topic-gated: nothing is
    // required per episode, so a continuity failure must not be able to hold an
    // otherwise sound script.
    llmRole: "script_continuity_editor",
    required: false,
    authors: "none",
  },
  independent_judge: {
    role: "independent_judge",
    order: 7,
    label: "Independent judge",
    purpose:
      "Score the finished script on the axes a single-model script fails. Never the writer of the script it judges.",
    llmRole: "quality_judge",
    required: true,
    authors: "none",
  },
};

/** Execution order. The pipeline runs exactly this sequence, every time. */
export const SEVEN_ROLE_ORDER: SevenRole[] = (
  Object.values(SEVEN_ROLE_DEFINITIONS) as SevenRoleDefinition[]
)
  .sort((a, b) => a.order - b.order)
  .map((d) => d.role);

/** Roles whose failure HOLDS production. Exported as the contract it is. */
export const REQUIRED_SEVEN_ROLES: SevenRole[] = SEVEN_ROLE_ORDER.filter(
  (r) => SEVEN_ROLE_DEFINITIONS[r].required
);

/** Roles whose failure is recorded and surfaced, but does not hold production. */
export const OPTIONAL_SEVEN_ROLES: SevenRole[] = SEVEN_ROLE_ORDER.filter(
  (r) => !SEVEN_ROLE_DEFINITIONS[r].required
);

export function isRequiredSevenRole(role: SevenRole): boolean {
  return SEVEN_ROLE_DEFINITIONS[role]?.required === true;
}

// ---------------------------------------------------------------- artifacts

/**
 * A content-addressed reference to something a stage read or produced.
 *
 * The blob itself is NOT copied into provenance — a script's worth of JSON per
 * stage would be megabytes on every episode. The digest is what makes the
 * reference useful: two stages that name the same artifact id genuinely read the
 * same bytes, and a stage that claims to have consumed the architect's turn plan
 * can be checked against the architect's recorded output id.
 */
export interface ArtifactRef {
  /** `${kind}@${digest}` — stable across runs for identical content. */
  id: string;
  kind: string;
  digest: string;
  bytes: number;
  /** Optional human note, e.g. "42 turns, 2 hosts". */
  note?: string;
}

export function artifactRef(kind: string, value: unknown, note?: string): ArtifactRef {
  let json: string;
  try {
    json = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  } catch {
    json = String(value);
  }
  const digest = createHash("sha1").update(json).digest("hex").slice(0, 12);
  return { id: `${kind}@${digest}`, kind, digest, bytes: Buffer.byteLength(json, "utf8"), note };
}

// ---------------------------------------------------------------- violations

export type RoleViolationKind =
  | "foreign_authorship"
  | "missing_turn"
  | "isolation_breach"
  | "director_overreach"
  | "voice_homogenization"
  | "schema";

export interface RoleViolation {
  role: SevenRole;
  kind: RoleViolationKind;
  detail: string;
  /** Numbers behind the finding, so a reviewer never has to trust the sentence. */
  observed?: Record<string, string | number>;
}

// ---------------------------------------------------------------- stage record

export type RoleStageStatus = "ok" | "failed" | "skipped";

/**
 * How the ACTUAL provider/model was learned. Never omitted, because the whole
 * value of the actual-model field is knowing whether it was observed or assumed.
 */
export type ModelObservationSource = "cost_ledger" | "provider_report" | "unobserved";

export interface RoleStageRecord {
  role: SevenRole;
  order: number;
  label: string;
  llmRole: LLMRole;
  required: boolean;
  status: RoleStageStatus;

  /** What the router ASKED for (rung 1 of the role's candidate chain). */
  requestedProvider: string;
  requestedModel: string;
  /** The full candidate chain the role would walk, for context. */
  candidateChain: string[];

  /**
   * What actually served the call. `null` when nothing could be observed —
   * NEVER back-filled from `requestedModel`, because that is precisely how a
   * silent fallback ends up recorded as the primary model having run.
   */
  actualProvider: string | null;
  actualModel: string | null;
  modelObservation: ModelObservationSource;

  /** True when the call was not served by the requested provider/model. */
  fallbackFired: boolean;
  /** Non-null whenever `fallbackFired` is true. Never a bare boolean. */
  fallbackReason: string | null;
  /** Earlier candidates in the role chain that failed before this call landed. */
  fallbackCount: number;

  inputArtifacts: ArtifactRef[];
  outputArtifacts: ArtifactRef[];

  startedAt: string;
  finishedAt: string;
  durationMs: number;

  /** Present when status is "failed" or "skipped". */
  error?: string;
  /** Violations this stage's guards recorded (structural enforcement results). */
  violations: RoleViolation[];
}

export interface SevenRoleTraceRecord {
  version: 1;
  pipeline: "seven_role";
  /** Every role, in execution order. Roles never reached appear as "skipped". */
  roles: RoleStageRecord[];
  requiredRoles: SevenRole[];
  optionalRoles: SevenRole[];
  /** Required roles that failed — the reason production is held. */
  holdingRoles: SevenRole[];
  violations: RoleViolation[];
  /** True when every required role finished ok. */
  allRequiredRolesOk: boolean;
  /**
   * A failure that belongs to the pipeline rather than to any one role — an
   * assembled draft that came out below the episode's word floor, for example.
   * Blocking: it is projected into `stages[]` as a failed stage.
   */
  pipelineError?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * The existing provenance shape, EXTENDED rather than replaced.
 *
 * `stages[]` keeps its exact meaning — the editorial gate reads
 * `stages[].status === "failed"` and holds — and `roleTrace` carries the richer
 * per-stage record. Nothing in scriptEditorialGate.ts changes.
 */
export interface SevenRoleProvenance extends ScriptPipelineProvenance {
  roleTrace: SevenRoleTraceRecord;
  /** Which creative path produced the script, at finer grain than `path`. */
  creativePath?: "seven_role" | "outline_driven_legacy" | "single_shot_fallback";
}

// ------------------------------------------------------- provider observation

/** What a provider can volunteer about the call it just served. */
export interface ResolvedCallReport {
  provider: string;
  model: string;
  /** Set when this was not the first candidate. */
  fallbackFrom?: string | null;
  fallbackReason?: string | null;
  fallbackCount?: number;
}

export interface CallReportingLLMProvider extends LLMProvider {
  lastResolvedCall(): ResolvedCallReport | null;
}

export function reportsResolvedCall(p: LLMProvider): p is CallReportingLLMProvider {
  return typeof (p as Partial<CallReportingLLMProvider>).lastResolvedCall === "function";
}

/** A provider bound to a role, plus what the router asked for on its behalf. */
export interface RoleProviderBinding {
  provider: LLMProvider;
  /** Defaults to the first candidate of the resolved role plan. */
  requested?: { provider: string; model?: string };
}

export type RoleProviderResolver = (
  role: SevenRole,
  llmRole: LLMRole
) => RoleProviderBinding;

export const defaultRoleProviderResolver: RoleProviderResolver = (_role, llmRole) => ({
  provider: getRoleLLMProvider(llmRole),
});

function requestedFor(
  llmRole: LLMRole,
  override?: { provider: string; model?: string }
): { provider: string; model: string; chain: string[] } {
  if (override) {
    return {
      provider: override.provider,
      model: override.model ?? "(provider-default)",
      chain: [candidateKey(override)],
    };
  }
  try {
    const plan = resolveRolePlan(llmRole);
    const first = plan.candidates[0];
    return {
      provider: first?.provider ?? "(no candidate)",
      model: first?.model ?? "(provider-default)",
      chain: plan.candidates.map(candidateKey),
    };
  } catch (err) {
    return {
      provider: "(unresolved)",
      model: "(unresolved)",
      chain: [`(role plan unresolved: ${(err as Error).message})`],
    };
  }
}

/**
 * Read the ACTUAL provider/model out of the cost ledger.
 *
 * Every real provider reports each call there with the provider name and model
 * id it used, plus how many earlier candidates in the role chain failed. Taking
 * a ledger mark immediately before the stage and reading the delta afterwards is
 * therefore a direct observation, not an inference.
 *
 * CAVEAT, stated rather than hidden: the ledger is process-global. Two episodes
 * generating concurrently in one worker could interleave calls for the same
 * role. The role filter below removes the common case (a different role running
 * alongside); it cannot separate two runs of the SAME role. That is why the
 * provider's own report is preferred when it offers one.
 */
function observeFromLedger(
  mark: number,
  llmRole: LLMRole
): { provider: string; model: string; fallbackCount: number } | null {
  const since = llmCostSince(mark);
  if (!since.stages.length) return null;
  const byRole = since.stages.filter((s) => s.roles.includes(llmRole));
  // Legacy-profile calls are not routed through RoutedLLMProvider, so they carry
  // no role attribution at all. Those are still this stage's calls (the mark was
  // taken immediately before it), so they are usable when no role-tagged call
  // exists — but a call tagged with a DIFFERENT role never is.
  const pool = byRole.length ? byRole : since.stages.filter((s) => s.roles.length === 0);
  if (!pool.length) return null;

  let last: string | null = null;
  let fallbackCount = 0;
  for (const stage of pool) {
    if (stage.models.length) last = stage.models[stage.models.length - 1];
    fallbackCount += stage.fallbacks || 0;
  }
  if (!last) return null;
  const cut = last.indexOf("/");
  return {
    provider: cut >= 0 ? last.slice(0, cut) : last,
    model: cut >= 0 ? last.slice(cut + 1) : "(provider-default)",
    fallbackCount,
  };
}

function sameEndpoint(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------------------------------------------------------------- the runner

export interface RoleStageOutput<T> {
  value: T;
  /** What this stage produced, by reference. */
  outputs: ArtifactRef[];
  /** Guard findings. A stage may succeed while recording violations. */
  violations?: RoleViolation[];
}

export type RoleStageOutcome<T> =
  | { ok: true; value: T; record: RoleStageRecord }
  | { ok: false; error: Error; record: RoleStageRecord };

export interface SevenRoleTraceOptions {
  resolveProvider?: RoleProviderResolver;
  log?: (message: string) => void;
}

/**
 * Accumulates one run's role records and turns them into gate-compatible
 * provenance.
 */
export class SevenRoleTrace {
  private readonly records = new Map<SevenRole, RoleStageRecord>();
  private readonly bindings = new Map<SevenRole, RoleProviderBinding>();
  private readonly extraViolations: RoleViolation[] = [];
  private readonly resolveProvider: RoleProviderResolver;
  private readonly log: (message: string) => void;
  private pipelineError?: string;
  readonly startedAt = new Date().toISOString();
  private finishedAt?: string;

  constructor(options: SevenRoleTraceOptions = {}) {
    this.resolveProvider = options.resolveProvider ?? defaultRoleProviderResolver;
    this.log = options.log ?? (() => {});
  }

  /**
   * The provider bound to a role, resolved once and cached.
   *
   * Cached because a role's provider must be the SAME instance everywhere it is
   * used in one run: the independent judge also judges the cold-open tournament,
   * and two instances would split that role's accumulated usage across two
   * objects and make the observed-model record depend on which copy answered.
   */
  providerFor(role: SevenRole): LLMProvider {
    return this.binding(role).provider;
  }

  private binding(role: SevenRole): RoleProviderBinding {
    const cached = this.bindings.get(role);
    if (cached) return cached;
    const resolved = this.resolveProvider(role, SEVEN_ROLE_DEFINITIONS[role].llmRole);
    this.bindings.set(role, resolved);
    return resolved;
  }

  /** Run one role. Never throws: a failure becomes a recorded failed stage. */
  async run<T>(
    role: SevenRole,
    inputs: ArtifactRef[],
    fn: (provider: LLMProvider) => Promise<RoleStageOutput<T>>
  ): Promise<RoleStageOutcome<T>> {
    const def = SEVEN_ROLE_DEFINITIONS[role];
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    let binding: RoleProviderBinding | null = null;
    let bindingError: Error | null = null;
    try {
      binding = this.binding(role);
    } catch (err) {
      bindingError = err instanceof Error ? err : new Error(String(err));
    }

    const requested = requestedFor(def.llmRole, binding?.requested);
    const base = {
      role,
      order: def.order,
      label: def.label,
      llmRole: def.llmRole,
      required: def.required,
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      candidateChain: requested.chain,
      inputArtifacts: inputs,
      startedAt,
    };

    if (!binding) {
      const record: RoleStageRecord = {
        ...base,
        status: "failed",
        actualProvider: null,
        actualModel: null,
        modelObservation: "unobserved",
        fallbackFired: false,
        fallbackReason: null,
        fallbackCount: 0,
        outputArtifacts: [],
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        error: `Provider for role '${role}' could not be resolved: ${bindingError?.message}`,
        violations: [],
      };
      this.records.set(role, record);
      this.log(`[SevenRole] ${role}: FAILED to resolve a provider — ${bindingError?.message}`);
      return { ok: false, error: bindingError ?? new Error("provider unresolved"), record };
    }

    const mark = llmCostMark();
    let output: RoleStageOutput<T> | null = null;
    let thrown: Error | null = null;
    try {
      output = await withLlmStage(`seven-role:${role}`, () => fn(binding!.provider));
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }

    // Observe what actually ran. Provider self-report first (it is the provider
    // stating what it did); ledger second (a direct record of the HTTP call);
    // nothing third — and "nothing" is recorded as nothing.
    const report = reportsResolvedCall(binding.provider) ? binding.provider.lastResolvedCall() : null;
    const ledger = observeFromLedger(mark, def.llmRole);
    let actualProvider: string | null = null;
    let actualModel: string | null = null;
    let modelObservation: ModelObservationSource = "unobserved";
    let fallbackCount = 0;
    let reportedReason: string | null = null;

    if (report) {
      actualProvider = report.provider;
      actualModel = report.model;
      modelObservation = "provider_report";
      fallbackCount = report.fallbackCount ?? (report.fallbackFrom ? 1 : 0);
      reportedReason = report.fallbackReason ?? null;
    } else if (ledger) {
      actualProvider = ledger.provider;
      actualModel = ledger.model;
      modelObservation = "cost_ledger";
      fallbackCount = ledger.fallbackCount;
    }

    const diverged =
      actualProvider !== null &&
      actualModel !== null &&
      !(
        sameEndpoint(actualProvider, requested.provider) &&
        (sameEndpoint(actualModel, requested.model) ||
          requested.model === "(provider-default)" ||
          actualModel === "(provider-default)")
      );
    const fallbackFired = diverged || fallbackCount > 0;
    const fallbackReason = !fallbackFired
      ? null
      : reportedReason ??
        (diverged
          ? `Requested ${requested.provider}/${requested.model}; ` +
            `${actualProvider}/${actualModel} served the call` +
            (fallbackCount > 0
              ? ` after ${fallbackCount} earlier candidate(s) in the role chain failed.`
              : ` (the requested candidate did not serve it).`)
          : `${fallbackCount} earlier candidate(s) in the '${def.llmRole}' chain failed before the call was served.`);

    const record: RoleStageRecord = {
      ...base,
      status: thrown ? "failed" : "ok",
      actualProvider,
      actualModel,
      modelObservation,
      fallbackFired,
      fallbackReason,
      fallbackCount,
      outputArtifacts: output?.outputs ?? [],
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      error: thrown?.message,
      violations: output?.violations ?? [],
    };
    this.records.set(role, record);

    this.log(
      `[SevenRole] ${def.order}/7 ${role}: ${record.status} in ${record.durationMs}ms ` +
        `(requested ${requested.provider}/${requested.model}; actual ${actualProvider ?? "unobserved"}/${actualModel ?? "unobserved"}` +
        `${fallbackFired ? "; FALLBACK FIRED" : ""})` +
        `${record.violations.length ? `; ${record.violations.length} violation(s)` : ""}` +
        `${thrown ? `: ${thrown.message}` : ""}`
    );

    if (thrown) return { ok: false, error: thrown, record };
    return { ok: true, value: output!.value, record };
  }

  /** Record a role that never ran. Non-blocking by construction. */
  skip(role: SevenRole, reason: string): void {
    if (this.records.has(role)) return;
    const def = SEVEN_ROLE_DEFINITIONS[role];
    const now = new Date().toISOString();
    const requested = requestedFor(def.llmRole);
    this.records.set(role, {
      role,
      order: def.order,
      label: def.label,
      llmRole: def.llmRole,
      required: def.required,
      status: "skipped",
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      candidateChain: requested.chain,
      actualProvider: null,
      actualModel: null,
      modelObservation: "unobserved",
      fallbackFired: false,
      fallbackReason: null,
      fallbackCount: 0,
      inputArtifacts: [],
      outputArtifacts: [],
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      error: reason,
      violations: [],
    });
  }

  addViolation(violation: RoleViolation): void {
    this.extraViolations.push(violation);
  }

  /** Record a failure that belongs to the pipeline, not to a single role. */
  failPipeline(reason: string): void {
    this.pipelineError = reason;
    this.log(`[SevenRole] pipeline FAILED: ${reason}`);
  }

  finish(): void {
    this.finishedAt = new Date().toISOString();
  }

  get stageRecords(): RoleStageRecord[] {
    return SEVEN_ROLE_ORDER.map((role) => this.records.get(role)).filter(
      (r): r is RoleStageRecord => Boolean(r)
    );
  }

  get violations(): RoleViolation[] {
    return [...this.stageRecords.flatMap((r) => r.violations), ...this.extraViolations];
  }

  /** Required roles that failed. Non-empty means production must be held. */
  get holdingRoles(): SevenRole[] {
    return this.stageRecords.filter((r) => r.required && r.status === "failed").map((r) => r.role);
  }

  get allRequiredRolesOk(): boolean {
    return REQUIRED_SEVEN_ROLES.every((role) => this.records.get(role)?.status === "ok");
  }

  toTraceRecord(): SevenRoleTraceRecord {
    return {
      version: 1,
      pipeline: "seven_role",
      roles: this.stageRecords,
      requiredRoles: REQUIRED_SEVEN_ROLES,
      optionalRoles: OPTIONAL_SEVEN_ROLES,
      holdingRoles: this.holdingRoles,
      violations: this.violations,
      allRequiredRolesOk: this.allRequiredRolesOk,
      pipelineError: this.pipelineError,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  /**
   * The gate-compatible projection of the role trace.
   *
   * The editorial gate holds on `stages[].status === "failed"`, and that is the
   * only lever available without editing the gate. So:
   *
   *   required role failed  -> status "failed"   (holds — intended)
   *   optional role failed  -> status "skipped", and the detail says FAILED in
   *                            plain words plus the reason. The role trace still
   *                            records status "failed"; this projection changes
   *                            the BLOCKING signal, not the finding, and the UI
   *                            reads the trace.
   */
  compatStages(): NonNullable<ScriptPipelineProvenance["stages"]> {
    const stages: NonNullable<ScriptPipelineProvenance["stages"]> = this.stageRecords.map((r) => {
      const name = `seven_role:${r.role}`;
      if (r.status === "failed" && !r.required) {
        return {
          name,
          status: "skipped" as const,
          detail:
            `OPTIONAL role FAILED (${r.error || "no reason recorded"}) — recorded as non-blocking; ` +
            `see roleTrace for the full record.`,
        };
      }
      const bits: string[] = [];
      if (r.status === "failed") bits.push(r.error || "no reason recorded");
      if (r.status === "skipped") bits.push(r.error || "did not run");
      if (r.fallbackFired && r.fallbackReason) bits.push(`fallback: ${r.fallbackReason}`);
      if (r.violations.length) bits.push(`${r.violations.length} violation(s)`);
      return { name, status: r.status, detail: bits.length ? bits.join("; ") : undefined };
    });
    if (this.pipelineError) {
      stages.push({ name: "seven_role:pipeline", status: "failed", detail: this.pipelineError });
    }
    return stages;
  }

  /** Merge this trace into an existing provenance object, in place. */
  attachTo<T extends ScriptPipelineProvenance>(provenance: T): T & SevenRoleProvenance {
    const merged = provenance as T & SevenRoleProvenance;
    merged.stages = [...(provenance.stages || []), ...this.compatStages()];
    merged.roleTrace = this.toTraceRecord();
    return merged;
  }
}
