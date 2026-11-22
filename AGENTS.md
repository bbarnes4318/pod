<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Remote

`https://github.com/bbarnes4318/pod` is the ONLY valid remote for this project — never push to `bbarnes4318/portal`, which is a different application.

# CI is local: run it before every PR

GitHub Actions does not run for this repository any more. Before pushing a PR,
run the local CI and put its result line in the PR description:

```
./scripts/ci/run.sh fast
```

Exit 0 is a pass; 3 (INCOMPLETE) is not a pass — say which checks could not
run. Do not add GitHub Actions workflows. See `scripts/ci/README.md`.
