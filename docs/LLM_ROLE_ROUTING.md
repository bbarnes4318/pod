# Role-Based LLM Routing

One model forced across the whole pipeline is the wrong shape for this
application. Writing believable two-host dialogue, planning an episode's
architecture, and grading a claim against an evidence packet are different jobs
with different failure modes. This layer assigns a model per **role** and keeps a
one-variable path back to the configuration that shipped before it.

- Code: `src/lib/providers/llm/`
- Default: `LLM_ROUTING_PROFILE=legacy` — deploying this feature changes nothing.

---

## 1. Inventory: every LLM call in the application

Found by searching for `generateText(`, `generateStructuredOutput(`,
`getLLMProvider(`, `getScriptLLMProvider(`, `getVerifyLLMProvider(`,
`new Anthropic`, `new OpenAI`, and the provider env vars. Ten real call sites,
all of which already went through the shared factory — nothing bypassed it.

| # | File | Function / stage | Old provider resolution | Response | Schema | Max output | Retries | Dialogue? | Role |
|---|------|------------------|-------------------------|----------|--------|-----------|---------|-----------|------|
| 1 | `src/lib/queue/worker.ts` | `topics:generate` | `getLLMProvider()` | JSON `{topics:[]}` | prompt-embedded | provider default | provider-level | no | `topic_generation` |
| 2 | `src/lib/queue/worker.ts` | `classifyTopic` → `topics:classify` | `getLLMProvider()`, skipped when `LLM_PROVIDER` unset/stub | JSON `{classification}` | prompt-embedded enum | provider default | provider-level, then heuristic | no | `topic_classification` |
| 3 | `src/lib/queue/worker.ts` | `topics:research-brief` | `getLLMProvider()` | JSON brief | prompt-embedded | provider default | provider-level | no | `research_brief` |
| 4 | `src/lib/services/scriptOutlineEngine.ts` | `script:outline` | script provider (passed in) | JSON `{beats:[]}` | prompt-embedded | `min(maxTokens, 7000)` | 1 retry via caller | no | `script_outline` |
| 5 | `src/lib/services/scriptOutlineEngine.ts` | `script:acts` | script provider (passed in) | nested script JSON | prompt-embedded | **16000** | 2 attempts per movement | **yes** | `script_movement` |
| 6 | `src/lib/services/scriptService.ts` | `script:single-shot-fallback` | `getScriptLLMProvider()` | nested script JSON | prompt-embedded | **16000** | none | **yes** | `script_movement` |
| 7 | `src/lib/services/scriptOutlineEngine.ts` | `script:selfverify-rewrite` (also the antithesis pass) | `getVerifyLLMProvider()` | JSON `{rewrites:[]}` | prompt-embedded | `min(300·n+600, 8000)` | best-effort, non-fatal | **yes** | `script_rewrite` |
| 8 | `src/lib/services/semanticReview.ts` via `scriptService` | `script:selfverify-semantic` | `getVerifyLLMProvider()` | JSON review | **real `jsonSchema` object** | provider default | round loop | no | `script_verification` |
| 9 | `src/lib/services/factCheckService.ts` | `factcheck:semantic-review` | `getVerifyLLMProvider()` | JSON review | **real `jsonSchema` object** | provider default | none | no | `fact_check` |
| 10 | `src/lib/services/continuityReport.ts` | `continuity:report` | script provider (reused instance) | JSON claim, zod-validated | zod | 1200 | none (null on failure) | no | `continuity_report` |
| 11 | `src/lib/services/contentAssetService.ts` | `content-assets:show-notes` | `getLLMProvider()`, skipped when provider is stub | JSON notes | prompt-embedded | provider default | none | no | `show_notes` |

Development-only harnesses (`src/scripts/testModelAB.ts`, `testRealEpisode.ts`,
`testRepetition.ts`) call the factory directly with explicit provider/model —
left as-is, plus a new role-experiment harness.

**Three roles are declared but have no LLM call site yet**, and the readiness
table says so rather than implying a model is doing work nothing calls:

| Role | Why it has no call | Where the work happens today |
|------|--------------------|------------------------------|
| `topic_ranking` | ranking is deterministic | `talkabilityService.scoreTopicTalkability` + `topicEligibility` |
| `evidence_extraction` | extraction is deterministic | `evidenceContext.ts`, `research/articleText.ts` |
| `episode_metadata` | titles/descriptions/chapters are derived | `publishAssetsService`, `contentAssetService` |

`quality_judge` is wired to the development harness (`npm run test:role-experiments`), not the production path.

---

## 2. Roles

`src/lib/providers/llm/roles.ts` is the registry. Each role carries its purpose,
env prefix, structured-output flag, reasoning posture, temperature, whether its
output reaches listeners, its real call sites, and **two** legacy mappings.

Two deliberate separations, both required:

- `script_verification` ≠ `script_rewrite`. The model that diagnoses a problem
  does not rewrite character dialogue — a grader asked to rewrite flattens
  speech into analysis, and an independent verifier is the point.
- `research_brief` ≠ `script_movement`. Organising evidence and writing
  entertaining spoken dialogue are materially different tasks.

### Why there are two legacy fields

| Field | Meaning |
|-------|---------|
| `legacyRollback` | what the role uses **today**, and therefore what `LLM_ROUTING_PROFILE=legacy` resolves to. The rollback contract. |
| `legacyBackup` | the role-**appropriate** paid rung (step 5) inside the non-legacy profiles. |

They differ for exactly one role. `script_rewrite` runs on the VERIFY provider
today, so legacy keeps that; but a dialogue repair belongs to the creative
writer, so the frontier profiles back it with the SCRIPT provider. Collapsing the
two fields would mean either breaking the rollback promise or shipping a
worse-than-intended fallback — so both are modelled.

---

## 3. Provider architecture

```
LLMProvider (interface, unchanged)
├── OpenAICompatibleLLMProvider   (shared wire protocol)
│   ├── NvidiaNimLLMProvider      base URL / NVIDIA_API_KEY / reasoning spelling
│   └── ZaiLLMProvider            base URL / ZAI_API_KEY / reasoning spelling
├── AnthropicLLMProvider          unchanged
├── OpenAILLMProvider             unchanged
└── StubLLMProvider               unchanged
```

The base class owns capability-filtered request bodies, reasoning separation,
strict structured parsing with one repair, retry policy, and redaction. The
subclasses are ~40 lines each.

**NVIDIA and Z.ai calls are never recorded as OpenAI calls.** Sharing a wire
protocol is not sharing an identity: each provider records its own name in the
cost ledger, holds its own credential and timeouts, and has its own capability
records.

### Endpoints

| Provider | Base URL | Credential | Timeout | Retries |
|----------|----------|-----------|---------|---------|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` (+`/chat/completions`) | `NVIDIA_API_KEY` | `NVIDIA_REQUEST_TIMEOUT_MS` (240000) | `NVIDIA_MAX_RETRIES` (2) |
| Z.ai | `https://api.z.ai/api/paas/v4` (+`/chat/completions`) | `ZAI_API_KEY` | `ZAI_REQUEST_TIMEOUT_MS` (240000) | `ZAI_MAX_RETRIES` (2) |

Z.ai's **general-purpose** API — not the coding-plan endpoint, which is a
different product with a different shape.

---

## 4. `frontier_development` role map

Recommended while the application is in development.

| Role | Primary | Secondary | Tertiary | Legacy backup |
|------|---------|-----------|----------|---------------|
| Topic generation | `nvidia/deepseek-ai/deepseek-v4-flash` | `zai/glm-4.7-flash` | — | global |
| Topic classification | `nvidia/deepseek-ai/deepseek-v4-flash` | `zai/glm-4.7-flash` | — | global |
| Topic ranking | `nvidia/z-ai/glm-5.2` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `zai/glm-4.7-flash` | global |
| Research brief | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `nvidia/deepseek-ai/deepseek-v4-pro` | `zai/glm-4.7-flash` | global |
| Evidence extraction | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `nvidia/deepseek-ai/deepseek-v4-pro` | `zai/glm-4.7-flash` | global |
| Script outline | `nvidia/z-ai/glm-5.2` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `zai/glm-4.7-flash` | script |
| **Script movement** | `nvidia/mistralai/mistral-medium-3.5-128b` | `nvidia/moonshotai/kimi-k2.6` | `zai/glm-4.7-flash` | script |
| Script verification | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `zai/glm-4.7-flash` | verify |
| Script rewrite | `nvidia/mistralai/mistral-medium-3.5-128b` | `nvidia/moonshotai/kimi-k2.6` | `zai/glm-4.7-flash` | script |
| Continuity report | `nvidia/deepseek-ai/deepseek-v4-flash` | `nvidia/deepseek-ai/deepseek-v4-pro` | `zai/glm-4.7-flash` | verify |
| Fact-check | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `zai/glm-4.7-flash` | verify |
| Show notes | `nvidia/deepseek-ai/deepseek-v4-flash` | `zai/glm-4.7-flash` | — | global |
| Episode metadata | `nvidia/mistralai/mistral-medium-3.5-128b` | `nvidia/moonshotai/kimi-k2.6` | `zai/glm-4.7-flash` | global |
| Quality judge | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `nvidia/z-ai/glm-5.2` | — | verify (Anthropic benchmark judge) |

The judge chain deliberately shares no model with `script_movement`: a writing
model must never be the only judge of its own output.

### `free_independent` role map

Every role → `zai/glm-4.7-flash`, with the role-appropriate existing provider as
the paid backup. This profile exists to answer one question: can a single
independent free provider carry the whole production chain without NVIDIA hosted
capacity?

### Legacy backup families

| Family | Resolution | Roles |
|--------|-----------|-------|
| global | `LLM_PROVIDER` / `LLM_MODEL` | topics, classification, ranking, research, evidence, show notes, metadata |
| script | `SCRIPT_LLM_PROVIDER` > `LLM_PROVIDER`, `SCRIPT_LLM_MODEL` | outline, movement, rewrite |
| verify | `VERIFY_LLM_PROVIDER` > `FACTCHECK_LLM_*` > `SCRIPT_LLM_*` > `LLM_PROVIDER`; `VERIFY_MODEL` > `claude-sonnet-5` on Anthropic | verification, fact-check, continuity, judge |

The verifier is never the first creative-writing fallback, and a
high-temperature creative configuration is never used for fact-checking.

Current repository values: `LLM_PROVIDER=anthropic`,
`ANTHROPIC_MODEL=claude-sonnet-5`, `SCRIPT_LLM_PROVIDER=anthropic`,
`SCRIPT_LLM_MODEL=claude-opus-5`, `VERIFY_LLM_PROVIDER`/`VERIFY_MODEL` empty
(so verify resolves to `anthropic/claude-sonnet-5`).

---

## 5. Precedence

```
1. explicit role override      <PREFIX>_LLM_PROVIDER / <PREFIX>_LLM_MODEL
2. profile primary
3. profile secondary
4. profile tertiary
5. role-appropriate existing provider   (legacyBackup family)
6. fail clearly, naming every candidate and its failure category
```

Implemented once, in `routing.ts`. No service duplicates any part of it.

- **Loop-proof**: candidates are de-duplicated by `provider/model` before the
  chain runs, so an alias (an override that names the primary, a legacy backup
  identical to the tertiary) can never re-run an endpoint or cycle.
- **Legacy is a bypass, not a chain**: `legacy` + no override returns the exact
  provider instance the old code built — same class, same eager construction,
  same construction-time errors, no wrapper.
- Overrides are never suppressed by the paid gate: an explicit override *is* the
  operator's decision.

---

## 6. Role parameters

Per role, applied only where the model accepts them and never overriding a value
the caller passed:

| Role | Reasoning | Temperature | Structured |
|------|-----------|-------------|-----------|
| topic_generation | off | 0.25 | yes |
| topic_classification | off | 0.1 | yes (enum-validated) |
| topic_ranking | on | 0.2 | yes |
| research_brief | on | 0.2 | yes |
| evidence_extraction | on | 0 | yes |
| script_outline | on | ≤0.7 | yes |
| script_movement | off (no visible reasoning in dialogue) | 0.85 | yes |
| script_verification | on | 0 | yes |
| script_rewrite | off | 0.5 | yes |
| continuity_report | off | 0 | yes |
| fact_check | on | 0 | yes |
| show_notes | off | 0.2 | yes |
| episode_metadata | off | 0.6 | yes |
| quality_judge | on | 0 | yes |

### The 16,000-token movement allowance

`SCRIPT_GEN_MAX_TOKENS=16000` reaches the provider **unchanged**.
`resolveMaxTokens()` only ever rejects, never reduces:

- unknown/unverified output cap → the caller's value passes through untouched;
- **confirmed** cap that the request exceeds → `UnsupportedOutputLimitError`,
  because silently halving a movement produces a truncated episode that looks
  like a model failure.

---

## 7. Structured output

`structured.ts` rejects rather than salvages whenever salvage would be a guess:

1. provider JSON mode when the model supports it, plus instruction-based forcing;
2. the caller's real schema, when one exists (`semanticReview` passes a genuine
   `jsonSchema`), used for required-array checks;
3. caller-supplied structural validators at the provider edge — `validateScriptShape`
   rejects a script with no segments or no lines, and the topic/classification/
   outline calls assert their load-bearing keys;
4. markdown fences stripped;
5. leading/trailing prose stripped only when a complete balanced object isolates;
6. **truncated JSON rejected, never patched** (brace/string-aware scan);
7. `{}`, non-objects and bare arrays rejected — never "success with no content";
8. exactly **one** schema-repair request, with the specific defect named;
9. then, and only then, the next candidate in the role chain.

No application schema was weakened to make a model pass.

---

## 8. Reasoning content

Reasoning never reaches dialogue, script segments, show notes, episode
descriptions, TTS input, parsed structured output, or any user-facing text.

- `reasoning_content` / `reasoning` are parsed out of the message and returned
  separately by `extractContent()`; both public entry points discard them.
- The JSON parser is handed **only** the answer text, so reasoning cannot enter
  structured application data.
- Recorded: whether reasoning was requested, the provider-reported reasoning
  token count, and the call duration. The reasoning **text** is not logged unless
  an operator sets `LLM_LOG_REASONING=true` for a debugging session.
- A reasoning model that spends its whole allowance thinking and returns an empty
  answer is reported as exactly that, not as an empty success.

---

## 9. Retry and fallback

Retried against the same model: 408, 409, 425, 429 (rate-limit shaped), 5xx,
connection resets, DNS failures, aborts/timeouts, empty responses. Exponential
backoff (base 3ⁿ, capped 30 s), ±30 % jitter, `Retry-After` honored,
`AbortController` timeout, bounded attempt count.

**Not** transient — no same-model retry, category preserved through the fallback:
missing API key, invalid authentication, invalid model id, invalid application
schema, unsupported request parameter, safety refusal, hard quota exhaustion,
programming error.

One deliberate exception: a 400 that names an unsupported *request field* is a
capability-registry defect, so the field is dropped once and the request is
re-sent, logged and counted as a **parameter downgrade** (never as a transient
retry). This is what keeps an unverified capability record from failing a role
outright — and it tells you exactly which registry entry to fix.

### Paid fallback control

`LLM_ALLOW_LEGACY_FALLBACK` — **default `true`**.

- `true`: after the free candidates fail, the role-appropriate existing provider
  runs. Every such call logs `[LLMRouting] PAID FALLBACK` with the role and model
  and lands in the ledger. Nothing is silent.
- `false`: NVIDIA may fall back to Z.ai and Z.ai to another configured free
  model, but Anthropic/OpenAI are never invoked automatically; the role fails
  instead, and the error names what was suppressed.

The default is `true` because the legacy providers are the safety net that keeps
an episode from dying on a rate-limited trial endpoint. That is a cost decision,
so it is stated here rather than buried.

---

## 10. Cost and usage ledger

`recordLlmCall` now records, per call: role, profile, candidate source, provider,
model, input tokens, cached input tokens, reasoning tokens, output tokens,
duration, attempts, retries, fallbacks, structured repairs, success/failure with
category, and an estimated cost.

Two honesty rules:

- token counts are always provider-reported, never inferred;
- `estimatedCostUsd` is `null` for free/unpriced endpoints **and** whenever no
  rate is configured. Rates come from `LLM_PRICE_<PROVIDER>_IN/_OUT`; the code
  ships none, so it can never state a confident wrong price.

---

## 11. Deployment stage

`APP_DEPLOYMENT_STAGE` = `development` | `staging` | `live`, defaulting to
`development`.

`NODE_ENV` is the wrong signal: development and staging deployments routinely run
production builds, so gating NVIDIA on `NODE_ENV=production` would disable it in
exactly the environments it is for.

- `development`, `staging`: hosted NVIDIA endpoints fully permitted, silently.
- `live`: **still permitted**, with a readiness advisory that hosted access is a
  trial service whose capacity, terms and availability should be reviewed before
  customer traffic. Nothing is auto-disabled, nothing is silently re-routed. The
  launch decision is the operator's.

---

## 12. Readiness display

The resolved role map appears in three places, all credential-free:

- `/admin/configuration` → "LLM Role Routing" panel: profile, stage, paid-fallback
  state, the trial advisory, and a per-role table of primary / secondary /
  legacy backup / status with notes.
- `GET /api/readiness` → `llm_role_routing` check with the full per-role detail.
- `getLlmRoutingChecks()` inside the production env checklist: a missing
  credential for a provider the active profile calls is a **fail**; a degraded
  chain or a live-stage trial endpoint is a **warning**; an unrecognized
  `LLM_ROUTING_PROFILE` value is a **fail**, because it silently resolves to
  legacy and an operator who typed `frontier-development` would otherwise
  believe the new routing was live.

Statuses: `ready`, `degraded` (running on a reduced chain), `unroutable` (no
usable candidate), `no LLM call yet` (the role is declared but deterministic
today).

---

## 13. Web/worker agreement

`routingEnv.ts` holds a **statically-referenced** snapshot of every routing
variable. Next.js inlines `process.env` at build time, and a computed read
(`process.env[`${prefix}_LLM_PROVIDER`]`) can only see variables that are also
referenced literally in the same bundle. Without the snapshot the web app would
resolve every role override as unset while the worker resolved them correctly,
and the two services would run different models for the same episode.
`npm run test:llm-routing` asserts every role override pair and every provider
key is present in that snapshot.

---

## 14. Development experiments

```bash
npm run test:role-experiments -- --experiment dialogue
npm run test:role-experiments -- --experiment outline
npm run test:role-experiments -- --experiment verification
```

Targeted per-role comparisons on this application's real work, not generic
benchmarks. Every candidate receives byte-identical inputs — same research
packet, outline, character definitions, previous-movement context, target length,
prompt, schema and output allowance. Incomplete or failed generations are
reported as failures, never hidden or silently retried into a win.

The in-pipeline dialogue challenger (`SCRIPT_CHALLENGER_ENABLED=true`,
`SCRIPT_CHALLENGER_PROVIDER`, `SCRIPT_CHALLENGER_MODEL`) generates each movement
a second time from identical inputs and reports both. Its dialogue never enters
the episode — one episode is written by one dialogue model.

### Promotion rule

The initial assignments in `profiles.ts` are defaults, not verdicts. A candidate
keeps or takes a role only when it completes the required JSON reliably, supports
the required output length, matches or beats the incumbent on role-specific
quality, adds no unacceptable latency, and does not drive up retry/fallback
rates. Any assignment changed by test evidence must be documented in the profile
map with the evidence that changed it. The deterministic scorer
(`episodeQualityService`) is not to be rewritten to make a new profile win.

---

## 15. Rollback — one variable

```env
LLM_ROUTING_PROFILE=legacy
```

Then redeploy **both** services:

```bash
# web and worker deploy separately — do both, or they run different routing
```

No code change, no database change, and no need to delete the NVIDIA or Z.ai
credentials. Every role returns to the exact provider it used before this
feature: `legacy` + no role override bypasses the router entirely.
