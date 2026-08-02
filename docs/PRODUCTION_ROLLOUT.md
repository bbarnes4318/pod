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

### Single migration owner

There is a **single migration owner**: exactly one release step applies
migrations, and it is the `web` Coolify service.

**The worker never runs migrations** — not on start, not as a pre-deploy hook,
not by hand during a release. Two owners race each other, and a migrated schema
can end up exposed to old code.

This is enforced, not merely documented: `npm run test:deployment-contract`
fails if any start script, `Dockerfile` `CMD`/`ENTRYPOINT`, image build step, or
**any document in `docs/`** introduces a second migration owner.

Migrations run from the **web service's Coolify _pre-deployment_ command**:

```bash
npm run prisma:migrate:deploy
```

Coolify's pre-deployment command runs a container from the **new image** before
the new container starts serving. That ordering is the whole point: the schema
must exist before any new code touches it.

> Do **not** use a post-deployment command. It runs after the new container has
> already started, so new code briefly runs against the old schema — which is
> exactly the window this contract exists to close.

### Migration rollback

Because both are purely additive, rolling back the *code* is safe with the tables
still present — nothing reads them unless the new code is running. Only drop the
tables if you are abandoning the feature entirely; the exact `DROP` statements are
listed at the top of each `migration.sql`.

---

## 4. Deployment order

This release adds tables and changes enforcement behaviour, so treat it as an
**incompatible deployment window**: pause and drain production jobs first, and
resume only once both services are on the new commit.

| # | Step | Where |
|---|---|---|
| 1 | Set every variable in §2 on both services | Coolify |
| 2 | `npm run verify:production-readiness -- --release --expect-sha <sha>` — must exit 0 | anywhere with prod env |
| 3 | **Pause the production queue** and let in-flight jobs drain; confirm `active` reaches 0 | Coolify / queue admin |
| 4 | **Back up the database** (Coolify snapshot or `pg_dump`) — the only rollback for a data mistake | Coolify / psql |
| 5 | **Apply migrations** from the web service's *pre-deployment* command: `npm run prisma:migrate:deploy` | web service only |
| 6 | Deploy **web** | Coolify |
| 7 | Deploy **worker** | Coolify |
| 8 | Verify commit identity: `GIT_COMMIT_SHA` on web and on worker both equal the expected release sha | readiness `--release` |
| 9 | Re-run `verify:production-readiness -- --release --expect-sha <sha>` from inside; the live probes (database, Redis, migrations, authenticated storage, worker health round-trip) only mean anything there | inside |
| 10 | **Resume the queue** | Coolify / queue admin |
| 11 | Watch the first episode through Studio and confirm the editorial-gate panel renders a verdict | Studio |

Web is deployed before the worker because web owns the migration: its
pre-deployment step creates the schema the worker will need. The queue stays
paused across steps 3–10, so no job ever runs against a half-deployed pair.

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

**Code rollback — order matters.** A new worker against an old schema is the one
state that must never exist, so the worker goes back first.

1. **Pause the production queue** and let in-flight jobs drain.
2. Roll back the **worker** to the previous commit, and wait for it to be healthy.
3. Roll back **web**.
4. Confirm `GIT_COMMIT_SHA` matches the previous release on both services.
5. **Resume the queue.**

Leave the new tables in place — the old code does not read them, and dropping
them is what would make the rollback destructive. Only run the `DROP` statements
in each `migration.sql` if you are abandoning the feature permanently, and only
after step 5 with the queue paused again.
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
