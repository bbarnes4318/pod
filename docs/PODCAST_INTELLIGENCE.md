# Podcast intelligence: sports and business

Take Machine runs two research engines on one production pipeline. `Podcast.intelligenceType`
(DB enum, default `SPORTS`) says which engine feeds a show.

| | Sports | Business |
|---|---|---|
| Research input | `TopicCandidate` + `ResearchBrief` (unchanged) | `BusinessProfile` → research runs → opportunities → dossiers |
| Creation | `/studio/shows/new?type=sports` (the existing wizard) | `/studio/shows/new/business` |
| Episode generation | unchanged | from an approved opportunity with a READY dossier (`BusinessEpisodeTopic` snapshot); `createEpisodeDraft` still refuses business shows |
| Recurring scheduler | unchanged (now filters `intelligenceType: SPORTS`) | not scheduled |

## Invariants

- Every podcast that existed before migration `20261121000000` is `SPORTS` via the column default. The
  creation path only ever accepted sports verticals, so that is a deterministic backfill, not a guess.
- The type is written once, server-side, as a literal (`businessActions.createBusinessPodcast`). No edit
  path — `savePodcastConfiguration`, the sports `updatePodcast` — can change it.
- A business show can't reach sports topics: `createEpisodeDraft` (which every creation route goes
  through) refuses it, as do the scheduler, the Studio episode builder, and the sports edit/generate actions.
- No sports table, column, score or URL changed. Business episodes link to `BusinessEpisodeTopic`, never `EpisodeTopic`/`TopicCandidate`; `resolveEditorialPacket` refuses mixed links either way.

## Rollout

Business shows are visible to owner/admin accounts (`OWNER_EMAILS` / role ADMIN) and to everyone else only
with `BUSINESS_PODCASTS_ENABLED=1` (web service). Sports is never behind a flag.

## Business engine (what exists)

Pipeline: setup → discovery → adaptive questions → industry research → demand → topics → scoring →
dossier → editorial approval → episode → grounded script → fact-check → the existing audio path.

### Claim verification (`src/lib/business/claimVerification.ts`)
Every source-backed claim — profile findings, topic key claims, dossier facts — goes through `verifyClaim`.
Provenance: `USER_PROVIDED`, `USER_CONFIRMED` (the owner's claim, not independent), `SOURCE_SUPPORTED`,
`SOURCE_CONTRADICTED`, `AI_INFERRED`, `UNVERIFIED` (`SOURCE_VERIFIED`/`UNKNOWN` are legacy, still read).
In order: the quote must exist verbatim (else fabricated → `UNVERIFIED`); deterministic contradictions in
money/percent/year/number and place names → `SOURCE_CONTRADICTED`; an independent source must name the
entity; time-sensitive claims (prices, rates, "currently") need a source ≤540 days old; every number in
the claim must be in the quote; ≥80% lexical coverage passes, otherwise the independent `fact_check` judge
must say "entailed". Marketing language caps confidence at 0.5. The business's own site is `FIRST_PARTY`,
never "independent". Syndicated copies collapse to one origin (5-gram shingles).

### Discovery (`discovery.ts`)
robots.txt (honoured), homepage links + sitemap.xml, page scoring (pricing, services, products,
industries, FAQ, about, case studies, locations, docs, blog), ≤2 pages per kind, default 8 pages,
same-origin only, legal/login/asset paths never fetched, near-duplicate pages skipped. Pages are stored as
`FIRST_PARTY_SITE` sources so research and dossiers can cite them.

### Profile → research routing (`profileSchema.ts`, `researchContext.ts`, `adaptiveQuestions.ts`)
Each advanced field declares the passes that read it (`queries`, `topics`, `insider`, `dossier`, `script`,
`exclude`); a test proves every field reaches every pass it declares. First target audience = primary
(setup accepts custom audiences and a chosen primary). Adaptive questions: 3–5 per batch, targeted at the
highest-value empty fields, validated in code (known field, no duplicates, no numbers/facts), templates
when no model; answered and skipped questions persist and are never re-asked. User text is fenced as data
in every prompt.

### Research runs (`researchEngine.ts`, `researchProviders.ts`, `businessJobs.ts`)
`BusinessResearchRun` on the `podcast-generation` queue (`business:research`, `business:dossier`), depth
QUICK/STANDARD/DEEP with query, model-call, cost and time budgets; cancel; idempotency key per profile
version and day; 7-day per-query cache; retry with backoff on retryable provider errors; usage (requests,
model calls, cost-ledger spend, cache hits, retries) stored on the run.
Passes: A plan (`research_brief`) → B Exa sources + demand adapters → C/D mechanisms + structured
opportunities (`topic_generation`, one call) → E/F verify every key claim, score, hold → G independent
review (`quality_judge`). Invented source/observation ids are discarded and reported.

Demand adapters — honest about what they measure:

| Adapter | Status | Measures |
|---|---|---|
| YouTube Data API | needs `YOUTUBE_API_KEY` | views/engagement on matching videos |
| Hacker News (Algolia) | keyless | discussion points (tech-skewed) |
| Apple Podcasts search | keyless | **supply** (matching shows), never demand |
| Exa publications | needs `EXA_API_KEY` | coverage volume in the last year |
| Search trends / Search Console / keyword volume / first-party analytics | **not integrated** | reported as a limitation on every run |

No volume, downloads or interest figure is ever estimated where no adapter measured it.

### Scoring (`scoring.ts`)
Demand **confidence** (how sure: independent origins, families, measured share, quality) is separate from
demand **strength** (how much: per-metric buckets → NONE/LOW/MODERATE/HIGH, or UNMEASURED).
**Potential IAS** is scored at topic time (evidence depth capped by what verification found);
**achieved IAS** is scored after the dossier from verified claims, origins, completed analyses, practical
applications and specificity. The IAS/opportunity weights and demand labels from the foundation are
unchanged. Hold gates: genericness, contradicted claims, no verified claim, exclusions, repetition (≥0.6
title similarity), trending without demand, insider with low IAS, editor hold. All thresholds are starting
editorial values, not fitted coefficients.

### Dossiers (`businessDossier.ts`)
Targeted Exa research + earlier sources → structured draft → every cited item re-verified; removed and
unverified items become uncertainties; "completed" analyses must use sourced inputs that match, or labelled
hypotheticals. READY needs ≥3 verified facts/statistics from ≥2 independent origins and a story structure;
otherwise HOLD with the research still needed.

### Production (`businessTopicSnapshot.ts`, `businessProduction.ts`)
`createBusinessEpisode` requires APPROVED + READY, freezes a versioned `BusinessTopicSnapshotV1` (facts
F1…Fn, sources, evidence fingerprint) on `BusinessEpisodeTopic`, runs the business readiness gate (no
sport/league/betting requirements) and claims the topic atomically. The worker dispatches script
generation and fact-check by podcast type. Business scripts use the existing format registry (debate only
when asked), the TTS line shape, and `evidenceRefs` `{type:"businessSource", id, factId}`. A deterministic
audit (shared by writer and fact-checker) blocks invented numbers, invalid fact ids, uncited factual lines,
synthetic personal experience and quotations not in the evidence; the `fact_check` judge adds an
independent entailment check. The owner approves the script in Studio (`recordHumanRelease`), then the
standard fact-check → TTS → stitch path runs unchanged.

### Studio
`/studio/shows/[id]?tab=` overview · radar · topics · insider · dossiers · episodes.

### Tests
- `npm run test:business-intelligence` — foundation + sports-isolation source contracts.
- `npm run test:business-engine` — deterministic: the 8 claim-verification regressions, robots/page
  selection, field routing, adaptive questions, demand, IAS, snapshot/readiness, line audit, packet split.
- `npm run test:business-integration` — embedded Postgres + `prisma migrate deploy`; real engine code with
  faked web/LLM boundaries: three businesses get different topics, cancel, replay, query cache, honest
  failure, dossier → episode → script → fact-check transitions, sports tables untouched, tenant isolation.

## Not built yet

- Live verification against real Exa / Anthropic / YouTube keys (tested with fakes at the boundary only).
- Search-trend, Search Console, keyword-volume and first-party analytics adapters.
- Calendar, growth outputs, audience learning; recurring scheduling for business shows.
