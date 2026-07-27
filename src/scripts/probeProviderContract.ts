// LIVE contract probe. Establishes what each hosted model ACTUALLY accepts.
//
//   npm run probe:llm-contract                        # every configured provider
//   npm run probe:llm-contract -- --provider nvidia
//   npm run probe:llm-contract -- --provider zai
//   npm run probe:llm-contract -- --model deepseek-ai/deepseek-v4-pro
//
// WHY THIS EXISTS: the mocked provider suites prove our request SHAPES match the
// documented examples. They cannot prove the hosted endpoint accepts them. Until
// this probe succeeds, every NVIDIA/Z.ai record is `catalogVerified: true,
// liveContractVerified: false` — the model ID is confirmed, its request contract
// is not, and no A/B result should be trusted.
//
// Each model is probed INDEPENDENTLY: they do not share a reasoning contract, so
// one model's success says nothing about its siblings.
//
// TWO HARD RULES:
//   1. This script NEVER edits source. It prints the exact recommended registry
//      changes for a human to review and apply. Auto-writing capability records
//      from provider responses is how a transient 400 becomes a permanent lie.
//   2. It never generates 16,000 tokens to test a 16,000-token allowance. It
//      REQUESTS max_tokens: 16000 with a one-sentence instruction and records
//      whether the request was accepted.
//
// Output: artifacts/<provider>-contract-report.json and .md

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { ModelCapabilities, probeTargets } from "../lib/providers/llm/capabilities";
import { NVIDIA_DEFAULT_BASE_URL } from "../lib/providers/llm/nvidia";
import { ZAI_DEFAULT_BASE_URL } from "../lib/providers/llm/zai";
import { credentialVarFor, providerCredentialPresent } from "../lib/providers/llm/routing";
import { redactSecrets } from "../lib/providers/llm/errors";

type ProviderName = "nvidia" | "zai";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ONLY_PROVIDER = flag("provider") as ProviderName | undefined;
const ONLY_MODEL = flag("model");

const ARTIFACT_DIR = path.join(process.cwd(), "artifacts");

// ---------------------------------------------------------------- probe types

type Verdict = "accepted" | "rejected" | "error" | "skipped";

interface ProbeResult {
  id: string;
  question: string;
  verdict: Verdict;
  /** HTTP status, when there was one. */
  status?: number;
  /** Credential-free detail: what came back, or why it was skipped. */
  detail: string;
  /** Observation extracted from a successful response, when relevant. */
  observed?: Record<string, unknown>;
  ms: number;
}

interface ModelReport {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  probes: ProbeResult[];
  /** Everything the probe learned, as capability fields. */
  learned: Partial<ModelCapabilities>;
  /** Did the model answer a plain request at all? */
  reachable: boolean;
  /**
   * Does this endpoint REJECT an invented parameter name?
   *
   * This is the control that makes every other acceptance meaningful. An endpoint
   * that 400s on `__probe_unsupported_parameter__` validates its input, so a 200
   * elsewhere is real evidence the field is understood. An endpoint that accepts
   * the invented name ignores unknown parameters, and then a 200 cannot tell
   * "honored" from "silently dropped" — so no capability flag may be upgraded
   * from acceptance alone.
   *
   * The 2026-07-26 run needed this: NVIDIA hard-400s unknown fields, while Z.ai
   * returned 200 for chat_template_kwargs, a field only NVIDIA implements.
   */
  validatesParameters: boolean | null;
  /** Did the plain request return an EMPTY answer despite HTTP 200? */
  emptyAnswerOnPlainRequest: boolean;
}

// ---------------------------------------------------------------- transport

function baseUrlFor(provider: ProviderName): string {
  return provider === "nvidia"
    ? process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL
    : process.env.ZAI_BASE_URL || ZAI_DEFAULT_BASE_URL;
}

function timeoutFor(provider: ProviderName): number {
  const raw = Number(
    provider === "nvidia" ? process.env.NVIDIA_REQUEST_TIMEOUT_MS : process.env.ZAI_REQUEST_TIMEOUT_MS
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

interface RawCall {
  ok: boolean;
  status: number;
  body: any;
  text: string;
  ms: number;
}

/**
 * One raw request. Deliberately does NOT go through the provider classes: the
 * point is to observe the endpoint's own behavior, including the rejections our
 * adapters are designed to avoid provoking.
 */
async function rawCall(
  provider: ProviderName,
  body: Record<string, unknown>
): Promise<RawCall> {
  const url = `${baseUrlFor(provider).replace(/\/+$/, "")}/chat/completions`;
  const key = (process.env[credentialVarFor(provider)] || "").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(provider));
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = redactSecrets(await res.text().catch(() => ""));
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON error bodies are reported as text */
    }
    return { ok: res.ok, status: res.status, body: parsed, text, ms: Date.now() - startedAt };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      body: null,
      text: redactSecrets(err?.name === "AbortError" ? "request timed out" : String(err?.message || err)),
      ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

const SHORT = "Answer in one short sentence.";

function baseBody(model: string, prompt: string, extra: Record<string, unknown> = {}) {
  return {
    model,
    messages: [
      { role: "system", content: "You are terse. You follow instructions exactly." },
      { role: "user", content: prompt },
    ],
    max_tokens: 128,
    stream: false,
    ...extra,
  };
}

function verdictOf(call: RawCall): Verdict {
  if (call.ok) return "accepted";
  if (call.status === 0) return "error";
  // A 400/422 naming the field is a rejection of that field; other statuses are
  // environment noise (rate limit, outage) and must not be recorded as a
  // capability answer.
  if (call.status === 400 || call.status === 422) return "rejected";
  return "error";
}

function shortDetail(call: RawCall): string {
  if (call.ok) return `HTTP ${call.status} in ${call.ms}ms`;
  return `HTTP ${call.status || "network"}: ${call.text.slice(0, 240)}`;
}

// ---------------------------------------------------------------- the probes

async function probeModel(provider: ProviderName, model: string): Promise<ModelReport> {
  const report: ModelReport = {
    provider,
    model,
    baseUrl: baseUrlFor(provider),
    probes: [],
    learned: {},
    reachable: false,
    validatesParameters: null,
    emptyAnswerOnPlainRequest: false,
  };

  const add = (
    id: string,
    question: string,
    call: RawCall,
    observed?: Record<string, unknown>
  ): ProbeResult => {
    const r: ProbeResult = {
      id,
      question,
      verdict: verdictOf(call),
      status: call.status || undefined,
      detail: shortDetail(call),
      // Observations are recorded ONLY from a successful call. A failed call has
      // no message to inspect, and attaching an empty observation to it reads
      // later as "the model returned no reasoning fields" when the truth is "the
      // model returned nothing at all" — which is how a 503 turns into a false
      // capability conclusion.
      observed: call.ok ? observed : undefined,
      ms: call.ms,
    };
    report.probes.push(r);
    console.log(
      `    ${r.verdict === "accepted" ? "✓" : r.verdict === "rejected" ? "✗" : "!"} ${id.padEnd(28)} ${r.detail.slice(0, 90)}`
    );
    return r;
  };

  console.log(`\n  ${provider}/${model}`);

  // 1-3. model id, system prompt, plain text response
  const plain = await rawCall(provider, baseBody(model, `Name one sport. ${SHORT}`));
  const plainProbe = add("1-3.model+system+text", "Model ID, system prompt and a plain text answer", plain, {
    content: plain.ok ? String(plain.body?.choices?.[0]?.message?.content || "").slice(0, 160) : undefined,
    finishReasonField: plain.ok ? Object.keys(plain.body?.choices?.[0] ?? {}).join(",") : undefined,
    usageFields: plain.ok ? Object.keys(plain.body?.usage ?? {}).join(",") : undefined,
  });
  report.reachable = plainProbe.verdict === "accepted";
  if (report.reachable) {
    const answer = String(plain.body?.choices?.[0]?.message?.content || "");
    report.emptyAnswerOnPlainRequest = answer.trim().length === 0;
    if (report.emptyAnswerOnPlainRequest) {
      const u = plain.body?.usage ?? {};
      const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0;
      add(
        "0.empty_answer_warning",
        "HTTP 200 but the answer was EMPTY",
        plain,
        {
          finish_reason: plain.body?.choices?.[0]?.finish_reason ?? null,
          completion_tokens: u.completion_tokens ?? null,
          reasoning_tokens: reasoningTokens,
          note:
            "The request succeeded and produced NO answer. If reasoning_tokens accounts for the whole completion, this model " +
            "reasons by default and consumed the entire allowance — it needs a larger max_tokens or thinking disabled. " +
            "Treating this as a success would be wrong.",
        }
      );
    }
  }

  // CONTROL: does this endpoint validate parameters at all? Everything below is
  // interpreted through the answer. Run it before the capability questions so the
  // report reads in the right order.
  if (report.reachable) {
    const control = await rawCall(
      provider,
      baseBody(model, `Say hi. ${SHORT}`, { __probe_unsupported_parameter__: "control" })
    );
    const controlProbe = add(
      "0.validates_parameters",
      "CONTROL — is an INVENTED parameter name rejected? (if not, every acceptance below is uninformative)",
      control,
      { verdictMeaning: control.ok ? "endpoint IGNORES unknown parameters" : "endpoint VALIDATES parameters" }
    );
    report.validatesParameters = controlProbe.verdict === "rejected";
    if (!report.validatesParameters) {
      console.log(
        `      NOTE: ${model} accepted an invented parameter — it does not validate unknown fields, so no capability ` +
          `flag may be upgraded from a 200 alone.`
      );
    }
  }

  if (!report.reachable) {
    // Everything after this would report a model-availability problem as a
    // capability answer, which is exactly the confusion this file exists to end.
    for (const [id, q] of [
      ["4.max_tokens", "Requested max_tokens accepted"],
      ["5.temperature", "temperature accepted"],
      ["6.seed", "seed accepted"],
      ["7.thinking_enable", "Thinking ENABLE field accepted"],
      ["8.thinking_disable", "Thinking DISABLE field accepted"],
      ["9.reasoning_effort", "reasoning_effort accepted"],
      ["10.reasoning_budget", "reasoning_budget accepted"],
      ["11.json_object", "Native JSON-object mode accepted"],
      ["12.json_schema", "Native JSON-schema mode accepted"],
      ["13.reasoning_separate", "Reasoning returned separately"],
      ["14.usage_fields", "Usage object field names"],
      ["15.finish_reason", "Finish-reason field"],
      ["16.prompt_enforced_json", "Structured response WITHOUT native JSON mode"],
      ["17.max_tokens_16000", "A 16,000-token allowance accepted"],
    ] as const) {
      report.probes.push({
        id,
        question: q,
        verdict: "skipped",
        detail: "skipped: the model did not answer a plain request, so nothing below would be a capability answer",
        ms: 0,
      });
    }
    return report;
  }

  // 14/15. Usage + finish-reason field names, from the plain call.
  add(
    "14-15.usage+finish",
    "Usage object field names and finish-reason field",
    plain,
    {
      usage: plain.body?.usage ?? null,
      finish_reason: plain.body?.choices?.[0]?.finish_reason ?? null,
    }
  );

  // 4. max_tokens accepted (small value).
  add("4.max_tokens", "Requested max_tokens accepted", await rawCall(provider, baseBody(model, `Say hi. ${SHORT}`, { max_tokens: 64 })));

  // 5. temperature.
  add("5.temperature", "temperature accepted", await rawCall(provider, baseBody(model, `Say hi. ${SHORT}`, { temperature: 0.7 })));

  // 6. seed.
  const seed = await rawCall(provider, baseBody(model, `Say hi. ${SHORT}`, { seed: 42 }));
  const seedProbe = add("6.seed", "seed accepted", seed);
  report.learned.supportsSeed = seedProbe.verdict === "accepted";

  // 7/8. Thinking enable + disable. BOTH documented spellings are tried
  // separately, because that is the specific thing we could not confirm from
  // documentation: which key this model reads.
  const thinkingCandidates: { id: string; fields: Record<string, unknown> }[] = [
    { id: "chat_template_kwargs.thinking", fields: { chat_template_kwargs: { thinking: true } } },
    { id: "chat_template_kwargs.enable_thinking", fields: { chat_template_kwargs: { enable_thinking: true } } },
    { id: "thinking.type", fields: { thinking: { type: "enabled" } } },
  ];
  const acceptedThinking: string[] = [];
  for (const cand of thinkingCandidates) {
    const call = await rawCall(provider, baseBody(model, `Explain 2+2. ${SHORT}`, cand.fields));
    const r = add(`7.thinking_enable[${cand.id}]`, `Thinking ENABLE via ${cand.id}`, call, {
      reasoningReturned:
        call.ok &&
        (typeof call.body?.choices?.[0]?.message?.reasoning_content === "string" ||
          typeof call.body?.choices?.[0]?.message?.reasoning === "string"),
    });
    if (r.verdict === "accepted") acceptedThinking.push(cand.id);
  }
  report.learned.supportsThinking = acceptedThinking.length > 0;

  for (const cand of [
    { id: "chat_template_kwargs.thinking=false", fields: { chat_template_kwargs: { thinking: false } } },
    { id: "chat_template_kwargs.enable_thinking=false", fields: { chat_template_kwargs: { enable_thinking: false } } },
    { id: "thinking.type=disabled", fields: { thinking: { type: "disabled" } } },
  ]) {
    add(
      `8.thinking_disable[${cand.id}]`,
      `Thinking DISABLE via ${cand.id}`,
      await rawCall(provider, baseBody(model, `Say hi. ${SHORT}`, cand.fields))
    );
  }

  // 9. reasoning_effort — BOTH placements, separately. This is the exact
  // ambiguity the documentation left: nested for DeepSeek, top level for Mistral.
  const nestedEffort = await rawCall(
    provider,
    baseBody(model, `Explain 2+2. ${SHORT}`, {
      chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
    })
  );
  const nestedProbe = add("9.reasoning_effort[nested]", "reasoning_effort NESTED in chat_template_kwargs", nestedEffort);
  const topEffort = await rawCall(provider, baseBody(model, `Explain 2+2. ${SHORT}`, { reasoning_effort: "high" }));
  const topProbe = add("9.reasoning_effort[top-level]", "reasoning_effort at the TOP LEVEL", topEffort);
  report.learned.supportsReasoningEffort =
    nestedProbe.verdict === "accepted" || topProbe.verdict === "accepted";

  // 10. reasoning_budget (top level, as documented for Nemotron).
  const budget = await rawCall(
    provider,
    baseBody(model, `Explain 2+2. ${SHORT}`, {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 1024,
    })
  );
  const budgetProbe = add("10.reasoning_budget", "Top-level reasoning_budget accepted", budget);
  report.learned.supportsReasoningBudget = budgetProbe.verdict === "accepted";

  // 11. Native JSON-object mode.
  const jsonObject = await rawCall(
    provider,
    baseBody(model, 'Return {"ok":true} and nothing else.', { response_format: { type: "json_object" } })
  );
  const jsonObjectProbe = add("11.json_object", "Native JSON-object mode accepted", jsonObject, {
    content: jsonObject.ok ? String(jsonObject.body?.choices?.[0]?.message?.content || "").slice(0, 160) : undefined,
  });
  report.learned.supportsNativeJsonObject = jsonObjectProbe.verdict === "accepted";

  // 12. Native JSON-schema mode.
  const jsonSchema = await rawCall(
    provider,
    baseBody(model, 'Return {"ok":true} and nothing else.', {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "probe",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    })
  );
  const jsonSchemaProbe = add("12.json_schema", "Native JSON-schema mode accepted", jsonSchema);
  report.learned.supportsNativeJsonSchema = jsonSchemaProbe.verdict === "accepted";

  // 13. Reasoning returned SEPARATELY (not inline in the answer).
  const reasoningShape = acceptedThinking.length
    ? await rawCall(
        provider,
        baseBody(model, `Which is larger, 9.9 or 9.11? ${SHORT}`, {
          ...(acceptedThinking[0] === "thinking.type"
            ? { thinking: { type: "enabled" } }
            : { chat_template_kwargs: { [acceptedThinking[0].split(".")[1]]: true } }),
        })
      )
    : null;
  if (reasoningShape) {
    const msg = reasoningShape.body?.choices?.[0]?.message ?? {};
    add("13.reasoning_separate", "Reasoning returned separately from the answer", reasoningShape, {
      hasReasoningContentField: typeof msg.reasoning_content === "string",
      hasReasoningField: typeof msg.reasoning === "string",
      messageKeys: Object.keys(msg).join(","),
      answerLooksLikeThinking: /<think>|^\s*(Okay|Let me|First,)/i.test(String(msg.content || "")),
    });
  } else {
    report.probes.push({
      id: "13.reasoning_separate",
      question: "Reasoning returned separately from the answer",
      verdict: "skipped",
      detail: "skipped: no thinking-enable field was accepted, so there is no reasoning to separate",
      ms: 0,
    });
  }

  // 16. A structured response with NO native JSON mode — the path our adapter
  // actually uses for every unconfirmed model.
  const promptEnforced = await rawCall(
    provider,
    baseBody(
      model,
      'Return a single JSON object exactly like {"sport":"...","ok":true} and nothing else. No code fences.',
      { max_tokens: 200 }
    )
  );
  const peProbe = add("16.prompt_enforced_json", "Structured response WITHOUT native JSON mode", promptEnforced, {
    content: promptEnforced.ok
      ? String(promptEnforced.body?.choices?.[0]?.message?.content || "").slice(0, 200)
      : undefined,
  });
  // A successful prompt-enforced response is NOT evidence of native JSON support.
  report.learned.supportsPromptEnforcedJson = peProbe.verdict === "accepted";

  // 17. A 16,000-token ALLOWANCE — request it, do not generate it.
  const bigAllowance = await rawCall(
    provider,
    baseBody(model, `Name one sport. ${SHORT}`, { max_tokens: 16000 })
  );
  add("17.max_tokens_16000", "A 16,000-token allowance is accepted (short answer requested)", bigAllowance, {
    completionTokens: bigAllowance.body?.usage?.completion_tokens ?? null,
    note: "The request asked for a one-sentence answer; only the ALLOWANCE was being tested.",
  });

  return report;
}

// ---------------------------------------------------------------- reporting

function recommendedRegistryDiff(reports: ModelReport[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    const caps = probeTargets(r.provider).find((c) => c.model === r.model);
    if (!caps) continue;
    const changes: string[] = [];
    const cmp = (field: keyof ModelCapabilities, observed: unknown) => {
      if (observed === undefined) return;
      if (caps[field] !== observed) changes.push(`  ${field}: ${String(caps[field])} -> ${String(observed)}`);
    };
    if (!r.reachable) {
      lines.push(
        `${r.provider}/${r.model}: NOT REACHABLE. Recommend catalogVerified: review, liveContractVerified: false. ` +
          `Do NOT change request-field flags from an unreachable probe.`
      );
      continue;
    }

    // An endpoint that ignores unknown parameters cannot tell us anything by
    // accepting one. Recommending upgrades from those 200s would launder a guess
    // into a live-verified record.
    if (r.validatesParameters === false) {
      lines.push(
        `${r.provider}/${r.model}: REACHED, but the endpoint ACCEPTED an invented parameter name — it does not validate ` +
          `unknown fields. Recommend liveContractVerified: false -> true ONLY, and NO request-field upgrades: a 200 here ` +
          `cannot distinguish "honored" from "silently ignored". Upgrade a field only on OBSERVED OUTPUT (e.g. ` +
          `reasoning_content actually returned, or JSON returned when prose was requested).`
      );
      continue;
    }

    cmp("supportsThinking", r.learned.supportsThinking);
    cmp("supportsReasoningEffort", r.learned.supportsReasoningEffort);
    cmp("supportsReasoningBudget", r.learned.supportsReasoningBudget);
    cmp("supportsNativeJsonObject", r.learned.supportsNativeJsonObject);
    cmp("supportsNativeJsonSchema", r.learned.supportsNativeJsonSchema);
    cmp("supportsSeed", r.learned.supportsSeed);
    changes.push(`  liveContractVerified: false -> true`);
    if (r.emptyAnswerOnPlainRequest) {
      changes.push(
        `  (WARNING: the plain request returned an EMPTY answer — see probe 0.empty_answer_warning before trusting this model)`
      );
    }
    lines.push(`${r.provider}/${r.model}:\n${changes.join("\n")}`);
  }
  return lines;
}

function toMarkdown(reports: ModelReport[], provider: ProviderName): string {
  const now = new Date().toISOString();
  const out: string[] = [
    `# ${provider} live contract report`,
    "",
    `Generated: ${now}`,
    `Base URL: \`${baseUrlFor(provider)}\``,
    "",
    "Every row is an OBSERVED response from the hosted endpoint. `accepted` means the request",
    "returned 2xx; `rejected` means the endpoint returned 400/422 for that specific field;",
    "`error` means something else went wrong (rate limit, outage, network) and is NOT a",
    "capability answer; `skipped` means a prerequisite failed.",
    "",
    "A successful prompt-enforced JSON response is NOT evidence that native JSON mode works.",
    "",
    "A `Validates` column of **no** means the endpoint accepted an invented parameter name.",
    "Every acceptance for that model is then uninformative, and no capability flag may be",
    "upgraded from it — only from observed OUTPUT.",
    "",
    "## Summary",
    "",
    "| Model | Reachable | Validates | Empty answer | Thinking | Effort | Budget | JSON object | JSON schema | Seed |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  const y = (v: unknown) => (v === undefined || v === null ? "—" : v ? "yes" : "no");
  for (const r of reports) {
    // Suppress the capability columns entirely for a lenient endpoint: printing
    // "yes" there would be read as a finding.
    const lenient = r.validatesParameters === false;
    const cap = (v: unknown) => (lenient ? "*uninformative*" : y(v));
    out.push(
      `| \`${r.model}\` | ${r.reachable ? "yes" : "**NO**"} | ${r.validatesParameters === null ? "—" : r.validatesParameters ? "yes" : "**no**"} | ` +
        `${r.emptyAnswerOnPlainRequest ? "**YES**" : "no"} | ${cap(r.learned.supportsThinking)} | ` +
        `${cap(r.learned.supportsReasoningEffort)} | ${cap(r.learned.supportsReasoningBudget)} | ` +
        `${cap(r.learned.supportsNativeJsonObject)} | ${cap(r.learned.supportsNativeJsonSchema)} | ${cap(r.learned.supportsSeed)} |`
    );
  }
  for (const r of reports) {
    out.push("", `## \`${r.model}\``, "", "| Probe | Question | Verdict | Detail |", "|---|---|---|---|");
    for (const p of r.probes) {
      out.push(
        `| \`${p.id}\` | ${p.question} | **${p.verdict}** | ${p.detail.replace(/\|/g, "\\|").slice(0, 220)} |`
      );
    }
    const observed = r.probes.filter((p) => p.observed);
    if (observed.length) {
      out.push("", "<details><summary>Observed response fields</summary>", "", "```json");
      out.push(JSON.stringify(Object.fromEntries(observed.map((p) => [p.id, p.observed])), null, 2));
      out.push("```", "", "</details>");
    }
  }
  out.push(
    "",
    "## Recommended registry changes (REVIEW BY HAND — nothing was auto-applied)",
    "",
    "```",
    ...recommendedRegistryDiff(reports),
    "```",
    "",
    "Apply these to `src/lib/providers/llm/capabilities.ts` only after reading the probe rows above.",
    "An `error` verdict is never grounds for changing a capability flag.",
    ""
  );
  return out.join("\n");
}

// ---------------------------------------------------------------- main

async function probeProvider(provider: ProviderName): Promise<boolean> {
  const keyVar = credentialVarFor(provider);
  if (!providerCredentialPresent(provider)) {
    console.log(
      `\n${provider}: SKIPPED — ${keyVar} is not set (or is a placeholder). ` +
        `NOTHING was verified against the real ${provider} API, and no capability record may be upgraded.`
    );
    return false;
  }

  let targets = probeTargets(provider).map((c) => c.model);
  if (ONLY_MODEL) targets = targets.filter((m) => m === ONLY_MODEL);
  if (targets.length === 0) {
    console.log(`\n${provider}: no probe targets matched.`);
    return false;
  }

  console.log(`\n=== LIVE CONTRACT PROBE: ${provider} (${targets.length} model(s)) ===`);
  console.log(`base URL: ${baseUrlFor(provider)}`);

  const reports: ModelReport[] = [];
  for (const model of targets) {
    reports.push(await probeModel(provider, model));
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const jsonPath = path.join(ARTIFACT_DIR, `${provider}-contract-report.json`);
  const mdPath = path.join(ARTIFACT_DIR, `${provider}-contract-report.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { provider, baseUrl: baseUrlFor(provider), generatedAt: new Date().toISOString(), reports },
      null,
      2
    )
  );
  fs.writeFileSync(mdPath, toMarkdown(reports, provider));

  console.log(`\n  report: ${jsonPath}`);
  console.log(`  report: ${mdPath}`);
  console.log("\n  RECOMMENDED REGISTRY CHANGES (not applied — review by hand):");
  for (const line of recommendedRegistryDiff(reports)) console.log(`    ${line.replace(/\n/g, "\n    ")}`);

  const unreachable = reports.filter((r) => !r.reachable);
  if (unreachable.length) {
    console.log(
      `\n  ${unreachable.length} model(s) did not answer a plain request: ${unreachable
        .map((r) => r.model)
        .join(", ")}. Their capability flags must NOT be changed from this run.`
    );
  }
  return true;
}

async function main(): Promise<void> {
  console.log("LIVE contract probe — observes what each hosted model actually accepts.");
  console.log("This script never edits source. It prints recommended registry changes for review.");

  const providers: ProviderName[] = ONLY_PROVIDER ? [ONLY_PROVIDER] : ["nvidia", "zai"];
  let ranAny = false;
  for (const p of providers) {
    const ran = await probeProvider(p);
    ranAny = ranAny || ran;
  }

  if (!ranAny) {
    console.log(
      "\nNO PROVIDER WAS PROBED. Every capability record therefore remains liveContractVerified: false, " +
        "and no model in this repository has been validated against a real endpoint. " +
        `Set ${credentialVarFor("nvidia")} and/or ${credentialVarFor("zai")} and re-run.`
    );
    // Not an error: reporting "nothing was verified" is the correct outcome of a
    // probe with no credentials, and must not read as a failing build.
  }
  console.log(
    "\nReminder: a model is only 'validated' after a successful live request, and only 'best for a role' " +
      "after a role-specific comparison (npm run test:role-experiments)."
  );
}

main().catch((err) => {
  console.error("Contract probe failed:", redactSecrets(String(err?.message || err)));
  process.exit(1);
});
