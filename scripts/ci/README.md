# Local CI — `scripts/ci/run.sh`

GitHub Actions no longer runs for this repository (the account's Actions
billing is locked, so every workflow job is cancelled before it starts and
reports a 2-second "failure" that is not about your code). This script is the
replacement: it runs the same checks the two pull-request workflows ran, on
your machine, before you open a PR.

```bash
./scripts/ci/run.sh fast    # before every PR
./scripts/ci/run.sh full    # fast + build the Docker image and boot it
```

Put the result line in the PR description.

One check at a time: `typecheck`, `quality`, `build`, `migrate`,
`integration`, `image`. `./scripts/ci/run.sh clean` removes containers a
killed run left behind.

| exit | meaning |
|---|---|
| 0 | PASS — every check ran and passed |
| 1 | FAIL |
| 3 | INCOMPLETE — a check could not run here (no Docker, wrong Node). **Not a pass**; say which checks could not run |
| 130 | interrupted (containers are still cleaned up) |

Report: `.ci-reports/<time>-<profile>-<sha>/summary.md` (gitignored, newest 20
kept), with the full log of every step under `steps/`.

## Requirements

- **Node 20** — what `Dockerfile` and `real-podcast-quality.yml` use. A
  different major is INCOMPLETE, not a pass. Point `CI_NODE_DIR` at a Node 20
  `bin` directory, or override with `CI_NODE_MAJOR`.
- **Docker** — PostgreSQL 16 and Redis 7 run as throwaway containers. Without
  it the quality half still runs and the run ends INCOMPLETE.
- **bash, git, tar, flock** (`setsid` is used when present). On Windows run
  this inside **WSL2**; Git Bash has no `flock`.

Checks run against a clean `git archive` export of `HEAD` in
`~/.cache/take-machine-ci/tree`, with its own `node_modules` (re-installed only
when `package-lock.json` changes). **Your working tree is never written to** —
no `npm ci` over your `node_modules`, no `.next`, no generated Prisma client —
and, exactly like GitHub, only committed code is tested. Commit before you run.

## What runs

### `real-podcast-quality.yml` → `typecheck`, `quality`, `build`

| step | what | was |
|---|---|---|
| `install` | `npm ci` + `npx prisma generate` in the export | every job |
| `typecheck` | `npx tsc --noEmit` | step "TypeScript" |
| `quality-gate` … `audio-stitch-recovery` | the 30 regression suites, one step each, in the workflow's order | the 30 regression steps |
| `build` | `npm run build` | step "Production build contract" |

### `integration.yml` → `migrate`, `integration`

| step | what | was |
|---|---|---|
| `services` | PostgreSQL 16 + Redis 7, random loopback ports | the `services:` block |
| `migrate-from-empty` | `npx prisma migrate deploy` against an empty database | step "Migrate from an empty database" |
| `integration-migrations` | `npm run test:integration-migrations` | step "Migration integrity…" |
| `integration-legacy-release` | `npm run test:integration-legacy-release` | step "Durable legacy release" |
| `integration-worker-health` | `npm run test:integration-worker-health` (3-minute bound, as in the workflow) | step "Worker health round-trip" |
| `integration-auditions` | `npm run test:integration-auditions` | step "Voice auditions and tenant isolation" |
| `integration-learning` | `npm run test:integration-learning` | step "Listener learning, aggregates…" |
| `integration-release-integrity` | `npm run test:integration-release-integrity` (release gate, publish paths and row locks on real rows) | added after Actions stopped; never a workflow step |

### `full` only

| step | what |
|---|---|
| `image` | builds `Dockerfile` from a clean export of the commit, runs `prisma migrate deploy` in it, starts it in production mode on a Docker `--internal` network with only its own PostgreSQL and Redis — no internet, no provider APIs — and requires `/api/health` to answer `ok` and `/api/readiness` to report `database: pass` from inside the container |

### Not ported

`live-provider-canary.yml` is a scheduled job, not a PR check. It spends real
money on Anthropic, Fish and Deepgram and needs live credentials, which this
runner deliberately scrubs. It is left for whoever restores Actions, or for a
manual `npm run canary` with credentials supplied on purpose.

## A suite that does nothing is a failure

Every test step is checked after it exits 0:

- **zero assertions** — no `✓` / `ok` / `N/M checks passed` line anywhere in
  the log — fails the step. `src/scripts/integration/helpers.ts` exits 0 on
  `0/0 checks passed`, so this is a real hole, not a theoretical one.
- **any reported skip** fails the step, because every service these suites
  need was supplied. Skips that are deliberately opt-in are listed one by one,
  with the reason, in `ALLOWED_SKIPS` at the top of `run.sh` (currently empty).

## Safety

- The environment is scrubbed (`env -i` with an allowlist) before anything
  runs: no `ANTHROPIC_API_KEY`, `FISH_API_KEY`, S3 credentials, production
  `DATABASE_URL` or SSH agent from your shell reaches a check. The names of
  dropped credential-like variables go in the report; with
  `CI_FORBID_SECRETS=1` receiving one fails the run outright.
- The database URL is built from this run's own container on a random
  loopback port with test-only credentials, so **no check can reach
  production**. Containers are labelled with the run id and removed on exit,
  including on failure and Ctrl-C.
- Every step has a timeout, a failure is never retried, and `flock` allows one
  run at a time on the machine.

## Knobs

| variable | effect |
|---|---|
| `CI_NODE_DIR` | prepended to `PATH` (point at Node 20) |
| `CI_NODE_MAJOR` | required Node major (default 20) |
| `CI_FORBID_SECRETS=1` | fail if the shell handed CI any credential-like variable |
| `CI_REUSE_NODE_MODULES=1` | link the working tree's `node_modules` into the export instead of `npm ci`. Not a clean install — the report says so on every run. Needed on machines where `npm ci` into a fresh directory cannot complete |
| `CI_REUSE_NODE_MODULES=copy` | the same, but copies instead of linking (slower, one-off per tree). Required for `build`: Turbopack rejects a linked `node_modules` |
| `CI_TREE_DIR` | where the clean export lives (default `~/.cache/take-machine-ci/tree`) |
| `CI_REPORTS_DIR` | where reports are written (default `.ci-reports`) |
| `CI_PG_IMAGE`, `CI_REDIS_IMAGE` | service images (default `postgres:16`, `redis:7`) |
| `CI_STEP_TIMEOUT`, `CI_BUILD_TIMEOUT`, `CI_INSTALL_TIMEOUT`, `CI_TYPECHECK_TIMEOUT`, `CI_IMAGE_TIMEOUT` | per-step limits in seconds |
| `CI_QUEUE_TIMEOUT` | how long to wait for the lock (default 3600s) |

## Known platform limits

- **`CI_REUSE_NODE_MODULES=1` (link mode) breaks `build`.** Turbopack refuses a
  linked `node_modules` ("points out of the filesystem root"). Use
  `CI_REUSE_NODE_MODULES=copy`, or a real `npm ci`.
- **`embedded-postgres` is not reaped on `windows-x64`.** The two suites that
  start a real PostgreSQL (`migration-adoption`,
  `podcast-configuration-migration`) leave a `postgres.exe` behind, whatever
  the dependency mode: `pg.stop()` fails and swallows its error. Both suites
  now exit on their own verdict, so the step still finishes; before that they
  printed `N passed, 0 failed` and hung until the step timed out, which CI can
  only report as a failure. `./scripts/ci/run.sh clean` removes containers,
  not that stray process — on Windows, kill leftover `postgres.exe` whose
  command line points into the CI tree.
- **WSL2 needs at least 4GB** for `tsc` and `next build` on this repo. A 2GB
  `.wslconfig` cap kills the WSL instance mid-run.
