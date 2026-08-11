# Rollback plan — `fix/llm-pipeline-hardening`

Merging PR #105 to `main` fires both GitHub webhooks and rebuilds **web** and
**worker** independently. This is what to do if that goes wrong.

Read the five-minute health check first. Most of what this branch could break is
visible in the worker log within one episode, and none of it takes the site down.

---

## 1. The revert

```bash
git checkout main && git pull
git revert --no-edit -m 1 <merge-commit-sha>
git push origin main
```

`-m 1` reverts the merge against `main`'s side — i.e. removes everything the PR
added and leaves `main` at its pre-merge behaviour. Use the **merge commit** sha
from `git log --oneline -1` after the merge, not `2bf677c`.

Pushing that revert **fires the webhooks again** and rebuilds both apps. That is
the intent: the revert is only live once both containers are running its image.

### What it does to each container

| Container | Effect |
|---|---|
| `take-machine-web` (`fs2y9ukgyykqq39bptosl7un`) | Rebuild + restart. Brief 502/connection-refused while the new image comes up. The only web-visible change in this branch is the readiness report gaining a `broken-in-production` category, so a revert here is near-cosmetic. |
| `take-machine-worker` (`xrw61e96a26n3cmhzxglxkf0`) | Rebuild + restart. **Any in-flight episode dies with it** — BullMQ will retry the job per its own policy, but a half-generated episode is not resumed mid-stage. Prefer reverting when the queue is idle. |

**They rebuild separately and can drift.** A revert that lands on web but not
worker leaves the old worker running the new code's routing. Always confirm both
image tags after (§2).

---

## 2. Is the deploy healthy? — five minutes

### Both containers are on the new image

```bash
ssh root@178.156.153.87 'docker ps --format "{{.Image}}  up {{.RunningFor}}" | grep -Ei "xrw61e96|fs2y9"'
```

Normal: both lines show the **same** commit sha, and `up` is measured in seconds
or minutes. Two different shas means one app failed to build — that is the drift
that puts a stale worker behind a current web.

### Web answers

```bash
curl -s https://podcast.hopwhistle.com/api/health
```

Normal: `{"ok":true,"service":"take-machine","timestamp":"..."}`. Anything else,
or a hang, means the web container did not come up.

### Worker booted

```bash
ssh root@178.156.153.87 'docker logs --tail 60 $(docker ps -q --filter name=xrw61e96)'
```

Normal, within seconds of restart:

```
--------------------------------------------------
TAKE MACHINE WORKER - INITIALIZING
...
Redis Connection: <...>
Background Queue: <...>
Production Queue: <...>
--------------------------------------------------
```

If those lines are absent, the worker crashed on boot — that is the one failure
mode of this branch that is **not** episode-scoped, and it is a revert, not a
wait.

### Then render one episode

Nothing below §3 can be seen without an episode. The health check proves the
containers are up; only a render proves the routing and ledger changes work.

---

## 3. What THIS branch could break, and the line that shows it

Four things changed that can misbehave. Each has a specific symptom in the
worker log — none is silent, which was the point of most of the work.

### 3a. A role has no reachable model (routing chains)

Six roles got replacement rungs and `frontier_development`'s host-B fallback
order changed. If a replacement is itself unreachable, that role has nothing
left.

**Symptom** — in the worker log:

```
[LLMRouting] role=continuity_report ... advancing to ...
```
followed by the stage failing, or a readiness line reading `EMPTY chain`.

**Confirm offline, instantly** (no deploy needed):

```bash
npm run test:routing-chain-health
```

That asserts no role is empty and none is down to a single candidate. If it
passes on the merged `main`, this failure mode is not what you are looking at.

**Severity:** episode-scoped. Optional roles (continuity) degrade; required roles
(host writers, judge) hold the episode at the production gate rather than
shipping something bad.

### 3b. The ledger crashes on an unpriced provider (cost telemetry)

`estimateCostUsd` gained cache-token pricing and both the Anthropic and OpenAI
adapters now call it where they previously did not.

**Symptom** — a stack trace naming `costLedger` or `estimateCostUsd`, or an LLM
call that succeeds upstream but throws immediately after. The tell is that the
**provider returned fine** and the failure is in recording it.

**What normal looks like** — every call emits one line:

```
[LLMCost] stage=script:host-writer:Zabala role=script_host_a_writer provider=zai model=glm-4.7-flash in=8123 out=1204 cacheRead=0 cacheWrite=0 reasoning=0 ms=14213 cost=$0.0000
```

`cost=unpriced` is **not** a failure — it means no rate is configured for that
provider. `cost=$0.0000` on NVIDIA/Z.ai is correct and deliberate.

**Severity:** would be episode-fatal if it threw, but this path is pure
arithmetic over numbers the provider already returned, and
`npm run test:llm-cost-pricing` covers the zero/empty/missing-rate cases. Low
risk; listed because it is new code on every single call.

### 3c. A host-writer call is missing context (prompt restructure)

The private brief, spine and evidence packet moved from the user prompt into
`cacheableContext`. If a provider adapter dropped that field, the writer would be
working without its brief.

**Symptom** — not a crash. The episode completes and reads wrong: hosts with no
distinct agenda, factual claims with empty `evidenceRefs`, or the fact-check gate
holding the publish. In the log:

```
... isolation_breach ...
```
or a spike in unsupported-claim holds at the publish gate.

**The faster tell** is token counts. A host-writer call that lost its static
block shows a much smaller `in=` than its siblings — the brief and evidence
packet are most of that number.

**Confirm offline:**

```bash
npm run test:prompt-cache-stability
```

It asserts every section of the pre-split prompt is still present across
`systemPrompt + cacheableContext + prompt`.

**Severity:** quality, not availability. This is the change most worth watching
on the first real episode, because its failure mode is a worse show rather than
an error.

### 3d. The paid backup 404s (model id)

`ANTHROPIC_MODEL` now defaults to `claude-opus-5` in code.

**Symptom:**

```
[Anthropic] API request failed with status 404: ... model ...
```

Only ever fires when the free chain has already failed, so it appears *after* a
run of `[LLMRouting]` fallback lines.

**Confirm offline:** `npm run test:anthropic-model-ids`.

**Severity:** only bites during an outage of the free chain — which is exactly
when you need the backup.

---

## 4. Config-only vs code

Not everything here needs a revert. Two of the four levers are environment, and
env changes take effect on the next worker restart with **no rebuild**.

| Change | Revert by | Redeploy? |
|---|---|---|
| `LLM_PRICE_*` rates (§2 of `COOLIFY_ENV_CHANGES.md`) | Unset the vars in Coolify | No — restart only. Ledger returns to `cost=unpriced`. |
| `SCRIPT_LLM_MODEL` / `ANTHROPIC_MODEL` pins | Set the vars back in Coolify | No — restart only. Env beats the in-code default. |
| Host-writer Anthropic pins, if left set after a cache proof | **Unset** `SCRIPT_HOST_A/B_WRITER_LLM_*` | No — restart only. Leaving these set is the likeliest post-merge mistake: it silently bills every episode's dialogue to Opus 5 **and** collapses both hosts onto one model. |
| Routing chain replacements (`profiles.ts`) | git revert | **Yes** |
| `broken-in-production` availability state | git revert | **Yes** |
| Cache-stable prompt split | git revert | **Yes** |
| `endpoint_rejected_fast` classification | git revert | **Yes** |

**Try config first.** If the symptom is cost-shaped or model-shaped, an env fix
is a restart; a code revert is a rebuild of both apps and kills any in-flight
episode. Only 3a and 3c genuinely require the revert.

---

## 5. If you are unsure

Reverting is cheap and reversible — `main` is a branch, and the PR can be
re-merged after a fix. An episode generated by a half-broken pipeline is not
cheap: it burns provider spend, and if it clears the gates it ships. When in
doubt, revert and diagnose on the branch.
