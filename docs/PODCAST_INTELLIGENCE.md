# Podcast intelligence: sports and business

Take Machine runs two research engines on one production pipeline. `Podcast.intelligenceType`
(DB enum, default `SPORTS`) says which engine feeds a show.

| | Sports | Business |
|---|---|---|
| Research input | `TopicCandidate` + `ResearchBrief` (unchanged) | `BusinessProfile` → (next) opportunities, demand signals, dossiers |
| Creation | `/studio/shows/new?type=sports` (the existing wizard) | `/studio/shows/new/business` |
| Episode generation | unchanged | **refused** until the business→production adapter exists |
| Recurring scheduler | unchanged (now filters `intelligenceType: SPORTS`) | not scheduled |

## Invariants

- Every podcast that existed before migration `20261121000000` is `SPORTS` via the column default. The
  creation path only ever accepted sports verticals, so that is a deterministic backfill, not a guess.
- The type is written once, server-side, as a literal (`businessActions.createBusinessPodcast`). No edit
  path — `savePodcastConfiguration`, the sports `updatePodcast` — can change it.
- A business show can't reach sports topics: `createEpisodeDraft` (which every creation route goes
  through) refuses it, as do the scheduler, the Studio episode builder, and the sports edit/generate actions.
- No sports table, column, score or URL changed.

## Rollout

Business shows are visible to owner/admin accounts (`OWNER_EMAILS` / role ADMIN) and to everyone else only
with `BUSINESS_PODCASTS_ENABLED=1` (web service). Sports is never behind a flag.

## What exists today (Phase 2–4 foundation)

- **Business profile** (`src/lib/business/profileSchema.ts`): Level 1 essentials as columns; discovered
  `findings` and advanced `answers` as validated JSON.
- **Discovery** (`src/lib/business/discovery.ts`): reads the homepage + `/about` through `safeFetch`
  (SSRF-safe), extracts with the `evidence_extraction` LLM role, then decides provenance in code: a finding
  is `SOURCE_VERIFIED` only if its quote appears verbatim in the cited page; everything else is
  `AI_INFERRED` with confidence ≤ 0.6. Page text is fenced as data. Provider failure returns an error —
  nothing is invented. Users keep, edit (→ `USER_CONFIRMED`) or reject every finding.
- **Scoring** (`src/lib/business/scoring.ts`): pure, tested, not yet fed by real research.
  - Demand labels are counted, not asserted: `VERIFIED_DEMAND` needs ≥3 relevant signals, ≥2 source
    families, ≥2 with a measured metric. One forum, however loud, tops out at `PROMISING_DEMAND`.
  - Information Advantage (0–100): original analysis 25, undercovered 20, specificity 20, practical 20,
    evidence depth 15. A dimension rated > 0.5 with no evidence refs and no analysis plan is capped at 0.5.
  - Opportunity (0–100): demand 25, listener fit 15, information advantage 20, practical value 20,
    timeliness 10, evidence quality 10. Information advantage maps from IAS **excluding** practical
    usefulness (rescaled 80→20), and practical value comes from that IAS dimension, so it is counted once.
  - Goal-based ranking changes order only. Traffic goals count demand twice; depth goals add IAS/4. Hold
    gates (trending without demand, insider with IAS < 50, evidence quality < 0.3) don't move with goals.
  - All weights are starting editorial weights, not fitted coefficients.

Tests: `npm run test:business-intelligence`.

## Not built yet (in order)

1. Adaptive industry follow-up questions (§8).
2. Demand providers (§10) — none are wired or verified. Each needs an adapter, keys, terms review, and
   tables (`DemandSignal`, `BusinessTopicOpportunity`) that get created with their first writer.
3. Opportunity generation + insider-intelligence research (§11–15), on the research queue with budgets.
4. Dossiers and the business→production adapter (§16, §18). The blocker: production consumes
   `TopicCandidate`, whose `sport` column is required. Do not fill it with a fake value; add the adapter
   at `EpisodeTopic.snapshot` level or make the column nullable with a sports-side guard.
5. Dashboard, calendar, growth outputs, audience learning (§20–25).
