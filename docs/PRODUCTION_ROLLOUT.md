# Production rollout for the quality-gate branch

This branch makes the quality gates **fail closed**. That is the point of it — but
it also means a missing environment variable no longer degrades quietly, it stops
the pipeline. Read this before deploying.

Run the preflight first. It is the whole safety story in one command:

```bash
npm run verify:production-readiness
```

It exits non-zero if production would ship without a mandatory quality gate, and
it reports every problem by **variable name**, never by value.

---

## 1. What changes behaviourally

| Before | After |
|---|---|
| `review` verdict continued to TTS | `review` blocks automatic production; a human decides |
| Missing independent judge → `review` (which blocked nothing) | Missing judge is a **hold** in production |
| Semantic audio QA reported `NOT_RUN` and continued | Fails closed; the episode stops |
| Single-shot fallback published itself | Fallback is a hold, and can never claim agendas/tournament ran |
| `SCRIPT_EDITORIAL_HOLD_OVERRIDE=true` cleared every hold | Removed; a hold is cleared only by an attributable per-script release |
| Gate consulted at one call site | Enforced at the queue boundary, covering every caller |

---

## 2. Required environment variables

**Names only. Never commit values, and never paste values into a terminal that logs.**

### Mandatory — the deploy is refused without these

| Variable | Where | Why |
|---|---|---|
| `DATABASE_URL` | web + worker | already set |
| `REDIS_URL` | web + worker | already set |
| `ANTHROPIC_API_KEY` | web + worker | already set (production-scoped) |
| `FISH_API_KEY` | web + worker | already set |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | web + worker | already set |
| **`SCRIPT_GATE_ENFORCEMENT_FROM`** | web + worker | **NEW.** ISO 8601 instant. Scripts created before it may finish without a verdict, attributably. Unset ⇒ nothing is grandfathered and pre-existing scripts are refused. Set it to the deploy instant. |
| **`TTS_TRANSCRIPT_QA_ENABLED`** | web + worker | Must be `true`. Production was previously observed with `false`, which is now a refusal. |
| **`TRANSCRIPT_QA_PROVIDER`** | web + worker | `deepgram` (recommended — the key already exists) or `openai`. |
| **`DEEPGRAM_API_KEY`** | web + worker | Required when the provider is `deepgram`. Already present in production. |
| **`GIT_COMMIT_SHA`** | web + worker | **NEW.** Stamp at build time. This is how you prove web and worker run the same tested commit. `SOURCE_COMMIT` / `COOLIFY_GIT_COMMIT_SHA` are also accepted. |
| `SCRIPT_EDITORIAL_GATE_MODE` | web + worker | Must resolve to `hold` in production (this is the default when `NODE_ENV=production`). |

### Must NOT be set

| Variable | Why |
|---|---|
| `TTS_TRANSCRIPT_QA_WAIVED` | A waiver is not production semantic QA. The preflight fails if it is `true`. |
| `SCRIPT_EDITORIAL_HOLD_OVERRIDE` | No longer honoured; the preflight fails if it is `true`. |

### GitHub Actions — for the live-provider canary

Repository currently has **zero** secrets and **zero** variables configured, which
is why the canary has never run. Secrets:

`CANARY_LLM_PROVIDER`, `CANARY_LLM_MODEL`, `CANARY_JUDGE_PROVIDER`,
`CANARY_JUDGE_MODEL`, `ANTHROPIC_API_KEY`, `FISH_API_KEY`, `ELEVENLABS_API_KEY`,
`CANARY_FISH_VOICE_A`, `CANARY_FISH_VOICE_B`, `CANARY_ELEVENLABS_VOICE_A`,
`CANARY_ELEVENLABS_VOICE_B`, `DEEPGRAM_API_KEY`

Variables (optional): `FISH_SCENE_MODEL` — **leave unset**; it defaults to
`s2.1-pro-free`, and anything else is reported as voice drift.

The judge route must differ from the writer route, or the canary fails as a
configuration error before spending anything.

### Verifying without exposing a value

```bash
# Presence only — prints a boolean, never the value.
npm run verify:production-readiness -- --json | jq '.checks[] | select(.status=="fail")'
```

---

## 3. Migrations

Both are **additive**. No column is dropped, no data is rewritten.

| Migration | Adds |
|---|---|
| `20260802000000_add_blind_voice_audition` | blind voice audition tables (candidates, ballots, votes, promotions, rollback history) |
| `20260802010000_add_listener_learning` | raw listener signal events, derived aggregates, versioned production policy |

Apply with:

```bash
npx prisma migrate deploy
```

**Both web and worker run `migrate deploy`.** Whichever starts first applies them;
the second is a no-op. Do not skip the worker.

### Migration rollback

Because both are purely additive, rolling back the *code* is safe with the tables
still present — nothing reads them unless the new code is running. Only drop the
tables if you are abandoning the feature entirely; the exact `DROP` statements are
listed at the top of each `migration.sql`.

---

## 4. Deployment order

The gate lives at the queue boundary, which the **worker** executes. Deploy the
worker first so it is never running old enforcement against new scripts.

1. Set every variable in §2 on **both** services.
2. `npm run verify:production-readiness` — must exit 0. Do not proceed otherwise.
3. Deploy **worker**, wait for it to report healthy.
4. Deploy **web**.
5. Confirm `GIT_COMMIT_SHA` matches on both.
6. Re-run the preflight against the deployed environment (the live checks —
   database, Redis, migrations, worker queue consumption — only mean something
   from inside).

---

## 5. Existing and in-flight scripts

Scripts written before this branch have no editorial verdict. The rollout policy
(`src/lib/queue/rolloutPolicy.ts`) handles them:

- **No verdict + created before `SCRIPT_GATE_ENFORCEMENT_FROM`** → allowed once,
  recorded with the script's creation time, the cutover, and a reason. Logged.
- **No verdict + created after the cutover** → blocked. That combination means the
  generation pipeline did not evaluate it, which is a defect, not a rollout gap.
- **Measured and came back `review`/`hold`** → blocked regardless of age. Age
  excuses "never evaluated"; it does not excuse "evaluated and found wanting".

The permanent fix is to give legacy scripts a real verdict:

```bash
npm run gate:reevaluate -- --all-legacy --dry-run   # score without writing
npm run gate:reevaluate -- --all-legacy             # write real verdicts
npm run gate:reevaluate -- --script <scriptId>
```

A script that comes back `review`/`hold` is not stuck: a human can inspect it in
Studio and record an attributable release, or edit and regenerate.

---

## 6. Rollback procedure

**Code rollback (safe at any point):**

1. Redeploy the previous commit to **web**, then **worker**.
2. Leave the new tables in place — the old code does not read them.
3. Optionally unset `SCRIPT_GATE_ENFORCEMENT_FROM`, `TTS_TRANSCRIPT_QA_ENABLED`,
   `TRANSCRIPT_QA_PROVIDER`. The old code ignores them.

Scripts that acquired an `editorialGate` verdict keep it; the old code reads the
field it always read and is unaffected by the added ones.

**If you only need to stop the gate blocking, without a full rollback:**

Set `SCRIPT_EDITORIAL_GATE_MODE=observe`. The gate still computes and records
every verdict, and Studio still shows it, but nothing is blocked. This is the
supported escape hatch — it is visible in an env audit, it is per-environment, and
it does not pretend the quality checks passed.

Do **not** use `TTS_TRANSCRIPT_QA_WAIVED` or `SCRIPT_EDITORIAL_HOLD_OVERRIDE` for
this. The first disables the only check that verifies speaker attribution, names
and numbers on rendered audio; the second no longer does anything.
