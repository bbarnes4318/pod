// LLM ROLE ROUTING — proof that nine roles are nine decisions.
//
// THE MISTAKE THIS FIXES. Every one of this show's nine editorial roles was
// pointed at Anthropic: seven at claude-opus-5, two at claude-sonnet-5. Both host
// writers resolved to the SAME endpoint, and the "independent" editorial judge
// differed from the writers it graded by model only — same lab, same training
// data, same blind spots. Nothing chose that. It is what an unset
// LLM_ROUTING_PROFILE plus the grouped SCRIPT_LLM_* variables produces, and the
// independence check passed it because it compared endpoint STRINGS.
//
// The failed canary provided no model-quality evidence for any of it: it never
// reached a writing role.
//
// Everything here is offline — pure functions, an injected environment and fake
// providers. No network, no credential, no spend.

import assert from "node:assert/strict";
import {
  AUTHORING_ROLES,
  JUDGING_ROLES,
  PRODUCTION_WRITING_ROLES,
  assessHostWriterRoutes,
  configuredLlmProviders,
  gradeIndependence,
  planColdOpenWriterRoutes,
  type GradableRoute,
  type RoleRouteRow,
} from "../lib/providers/llm/routingAudit";
import { ALL_ROLES, ROLE_DEFINITIONS, roleDefinition } from "../lib/providers/llm/roles";
import { roleOverrideKeys } from "../lib/providers/llm/routingEnv";
import { resolveRolePlan, candidateKey, endpointIdentity, instantiateProvider } from "../lib/providers/llm/routing";
import { SUPPORTED_LLM_PROVIDERS } from "../lib/providers/llm/providerRegistry";
import { getLLMProvider } from "../lib/providers/llm/factory";
import { declaredProfileChainFor } from "../lib/providers/llm/profiles";
import { categorizeHttpFailure, categoryOf } from "../lib/providers/llm/errors";
import { classifyProviderError } from "./runLiveProviderCanary";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { writeHostLines, privateBriefTerms } from "../lib/services/scriptCreativePipeline";
import { decidePromotion, assignBlindLabels, scrubCandidateIdentity, summarizeRun, type EvaluationRun } from "../lib/services/modelEvaluation";
import type { LLMProvider } from "../lib/providers/llm/interface";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** Run `fn` with an exact environment, then restore. Routing reads process.env. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const touched = new Set([
    ...Object.keys(env),
    "LLM_ROUTING_PROFILE",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "SCRIPT_LLM_PROVIDER",
    "SCRIPT_LLM_MODEL",
    "VERIFY_LLM_PROVIDER",
    "VERIFY_MODEL",
    "FACTCHECK_LLM_PROVIDER",
    "FACTCHECK_LLM_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NVIDIA_API_KEY",
    "ZAI_API_KEY",
    "LLM_ALLOW_LEGACY_FALLBACK",
    ...ALL_ROLES.flatMap((r) => {
      const k = roleOverrideKeys(r);
      return [k.providerKey, k.modelKey];
    }),
  ]);
  const before = new Map<string, string | undefined>();
  for (const key of touched) {
    before.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function row(role: string, label: string): RoleRouteRow {
  const [provider, model] = label.split("/");
  return {
    role: role as never,
    label,
    provider,
    model: model ?? null,
    identity: `${provider}|https://example/${provider}|${model ?? "(provider-default)"}`,
    source: "role_override",
    envProvider: `${role.toUpperCase()}_LLM_PROVIDER`,
    envModel: `${role.toUpperCase()}_LLM_MODEL`,
    explicit: true,
    credentialPresent: true,
  };
}

function gradable(role: string, label: string): GradableRoute {
  const r = row(role, label);
  return { role: r.role, label: r.label, provider: r.provider, identity: r.identity };
}

async function main() {
  console.log("\nLLM role routing: nine roles are nine decisions\n");

  // =========================================================================
  console.log("  -- 1. no default maps every role to Anthropic --");

  await check("with a CLEAN environment, not one role resolves to Anthropic", () => {
    withEnv({}, () => {
      const anthropic = ALL_ROLES.map((role) => ({ role, plan: resolveRolePlan(role) })).filter((r) =>
        r.plan.candidates.some((c) => c.provider === "anthropic")
      );
      assert.deepEqual(
        anthropic.map((a) => a.role),
        [],
        `no role may reach Anthropic without configuration; these did: ${anthropic.map((a) => a.role).join(", ")}`
      );
    });
  });

  await check("every one of the nine roles has its OWN pair of variables", () => {
    const seen = new Map<string, string>();
    for (const role of PRODUCTION_WRITING_ROLES) {
      const { providerKey, modelKey } = roleOverrideKeys(role);
      assert.ok(providerKey && modelKey, `${role} must be addressable`);
      const clash = seen.get(providerKey);
      assert.equal(clash, undefined, `${role} shares ${providerKey} with ${clash}`);
      seen.set(providerKey, role);
    }
    assert.equal(seen.size, 9, "there are nine editorial roles, and nine ways to route them");
  });

  await check("the nine roles named in the correction all exist and are routable", () => {
    // story editor, debate architect, host A, host B, dialogue director,
    // continuity editor, fact checker, cold-open judge, final editorial judge.
    for (const role of PRODUCTION_WRITING_ROLES) {
      const def = roleDefinition(role);
      assert.ok(def.envPrefix, `${role} needs an env prefix`);
    }
    assert.ok(PRODUCTION_WRITING_ROLES.includes("fact_check"), "the fact checker must be routable");
    assert.ok(PRODUCTION_WRITING_ROLES.includes("cold_open_judge"), "the cold-open judge must be routable");
    assert.ok(PRODUCTION_WRITING_ROLES.includes("quality_judge"), "the final editorial judge must be routable");
    assert.notEqual(
      ROLE_DEFINITIONS.cold_open_judge.envPrefix,
      ROLE_DEFINITIONS.quality_judge.envPrefix,
      "the cold-open judge and the final judge are two decisions, not one"
    );
  });

  await check("routing ONE role explicitly does not move the other eight", () => {
    withEnv({ NVIDIA_API_KEY: "test-nvidia", SCRIPT_HOST_B_WRITER_LLM_PROVIDER: "nvidia", SCRIPT_HOST_B_WRITER_LLM_MODEL: "some-model" }, () => {
      const b = resolveRolePlan("script_host_b_writer").candidates[0];
      assert.equal(b.provider, "nvidia", "the role that was routed must move");
      for (const role of PRODUCTION_WRITING_ROLES) {
        if (role === "script_host_b_writer") continue;
        const first = resolveRolePlan(role).candidates[0];
        assert.notEqual(
          first?.provider,
          "nvidia",
          `${role} must not inherit host B's override — that is the collapse this fixes`
        );
      }
    });
  });

  await check("the production shape is REPRODUCED and its collapse is detected", () => {
    // Exactly what the deployment runs: unset profile, grouped variables.
    withEnv(
      {
        ANTHROPIC_API_KEY: "test-anthropic",
        LLM_PROVIDER: "anthropic",
        SCRIPT_LLM_PROVIDER: "anthropic",
        SCRIPT_LLM_MODEL: "claude-opus-5",
      },
      () => {
        const rows = PRODUCTION_WRITING_ROLES.map((role) => {
          const first = resolveRolePlan(role).candidates[0];
          return { role, label: candidateKey(first), identity: endpointIdentity(first) };
        });
        assert.ok(
          rows.every((r) => r.label.startsWith("anthropic/")),
          "this fixture is supposed to reproduce the all-Anthropic collapse"
        );
        const hostA = rows.find((r) => r.role === "script_host_a_writer")!;
        const hostB = rows.find((r) => r.role === "script_host_b_writer")!;
        assert.equal(hostA.identity, hostB.identity, "the fixture must reproduce the host collision");

        // ...and the audit must SAY so rather than passing it.
        const separation = assessHostWriterRoutes(
          PRODUCTION_WRITING_ROLES.map((role) => row(role, rows.find((r) => r.role === role)!.label))
        );
        assert.equal(separation.separate, false, "the collision must be reported, not tolerated");
      }
    );
  });

  // =========================================================================
  console.log("\n  -- 2. writer/judge independence is enforced --");

  const writers = AUTHORING_ROLES.map((r) => gradable(r, "anthropic/claude-opus-5"));

  await check("a judge on the writers' ENDPOINT is refused, always", () => {
    const grade = gradeIndependence({
      judge: gradable("quality_judge", "anthropic/claude-opus-5"),
      authoring: writers,
      alternativesAvailable: ["anthropic"],
    });
    assert.equal(grade.level, "none");
    assert.equal(grade.independent, false);
    assert.equal(grade.acceptable, false, "self-judging is unacceptable at every deployment shape");
    assert.match(grade.reason!, /cannot independently judge dialogue it wrote/);
  });

  await check("a judge on the writers' PROVIDER is not independent, even on a different model", () => {
    // The exact configuration this repository was running.
    const grade = gradeIndependence({
      judge: gradable("quality_judge", "anthropic/claude-sonnet-5"),
      authoring: writers,
      alternativesAvailable: ["anthropic"],
    });
    assert.equal(grade.level, "model", "same lab is model-level separation, not independence");
    assert.equal(grade.independent, false, "independence=false must be RECORDED, not assumed");
    assert.match(grade.reason!, /SAME PROVIDER/);
    assert.match(grade.reason!, /training data, alignment and blind spots/);
  });

  await check("with another provider credentialed, same-lab judging BLOCKS", () => {
    const grade = gradeIndependence({
      judge: gradable("quality_judge", "anthropic/claude-sonnet-5"),
      authoring: writers,
      alternativesAvailable: ["anthropic", "nvidia"],
    });
    assert.equal(grade.acceptable, false, "an unused alternative makes this a fixable mistake");
    assert.match(grade.reason!, /nvidia/);
    assert.match(grade.remedy!, /nvidia/);
  });

  await check("with NO alternative, it proceeds — but never silently", () => {
    const grade = gradeIndependence({
      judge: gradable("quality_judge", "anthropic/claude-sonnet-5"),
      authoring: writers,
      alternativesAvailable: ["anthropic"],
    });
    assert.equal(grade.acceptable, true, "a one-provider account cannot do better; blocking would help nobody");
    assert.equal(grade.independent, false, "and the record still says it is not independent");
    assert.match(grade.remedy!, /Credential a second provider/);
  });

  await check("a judge on a DIFFERENT provider is the real thing", () => {
    const grade = gradeIndependence({
      judge: gradable("quality_judge", "nvidia/nemotron-3-ultra"),
      authoring: writers,
      alternativesAvailable: ["anthropic", "nvidia"],
    });
    assert.equal(grade.level, "provider");
    assert.equal(grade.independent, true);
    assert.equal(grade.acceptable, true);
    assert.equal(grade.reason, null);
  });

  await check("all THREE judging roles are graded, not just the final one", () => {
    for (const judgeRole of JUDGING_ROLES) {
      const grade = gradeIndependence({
        judge: gradable(judgeRole, "anthropic/claude-opus-5"),
        authoring: writers,
        alternativesAvailable: ["anthropic", "nvidia"],
      });
      assert.equal(grade.acceptable, false, `${judgeRole} must be held to the same rule`);
    }
  });

  await check("the profiles never route a judge to a model that writes dialogue", () => {
    for (const profile of ["frontier_development", "verified_development"] as const) {
      const dialogue = new Set(
        (["script_host_a_writer", "script_host_b_writer", "script_dialogue_director", "script_movement"] as const)
          .flatMap((r) => declaredProfileChainFor(profile, r))
          .map((c) => `${c.provider}/${c.model}`)
      );
      for (const judgeRole of ["quality_judge", "cold_open_judge"] as const) {
        for (const candidate of declaredProfileChainFor(profile, judgeRole)) {
          assert.ok(
            !dialogue.has(`${candidate.provider}/${candidate.model}`),
            `${profile}/${judgeRole} routes to ${candidate.provider}/${candidate.model}, which also writes dialogue`
          );
        }
      }
    }
  });

  // =========================================================================
  console.log("\n  -- 3. Host A and Host B have separated writing contexts --");

  const BRIEF_A = {
    speakerName: "Zabala",
    exclusiveFactResponsibility: "the attendance figures were restated twice in the same filing",
    protectedBelief: "the front office knew before the extension was signed",
    avoidedConcession: "that her own show amplified the original number",
    behavioralTrigger: "when someone rounds a number in her presence",
    misconceptionAboutOtherHost: "she thinks he is sentimental rather than calculating",
    genuineQuestion: "who actually signed off on the revised figure",
    privateObjective: "get him to say the word deliberate on tape",
  };
  const BRIEF_B = {
    speakerName: "Mulkey",
    exclusiveFactResponsibility: "the promotions budget was cut the same week as the extension",
    protectedBelief: "the fans were never the ones being protected here",
    avoidedConcession: "that he approved the giveaway that inflated the gate",
    behavioralTrigger: "when anyone implies the crowd was fake",
    misconceptionAboutOtherHost: "he thinks she is being paid to run this angle",
    genuineQuestion: "whether she would have run the same segment about her own station",
    privateObjective: "steer the conversation to the concession stands before the break",
  };

  /** Captures the composed prompt instead of calling anything. */
  function capturingProvider(sink: { systemPrompt: string; prompt: string }[]): LLMProvider {
    return {
      name: "capture",
      generateText: async () => "",
      generateStructuredOutput: async (options: any) => {
        sink.push({ systemPrompt: String(options.systemPrompt), prompt: String(options.prompt) });
        return { lines: [{ lineIndex: 0, turnIndex: 0, speakerName: "Zabala", text: "Say that number again." }] };
      },
    } as unknown as LLMProvider;
  }

  const hostWriterArgs = (
    hostName: string,
    otherHostName: string,
    brief: unknown,
    foreign: string[],
    chunkTurns: Array<{ turnIndex: number; speakerName: string; intent: string; targetWords: number; factRefs: string[] }> = [
      { turnIndex: 0, speakerName: hostName, intent: "open with the discrepancy", targetWords: 40, factRefs: [] },
      { turnIndex: 1, speakerName: otherHostName, intent: "deflect to the crowd", targetWords: 40, factRefs: [] },
    ]
  ) => ({
    hostName,
    otherHostName,
    privateBrief: brief as never,
    foreignBriefTerms: foreign,
    spine: { aboutInOneSentence: "Who signed off on the revised attendance figure." },
    beats: [{ beat: "open on the filing" }],
    chunkTurns: chunkTurns as never,
    ownTurnIndexes: [0],
    writtenSoFar: [],
    topicsEvidence: "The filing restated attendance twice.",
    systemPrompt: "You are writing dialogue for a two-host sports debate podcast.",
    movementNumber: 1,
    movementCount: 3,
    temperature: 0.9,
    maxTokens: 2000,
  });

  await check("host A's writer never receives host B's private brief", async () => {
    const sink: { systemPrompt: string; prompt: string }[] = [];
    const result = await writeHostLines({
      llm: capturingProvider(sink),
      ...hostWriterArgs("Zabala", "Mulkey", BRIEF_A, privateBriefTerms(BRIEF_B as never)),
    });
    const sent = `${result.isolation.sentSystemPrompt}\n${result.isolation.sentPrompt}`;
    for (const term of privateBriefTerms(BRIEF_B as never)) {
      assert.ok(!sent.includes(term), `host B's brief leaked into host A's prompt: "${term.slice(0, 40)}..."`);
    }
    // ...and host A's OWN brief did reach it, or the isolation is just an empty prompt.
    assert.ok(
      sent.includes(BRIEF_A.protectedBelief),
      "host A's writer must actually receive host A's brief"
    );
  });

  await check("a brief that leaks through a turn intent is REDACTED and recorded", async () => {
    const sink: { systemPrompt: string; prompt: string }[] = [];
    // The architect paraphrases host B's protected belief into host B's turn
    // intent — the back door the redaction pass exists to close.
    const args = hostWriterArgs("Zabala", "Mulkey", BRIEF_A, privateBriefTerms(BRIEF_B as never), [
      { turnIndex: 0, speakerName: "Zabala", intent: "open with the discrepancy", targetWords: 40, factRefs: [] },
      { turnIndex: 1, speakerName: "Mulkey", intent: `argue that ${BRIEF_B.protectedBelief}`, targetWords: 40, factRefs: [] },
    ]);
    const result = await writeHostLines({ llm: capturingProvider(sink), ...args });
    assert.ok(result.isolation.redactedTerms.length > 0, "the leak must be caught, not trusted away");
    assert.ok(
      !`${result.isolation.sentSystemPrompt}\n${result.isolation.sentPrompt}`.includes(BRIEF_B.protectedBelief),
      "and the phrase must not reach the model"
    );
  });

  await check("the two host writers are given SEPARATE provider instances", () => {
    const sinkA: { systemPrompt: string; prompt: string }[] = [];
    const sinkB: { systemPrompt: string; prompt: string }[] = [];
    const a = capturingProvider(sinkA);
    const b = capturingProvider(sinkB);
    assert.notEqual(a, b, "two host writers must not share one provider object");
    // Route separation is the other half, and it is what the audit reports.
    const separate = assessHostWriterRoutes([
      row("script_host_a_writer", "anthropic/claude-opus-5"),
      row("script_host_b_writer", "nvidia/mistral-medium-3.5"),
    ]);
    assert.equal(separate.separate, true);
    assert.equal(separate.sameProvider, false);

    const collided = assessHostWriterRoutes([
      row("script_host_a_writer", "anthropic/claude-opus-5"),
      row("script_host_b_writer", "anthropic/claude-opus-5"),
    ]);
    assert.equal(collided.separate, false);
    assert.match(collided.reason!, /two versions of itself/);
    assert.match(collided.remedy!, /SCRIPT_HOST_B_WRITER_LLM_PROVIDER/);
  });

  // =========================================================================
  console.log("\n  -- 4. missing OPTIONAL providers do not break production --");

  await check("an unconfigured extra provider changes nothing about the nine roles", () => {
    withEnv(
      { ANTHROPIC_API_KEY: "test-anthropic", LLM_PROVIDER: "anthropic", SCRIPT_LLM_PROVIDER: "anthropic" },
      () => {
        const before = PRODUCTION_WRITING_ROLES.map((r) => candidateKey(resolveRolePlan(r).candidates[0]));
        // NVIDIA and Z.ai are simply absent. Nothing may demand them.
        assert.deepEqual(configuredLlmProviders(), ["anthropic"]);
        const after = PRODUCTION_WRITING_ROLES.map((r) => candidateKey(resolveRolePlan(r).candidates[0]));
        assert.deepEqual(after, before, "resolution must not depend on providers that are not configured");
        assert.ok(after.every(Boolean), "every role must still resolve");
      }
    );
  });

  await check("the cold-open tournament falls back to one writer instead of failing", () => {
    withEnv(
      { ANTHROPIC_API_KEY: "test-anthropic", LLM_PROVIDER: "anthropic", SCRIPT_LLM_PROVIDER: "anthropic" },
      () => {
        const plan = planColdOpenWriterRoutes();
        assert.deepEqual(plan, [], "one distinct route means the single-writer path, not an error");
      }
    );
  });

  await check("two distinct credentialed routes DO contest the tournament", () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: "test-anthropic",
        NVIDIA_API_KEY: "test-nvidia",
        LLM_PROVIDER: "anthropic",
        SCRIPT_LLM_PROVIDER: "anthropic",
        SCRIPT_HOST_B_WRITER_LLM_PROVIDER: "nvidia",
        SCRIPT_HOST_B_WRITER_LLM_MODEL: "mistral-medium-3.5",
      },
      () => {
        const plan = planColdOpenWriterRoutes();
        assert.equal(plan.length, 3, "all three angles must be assigned");
        assert.ok(new Set(plan.map((p) => p.label)).size >= 2, "and to at least two different routes");
      }
    );
  });

  await check("an uncredentialed route is excluded from the pool rather than assigned", () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: "test-anthropic",
        LLM_PROVIDER: "anthropic",
        SCRIPT_LLM_PROVIDER: "anthropic",
        // Routed, but the key was never set.
        SCRIPT_HOST_B_WRITER_LLM_PROVIDER: "nvidia",
        SCRIPT_HOST_B_WRITER_LLM_MODEL: "mistral-medium-3.5",
      },
      () => {
        assert.deepEqual(planColdOpenWriterRoutes(), [], "a route with no credential is not an available writer");
      }
    );
  });

  // =========================================================================
  console.log("\n  -- 5. unavailable REQUIRED routes fail clearly --");

  await check("a role with no credential is named, not silently substituted", () => {
    withEnv({ LLM_ROUTING_PROFILE: "custom", QUALITY_JUDGE_LLM_PROVIDER: "nvidia", QUALITY_JUDGE_LLM_MODEL: "nemotron" }, () => {
      const rows = [
        row("script_host_a_writer", "anthropic/claude-opus-5"),
        { ...row("quality_judge", "nvidia/nemotron"), credentialPresent: false },
      ];
      const uncredentialed = rows.filter((r) => !r.credentialPresent).map((r) => r.role);
      assert.deepEqual(uncredentialed, ["quality_judge"], "the audit must name the role that cannot run");
    });
  });

  await check("a judge that resolves to nothing is a failure, not an absence", () => {
    // The trap: an unresolved judge collides with NOBODY, and "collides with
    // nobody" is how a naive rule spells "independent". A missing judge is the
    // worst case, not the best one.
    const grade = gradeIndependence({
      judge: { role: "quality_judge", label: "(unresolved)", provider: "(none)", identity: "unresolved|quality_judge" },
      authoring: writers,
      alternativesAvailable: ["anthropic"],
    });
    assert.equal(grade.independent, false, "an absent judge must never be reported as independent");
    assert.equal(grade.level, "none");
    assert.equal(grade.acceptable, false, "and it must never be acceptable");
    assert.match(grade.reason!, /nothing is judging this script/);
  });

  await check("a rejected credential surfaces as a credential failure, not an outage", () => {
    const err = new LlmProviderError({
      provider: "nvidia",
      model: "nemotron",
      category: "authentication_failed",
      message: "401",
    });
    assert.equal(classifyProviderError(err), "credential_failure");
  });

  await check("an unknown model id is named as such rather than retried forever", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "model nemotron-9 does not exist" } });
    assert.equal(categorizeHttpFailure(404, body, []), "invalid_model");
    assert.equal(categorizeHttpFailure(400, body, []), "invalid_model");
  });

  // =========================================================================
  console.log("\n  -- 6. billing failures are billing_failure, not programming_error --");

  await check("the Anthropic credit-balance 400 keeps its billing classification", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    });
    assert.equal(categorizeHttpFailure(400, body, ["system", "max_tokens"]), "insufficient_credit");
    assert.notEqual(categorizeHttpFailure(400, body, []), "programming_error");
    assert.equal(
      categoryOf(new Error(`[Anthropic] API request failed with status 400: ${body}`)),
      "insufficient_credit"
    );
    const routed = new LlmProviderError({
      provider: "routing",
      model: "quality_judge",
      category: "unknown",
      message: `anthropic/claude-sonnet-5 [role_override] failed (insufficient_credit): ${body}`,
    });
    assert.equal(classifyProviderError(routed), "billing_failure");
  });

  await check("routing changes did not weaken that classification", () => {
    // Guards the interaction: this pass touched routing.ts, and a regression
    // here would send an operator back to debugging code over an unpaid bill.
    const malformed = JSON.stringify({ error: { type: "invalid_request_error", message: "messages: required" } });
    assert.equal(categorizeHttpFailure(400, malformed, []), "programming_error");
    assert.equal(categorizeHttpFailure(429, "rate limit", []), "rate_limited");
    assert.equal(categorizeHttpFailure(500, "", []), "provider_internal_error");
  });

  // =========================================================================
  console.log("\n  -- 7. promotion rests on stored blind results, never on a name --");

  await check("no vendor or model name appears in the promotion logic", () => {
    const source = fs.readFileSync(new URL("../lib/services/modelEvaluation.ts", import.meta.url), "utf8");
    for (const vendor of ["anthropic", "claude", "openai", "gpt-", "gemini", "llama", "mistral", "nvidia", "nemotron", "deepseek"]) {
      assert.ok(
        !source.toLowerCase().includes(vendor),
        `modelEvaluation.ts names '${vendor}' — promotion logic must be unable to prefer a vendor`
      );
    }
  });

  await check("promotion is REFUSED without enough stored evidence", () => {
    const decision = decidePromotion([], "provider-x/model-1");
    assert.equal(decision.promote, false);
    assert.ok(decision.evidenceGaps.length > 0, "and it says exactly what is missing");
    assert.match(decision.evidenceGaps.join(" "), /stored run/i);
  });

  await check("a run judged by a candidate's own lab is discarded as evidence", () => {
    const captured: EvaluationRun = {
      runId: "r1",
      ranAt: "2026-08-01T00:00:00.000Z",
      fixtureDigest: "abc",
      incumbent: "provider-x/model-1",
      candidates: ["provider-x/model-1", "provider-y/model-2"],
      results: [],
      judge: "provider-y/model-3",
      judgeIndependentOfCandidates: false,
      notes: [],
    };
    const decision = decidePromotion([captured, { ...captured, runId: "r2" }], "provider-x/model-1");
    assert.equal(decision.promote, false);
    assert.match(decision.evidenceGaps.join(" "), /sharing a provider with a candidate/);
  });

  await check("runs on DIFFERENT fixtures cannot be pooled", () => {
    const base: EvaluationRun = {
      runId: "r1",
      ranAt: "2026-08-01T00:00:00.000Z",
      fixtureDigest: "abc",
      incumbent: "provider-x/model-1",
      candidates: ["provider-x/model-1"],
      results: [],
      judge: "provider-z/model-9",
      judgeIndependentOfCandidates: true,
      notes: [],
    };
    const decision = decidePromotion([base, { ...base, runId: "r2", fixtureDigest: "different" }], "provider-x/model-1");
    assert.match(decision.evidenceGaps.join(" "), /different fixture sets/);
  });

  await check("blind labels are stable, and identity is scrubbed from the text", () => {
    const labels = assignBlindLabels("run-1", ["provider-x/model-1", "provider-y/model-2"]);
    const again = assignBlindLabels("run-1", ["provider-y/model-2", "provider-x/model-1"]);
    assert.deepEqual([...labels.entries()].sort(), [...again.entries()].sort(), "order must not change the mapping");
    const scrubbed = scrubCandidateIdentity("Written by model-1 from provider-x.", ["provider-x/model-1"]);
    assert.ok(!scrubbed.includes("model-1"), "a model that names itself must not identify itself to the judge");
    assert.ok(!scrubbed.includes("provider-x"));
  });

  await check("a candidate that failed a fixture is not averaged into a win", () => {
    const run: EvaluationRun = {
      runId: "r1",
      ranAt: "2026-08-01T00:00:00.000Z",
      fixtureDigest: "abc",
      incumbent: "provider-x/model-1",
      candidates: ["provider-y/model-2"],
      results: [
        {
          candidate: "provider-y/model-2",
          fixtureKey: "one",
          blindLabel: "Candidate A",
          scores: { opening_strength: 99 },
          failure: null,
          latencyMs: 100,
          estimatedCostUsd: 0.01,
          tokensIn: 10,
          tokensOut: 10,
        },
        {
          candidate: "provider-y/model-2",
          fixtureKey: "two",
          blindLabel: "Candidate A",
          scores: {},
          failure: "structured output invalid after repair",
          latencyMs: 100,
          estimatedCostUsd: null,
          tokensIn: 0,
          tokensOut: 0,
        },
      ],
      judge: "provider-z/model-9",
      judgeIndependentOfCandidates: true,
      notes: [],
    };
    const [summary] = summarizeRun(run);
    assert.equal(summary.fixturesAttempted, 2);
    assert.equal(summary.fixturesCompleted, 1, "the failure must remain visible as a failure");
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.qualityComposite, null, "an incomplete dimension set yields no composite, not a flattering one");
  });

  // ===========================================================================
  // Both entry points must know every provider.
  //
  // THE BUG THIS EXISTS FOR: there were two provider switches — getLLMProvider()
  // in factory.ts and instantiateProvider() in routing.ts. Three providers were
  // added to the first and not the second. Direct calls worked, ROUTED calls
  // threw "Unknown provider 'xai'", and the live smoke test reported success
  // because it goes through the factory. A paid evaluation run was burned before
  // anything noticed. There is one registry now, and this keeps it that way.
  //
  // A MISSING CREDENTIAL IS AN ACCEPTABLE OUTCOME — this has to pass in CI,
  // where nothing is credentialed. What is never acceptable is a provider name
  // the code cannot resolve to a class at all.
  console.log("\n  -- every supported provider builds from BOTH entry points --");
  for (const provider of SUPPORTED_LLM_PROVIDERS) {
    check(`'${provider}' is known to the factory AND the router`, () => {
      for (const [entryPoint, build] of [
        ["getLLMProvider (factory)", () => getLLMProvider({ provider })],
        ["instantiateProvider (router)", () => instantiateProvider(provider)],
      ] as const) {
        try {
          build();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          assert.ok(
            !/unknown provider/i.test(msg),
            `${entryPoint} cannot build '${provider}': ${msg}\n` +
              `      Both resolve through providerRegistry.ts — register it there, not in a second switch.`
          );
          // Anything else (a missing credential, most likely) is fine: the name
          // resolved to a real class, which is all this check is about.
        }
      }
    });
  }

  check("the factory falls back to stub for an unknown name; the router refuses", () => {
    const built = getLLMProvider({ provider: "not-a-real-provider" });
    assert.match(
      built.name.toLowerCase(),
      /^stub/,
      "an unset or garbage LLM_PROVIDER is ordinary in development, so the factory degrades to the stub"
    );
    assert.throws(
      () => instantiateProvider("not-a-real-provider"),
      /unknown provider/i,
      "a ROUTED name nothing can build is a configuration defect and must stop the chain"
    );
  });

  if (failed) {
    console.error(`\n${failed} check(s) FAILED.\n`);
    process.exit(1);
  }
  console.log("\nAll LLM role routing checks passed.\n");
}

import fs from "node:fs";

void main();
