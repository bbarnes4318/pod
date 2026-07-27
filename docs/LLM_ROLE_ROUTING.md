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

### 3b. Capability registry: catalog vs LIVE verification

One `verified` flag conflated two very different claims and made both useless.
There are now two:

| Field | Claim |
|---|---|
| `catalogVerified` | the model ID and its documented availability were confirmed from the official provider catalog |
| `liveContractVerified` | this repository called the model successfully with the current key and adapter, and a probe recorded which fields it accepted |

A model can be catalog-verified and still have entirely unverified request
parameters. That is the normal starting state, and it is what readiness reports.

### State after the live probe of 2026-07-26

| Model | Catalog | Live contract | What the probe found |
|---|---|---|---|
| `deepseek-ai/deepseek-v4-pro` | ✅ | ✅ | cleanest of the six; native JSON + seed work; `reasoning_budget` rejected; `reasoning_content` returned |
| `nvidia/nemotron-3-ultra-550b-a55b` | ✅ | ✅ | `enable_thinking` + top-level `reasoning_budget` accepted; **top-level `thinking` rejected**; reasoning-separation probe hit a 503, so unknown |
| `z-ai/glm-5.2` | ✅ | ✅ | reasoning **confirmed by output** (`reasoning_content`); `reasoning_budget` rejected — not Nemotron's contract |
| `mistralai/mistral-medium-3.5-128b` | ✅ | ✅ | **rejects `chat_template_kwargs` entirely**; only top-level `reasoning_effort` works; **30–88 s latency** |
| `deepseek-ai/deepseek-v4-flash` | ✅ | ❌ | `503 ResourceExhausted (48/48)` on every attempt — capacity, not capability |
| `moonshotai/kimi-k2.6` | ❌ | ❌ | `404 Not found for account` — the ID does not resolve for this key |
| `zai/glm-4.7-flash` | ✅ | ✅ | answered, **but accepted an invented parameter** — see below |

Two findings changed how the registry is written:

- **Mistral rejects `chat_template_kwargs`** (*"chat_template is not supported for
  Mistral tokenizers"*). The original provider-wide `reasoningSpelling:
  "chat_template_kwargs"` would have 400'd **every Mistral call**. The per-model
  split fixed a real breakage.
- **Z.ai does not validate unknown parameters.** It returned 200 for
  `chat_template_kwargs` — a field only NVIDIA's NIM transport implements. On such
  an endpoint a 200 cannot distinguish *honored* from *silently ignored*, so its
  `json` / `seed` / `effort` / `budget` flags were **not** upgraded despite the
  probe recommending it. Only claims provable from **output** were taken:
  `reasoning_content` is genuinely returned. The probe now runs a leniency control
  (an invented parameter name) so a future run can tell the two cases apart, and
  suppresses the capability columns for any endpoint that fails it.

And one operational finding worth knowing before you route anything to Z.ai: **it
reasons by default and will spend the entire allowance doing it.** On a
128-token probe it returned `finish_reason: length`, `completion_tokens: 128` of
which `reasoning_tokens: 128`, and **empty content**. Our provider reports that as
`output_limit` with the "spent its entire allowance on reasoning" message rather
than as an empty success, and the `zai-glm` profile sends
`thinking: { type: "disabled" }` explicitly for roles that don't want it.

Two hard rules follow:

- **Output limits are enforceable only when live-verified.** A number copied off a
  model card lives in `documentedMaximumOutputTokens`, which is informational and
  can never shrink a request. `maximumOutputTokens` is set only by a probe. So the
  16,000-token movement allowance passes through untouched today, and only a
  *measured* cap can ever reject it (loudly — see §6).
- **`provenance` records where every claim came from** (`catalog`, `requestFields`,
  `limits`), so nobody has to guess later which numbers were measured and which
  were read.

Readiness distinguishes exactly three states: `catalog-verified-live-untested`,
`live-contract-verified`, `catalog-unavailable`.

### 3c. Per-MODEL NVIDIA request shaping

A provider-wide `reasoningSpelling` was wrong. NVIDIA's hosted models do not share
one reasoning contract, so each gets a typed profile with its own shaping function
(`nvidiaRequestProfiles.ts`), selected by `requestParameterProfile`:

| Profile | Models | Reasoning ON sends | Reasoning OFF sends |
|---|---|---|---|
| `deepseek-v4` | DeepSeek V4 Flash + Pro | `chat_template_kwargs: { thinking: true, reasoning_effort: <level> }` — effort **nested** | `chat_template_kwargs: { thinking: false }` |
| `nemotron-3-ultra` | Nemotron 3 Ultra | `chat_template_kwargs: { enable_thinking: true }` + **top-level** `reasoning_budget` | `chat_template_kwargs: { enable_thinking: false }` |
| `mistral-medium-3-5` | Mistral Medium 3.5 | **top-level** `reasoning_effort` | *nothing* |
| `kimi-k2-6` | Kimi K2.6 | *nothing* | *nothing* |
| `glm-5-2` | GLM-5.2 via NVIDIA | `chat_template_kwargs: { thinking: true, reasoning_effort: <level> }` — **verified**, no budget | `chat_template_kwargs: { thinking: false }` |
| `generic-nim` | any unregistered NVIDIA model | *nothing* | *nothing* |

Corrections and deliberate choices baked in here:

- **DeepSeek V4 Flash is a reasoning model.** The previous registry declared it
  incapable of thinking. Fixed; both Flash and Pro take the same shape.
- **Nemotron is never sent DeepSeek's `thinking` alias.** Nothing proves it accepts
  it, and NVIDIA's own example for this model uses `enable_thinking`. Note that
  *other* Nemotron variants use different controls again (the self-hosted NIM docs
  show `max_thinking_tokens` and env switches for Nano/Super) — which is why the
  record is keyed to this exact model, not to "nemotron".
- **Mistral keeps reasoning OFF for dialogue.** Its production job here is the
  16,000-token movement call; adding hidden reasoning overhead to every one of
  those is a real cost and latency change, and no application-specific experiment
  has justified it yet.
- **Kimi gets no `response_format` and no reasoning field**, because NVIDIA's
  deployment information advertises neither.
- **GLM-5.2 was unconfirmed and is now verified.** The probe accepted
  `chat_template_kwargs.thinking` *and* the response came back with
  `reasoning_content`, so it reasons for real and the profile now sends the
  control. `reasoning_budget` is still omitted — this model 400s on it while
  Nemotron accepts it, which is precisely the guess the per-model split refused
  to make. A run still only claims it reasoned when the response actually
  returns reasoning content.

Nemotron's thinking budget is configurable per role family
(`NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH` / `_VERIFY` / `_JUDGE`, with
`NVIDIA_NEMOTRON_REASONING_BUDGET` as the fallback, default 4096), clamped to the
documented 256–16384 range, and **capped to half the caller's `max_tokens`** so a
1,200-token continuity call can never spend its whole allowance thinking and
return no answer.

One documented NIM quirk is respected throughout: the `developer` role combined
with `chat_template_kwargs` produces 500s, so the system prompt always goes in the
`system` role.

---

## 4. `verified_development` role map — the observed-working profile

**Use this for development.** Built ONLY from models that passed the live contract
probe. It is a statement about which endpoints work, **not** a verdict on which
models are best — nothing here has been through a role-quality experiment.

| Role | Primary | Secondary | Legacy backup |
|---|---|---|---|
| Topic generation | `zai/glm-4.7-flash` *(reasoning off)* | `nvidia/z-ai/glm-5.2` | global |
| Topic classification | `zai/glm-4.7-flash` *(reasoning off)* | `nvidia/deepseek-ai/deepseek-v4-pro` | global |
| Topic ranking | `nvidia/z-ai/glm-5.2` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | global |
| Research brief | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | global |
| Evidence extraction | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | global |
| Script outline | `nvidia/z-ai/glm-5.2` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | script |
| **Script movement** | `nvidia/mistralai/mistral-medium-3.5-128b` | `zai/glm-4.7-flash` | script |
| Script verification | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | verify |
| Script rewrite | `nvidia/mistralai/mistral-medium-3.5-128b` | `zai/glm-4.7-flash` | script |
| Fact-check | `nvidia/deepseek-ai/deepseek-v4-pro` | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | verify |
| Continuity report | `nvidia/deepseek-ai/deepseek-v4-pro` | `zai/glm-4.7-flash` | verify |
| Show notes | `zai/glm-4.7-flash` *(reasoning off)* | `nvidia/deepseek-ai/deepseek-v4-pro` | global |
| Episode metadata | `zai/glm-4.7-flash` *(reasoning off)* | `nvidia/mistralai/mistral-medium-3.5-128b` | global |
| Quality judge | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `nvidia/z-ai/glm-5.2` | verify (Anthropic, explicit only) |

The Z.ai-primary roles all declare `reasoning: "off"` in `roles.ts`, and the
`zai-glm` profile sends the disable control **explicitly** — because the probe
showed GLM-4.7 Flash reasons by default and will spend a whole small allowance
doing it. Leaving the flag unset would let the model's default win.

### The availability filter

Two models are excluded from **every** default profile chain, not just this one:

| Model | State | Observation |
|---|---|---|
| `deepseek-ai/deepseek-v4-flash` | `capacity-limited` | `503 ResourceExhausted (48/48)` on every probe request |
| `moonshotai/kimi-k2.6` | `unavailable-for-account` | `404 Not found for account` |

Filtering happens in `filterProfileChain()`, before the chain runs. Leaving a
503-limited or 404 model in place costs a real attempt on **every request** — and
on a role whose primary already takes 30–88 s, burning attempts before reaching a
usable model makes every production-chain run slower and every failure harder to
read.

Nothing is deleted. Their capability records, providers and integration are
intact, and an **explicit role override still reaches them** — that is the retest
path, and routing logs a warning saying so:

```env
SCRIPT_MOVEMENT_LLM_PROVIDER=nvidia
SCRIPT_MOVEMENT_LLM_MODEL=moonshotai/kimi-k2.6
```

A model returns to the default profiles only when its capability record says
`availability: "available"` — i.e. when a live contract probe passes.

`frontier_development` is kept unchanged as the **documented intent**, so what we
want stays readable next to what this account can currently reach. Its declared
chain still names Kimi; its runnable chain does not, and `filteredUnavailable`
reports the difference per role.

## 5. `frontier_development` role map (documented intent)

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

## 6. Precedence

```
1. explicit role override      <PREFIX>_LLM_PROVIDER / <PREFIX>_LLM_MODEL
2. profile primary
3. profile secondary
4. profile tertiary
5. role-appropriate existing provider   (legacyBackup family)
6. fail clearly, naming every candidate and its failure category
```

Implemented once, in `routing.ts`. No service duplicates any part of it.

- **Loop-proof, by TRUE ENDPOINT IDENTITY**: candidates are de-duplicated on
  `provider | normalizedBaseUrl | model` before the chain runs. Provider/model
  alone is *not* endpoint identity — with a custom `NVIDIA_BASE_URL` or
  `ZAI_BASE_URL`, two candidates can name the same provider and model while
  pointing at different services, and two differently-spelled base URLs can
  reach the same one. Normalization folds trailing slashes, case and default
  ports, so an alias (an override that names the primary in different case, a
  legacy backup identical to the tertiary) can never re-run one endpoint or
  cycle, while a genuinely different endpoint stays a separate attempt.
- **Legacy is a bypass, not a chain**: `legacy` + no override returns the exact
  provider instance the old code built — same class, same eager construction,
  same construction-time errors, no wrapper.
- Overrides are never suppressed by the paid gate: an explicit override *is* the
  operator's decision.

---

## 7. Role parameters

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

## 8. Structured output

Support is **three separate questions per model**, not one:

| Capability | Meaning |
|---|---|
| `supportsNativeJsonSchema` | accepts `response_format: { type: "json_schema", … }` |
| `supportsNativeJsonObject` | accepts `response_format: { type: "json_object" }` |
| `supportsPromptEnforcedJson` | reliably returns JSON when the prompt demands it |

Mode selection (`structuredOutputMode`):

```
native JSON schema supported AND a schema exists  -> json_schema mode
else native JSON-object mode supported            -> json_object mode
else                                              -> send NO response_format;
                                                     enforce JSON in the prompt;
                                                     parse and validate strictly
```

Every NVIDIA model currently declares **no** native support, so the default path
sends no `response_format` at all. That is deliberate: the documentation does not
confirm native support for these models, provoking a 400 once per process to
discover something the docs already imply is wasteful, and prompt-enforced JSON
plus the strict parser is the mechanism the Anthropic provider has always used —
proven in this application, not merely permissible. A probe can upgrade a record.

**A successful prompt-enforced JSON response is not evidence of native JSON
support.** Only the probe's explicit native-mode test can set those flags.

`structured.ts` then rejects rather than salvages whenever salvage would be a guess:

1. the mode above, plus instruction-based forcing;
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

## 9. Reasoning content

Reasoning never reaches dialogue, script segments, show notes, episode
descriptions, TTS input, parsed structured output, or any user-facing text.

- `reasoning_content` / `reasoning` are parsed out of the message and returned
  separately by `extractContent()`; both public entry points discard them.
- The JSON parser is handed **only** the answer text, so reasoning cannot enter
  structured application data.
- Recorded as **two separate facts**: `reasoningRequested` (what we asked for) and
  `reasoningReturned` (whether the response actually carried reasoning content),
  plus the provider-reported reasoning token count and the call duration. Asking
  for reasoning is not evidence that any occurred — a role must never be reported
  as having reasoned because it requested it. When reasoning is requested and none
  comes back, the log says so explicitly.
- The reasoning **text** is not logged unless an operator sets
  `LLM_LOG_REASONING=true` for a debugging session.
- A reasoning model that spends its whole allowance thinking and returns an empty
  answer is reported as exactly that, not as an empty success.

---

## 10. Retry and CATEGORY-AWARE fallback

The failure's **category** decides what happens next. `errors.ts` classifies;
`fallbackPolicy.ts` decides; `routing.ts` obeys. Nothing else makes this call.

Advancing after *every* caught error — the original behavior — is wrong twice
over. It buried real defects (a bad application schema failed identically on four
providers before surfacing) and it spent money quietly (a configuration mistake
walked into the paid provider, the episode "succeeded", and the misconfiguration
stayed invisible).

| Group | Categories | Same-model retry | Next candidate |
|---|---|---|---|
| Recoverable | `rate_limited`, `temporary_unavailable`, `network_error`, `timeout`, `provider_internal_error`, `model_temporarily_unavailable` | yes | yes |
| Recoverable, no retry | `empty_response`, `output_limit`, `structured_output_invalid_after_repair`, `quota_exhausted` | no | yes |
| **Terminal** | `invalid_application_schema`, `programming_error`, `unsupported_role`, `safety_refusal`, `prompt_policy_violation`, `data_validation_bug` | no | **no — the chain STOPS** |
| Configuration | `missing_api_key`, `authentication_failed`, `invalid_model`, `unsupported_parameter` | no | free candidates only (see below) |

`quota_exhausted` is separated from `rate_limited` on purpose: a spent free-tier
allowance does not refill in two seconds, so retrying is waste while falling
through is exactly right.

When a terminal category stops the chain, the ORIGINAL error's category, provider
and model are preserved on the way out — a safety refusal is reported as a safety
refusal, not as a generic routing failure.

Retry mechanics for the recoverable set: exponential backoff (base 3ⁿ, capped
30 s), ±30 % jitter, `Retry-After` honored, `AbortController` timeout, bounded
attempt count.

The pre-existing Anthropic and OpenAI providers throw plain `Error`s and are
deliberately left untouched, so `categoryOf()` parses their messages into the
same taxonomy. Without that, every legacy-provider failure classified as
"unknown" and the router treated all of them as recoverable.

### Parameter downgrade — narrow, and not the normal path

A 400 that **specifically names** a request field we sent is a capability-registry
defect: the field is dropped for the process, the request is re-sent **once**, and
it is counted as a **parameter downgrade**, never as a transient retry. An
**ambiguous** 400 strips nothing — guessing which field to remove is worse than
failing, and the log says so.

Because the registry now declares each model's real support (§3), the normal path
never provokes such a 400 at all. A downgrade firing is a signal that a capability
record is wrong, not routine operation.

### Paid fallback control

`LLM_ALLOW_LEGACY_FALLBACK` — **default `false`**.

| Value | Mode | Behavior |
|---|---|---|
| `false` (default) | **Comparison** | A role that exhausts its free candidates FAILS. Anthropic/OpenAI are never invoked automatically. The error names what was suppressed. |
| `true` | **Resilient** | After the free candidates fail, the role-appropriate existing provider runs. For full-pipeline runs where finishing the episode matters more than isolating the candidate. |

The default is `false` for measurement integrity: while candidates are being
evaluated, a quiet paid fallback makes a failing free model look like a working
one — the episode completes, the A/B table fills in, and the number you end up
trusting was produced by Anthropic.

Two extra rules:

- A **configuration** failure may advance among free candidates, but crossing into
  a paid provider to paper one over requires `LLM_ALLOW_LEGACY_FALLBACK` to be set
  **explicitly** to `true`. An inherited default is not consent.
- Every paid fallback logs a full audit record before the call: role, which free
  candidates failed, their failure categories, the paid provider and model, and
  why paid fallback was permitted.

---

## 11. Cost and usage ledger

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

## 12. Deployment stage

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

## 13. Readiness display

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

Model verification is reported **separately from role status**, in FIVE states,
both per candidate and as an `LLM_MODEL_VERIFICATION` roll-up:

| State | Meaning | Current members |
|---|---|---|
| `catalog-available` | the ID is in the catalog; no live request attempted | — |
| `not-quality-tested` | live contract PASSED; nothing has measured role quality | all five reachable models |
| `live-contract-passed` | live contract passed AND quality-tested | none yet |
| `live-contract-failed` | endpoint would not serve this account (503) | `deepseek-v4-flash` |
| `unavailable-for-account` | the ID does not resolve for this credential (404) | `kimi-k2.6` |

The distinction that matters most is `not-quality-tested` vs `live-contract-passed`:
an HTTP 200 says the endpoint works, not that the model writes a podcast anyone
wants to hear. Nothing reaches `live-contract-passed` until
`npm run test:role-experiments` produces evidence.

Role experiments — one role at a time, identical inputs per candidate.

=== DIALOGUE EXPERIMENT (role: script_movement) ===
Three episode situations x every candidate. Identical outline, evidence, character prompt, continuity
state, previous-movement transcript, target duration, prompt, schema and 16,000-token allowance.


  EXCLUDED — endpoint unreachable, NOT a quality judgement:
    nvidia/deepseek-ai/deepseek-v4-flash         capacity-limited: 503 ResourceExhausted — the endpoint would not serve this account
    nvidia/moonshotai/kimi-k2.6                  unavailable-for-account: 404 Not found for this account — the ID does not resolve for the credential in use

--- Evidence-heavy disagreement ---
    testing: Can the model argue from a dense fact set without fabricating a number, and keep two positions distinct while both cite the same evidence?

--- Emotional / character-revealing disagreement ---
    testing: Can the model let a disagreement expose something personal without collapsing into therapy-speak, and keep the two voices asymmetric when the scene is quiet?

--- Fast, humorous sports discussion ---
    testing: Can the model hold a comic rhythm — short turns, interruptions, a callback that lands — without stapling jokes on or writing essay sentences?

Per-candidate rollup across all three situations (judge axes 0-10, higher is better):
candidate                                 verify          completion     validJson  repairs  det  judge  distinct  causal  filler  mech  repeat  character  grounding  continuity  natural  oneVoice  firstMv  secs  tkOut
----------------------------------------  --------------  -------------  ---------  -------  ---  -----  --------  ------  ------  ----  ------  ---------  ---------  ----------  -------  --------  -------  ----  -----
nvidia/mistralai/mistral-medium-3.5-128b  live, untested  0/0 (skipped)  —          0        —    —      —         —       —       —     —       —          —          —           —        —         —        —     0    
zai/glm-4.7-flash                         live, untested  0/0 (skipped)  —          0        —    —      —         —       —       —     —       —          —          —           —        —         —        —     0    
stub/(provider default) [incumbent]       n/a             0/0 (skipped)  —          0        —    —      —         —       —       —     —       —          —          —           —        —         —        —     0    

  firstMv = seconds to the FIRST completed movement; secs = the full three-movement episode.
  Movements are SEQUENTIAL, so a slow model multiplies — judge latency on firstMv x3, not on one prompt.

Per-situation detail:
situation            candidate                                 status                                           lines  words  rep  det  judge  secs
-------------------  ----------------------------------------  -----------------------------------------------  -----  -----  ---  ---  -----  ----
evidence_heavy       nvidia/mistralai/mistral-medium-3.5-128b  SKIPPED (no credential for nvidia)               0      0      —    —    —      0   
evidence_heavy       zai/glm-4.7-flash                         SKIPPED (no credential for zai)                  0      0      —    —    —      0   
evidence_heavy       stub/(provider default) [incumbent]       SKIPPED (resolves to stub — nothing to measure)  0      0      —    —    —      0   
character_revealing  nvidia/mistralai/mistral-medium-3.5-128b  SKIPPED (no credential for nvidia)               0      0      —    —    —      0   
character_revealing  zai/glm-4.7-flash                         SKIPPED (no credential for zai)                  0      0      —    —    —      0   
character_revealing  stub/(provider default) [incumbent]       SKIPPED (resolves to stub — nothing to measure)  0      0      —    —    —      0   
fast_humorous        nvidia/mistralai/mistral-medium-3.5-128b  SKIPPED (no credential for nvidia)               0      0      —    —    —      0   
fast_humorous        zai/glm-4.7-flash                         SKIPPED (no credential for zai)                  0      0      —    —    —      0   
fast_humorous        stub/(provider default) [incumbent]       SKIPPED (resolves to stub — nothing to measure)  0      0      —    —    —      0   

  artifact: C:\pod\.claude\worktrees\pod-role-based-llm-routing-a82ae4rtifacts
ole-experiment-dialogue.json

=== OUTLINE EXPERIMENT (role: script_outline) ===
Same evidence and episode requirements for every candidate; 7,000-token outline allowance.


  EXCLUDED — endpoint unreachable, NOT a quality judgement:
    nvidia/deepseek-ai/deepseek-v4-flash         capacity-limited: 503 ResourceExhausted — the endpoint would not serve this account
    nvidia/moonshotai/kimi-k2.6                  unavailable-for-account: 404 Not found for this account — the ID does not resolve for the credential in use
candidate                                 verify          status                                           beats  movements  facts  dupFacts  shifts  escalation  callbacks  coldOpen  payoff  repairs  secs
----------------------------------------  --------------  -----------------------------------------------  -----  ---------  -----  --------  ------  ----------  ---------  --------  ------  -------  ----
nvidia/z-ai/glm-5.2                       live, untested  SKIPPED (no credential for nvidia)               —      —          —      —         —       —           —          —         —       —        —   
nvidia/nvidia/nemotron-3-ultra-550b-a55b  live, untested  SKIPPED (no credential for nvidia)               —      —          —      —         —       —           —          —         —       —        —   
zai/glm-4.7-flash                         live, untested  SKIPPED (no credential for zai)                  —      —          —      —         —       —           —          —         —       —        —   
stub/(provider default) [incumbent]       n/a             SKIPPED (resolves to stub — nothing to measure)  —      —          —      —         —       —           —          —         —       —        —   

  dupFacts = the same evidence ref assigned to more than one beat (repetition risk).

  artifact: C:\pod\.claude\worktrees\pod-role-based-llm-routing-a82ae4rtifacts
ole-experiment-outline.json

=== VERIFICATION EXPERIMENT (roles: script_verification / fact_check) ===
Seeded set: 14 lines across 13 labelled categories — 7 genuinely defective, 7 legitimate.
False positives are weighted heavily in the read-out: an overactive verifier rewrites valid dialogue.


  EXCLUDED — endpoint unreachable, NOT a quality judgement:
    nvidia/deepseek-ai/deepseek-v4-flash         capacity-limited: 503 ResourceExhausted — the endpoint would not serve this account
    nvidia/moonshotai/kimi-k2.6                  unavailable-for-account: 404 Not found for this account — the ID does not resolve for the credential in use
candidate                                 verify          status                                           schema  caught  missed  falsePos  precision  recall  fpRate  fnRate  secs
----------------------------------------  --------------  -----------------------------------------------  ------  ------  ------  --------  ---------  ------  ------  ------  ----
nvidia/deepseek-ai/deepseek-v4-pro        live, untested  SKIPPED (no credential for nvidia)               —       —       —       —         —          —       —       —       —   
nvidia/nvidia/nemotron-3-ultra-550b-a55b  live, untested  SKIPPED (no credential for nvidia)               —       —       —       —         —          —       —       —       —   
zai/glm-4.7-flash                         live, untested  SKIPPED (no credential for zai)                  —       —       —       —         —          —       —       —       —   
stub/(provider default) [incumbent]       n/a             SKIPPED (resolves to stub — nothing to measure)  —       —       —       —         —          —       —       —       —   

  Ground truth — must be flagged:
    line  2 [incorrect_numerical_claim] Evidence says 6th, not 2nd. A verifier must catch the wrong figure.
    line  3 [unsupported_fact] 31 points appears nowhere in the evidence (the real figure is 24).
    line  4 [contradicted_fact] Contradicts line 0 and the evidence outright.
    line  9 [unsafe_claim] Explicitly listed as an unusable claim, and dressed as sourced reporting.
    line 10 [duplicate_argument] Verbatim repeat of line 1 — the same argument made twice.
    line 11 [character_violation] Zabala is the process host; this is Mulkey's position in her mouth.
    line 12 [continuity_violation] Thursday precedes the Friday option date, so there is no extra week.
  Ground truth — must NOT be flagged:
    line  0 [supported_fact] Directly supported by news-1.
    line  1 [correct_numerical_claim] 19 snaps is exactly what news-1 says.
    line  5 [reasonable_inference] An inference drawn from a supported fact. Must NOT be failed.
    line  6 [prediction] A prediction. Must NOT be treated as a factual error.
    line  7 [rhetorical_exaggeration] Obvious hyperbole in a debate show. Flagging it is a false positive.
    line  8 [opinion] Opinion, in character. Must NOT be failed.
    line 13 [supported_fact] Supported by inj-1. A verifier that misses this evidence will false-positive it.

  artifact: C:\pod\.claude\worktrees\pod-role-based-llm-routing-a82ae4rtifacts
ole-experiment-verification.json

0 candidate run(s) failed or came back incomplete. A failure here is a RESULT — it means that model could not do this role's job on this application's real work.

PROMOTION RULE — a model may retain or take a primary role ONLY if it:
  1. accepts the real request contract (see `npm run probe:llm-contract`),
  2. reliably completes the required JSON,
  3. accepts the required output allowance,
  4. meets or exceeds the incumbent on role-specific quality,
  5. does not introduce unacceptable latency,
  6. does not require frequent repair,
  7. does not trigger frequent fallback,
  8. does not materially damage character voice or factual accuracy.
A model that fails these stays INTEGRATED as an optional candidate but must not remain the default
primary merely because the original specification named it. Document any change in profiles.ts with
the evidence that justified it. produces evidence.

A role can therefore be `ready` (a credential is present, a chain exists) while
every model in it is still live-untested. Those are different questions and the
readout keeps them apart, so "ready" never reads as "validated".

---

## 14. Web/worker agreement

`routingEnv.ts` holds a **statically-referenced** snapshot of every routing
variable. Next.js inlines `process.env` at build time, and a computed read
(`process.env[`${prefix}_LLM_PROVIDER`]`) can only see variables that are also
referenced literally in the same bundle. Without the snapshot the web app would
resolve every role override as unset while the worker resolved them correctly,
and the two services would run different models for the same episode.
`npm run test:llm-routing` asserts every role override pair and every provider
key is present in that snapshot.

---

## 15. Live contract probe, then role experiments

**The order matters.** A quality comparison against a model whose request contract
was never verified measures the adapter as much as the model. So:

### Step 1 — establish the contract

```bash
npm run probe:llm-contract -- --provider nvidia
```

```bash
npm run probe:llm-contract -- --provider zai
```

Probes each configured model **independently** (they do not share a reasoning
contract, so one model's success says nothing about its siblings) and answers the
17 contract questions per model: model ID accepted, system prompt accepted, plain
text response, `max_tokens` accepted, temperature, seed, thinking enable, thinking
disable, `reasoning_effort` (**tested nested AND top-level, separately** — that
placement is the specific ambiguity the documentation left), `reasoning_budget`,
native JSON-object mode, native JSON-schema mode, reasoning returned separately,
usage field names, finish-reason field, a structured response without native JSON
mode, and a 16,000-token allowance.

The allowance test **requests** `max_tokens: 16000` with a one-sentence answer
instruction; it never generates 16,000 tokens to test a parameter.

Writes `artifacts/<provider>-contract-report.json` and `.md`, and prints the exact
recommended registry changes. It **never edits source** — auto-writing capability
records from provider responses is how a transient 400 becomes a permanent lie. An
`error` verdict (rate limit, outage) is never grounds for changing a flag, and a
model that fails the plain-request probe has every later question recorded as
`skipped` rather than as a capability answer.

### Step 2 — compare per role

```bash
npm run test:role-experiments -- --experiment dialogue
```

```bash
npm run test:role-experiments -- --experiment outline
```

```bash
npm run test:role-experiments -- --experiment verification
```

Targeted per-role comparisons on this application's real work, not generic
benchmarks. Candidates are instantiated **directly, bypassing the router**, so a
candidate's failure is recorded as that candidate's failure rather than being
silently substituted by a fallback.

**Dialogue** runs each candidate through **three episode situations**, because
dialogue models fail differently depending on what the scene asks for:

| Situation | What it tests |
|---|---|
| Evidence-heavy disagreement | arguing from a dense fact set without fabricating a number, while keeping two positions distinct |
| Emotional / character-revealing | letting a disagreement expose something personal without collapsing into therapy-speak |
| Fast, humorous | holding a comic rhythm without stapling jokes on or writing essay sentences |

Identical per candidate: research packet, outline (one shared outline model),
character definitions, continuity state, previous-movement transcript, target
duration, prompt version, 16,000-token allowance, schema and validation rules.
Measured: completion rate, valid-JSON rate, repair rate, retries, latency, token
usage, the deterministic score, and judge axes for host distinctness,
conversational causality, generic filler, mechanical alternation, repetition,
character consistency, evidence grounding, movement continuity and spoken
naturalness — plus how often the judge says both hosts sound like one model.

**Verification** uses a seeded set covering every required category with ground
truth: supported fact, contradicted fact, unsupported fact, reasonable inference,
opinion, prediction, rhetorical exaggeration, character violation, continuity
violation, duplicate argument, correct numerical claim, incorrect numerical claim
and an unsafe claim. It reports precision, recall, **false-positive rate**,
false-negative rate, schema completion and latency. False positives are weighted
heavily in the read-out: an overactive verifier rewrites valid dialogue, which
damages the show while looking like diligence.

Every result row carries the model's verification state (`live-verified` /
`catalog-only` / `unconfirmed`), so a quality number is never read without knowing
whether the contract behind it was ever tested. Incomplete or failed generations
are reported as failures, never hidden or silently retried into a win.

The in-pipeline dialogue challenger (`SCRIPT_CHALLENGER_ENABLED=true`,
`SCRIPT_CHALLENGER_PROVIDER`, `SCRIPT_CHALLENGER_MODEL`) generates each movement
a second time from identical inputs and reports both. Its dialogue never enters
the episode — one episode is written by one dialogue model.

### Promotion rule

The initial assignments in `profiles.ts` are **defaults, not verdicts**, and the
profile order is not to change until the tests above are complete.

A model may retain or take a primary role only when it:

1. accepts the real request contract (step 1 above);
2. reliably completes the required JSON;
3. accepts the required output allowance;
4. meets or exceeds the incumbent on role-specific quality;
5. does not introduce unacceptable latency;
6. does not require frequent repair;
7. does not trigger frequent fallback;
8. does not materially damage character voice or factual accuracy.

A model that fails these stays **integrated as an optional candidate** but must not
remain the default primary merely because the original specification named it. Any
assignment changed by evidence must be documented in the profile map with the
evidence that changed it, and the deterministic scorer (`episodeQualityService`) is
never to be rewritten to make a new profile win.

---

## 16. Rollback — one variable

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
