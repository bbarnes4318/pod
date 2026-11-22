<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Remote

`https://github.com/bbarnes4318/pod` is the ONLY valid remote for this project — never push to `bbarnes4318/portal`, which is a different application.

# Standing rules — read before EVERY task

These come from real mistakes on this project. They apply to every prompt,
even when the prompt does not repeat them, and they override anything a prompt
says to the contrary unless the owner explicitly says otherwise in that prompt.

## 1. Never use the owner's computer for Docker, CI, databases or test servers

Do not run Docker, `scripts/ci/run.sh`, Postgres (embedded or otherwise),
Redis, `next dev`, Playwright, or any long-running test process on the owner's
Windows machine or its WSL. That is what the server and cloud sessions are for.
Reading code, editing files, git and quick unit tests with `npx tsx` are fine.

If you cannot run CI anywhere but the owner's machine, do not run it. Write
`CI: pending, to be run on the server` in the PR and say so plainly.

## 2. Start from the real, current main

Run `git fetch origin` first and branch from `origin/main`. Commit hashes and
PR states written in a prompt may already be out of date: check them, and if
the prompt is wrong (a PR it calls open is merged, main has moved), say so and
work from what is actually there.

## 3. Push early, never leave work only on a local disk

Push the branch after the first real commit, and after every milestone. Work
that exists only on the owner's machine is one lost folder away from gone.

## 4. Never claim something was tested if it was not

Say exactly what ran, where, and the result line. Say what could not be tested
and why (missing API key, no Docker, etc.). Fakes and mocks are not live tests;
call them what they are. A database row existing does not mean a feature works.

## 5. Database migrations

- Additive only unless the owner approves otherwise: no drops, renames or
  destructive changes to existing tables. Sports data must never be touched by
  business work.
- Every new folder in `prisma/migrations/` MUST get a checkpoint entry in
  `src/lib/services/migrationCheckpoints.ts` (follow the previous entry). CI's
  `deployment-contract`, `migration-adoption` and `integration-migrations`
  checks fail without it.
- Never run `prisma migrate resolve` to make an error go away.
- After a migration merges, tell the owner to confirm it in Coolify (see 7).

## 6. CI

- Run it as `bash scripts/ci/run.sh fast` (Node 20; see `scripts/ci/README.md`).
- Use `full` when the change touches `prisma/`, the worker, the `Dockerfile`,
  `package.json` or startup code.
- Exit 0 = PASS. 1 = FAIL. 3 = INCOMPLETE, which is NOT a pass.
- Never skip, disable or delete a test to get a pass.

## 7. Deploying: what happens, and what the owner must do

- Production: https://podcast.hopwhistle.com, hosted on Coolify
  (http://178.156.153.87:8000), services `take-machine-web` and
  `take-machine-worker`. `/api/readiness` shows the deployed commit.
- Merging into `main` deploys BOTH web and worker automatically. Never deploy,
  restart services or change production settings yourself.
- If your PR is a DRAFT, tell the owner they must click **Ready for review**,
  then **Merge**.
- After every PR, give the owner the COMPLETE list of manual steps, numbered,
  with every click. Never leave a step for them to discover. In particular:
  - **New environment variable or API key:** say its exact name, that it goes
    in BOTH `take-machine-web` and `take-machine-worker` (Environment
    Variables), and that BOTH must then be **Redeployed**. Coolify only reads
    variables when a service starts.
  - **New migration:** Coolify → take-machine-web → **Terminal** → run
    `npx prisma migrate status`, and tell them what result to expect. Have them
    paste the output back before running `npx prisma migrate deploy`.
  - **Nothing needed:** say "nothing to do after merging" in those words.

## 8. Talking to the owner

Plain language. Short. Lead with the answer or the action. Numbered steps that
can be followed without technical knowledge. No walls of text, no jargon
without a plain explanation.

## 9. Product facts that are settled

- Host voices are created INSIDE the app (Studio → Hosts → Create voice) through
  the Fish Audio API. Never tell the owner to create voices on Fish's website.
- Sports and Business are separate intelligence engines. Never push sports data
  through business research or the reverse, and never fill sports fields
  (`sport`, `leagueId`, betting, player) with fake values.

# CI is local: run it before every PR

GitHub Actions does not run for this repository any more. Before pushing a PR,
run the local CI and put its result line in the PR description:

```
bash scripts/ci/run.sh fast
```

Exit 0 is a pass; 3 (INCOMPLETE) is not a pass — say which checks could not
run. Do not add GitHub Actions workflows. See `scripts/ci/README.md`.
