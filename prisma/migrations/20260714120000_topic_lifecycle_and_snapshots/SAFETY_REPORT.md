# Migration safety report — `20260714120000_topic_lifecycle_and_snapshots`

Scope: decouple topic **editorial status** from **usage**, enforce editorial
status with a Prisma enum, and freeze an **immutable per-episode topic
snapshot** with an accurate historical `selectedAt`.

This report is deliberately honest about one thing the first version got wrong:
**this is NOT a zero-downtime, independently-rollback-able change.** The old
script path was coupled to `status = "used"`, so code and schema must move
together. The safe path is a **coordinated deploy**, documented below.

---

## 1. What the migration does (and does not) touch

| Object | Change | Destructive? |
| --- | --- | --- |
| `TopicCandidate.status` | `used` → `approved`, then column retyped to enum `TopicEditorialStatus(pending, approved, rejected, archived)` | No rows deleted; one in-place value remap |
| `EpisodeTopic.snapshot` | New nullable `JSONB`, backfilled from current related rows | Additive |
| `EpisodeTopic.selectedAt` | New column, backfilled to a **historical approximation**, then `NOT NULL` + default + index | Additive |

No `TopicCandidate`, `ResearchBrief`, `Episode`, `EpisodeTopic`, or `Script`
row is ever deleted. Every statement is guarded (`IF NOT EXISTS`,
`WHERE`-scoped, `duplicate_object` catch, `::text` casts) so a **partial or
repeated re-run is safe** — proven by `npm run test:topic-migration`, which
runs the real SQL against a throwaway Postgres and asserts a second run does not
clobber snapshots.

### Unexpected-value handling
Before retyping the column the migration **aborts with a clear error** if any
`status` value falls outside the editorial set — it never silently coerces
garbage to `approved`. (Test: "unexpected status value aborts migration".)

### `selectedAt` accuracy
`selectedAt` is added **nullable**, backfilled to
`COALESCE(Episode.createdAt, TopicCandidate.createdAt, now())` — a real
historical timestamp, **not** migration time — and only then made `NOT NULL`
with a default and index. The snapshot's `selectionTimestamp` is derived from
that corrected `selectedAt`, so backfilled snapshots are internally consistent.

---

## 2. Why this is NOT independently rollback-able

The pre-migration code (`main`) is coupled to the literal `"used"` status in two
places that a schema-only or code-only rollback would break:

- `src/lib/services/episodeService.ts:131` — the script-generation path
  **throws** unless `topic.status === "used"`.
- `src/lib/services/episodeService.ts:460` — episode creation **writes**
  `status: "used"`.

Consequences of an uncoordinated move:

| Action | Result |
| --- | --- |
| **Migrate DB, keep old code** | Old code writes `status: "used"` → the new enum **rejects** it → every episode-creation write throws. Old script path also can't find any `"used"` topic (all are now `approved`) → script generation throws for every episode. **Hard break.** |
| **Deploy new code, skip migration** | New code reads `EpisodeTopic.snapshot` / `selectedAt` and filters `status = 'approved'` on a column that still allows `"used"` and has no snapshot column → runtime/query errors. **Hard break.** |
| **Migrate, then roll code back to `main`** | Same as row 1: DB no longer has `"used"`, and the enum forbids writing it back. Rolling the *code* back does **not** roll the *data* back. **Hard break.** |

There is **no zero-downtime, drain-free, independently-reversible** version of
this change. Any claim otherwise (including in the first report) was wrong.

---

## 3. Safe coordinated-deploy strategy (maintenance-mode order)

Deploy web + worker + DB **together**. Both the web app and the BullMQ worker
read topic status and snapshots, so they must ship the same code at the same
time (see [[coolify-deploy]] — always deploy web + worker together). The
critical rule: **the migrated database must never be exposed to the OLD web
code** (which writes `status:"used"` and requires `status==="used"` — both fatal
under the new enum). That means the interactive web writers must be stopped
*before* the migration, not merely the queue.

**Migration ownership:** exactly ONE release job runs `prisma migrate deploy`
(the deploy/release step, step 6 below). The web and worker **containers must
NOT run migrations on boot** — do not let both race `migrate deploy` on startup.
Confirm neither the web nor the worker image runs `prisma migrate deploy` in its
entrypoint; only the release job does.

**Order:**

1. **Enable maintenance mode** — stop routing write traffic to the CURRENT web
   app (maintenance page / drain the load balancer). This is what closes the
   "old web code on new schema" window; do not skip it.
2. **Pause and drain** the BullMQ `podcast-generation` queue (episode-creation
   jobs). Let in-flight jobs finish or leave them queued (not lost).
3. **Disable recurring + scheduled generation** (the daily scheduler tick) so no
   new build is enqueued mid-switch.
4. **Confirm no active episode-creation transaction remains** — check for
   in-flight `build:episode` workers and open transactions before proceeding.
5. **Back up** `TopicCandidate` and `EpisodeTopic` (`pg_dump` of those tables is
   enough for the forward-fix path — see §4).
6. **Run the migration ONCE** via the single release job (`prisma migrate
   deploy`). It is transactional and aborts loudly on unexpected data.
7. **Deploy compatible web + worker images together** (new code expects the
   enum, the snapshot column, and derived usage).
8. **Run smoke tests** — create a draft episode, generate a script for an
   existing topic, load `/studio/takes` — before taking any traffic.
9. **Resume worker queues + schedulers** (un-pause step 2/3).
10. **Disable maintenance mode** — route traffic back to the new web app.

Expected impact: a short window (seconds-to-minutes) where episode creation is
paused. Reads (RSS, playback, analytics) are unaffected — none of those columns
change shape destructively — but write traffic is intentionally held during the
switch.

**Do not** roll only one of {code, schema} forward or back.

---

## 4. If something goes wrong (forward-fix, not rollback)

Because a data rollback is not clean, prefer **forward fixes**:

- **Migration aborts on unexpected status:** it told you the offending
  value(s). Correct those rows to a valid editorial status and re-run — the
  migration is idempotent.
- **Post-deploy defect in new code:** fix forward and redeploy. The data is
  already in the new shape and valid; you do **not** need to touch the schema.
- **Genuine need to revert to old code:** this requires a **manual data
  reversal** first — add `"used"` back as an allowed value (retype the column to
  text, or add the enum label), then re-derive which topics were "used" from
  `EpisodeTopic` join rows, then set them back to `"used"`. This is a
  deliberate, scripted operation from the §3 step-5 backup — not an automatic
  `migrate down`. Budget for it explicitly; do not assume it is instant.

### Failed-deployment recovery path

If step 7 (new images) or step 8 (smoke tests) fails, **keep maintenance mode
ON** (do not run step 10). The database is already migrated and valid, so the
fix is *forward*, not backward:

1. Leave maintenance mode enabled and queues paused — no old code ever touches
   the migrated DB.
2. Build and deploy a corrected web + worker image (forward fix).
3. Re-run smoke tests (step 8).
4. Only once green, resume queues/schedulers (step 9) and disable maintenance
   mode (step 10).

Reverting to the pre-migration images is NOT a valid recovery here: they are
incompatible with the migrated schema (see §2). Reach for the §4 manual data
reversal only if a forward fix is genuinely impossible.

---

## 5. Verification performed

- `npm run test:topic-migration` — real Postgres: rows preserved, `used →
  approved`, enum rejects `"used"`/arbitrary values, `selectedAt` historical,
  snapshots populated, re-run does not clobber, unexpected value aborts. **7/7.**
- `npm run test:topic-lifecycle` — snapshot immutability, snapshot-first content
  gate, scoped usage/warnings, `exclude_podcast` pins + `reuseOverride`. **17/17.**
- `npx prisma validate` / `npm run typecheck` — clean.
