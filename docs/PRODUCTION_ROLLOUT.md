# Production rollout for the quality-gate branch

This branch makes the quality gates **fail closed**. That is the point of it — but
it also means a missing environment variable no longer degrades quietly, it stops
the pipeline. Read this before deploying.

There are **two** verification commands, and they are not interchangeable:

```bash
npm run verify:predeploy -- --expect-sha <sha>    # BEFORE you touch production
npm run verify:release   -- --expect-sha <sha>    # AFTER web and worker are deployed
```

An earlier version of this document asked for `--release` before deploying. That
could never pass: release mode verifies that migrations are **applied** and that
web and worker are **already running the new commit**, none of which is true
beforehand. The two phases below exist to remove that circularity.

Both report every problem by **variable name**, never by value.

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
| **`LEARNING_SIGNAL_SECRET`** | web | **NEW.** HMAC key for the server-issued listener-signal context. The public `/api/learning/*` endpoints **fail closed** in production without it. |
| **`GIT_COMMIT_SHA`** | web + worker | **NEW.** Stamp at build time. This is how you prove web and worker run the same tested commit. `SOURCE_COMMIT` / `COOLIFY_GIT_COMMIT_SHA` are also accepted. |
| `SCRIPT_EDITORIAL_GATE_MODE` | web + worker | Must resolve to `hold` in production (the default when `NODE_ENV=production`). |

### Pre-deploy only — needed by `verify:predeploy`, not by the running app

| Variable | Where | Why |
|---|---|---|
| `EXPECTED_RELEASE_SHA` | wherever you run the check | The commit being shipped. `--expect-sha` overrides it. |
| `DEPLOY_BACKUP_REFERENCE` | wherever you run the check | Your backup's identifier. Recorded, never inspected. |
| `CANARY_GITHUB_REPO` | wherever you run the check | `owner/name` — where the canary workflow lives. |
| `CANARY_READ_GITHUB_TOKEN` | wherever you run the check | Read-only token, minimum permission **`actions: read`** on this repository, nothing else. Inside GitHub Actions the workflow's own `GITHUB_TOKEN` suffices. |
| `CANARY_WORKFLOW_FILE` | optional | Defaults to `live-provider-canary.yml`. |

### Must NOT be set

| Variable | Why |
|---|---|
| `TTS_TRANSCRIPT_QA_WAIVED` | A waiver is not production semantic QA. The preflight fails if it is `true`. |
| `SCRIPT_EDITORIAL_HOLD_OVERRIDE` | No longer honoured; the preflight fails if it is `true`. |

### Speech providers

**Production renders with Fish, at `s2.1-pro-free`.** That is the only speech
provider a release depends on, and `PRODUCTION_REQUIRED_TTS_PROVIDERS` defaults
to `fish` accordingly.

**ElevenLabs is a supported adapter, not a dependency.** The canary exercises it
when it is configured and reports it as `skipped` when it is not; either way it
cannot fail a Fish release. It becomes mandatory only if you add it to
`PRODUCTION_REQUIRED_TTS_PROVIDERS` — a deliberate act, at which point its
credential and two distinct voice ids are demanded like any other requirement.

Do not assign ElevenLabs voices to production hosts to satisfy a check; nothing
requires it.

### GitHub Actions — the canary's own secrets

These belong to the **workflow**, and are deliberately **not** required inside
the web or worker containers. Copying them into Coolify to satisfy a
container-side check would widen their blast radius while proving nothing —
what production needs is evidence the canary went green for the exact commit,
which `verify:predeploy` checks over the Actions API.

**Required secrets** (6): `ANTHROPIC_API_KEY`, `FISH_API_KEY`, `DEEPGRAM_API_KEY`,
`CANARY_FISH_VOICE_A`, `CANARY_FISH_VOICE_B` — plus `OPENAI_API_KEY` /
`NVIDIA_API_KEY` / `ZAI_API_KEY` only if a role is pointed at that provider.

**Optional-adapter secrets** (never required for a Fish release):
`ELEVENLABS_API_KEY`, `CANARY_ELEVENLABS_VOICE_A`, `CANARY_ELEVENLABS_VOICE_B`.

**Required variables** — routing is pinned per role, not by a single
writer/judge pair. `LLM_ROUTING_PROFILE` plus a `_LLM_PROVIDER` / `_LLM_MODEL`
pair for each of: `TOPIC_GENERATION`, `RESEARCH`, `SCRIPT_STORY_EDITOR`,
`SCRIPT_DEBATE_ARCHITECT`, `SCRIPT_HOST_A_WRITER`, `SCRIPT_HOST_B_WRITER`,
`SCRIPT_DIALOGUE_DIRECTOR`, `SCRIPT_CONTINUITY_EDITOR`, `QUALITY_JUDGE`. The
judge must not resolve to the same endpoint as any authoring role, or the run
stops before spending anything.

> There are no `CANARY_LLM_PROVIDER` / `CANARY_JUDGE_MODEL` secrets. Those were
> replaced by the per-role pairs above, so a single unpinned role can no longer
> resolve silently down a fallback chain.

**Optional variables:** `FISH_SCENE_MODEL` — **leave unset**; it defaults to
`s2.1-pro-free`, and anything else is reported as voice drift.
`PRODUCTION_REQUIRED_TTS_PROVIDERS` defaults to `fish`.

### Verifying without exposing a value

```bash
npm run verify:predeploy -- --expect-sha <sha> --json | jq '.checks[] | select(.status=="fail")'
```

---

## 3. Migrations

This branch adds **four** migrations. All are additive: no column is dropped, no
row is rewritten.

| Migration | Adds |
|---|---|
| `20260802000000_add_blind_voice_audition` | 4 tables: blind voice auditions, candidates, votes, promotions |
| `20260802010000_add_listener_learning` | 5 tables: raw listener events, aggregates, cold-open trials, versioned per-show policy, policy decisions |
| `20260802020000_add_script_legacy_release` | 1 table: the durable, scoped editorial-gate legacy release |
| `20260802030000_learning_event_dedupe_index` | 1 unique index making listener-event dedupe a database invariant |

### Single migration owner

There is a **single migration owner**: exactly one release step applies
migrations, and it is the `web` Coolify service.

**The worker never runs migrations** — not on start, not as a pre-deploy hook,
not by hand during a release. Two owners race each other, and a migrated schema
can end up exposed to old code.

This is enforced, not merely documented: `npm run test:deployment-contract`
fails if any start script, `Dockerfile` `CMD`/`ENTRYPOINT`, image build step, or
**any document in `docs/`** introduces a second migration owner.

### Rollback

**Code rollback is the normal rollback, and it leaves these tables and the index
in place.** They are additive, the old code does not read them, and dropping
them is what would make a rollback destructive.

Editing `_prisma_migrations` is **not** an ordinary rollback method. It is
migration-history surgery, appropriate only when you are permanently abandoning
a feature and have already taken a backup. The `DROP` statements for that case
are written at the top of each `migration.sql`, in dependency order.

---

## 4. Deployment

Treat this as an **incompatible deployment window**: production jobs are paused
and drained first, and resumed only once release acceptance passes.

### Phase A — pre-deploy validation (production is untouched)

Run from anywhere that has the production environment. It verifies only what is
truthfully knowable in advance, and it does **not** require the new migrations
to be applied or the services to be running the new commit.

```bash
npm run verify:predeploy -- --expect-sha <sha>
```

It checks: required variable names · no waiver variables · LLM route separation ·
authenticated provider probes (LLM, Deepgram, every required TTS engine) ·
authenticated object storage · database and Redis reachability · the migration
**plan** (nothing half-applied, nothing applied that is missing from the repo) ·
a recorded backup · the expected release SHA · and **a green live-provider canary
for that exact SHA**.

The canary check refuses a run from a different commit, a cancelled run, a
skipped run, a failed run, and a green run older than 72 hours.

### Phase B — the window

| # | Step | Command / where |
|---|---|---|
| 1 | Pause the production queue | `npm run queue:pause-production` |
| 2 | Wait until nothing is in flight | `npm run queue:production-status` — proceed when `active` is 0 |
| 3 | Take the backup and record it | Coolify snapshot or `pg_dump`; set `DEPLOY_BACKUP_REFERENCE` |
| 4 | Deploy **web** (its pre-deployment command applies the migrations) | Coolify |
| 5 | Deploy **worker** | Coolify |

Pause never deletes a job. Resume never duplicates one. Both are idempotent, so
re-running either mid-deploy is safe.

### Phase C — release acceptance (after both services are up)

```bash
npm run verify:release -- --expect-sha <sha>
```

It verifies: migrations applied · no schema drift · web runs the expected SHA ·
the worker health job is processed **by a worker on the expected SHA** · web and
worker match each other · database, Redis and storage reachable · required
providers still authenticate.

**Keep the queue paused until this passes.** Only then:

```bash
npm run queue:resume-production
npm run queue:production-status   # confirm running, and workers report the new sha
```

---

## 5. Coolify service commands

Set these in each service's configuration, **save**, and confirm they persisted
(reload the service page and re-read the fields) **before** starting a deploy. A
command that was typed but not saved is the classic way to deploy old behaviour.

### web

| Slot | Value |
|---|---|
| Pre-deployment command | `npm run prisma:migrate:deploy` |
| Post-deployment command | **empty** — it must not run `prisma migrate deploy` |

The previous configuration ran the migration as a **post**-deployment command.
That is unsafe here: post-deployment runs after the new container is already
serving, so new code briefly touches the old schema. Move it to
pre-deployment, which runs a container from the new image *before* the new one
takes traffic.

**On `npx prisma db seed`:** if it is present in a post-deployment slot, remove
it for this release. The seed is idempotent for hosts and sound assets, but it
is not part of a release and it competes with the deploy for the same rows. Run
it deliberately and separately when a seed change is actually intended.

### worker

| Slot | Value |
|---|---|
| Pre-deployment command | **empty** — no migration command |
| Post-deployment command | **empty** — no migration command |

The worker is a consumer. It must never migrate, in either slot.

---

## 6. Existing and in-flight scripts

Scripts written before this branch have no editorial verdict. The rollout policy
(`src/lib/queue/rolloutPolicy.ts`) handles them:

- **No verdict + created before `SCRIPT_GATE_ENFORCEMENT_FROM`** → a durable,
  scoped `ScriptLegacyRelease` row is created once, recording the script's
  creation time, the cutover, a system actor, and exactly which stages it
  permits.
- **No verdict + created after the cutover** → blocked. That means the pipeline
  did not evaluate it, which is a defect, not a rollout gap.
- **Measured and came back `review`/`hold`** → blocked regardless of age. Age
  excuses "never evaluated"; it does not excuse "evaluated and found wanting".

The permanent fix is to give legacy scripts a real verdict:

```bash
npm run gate:reevaluate -- --all-legacy --dry-run   # score without writing
npm run gate:reevaluate -- --all-legacy             # write real verdicts
npm run gate:reevaluate -- --script <scriptId>
```

---

## 7. Rollback procedure

**Order matters.** A new worker against an old schema is the one state that must
never exist, so the worker goes back first.

1. `npm run queue:pause-production`, then `npm run queue:production-status` until `active` is 0.
2. Roll back the **worker** to the previous commit; wait for healthy.
3. Roll back **web**.
4. Confirm `GIT_COMMIT_SHA` matches the previous release on both services.
5. `npm run queue:resume-production`.

Leave the four migrations and the index in place — see §3. The old code does not
read them.

**If you only need to stop the gate blocking, without a rollback:** set
`SCRIPT_EDITORIAL_GATE_MODE=observe`. The gate still computes and records every
verdict, and Studio still shows it, but nothing is blocked. This is the supported
escape hatch: it is visible in an env audit, it is per-environment, and it does
not pretend the quality checks passed.

Do **not** use `TTS_TRANSCRIPT_QA_WAIVED` or `SCRIPT_EDITORIAL_HOLD_OVERRIDE`.
The first disables the only check that verifies speaker attribution, names and
numbers on rendered audio; the second no longer does anything.
