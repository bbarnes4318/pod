// Centralized role → provider/model resolution. THE ONLY place fallback order
// is decided; no service duplicates any part of this.
//
// RESOLUTION ORDER (spec order, one implementation):
//   1. explicit role override      <ROLE>_LLM_PROVIDER / <ROLE>_LLM_MODEL
//   2. selected profile primary
//   3. selected profile secondary
//   4. selected profile tertiary
//   5. role-appropriate EXISTING provider (LLM_* / SCRIPT_LLM_* / VERIFY_*)
//   6. fail clearly, naming every candidate and why each one failed
//
// LEGACY IS A BYPASS, NOT A CHAIN. With LLM_ROUTING_PROFILE=legacy (the default)
// and no role override set, getRoleLLMProvider() returns exactly the provider
// instance the old call site built — the same class, the same model resolution,
// the same construction-time errors, no wrapper, no retry layer, no fallback.
// That is what makes the one-variable rollback total.
//
// LOOP SAFETY: candidates are de-duplicated by provider/model before running, so
// an alias (a role override that happens to name the profile primary, or a
// legacy backup identical to the tertiary) can never make the chain re-run the
// same endpoint or cycle.

import { LLMProvider, GenerateStructuredOutputOptions, GenerateTextOptions, LLMUsage } from "./interface";
import { LLMRole, LegacyFamily, ROLE_DEFINITIONS, ALL_ROLES, roleDefinition } from "./roles";
import { RoutingProfile, activeRoutingProfile, profileChainFor } from "./profiles";
import { readRoutingEnv, roleOverrideKeys } from "./routingEnv";
import { LlmErrorCategory, LlmProviderError, categoryOf, describeFailure } from "./errors";
import { fallbackDecision, formatPaidFallbackAudit } from "./fallbackPolicy";
import { VerificationState, modelCapabilities, verificationState } from "./capabilities";
import { NVIDIA_DEFAULT_BASE_URL } from "./nvidia";
import { ZAI_DEFAULT_BASE_URL } from "./zai";
import { withLlmAttribution } from "./costLedger";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";
import { NvidiaNimLLMProvider } from "./nvidia";
import { ZaiLLMProvider } from "./zai";

export type CandidateSource =
  | "role_override"
  | "profile_primary"
  | "profile_secondary"
  | "profile_tertiary"
  | "legacy_backup";

export interface RoleCandidate {
  provider: string;
  /** undefined = let the provider apply its own default model. */
  model?: string;
  source: CandidateSource;
  /** Calling this costs money (Anthropic / OpenAI). */
  paid: boolean;
}

export interface RolePlan {
  role: LLMRole;
  profile: RoutingProfile;
  candidates: RoleCandidate[];
  /** Removed because LLM_ALLOW_LEGACY_FALLBACK is false. */
  suppressedPaid: RoleCandidate[];
  /** True when this plan is the untouched pre-feature behavior. */
  isLegacyBypass: boolean;
}

const PAID_PROVIDERS = new Set(["anthropic", "openai"]);

export function isPaidProvider(provider: string): boolean {
  return PAID_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Paid Anthropic/OpenAI fallback control.
 *
 * DEFAULT: FORBIDDEN. This is a deliberate change from "allowed by default",
 * and the reason is measurement integrity: while candidate models are being
 * evaluated, a quiet paid fallback makes a failing free model look like a
 * working one. The episode completes, the A/B table fills in, and the number you
 * end up trusting was produced by Anthropic. A comparison run must measure the
 * candidate or fail loudly.
 *
 *   LLM_ALLOW_LEGACY_FALLBACK=false   (default) COMPARISON MODE — a role that
 *                                     exhausts its free candidates fails, and the
 *                                     failure is the result.
 *   LLM_ALLOW_LEGACY_FALLBACK=true    RESILIENT MODE — for full-pipeline runs
 *                                     where finishing the episode matters more
 *                                     than isolating the candidate. Every paid
 *                                     call is logged with a full audit record.
 */
export function legacyFallbackAllowed(): boolean {
  const raw = (readRoutingEnv("LLM_ALLOW_LEGACY_FALLBACK") || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Did the operator set LLM_ALLOW_LEGACY_FALLBACK explicitly?
 *
 * Used only for CONFIGURATION failures: spending money to paper over a missing
 * key or a wrong model id needs a deliberate choice, never an inherited default.
 */
export function legacyFallbackExplicit(): boolean {
  return (readRoutingEnv("LLM_ALLOW_LEGACY_FALLBACK") || "").trim() !== "";
}

// ---------------------------------------------------------------- legacy config

/**
 * The existing grouped configuration, resolved EXACTLY as the current code does.
 *
 * - global: `getLLMProvider()` — LLM_PROVIDER, provider-default model.
 *   LLM_MODEL is honored here as the spec's documented global model variable;
 *   nothing in the repository sets it today, so honoring it cannot change an
 *   existing deployment.
 * - script: `getScriptLLMProvider()` — SCRIPT_LLM_PROVIDER > LLM_PROVIDER.
 * - verify: `resolveVerifyLLMConfig()` — VERIFY_LLM_PROVIDER > the fact-check
 *   chain (FACTCHECK_LLM_* > SCRIPT_LLM_* > LLM_PROVIDER), and VERIFY_MODEL >
 *   claude-sonnet-5 on Anthropic chains.
 */
export function resolveLegacyFamily(family: LegacyFamily): { provider: string; model?: string } {
  if (family === "global") {
    return {
      provider: (readRoutingEnv("LLM_PROVIDER") || "stub").toLowerCase(),
      model: readRoutingEnv("LLM_MODEL"),
    };
  }
  if (family === "script") {
    return {
      provider: (readRoutingEnv("SCRIPT_LLM_PROVIDER") || readRoutingEnv("LLM_PROVIDER") || "stub").toLowerCase(),
      model: readRoutingEnv("SCRIPT_LLM_MODEL"),
    };
  }
  // verify — mirrors resolveFactCheckLLMConfig() then resolveVerifyLLMConfig().
  let base: { provider: string; model?: string };
  if (readRoutingEnv("FACTCHECK_LLM_PROVIDER")) {
    base = {
      provider: readRoutingEnv("FACTCHECK_LLM_PROVIDER")!.toLowerCase(),
      model: readRoutingEnv("FACTCHECK_LLM_MODEL"),
    };
  } else if (readRoutingEnv("SCRIPT_LLM_PROVIDER")) {
    base = {
      provider: readRoutingEnv("SCRIPT_LLM_PROVIDER")!.toLowerCase(),
      model: readRoutingEnv("SCRIPT_LLM_MODEL"),
    };
  } else {
    base = { provider: (readRoutingEnv("LLM_PROVIDER") || "stub").toLowerCase(), model: undefined };
  }
  const provider = (readRoutingEnv("VERIFY_LLM_PROVIDER") || base.provider).toLowerCase();
  const model =
    readRoutingEnv("VERIFY_MODEL") || (provider === "anthropic" ? "claude-sonnet-5" : base.model);
  return { provider, model };
}

// ---------------------------------------------------------------- plan building

function roleOverride(role: LLMRole): RoleCandidate | null {
  const { providerKey, modelKey } = roleOverrideKeys(role);
  const provider = readRoutingEnv(providerKey);
  if (!provider) return null;
  return {
    provider: provider.trim().toLowerCase(),
    model: readRoutingEnv(modelKey),
    source: "role_override",
    paid: isPaidProvider(provider),
  };
}

const PROFILE_SOURCES: CandidateSource[] = ["profile_primary", "profile_secondary", "profile_tertiary"];

/** Resolve the full ordered candidate chain for a role. */
export function resolveRolePlan(role: LLMRole, profileOverride?: RoutingProfile): RolePlan {
  const def = roleDefinition(role);
  const profile = profileOverride ?? activeRoutingProfile();
  const override = roleOverride(role);

  // The rollback contract: legacy profile with no override is the old code path.
  if (profile === "legacy" && !override) {
    const legacy = resolveLegacyFamily(def.legacyRollback);
    return {
      role,
      profile,
      candidates: [
        { provider: legacy.provider, model: legacy.model, source: "legacy_backup", paid: isPaidProvider(legacy.provider) },
      ],
      suppressedPaid: [],
      isLegacyBypass: true,
    };
  }

  const raw: RoleCandidate[] = [];
  if (override) raw.push(override);

  profileChainFor(profile, role).forEach((ref, i) => {
    raw.push({
      provider: ref.provider,
      model: ref.model,
      source: PROFILE_SOURCES[Math.min(i, PROFILE_SOURCES.length - 1)],
      paid: isPaidProvider(ref.provider),
    });
  });

  // Rung 5: the role-APPROPRIATE existing provider. Never the verifier as the
  // first creative-writing fallback, and never a creative configuration for
  // fact-checking — roles.ts decides which family that is per role.
  const backup = resolveLegacyFamily(def.legacyBackup);
  raw.push({
    provider: backup.provider,
    model: backup.model,
    source: "legacy_backup",
    paid: isPaidProvider(backup.provider),
  });

  // De-duplicate by TRUE ENDPOINT IDENTITY — provider + normalized base URL +
  // model. Provider/model alone was not endpoint identity: with custom base URLs
  // two candidates can name the same provider and model while pointing at
  // different services (and, conversely, an alias can reach the same service).
  // Keying on the endpoint is what actually makes a loop impossible.
  const seen = new Set<string>();
  const deduped: RoleCandidate[] = [];
  for (const c of raw) {
    const key = endpointIdentity(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Paid gate: applies to fallback rungs only. An explicit role override IS the
  // operator's decision, so it is never suppressed.
  const allowPaid = legacyFallbackAllowed();
  const candidates: RoleCandidate[] = [];
  const suppressedPaid: RoleCandidate[] = [];
  for (const c of deduped) {
    if (!allowPaid && c.paid && c.source !== "role_override") {
      suppressedPaid.push(c);
      continue;
    }
    candidates.push(c);
  }

  return { role, profile, candidates, suppressedPaid, isLegacyBypass: false };
}

/** Display label for a candidate: `provider/model`. Not an identity key. */
export function candidateKey(c: { provider: string; model?: string }): string {
  return `${c.provider}/${c.model ?? "(provider-default)"}`.toLowerCase();
}

/** Where a provider's requests actually go, normalized for comparison. */
export function normalizedBaseUrl(provider: string): string {
  const p = provider.toLowerCase();
  const raw =
    p === "nvidia"
      ? readRoutingEnv("NVIDIA_BASE_URL") || NVIDIA_DEFAULT_BASE_URL
      : p === "zai"
      ? readRoutingEnv("ZAI_BASE_URL") || ZAI_DEFAULT_BASE_URL
      : p === "anthropic"
      ? "https://api.anthropic.com/v1"
      : p === "openai"
      ? "https://api.openai.com/v1"
      : "(none)";
  // Normalize so trailing slashes, case and a default port cannot make one
  // endpoint look like two.
  try {
    const u = new URL(raw);
    const port = u.port && u.port !== (u.protocol === "https:" ? "443" : "80") ? `:${u.port}` : "";
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * TRUE endpoint identity: provider + normalized base URL + model.
 *
 * Two candidates with this key equal are the same HTTP call to the same service
 * for the same model, however they were spelled. This is the key the chain
 * de-duplicates on, so no alias can make the router attempt one endpoint twice
 * or cycle between two names for it.
 */
export function endpointIdentity(c: { provider: string; model?: string }): string {
  return [
    c.provider.toLowerCase(),
    normalizedBaseUrl(c.provider),
    (c.model ?? "(provider-default)").toLowerCase(),
  ].join("|");
}

// ---------------------------------------------------------------- instantiation

/** Build a concrete provider. Registered providers only — never a guess. */
export function instantiateProvider(provider: string, model?: string): LLMProvider {
  switch (provider.toLowerCase()) {
    case "nvidia":
      return new NvidiaNimLLMProvider(model);
    case "zai":
      return new ZaiLLMProvider(model);
    case "anthropic":
      return new AnthropicLLMProvider(model);
    case "openai":
      return new OpenAILLMProvider(model);
    case "stub":
      return new StubLLMProvider();
    default:
      // A provider name nothing can build is a configuration/programming defect,
      // not something another model fixes — it stops the chain.
      throw new LlmProviderError({
        provider,
        model: model || "(default)",
        category: "programming_error",
        message:
          `[LLMRouting] Unknown provider '${provider}'. Supported: nvidia, zai, anthropic, openai, stub.`,
      });
  }
}

// ---------------------------------------------------------------- routed provider

/**
 * Runs a role's candidate chain. One instance per role per caller, so its
 * accumulated usage covers every model it actually used — the self-verify token
 * delta in scriptService stays meaningful across a fallback.
 */
export class RoutedLLMProvider implements LLMProvider {
  readonly name: string;
  private readonly plan: RolePlan;
  private readonly instances = new Map<string, LLMProvider>();

  constructor(plan: RolePlan) {
    this.plan = plan;
    this.name = `role:${plan.role}`;
  }

  get rolePlan(): RolePlan {
    return this.plan;
  }

  getAccumulatedUsage(): LLMUsage {
    const total: LLMUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    for (const p of this.instances.values()) {
      const u = typeof p.getAccumulatedUsage === "function" ? p.getAccumulatedUsage() : null;
      if (!u) continue;
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.requestCount += u.requestCount;
      total.reasoningTokens = (total.reasoningTokens || 0) + (u.reasoningTokens || 0);
      total.cachedInputTokens = (total.cachedInputTokens || 0) + (u.cachedInputTokens || 0);
    }
    return total;
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    return this.run(options, (p, o) => p.generateText(o));
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    return this.run(options, (p, o) => p.generateStructuredOutput<T>(o as GenerateStructuredOutputOptions));
  }

  /** Apply the role's parameter posture without overriding an explicit caller value. */
  private withRoleDefaults<T extends GenerateTextOptions>(options: T): T {
    const def = ROLE_DEFINITIONS[this.plan.role];
    return {
      ...options,
      reasoning: options.reasoning ?? def.reasoning,
      temperature: options.temperature ?? def.temperature,
    };
  }

  /**
   * Run the chain, consulting the FALLBACK POLICY after every failure.
   *
   * The old loop advanced after any caught error. That buried real defects (a bad
   * application schema failed identically on four providers before surfacing) and
   * it spent money quietly (a configuration mistake walked into the paid provider
   * and the episode "succeeded"). Now the failure's CATEGORY decides, and when it
   * says stop, the first failure is what the caller sees.
   */
  private async run<T>(
    options: GenerateStructuredOutputOptions | GenerateTextOptions,
    invoke: (p: LLMProvider, o: any) => Promise<T>
  ): Promise<T> {
    const opts = this.withRoleDefaults(options as GenerateStructuredOutputOptions);
    const failures: string[] = [];
    const categories: LlmErrorCategory[] = [];
    const failedFree: string[] = [];
    const policyCtx = {
      paidFallbackAllowed: legacyFallbackAllowed(),
      paidFallbackExplicit: legacyFallbackExplicit(),
    };
    let fallbacks = 0;
    let stoppedEarly: { error: unknown; reason: string } | null = null;

    for (let i = 0; i < this.plan.candidates.length; i++) {
      const candidate = this.plan.candidates[i];
      const next = this.plan.candidates[i + 1];
      const key = candidateKey(candidate);
      const identity = endpointIdentity(candidate);

      let provider: LLMProvider;
      try {
        provider =
          this.instances.get(identity) ?? instantiateProvider(candidate.provider, candidate.model);
        this.instances.set(identity, provider);
      } catch (err) {
        // Construction failures are configuration failures (a missing key, an
        // unbuildable provider). They go through the same policy — including the
        // rule that a config failure may not silently cross into a paid provider.
        const decision = fallbackDecision(err, candidate, next, policyCtx);
        failures.push(`${key} [${candidate.source}] not usable: ${describeFailure(err)}`);
        categories.push(decision.category);
        if (!candidate.paid) failedFree.push(key);
        console.warn(`[LLMRouting] role=${this.plan.role} ${decision.reason}`);
        // Only a decision that DECLINED an available candidate is "stopping
        // early". Running out of candidates is exhaustion, and gets the
        // exhaustion message below with the whole list.
        if (decision.verdict === "stop" && next) {
          stoppedEarly = { error: err, reason: decision.reason };
          break;
        }
        fallbacks++;
        continue;
      }

      // Paid calls are audited BEFORE they happen, with the whole story: which
      // free candidates failed, with which categories, and why this was allowed.
      if (candidate.paid && candidate.source !== "role_override" && fallbacks > 0) {
        console.warn(
          formatPaidFallbackAudit({
            role: this.plan.role,
            failedFreeCandidates: failedFree,
            failureCategories: categories.map(String),
            paidProvider: candidate.provider,
            paidModel: candidate.model ?? "(provider-default)",
            reasonPermitted: policyCtx.paidFallbackExplicit
              ? "LLM_ALLOW_LEGACY_FALLBACK=true was set explicitly (resilient mode)"
              : "LLM_ALLOW_LEGACY_FALLBACK is true",
          })
        );
      }

      try {
        return await withLlmAttribution(
          {
            role: this.plan.role,
            profile: this.plan.profile,
            candidateSource: candidate.source,
            fallbacks,
          },
          () => invoke(provider, opts)
        );
      } catch (err) {
        const decision = fallbackDecision(err, candidate, next, policyCtx);
        failures.push(`${key} [${candidate.source}] failed (${decision.category}): ${describeFailure(err)}`);
        categories.push(decision.category);
        if (!candidate.paid) failedFree.push(key);
        console.warn(`[LLMRouting] role=${this.plan.role} ${decision.reason}`);
        if (decision.verdict === "stop" && next) {
          stoppedEarly = { error: err, reason: decision.reason };
          break;
        }
        fallbacks++;
      }
    }

    const suppressed = this.plan.suppressedPaid.length
      ? ` Paid fallback is DISABLED (LLM_ALLOW_LEGACY_FALLBACK=${
          readRoutingEnv("LLM_ALLOW_LEGACY_FALLBACK") ?? "unset, default false"
        }), which suppressed: ${this.plan.suppressedPaid.map(candidateKey).join(", ")}. ` +
        `That is comparison mode working as intended — the candidate failed and was not quietly rescued.`
      : "";

    if (stoppedEarly) {
      // Preserve the original error's category. Re-labelling a safety refusal or
      // a schema defect as a generic routing failure is how the actual cause gets
      // lost between here and the job log.
      const original = stoppedEarly.error;
      const category = categoryOf(original);
      throw new LlmProviderError({
        provider: original instanceof LlmProviderError ? original.provider : "routing",
        model: original instanceof LlmProviderError ? original.model : this.plan.role,
        category,
        message:
          `[LLMRouting] Role '${this.plan.role}' STOPPED at ${failures.length} candidate(s) under profile ` +
          `'${this.plan.profile}'. ${stoppedEarly.reason}\n  - ${failures.join("\n  - ")}${suppressed}`,
        cause: original,
      });
    }

    throw new LlmProviderError({
      provider: "routing",
      model: this.plan.role,
      category: categories[categories.length - 1] ?? "unknown",
      message:
        `[LLMRouting] Every candidate for role '${this.plan.role}' failed under profile ` +
        `'${this.plan.profile}':\n  - ${failures.join("\n  - ")}${suppressed}`,
    });
  }
}

// ---------------------------------------------------------------- public entry

/**
 * The provider for one role.
 *
 * Legacy profile with no role override returns the plain provider the old code
 * built — same class, same eager construction, same errors. Any other
 * configuration returns the routed chain.
 */
export function getRoleLLMProvider(role: LLMRole, profileOverride?: RoutingProfile): LLMProvider {
  const plan = resolveRolePlan(role, profileOverride);
  if (plan.isLegacyBypass) {
    const only = plan.candidates[0];
    return instantiateProvider(only.provider, only.model);
  }
  return new RoutedLLMProvider(plan);
}

// ---------------------------------------------------------------- challenger

export interface ScriptChallenger {
  provider: LLMProvider;
  label: string;
}

/**
 * The optional second dialogue model for a development comparison run.
 *
 *   SCRIPT_CHALLENGER_ENABLED=true
 *   SCRIPT_CHALLENGER_PROVIDER=nvidia
 *   SCRIPT_CHALLENGER_MODEL=moonshotai/kimi-k2.6
 *
 * OFF unless explicitly enabled, and never able to break generation: a
 * misconfigured challenger logs and returns null rather than failing an episode.
 * Its output is scored and stored separately — the winner is chosen by the
 * configured comparison process, never by mixing two models' movements into one
 * episode.
 */
export function resolveScriptChallenger(): ScriptChallenger | null {
  if ((readRoutingEnv("SCRIPT_CHALLENGER_ENABLED") || "").trim().toLowerCase() !== "true") return null;

  const provider = (readRoutingEnv("SCRIPT_CHALLENGER_PROVIDER") || "").trim();
  const model = readRoutingEnv("SCRIPT_CHALLENGER_MODEL");
  if (!provider) {
    console.warn(
      "[LLMRouting] SCRIPT_CHALLENGER_ENABLED=true but SCRIPT_CHALLENGER_PROVIDER is unset — no challenger run."
    );
    return null;
  }
  try {
    return {
      provider: instantiateProvider(provider, model),
      label: model ? `${provider.toLowerCase()}/${model}` : provider.toLowerCase(),
    };
  } catch (err) {
    console.warn(`[LLMRouting] Challenger ${provider}/${model ?? "(default)"} unavailable: ${describeFailure(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------- reporting

export interface RoleRouteReport {
  role: LLMRole;
  label: string;
  profile: RoutingProfile;
  primary: string;
  secondary: string;
  tertiary: string;
  legacyBackup: string;
  /** Rung 1, when an operator set one. */
  override: string | null;
  candidates: {
    key: string;
    source: CandidateSource;
    paid: boolean;
    /** True endpoint identity (provider|normalizedBaseUrl|model). */
    endpoint: string;
    /** Model ID confirmed against the provider's official catalog. */
    catalogVerified: boolean;
    /** Successfully called from this repository with the current adapter. */
    liveContractVerified: boolean;
    /** The three readiness states, already resolved. */
    verification: VerificationState;
  }[];
  suppressedPaid: string[];
  /** "ready" | "degraded" | "unroutable" | "not-wired" */
  status: "ready" | "degraded" | "unroutable" | "not-wired";
  /** Why the status is not "ready". */
  notes: string[];
  hasCallSite: boolean;
}

/**
 * Resolved role map for the readiness surfaces. Reports credential presence and
 * whether a model's capability record is still an unverified declaration —
 * never a credential value.
 */
export function roleRouteReport(profileOverride?: RoutingProfile): RoleRouteReport[] {
  return ALL_ROLES.map((role) => {
    const def = ROLE_DEFINITIONS[role];
    const plan = resolveRolePlan(role, profileOverride);
    const notes: string[] = [];

    const byS = (s: CandidateSource) => plan.candidates.filter((c) => c.source === s).map(candidateKey);
    const usable = plan.candidates.filter((c) => providerCredentialPresent(c.provider));
    const unusable = plan.candidates.filter((c) => !providerCredentialPresent(c.provider));

    for (const c of unusable) {
      notes.push(`${candidateKey(c)} (${c.source}) has no usable credential — set ${credentialVarFor(c.provider)}.`);
    }
    if (plan.suppressedPaid.length) {
      notes.push(
        `Paid fallback disabled: ${plan.suppressedPaid.map(candidateKey).join(", ")} will not be called.`
      );
    }
    // Catalog verification and LIVE verification are separate claims, reported
    // separately. A catalog-verified model can still have entirely unverified
    // request parameters, and conflating the two is what let "verified" mean
    // nothing useful.
    const catalogOnly = plan.candidates.filter((c) => {
      if (!c.model) return false;
      const caps = modelCapabilities(c.provider, c.model);
      return caps.catalogVerified && !caps.liveContractVerified;
    });
    const notInCatalog = plan.candidates.filter(
      (c) => c.model && !modelCapabilities(c.provider, c.model).catalogVerified
    );
    if (catalogOnly.length) {
      notes.push(
        `Catalog verified, LIVE CONTRACT UNTESTED (request parameters unconfirmed from this repo): ` +
          `${catalogOnly.map(candidateKey).join(", ")}. Run \`npm run probe:llm-contract\`.`
      );
    }
    if (notInCatalog.length) {
      notes.push(
        `Catalog/model unavailable — ID not confirmed against the provider catalog: ` +
          `${notInCatalog.map(candidateKey).join(", ")}.`
      );
    }
    if (def.callSites.length === 0) {
      notes.push("No LLM call site yet — this responsibility is deterministic in the current pipeline.");
    }

    const status: RoleRouteReport["status"] =
      def.callSites.length === 0
        ? "not-wired"
        : usable.length === 0
        ? "unroutable"
        : unusable.length > 0 || plan.suppressedPaid.length > 0
        ? "degraded"
        : "ready";

    return {
      role,
      label: def.label,
      profile: plan.profile,
      primary: byS("profile_primary")[0] ?? (plan.isLegacyBypass ? candidateKey(plan.candidates[0]) : "—"),
      secondary: byS("profile_secondary")[0] ?? "—",
      tertiary: byS("profile_tertiary")[0] ?? "—",
      legacyBackup: byS("legacy_backup")[0] ?? "—",
      override: byS("role_override")[0] ?? null,
      candidates: plan.candidates.map((c) => {
        const caps = modelCapabilities(c.provider, c.model ?? "");
        return {
          key: candidateKey(c),
          source: c.source,
          paid: c.paid,
          endpoint: endpointIdentity(c),
          catalogVerified: caps.catalogVerified,
          liveContractVerified: caps.liveContractVerified,
          verification: verificationState(caps),
        };
      }),
      suppressedPaid: plan.suppressedPaid.map(candidateKey),
      status,
      notes,
      hasCallSite: def.callSites.length > 0,
    };
  });
}

/** Which variable holds a provider's credential. Names only — never values. */
export function credentialVarFor(provider: string): string {
  switch (provider.toLowerCase()) {
    case "nvidia":
      return "NVIDIA_API_KEY";
    case "zai":
      return "ZAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    default:
      return "(none required)";
  }
}

/** Is a usable (non-placeholder) credential present for this provider? */
export function providerCredentialPresent(provider: string): boolean {
  if (provider.toLowerCase() === "stub") return true;
  const v = (readRoutingEnv(credentialVarFor(provider)) || "").trim();
  if (!v) return false;
  if (/^(your|set|paste|change)[-_ ]/i.test(v)) return false;
  if (v.toUpperCase() === "SET_IN_SECRET_MANAGER" || v.toUpperCase() === "SET_IN_COOLIFY_ONLY") return false;
  return true;
}

/**
 * Does this role have any candidate that is a REAL provider (not stub)?
 *
 * Call sites that legitimately skip the model entirely — the heuristic topic
 * classifier, the deterministic show-notes builder — must ask this instead of
 * reading LLM_PROVIDER directly, or they would fall back to their heuristic
 * whenever a profile routes the role somewhere other than the global provider.
 * In the legacy profile the answer is identical to the old LLM_PROVIDER check.
 */
export function roleHasRealProvider(role: LLMRole, profileOverride?: RoutingProfile): boolean {
  return resolveRolePlan(role, profileOverride).candidates.some(
    (c) => c.provider.toLowerCase() !== "stub"
  );
}

/**
 * Human label for what a role will actually call, for job logs and gate
 * summaries. Credential-free. In the legacy profile this is exactly the
 * `provider/model` string the old code logged.
 */
export function roleProviderLabel(role: LLMRole, profileOverride?: RoutingProfile): string {
  const plan = resolveRolePlan(role, profileOverride);
  const first = plan.candidates[0];
  if (!first) return "(no candidate)";
  const head = first.model ? `${first.provider}/${first.model}` : first.provider;
  const rest = plan.candidates.length - 1;
  return rest > 0 ? `${head} (+${rest} fallback${rest === 1 ? "" : "s"})` : head;
}

/** Every provider the active profile would actually call (for stage advisories). */
export function providersInActiveRouting(profileOverride?: RoutingProfile): string[] {
  const set = new Set<string>();
  for (const role of ALL_ROLES) {
    if (ROLE_DEFINITIONS[role].callSites.length === 0) continue;
    for (const c of resolveRolePlan(role, profileOverride).candidates) set.add(c.provider);
  }
  return [...set];
}
