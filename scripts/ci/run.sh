#!/usr/bin/env bash
# take-machine local CI -- the replacement for the GitHub Actions PR checks
# (.github/workflows/real-podcast-quality.yml and integration.yml), which no
# longer run for this repository.
#
#   ./scripts/ci/run.sh fast     # before every PR: every check the two PR
#                                # workflows ran (~15 min)
#   ./scripts/ci/run.sh full     # fast + build the Docker image AND boot it
#   ./scripts/ci/run.sh <step>   # one of: typecheck quality build migrate
#                                #         integration image
#   ./scripts/ci/run.sh clean    # remove containers a killed run left behind
#
# Exit codes: 0 PASS, 1 FAIL, 2 usage, 3 INCOMPLETE (a required check could
# not run here -- never a pass), 130 interrupted.
#
# Needs Node 20 (the Dockerfile's version) and Docker; PostgreSQL 16 and
# Redis 7 run as throwaway containers on random loopback ports.
# Reports: .ci-reports/<time>-<profile>-<sha>/summary.md (newest 20 kept).
# Documentation: scripts/ci/README.md
set -euo pipefail
shopt -s inherit_errexit

# ── Scrub the environment ───────────────────────────────────────────────
# Re-exec under `env -i` with an allowlist: ANTHROPIC/FISH/DEEPGRAM keys, the
# production DATABASE_URL, S3 credentials, SSH agent sockets and everything
# else in the calling shell are gone before any check runs. The NAMES (never
# the values) of credential-like variables are recorded; with
# CI_FORBID_SECRETS=1 merely receiving one fails the run.
if [[ "${TMCI_SCRUBBED:-}" != 1 ]]; then
  sensitive=$(env | cut -d= -f1 | grep -E \
    '(^|_)(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|CREDENTIALS?)($|_)|^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|NVIDIA|ZAI|FISH|ELEVENLABS|CARTESIA|BOSON|DEEPGRAM|AWS|S3|COOLIFY|EPIDEMIC|SMTP|NEXTAUTH|ADMIN)_|^(SSH_AUTH_SOCK|DATABASE_URL|DIRECT_URL|REDIS_URL|PGPASSWORD|GITHUB_TOKEN|GH_TOKEN|ADMIN_PASSWORD)$' |
    sort | tr '\n' ' ' || true)
  keep=(TMCI_SCRUBBED=1 "TMCI_SENSITIVE=${sensitive% }")
  for v in PATH HOME USER LANG LC_ALL TERM TZ TMPDIR NO_COLOR \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE DOCKER_HOST XDG_CACHE_HOME npm_config_cache \
    SYSTEMROOT SystemRoot COMSPEC ComSpec PATHEXT WINDIR windir OS \
    APPDATA LOCALAPPDATA USERPROFILE TEMP TMP SYSTEMDRIVE SystemDrive \
    PROGRAMFILES ProgramFiles PROGRAMDATA ProgramData \
    NUMBER_OF_PROCESSORS HOMEDRIVE HOMEPATH USERNAME MSYSTEM; do
    [[ -n "${!v:-}" ]] && keep+=("$v=${!v}")
  done
  while IFS='=' read -r name _; do
    case "$name" in CI_NETRC_*) ;; CI_*) keep+=("$name=${!name}") ;; esac
  done < <(env)
  exec env -i "${keep[@]}" bash "$0" "$@"
fi

[[ -n "${CI_NODE_DIR:-}" ]] && export PATH="$CI_NODE_DIR:$PATH"
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' B=$'\e[34m' D=$'\e[2m' O=$'\e[0m'; else R='' G='' Y='' B='' D='' O=''; fi
log() { printf '%s[ci %s]%s %s\n' "$D" "$(date +%H:%M:%S)" "$O" "$*" >&2; }

PROFILE="${1:-}"
case "$PROFILE" in
  fast | full | typecheck | quality | build | migrate | integration | image) ;;
  clean)
    docker ps -aq --filter label=take-machine-ci=1 2>/dev/null | xargs -r docker rm -f
    docker network ls -q --filter label=take-machine-ci=1 2>/dev/null | xargs -r docker network rm
    exit 0
    ;;
  -h | --help | help | '')
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown profile '$PROFILE' (fast|full|typecheck|quality|build|migrate|integration|image|clean)" >&2
    exit 2
    ;;
esac

SHA="$(git rev-parse HEAD)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$PROFILE-${SHA:0:8}-$$"
REPORTS="${CI_REPORTS_DIR:-$REPO/.ci-reports}"
RD="$REPORTS/$RUN_ID"
mkdir -p "$RD/steps"
: >"$RD/steps.tsv"
: >"$RD/notes.txt"
START=$(date +%s)
SEQ=0
CRIT=''
PG_PORT=''
REDIS_PORT=''
[[ -n "$(git status --porcelain --untracked-files=no)" ]] && DIRTY=yes || DIRTY=no

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/take-machine-ci"
# Running as root (servers, cloud runners): the tests that start an embedded
# Postgres cannot run as root -- embedded-postgres drops to a `postgres` user
# that can enter neither /root nor the test's root-owned temp directory. So as
# root the working copy lives outside /root and the test steps run as an
# unprivileged user (see do_quality). Nothing changes for a normal user.
CI_UNPRIV_USER="${CI_UNPRIV_USER:-takemachine-ci}"
if [[ $EUID -eq 0 && -z "${XDG_CACHE_HOME:-}" ]]; then CACHE=/var/cache/take-machine-ci; fi
# Checks run against a clean export of HEAD, never the working tree: the tree
# is never written to (no npm ci over the developer's node_modules, no .next,
# no generated Prisma client) and, like GitHub, only committed code is tested.
TREE="${CI_TREE_DIR:-$CACHE/tree}"

# Tests that are ALLOWED to report a skip, named one by one with the reason.
# Anything else that reports a skip fails the step: a suite that quietly skips
# when its services are present is a suite that did not run.
#   "<step>|<grep -E pattern>|<reason>"
ALLOWED_SKIPS=()

# ── Cleanup and report, whatever happens ────────────────────────────────
INTERRUPTED=''
finish() {
  local rc=$? status code
  trap - EXIT INT TERM
  [[ -f "$RD/.sid" ]] && kill_tree "$(cat "$RD/.sid" 2>/dev/null)"
  local ids
  ids=$(docker ps -aq --filter "label=take-machine-ci.run=$RUN_ID" 2>/dev/null || true)
  if [[ -n "$ids" ]]; then
    for id in $ids; do docker logs --tail 200 "$id" >"$RD/container-$id.log" 2>&1 || true; done
    echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  docker network ls -q --filter "label=take-machine-ci.run=$RUN_ID" 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -rf "$RD/.ctx"

  local nfail nblock npass
  nfail=$(awk -F'\t' '$2=="FAIL"||$2=="TIMEOUT"' "$RD/steps.tsv" | wc -l)
  nblock=$(awk -F'\t' '$2=="BLOCKED"' "$RD/steps.tsv" | wc -l)
  npass=$(awk -F'\t' '$2=="PASS"' "$RD/steps.tsv" | wc -l)
  if [[ -n "$INTERRUPTED" ]]; then status=INTERRUPTED code=130
  elif ((nfail > 0)); then status=FAIL code=1
  elif ((nblock > 0)); then status=INCOMPLETE code=3
  elif ((rc != 0)); then status=FAIL code=1; echo "runner exited $rc outside a step" >>"$RD/notes.txt"
  elif ((npass == 0)); then status=INCOMPLETE code=3; echo "no step ran" >>"$RD/notes.txt"
  else status=PASS code=0; fi
  local dur=$(($(date +%s) - START))
  {
    echo "# take-machine CI -- $PROFILE -- $status"
    echo
    echo "commit \`$SHA\` · uncommitted changes: $DIRTY · node $(node -v 2>/dev/null) · $((dur / 60))m$((dur % 60))s"
    echo
    echo "| step | status | time | note |"
    echo "|---|---|---|---|"
    awk -F'\t' '{printf "| %s | **%s** | %ss | %s |\n", $1, $2, $3, $5}' "$RD/steps.tsv"
    if [[ -s "$RD/notes.txt" ]]; then echo; echo "Notes:"; sed 's/^/- /' "$RD/notes.txt"; fi
    for f in $(awk -F'\t' '$2=="FAIL"||$2=="TIMEOUT" {print $4}' "$RD/steps.tsv"); do
      [[ $f == - ]] && continue
      echo; echo "### $f"; echo '```'; tail -n 40 "$RD/$f" || true; echo '```'
    done
  } >"$RD/summary.md"
  printf '{"status":"%s","profile":"%s","sha":"%s","durationSeconds":%d}\n' "$status" "$PROFILE" "$SHA" "$dur" >"$RD/summary.json"
  ls -1dt "$REPORTS"/*/ 2>/dev/null | tail -n +21 | xargs -r rm -rf
  local c=$G
  [[ $status == FAIL || $status == INTERRUPTED ]] && c=$R
  [[ $status == INCOMPLETE ]] && c=$Y
  printf '\n%s══ %s: %s ══%s  %d passed, %d failed, %d blocked in %dm%02ds\n   report: %s\n' \
    "$c" "$PROFILE" "$status" "$O" "$npass" "$nfail" "$nblock" $((dur / 60)) $((dur % 60)) "$RD/summary.md" >&2
  [[ $status == INCOMPLETE ]] && echo "   INCOMPLETE is not a pass: some required checks could not run here." >&2
  exit "$code"
}
trap finish EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM

# Kill a step's whole process tree. `kill -- -pid` needs a process group,
# which needs setsid; Git Bash has neither, and a killed run there used to
# leave tsx/prisma/postgres children holding files in the export tree, which
# then broke the NEXT run with EPERM. taskkill does the same job on Windows.
kill_tree() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if [[ -n "${SETSID:-}" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  elif command -v taskkill >/dev/null; then
    taskkill //T //F //PID "$pid" >/dev/null 2>&1 || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >>"$RD/steps.tsv"; }
blocked() {
  printf '  %s%-8s%s %s (%s)\n' "$Y" BLOCKED "$O" "$1" "$2" >&2
  record "$1" BLOCKED 0 - "$2"
}

# A step marked --test must show that assertions actually ran, and must not
# report a skip. Test runners here exit 0 on "0/0 checks passed", and a suite
# that skips because a service was missing is not a suite that passed.
verify_ran() {
  local name="$1" logf="$2" evidence skips pat
  # Every pass vocabulary these suites actually use. A suite whose output
  # matches none of them is treated as having run nothing.
  evidence=$(grep -cE '^[[:space:]]*(✓|✔|ok +|PASS|pass )|[0-9]+/[0-9]+ (checks|assertions) passed|ALL CHECKS PASSED|PASS — [0-9]+|: PASS$|[0-9]+ passed, [0-9]+ failed' "$logf" || true)
  if grep -qE '(^|[^0-9])0/0 (checks|assertions) passed' "$logf"; then
    echo "no assertions ran (0/0) -- the suite did nothing" >&2
    return 1
  fi
  if [[ "${evidence:-0}" -eq 0 ]]; then
    echo "no assertion output from this suite -- zero tests ran" >&2
    return 1
  fi
  skips=$(grep -nE '^[[:space:]]*(SKIP|SKIPPED|skipping |skipped )|\b[1-9][0-9]* (tests? )?skipped\b|\bskipped: *[1-9]' "$logf" || true)
  if [[ -n "$skips" ]]; then
    for pat in ${ALLOWED_SKIPS[@]+"${ALLOWED_SKIPS[@]}"}; do
      [[ "${pat%%|*}" == "$name" ]] || continue
      local rest="${pat#*|}"
      skips=$(grep -vE "${rest%%|*}" <<<"$skips" || true)
    done
  fi
  if [[ -n "$skips" ]]; then
    echo "a test reported a SKIP although its services were supplied:" >&2
    head -10 <<<"$skips" >&2
    return 1
  fi
  return 0
}

# step [--critical] [--test] <name> <timeout-seconds> <command...>
# Runs in its own process group under `timeout`; output to steps/NN-name.log.
# A failure is never retried.
step() {
  local crit='' istest=''
  while [[ "${1:-}" == --* ]]; do
    [[ "$1" == --critical ]] && crit=1
    [[ "$1" == --test ]] && istest=1
    shift
  done
  local name="$1" limit="$2"
  shift 2
  if [[ -n "$CRIT" ]]; then blocked "$name" "not run: critical step '$CRIT' failed"; return 0; fi
  SEQ=$((SEQ + 1))
  local logf
  logf=$(printf 'steps/%02d-%s.log' "$SEQ" "$name")
  printf '  %s%-8s%s %s\n' "$B" RUN "$O" "$name" >&2
  local t0=$SECONDS rc=0
  $SETSID timeout --kill-after=20 "$limit" bash -c "set -euo pipefail; cd '${STEP_CWD:-$TREE}'; $*" >"$RD/$logf" 2>&1 &
  local pid=$!
  echo "$pid" >"$RD/.sid"
  wait "$pid" || rc=$?
  rm -f "$RD/.sid"
  ((rc != 0)) && kill_tree "$pid" # timeout kills the shell, not its children
  local secs=$((SECONDS - t0)) st=PASS note=''
  ((rc != 0)) && st=FAIL note="exit $rc"
  ((rc == 124 || rc == 137)) && st=TIMEOUT note="exceeded ${limit}s"
  if [[ $st == PASS && -n $istest ]]; then
    local why
    if ! why=$(verify_ran "$name" "$RD/$logf" 2>&1); then
      st=FAIL note="${why%%$'\n'*}"
      { echo; echo "[ci] $why"; } >>"$RD/$logf"
    fi
  fi
  local c=$G
  [[ $st != PASS ]] && c=$R
  printf '  %s%-8s%s %s %s(%ss)%s\n' "$c" "$st" "$O" "$name" "$D" "$secs" "$O" >&2
  if [[ $st != PASS ]]; then
    tail -n 20 "$RD/$logf" | sed 's/^/      | /' >&2
    [[ -n "$crit" ]] && CRIT="$name"
  fi
  record "$name" "$st" "$secs" "$logf" "$note"
}

# ── Preflight ───────────────────────────────────────────────────────────
log "profile=$PROFILE commit=${SHA:0:12} report=$RD"
if [[ -n "${TMCI_SENSITIVE:-}" ]]; then
  echo "credential-like variables received and dropped (names only): $TMCI_SENSITIVE" >>"$RD/notes.txt"
  if [[ "${CI_FORBID_SECRETS:-}" == 1 ]]; then
    record secret-exposure FAIL 0 - "CI_FORBID_SECRETS=1 and this job was handed: $TMCI_SENSITIVE"
    exit 0
  fi
fi

# The Dockerfile and real-podcast-quality.yml both use Node 20. (integration.yml
# pins 22 -- see scripts/ci/README.md; 20 is what ships.)
NODE_WANT="${CI_NODE_MAJOR:-20}"
nm=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [[ "$nm" != "$NODE_WANT" ]]; then
  blocked node-version "node $nm on PATH; the Dockerfile and the quality workflow use Node $NODE_WANT. Set CI_NODE_DIR to a Node $NODE_WANT bin directory (or CI_NODE_MAJOR to override)."
  exit 0
fi
for t in git tar; do
  command -v "$t" >/dev/null || { blocked "$t" "'$t' is required and is not on PATH"; exit 0; }
done
SETSID="$(command -v setsid || true)"

needs_docker=''
case "$PROFILE" in fast | full | migrate | integration | image) needs_docker=1 ;; esac

# One run at a time on this machine. flock where it exists; where it does not
# (Git Bash), an atomic lock directory holding the owner's pid.
mkdir -p "$CACHE"
if command -v flock >/dev/null; then
  exec {LOCK}>"$CACHE/run.lock"
  if ! flock -n "$LOCK"; then
    log "another take-machine CI run holds the lock; waiting (up to ${CI_QUEUE_TIMEOUT:-3600}s)"
    flock -w "${CI_QUEUE_TIMEOUT:-3600}" "$LOCK" || { blocked queue "lock not free in time"; exit 0; }
  fi
else
  LOCKDIR="$CACHE/run.lock.d"
  for _ in $(seq 1 $((${CI_QUEUE_TIMEOUT:-3600} / 5))); do
    if mkdir "$LOCKDIR" 2>/dev/null; then
      echo $$ >"$LOCKDIR/pid"
      trap 'rm -rf "$LOCKDIR"' EXIT
      break
    fi
    # A lock whose owner is gone is stale.
    if ! kill -0 "$(cat "$LOCKDIR/pid" 2>/dev/null || echo 0)" 2>/dev/null; then
      rm -rf "$LOCKDIR"
      continue
    fi
    log "another take-machine CI run holds the lock; waiting"
    sleep 5
  done
  [[ -f "$LOCKDIR/pid" ]] || { blocked queue "lock not free in time"; exit 0; }
  # finish() must still run, and must also drop the lock.
  trap 'rm -rf "$LOCKDIR"; finish' EXIT
fi

# ── A clean export of HEAD, with its own node_modules ───────────────────
# node_modules is keyed by package-lock.json, so `npm ci` only re-runs when the
# lockfile changes. The working tree is never written to.
prepare_tree() {
  local lock_hash
  lock_hash=$(git show "$SHA:package-lock.json" | sha256sum | cut -c1-16)
  mkdir -p "$TREE"
  if [[ "$(cat "$TREE/.ci-tree-sha" 2>/dev/null || true)" != "$SHA" ]]; then
    find "$TREE" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name '.ci-*' -exec rm -rf {} +
    git archive --format=tar "$SHA" | tar -x -C "$TREE"
    echo "$SHA" >"$TREE/.ci-tree-sha"
  fi
  # CI_REUSE_NODE_MODULES=1 links the working tree's node_modules instead of
  # installing. Not a clean install -- the report says so -- but it is the only
  # way to run here when `npm ci` into a fresh directory cannot complete
  # (Windows EPERM from file locking, or a 2GB WSL).
  if [[ -n "${CI_REUSE_NODE_MODULES:-}" && -d "$REPO/node_modules" && ! -e "$TREE/node_modules" ]]; then
    # A link is instant but Turbopack rejects one ("points out of the
    # filesystem root"), so `npm run build` needs CI_REUSE_NODE_MODULES=copy.
    if [[ "$CI_REUSE_NODE_MODULES" == copy ]]; then
      cp -r "$REPO/node_modules" "$TREE/node_modules"
    else
      case "${OSTYPE:-}" in
        msys* | cygwin*) cmd //c mklink //J "$(cygpath -w "$TREE/node_modules")" "$(cygpath -w "$REPO/node_modules")" >/dev/null ;;
        *) ln -s "$REPO/node_modules" "$TREE/node_modules" ;;
      esac
    fi
    echo "node_modules reused from $REPO (CI_REUSE_NODE_MODULES=$CI_REUSE_NODE_MODULES) -- not a clean npm ci"
    echo "dependencies were reused from the working tree (CI_REUSE_NODE_MODULES=1), not installed clean" >>"$RD/notes.txt"
    echo "$lock_hash" >"$TREE/.ci-lock-hash"
  fi
  if [[ "$(cat "$TREE/.ci-lock-hash" 2>/dev/null || true)" != "$lock_hash" ]]; then
    rm -rf "$TREE/node_modules"
    (cd "$TREE" && npm ci --no-audit --no-fund)
    echo "$lock_hash" >"$TREE/.ci-lock-hash"
  else
    echo "node_modules reused (package-lock unchanged: $lock_hash)"
  fi
  (cd "$TREE" && npx prisma generate)
}

# ── Disposable PostgreSQL 16 and Redis 7 ────────────────────────────────
# Random loopback ports, test-only credentials, removed on exit even on Ctrl-C.
# The production database is unreachable by construction: the environment was
# scrubbed, and the URLs below are built from these containers only.
services_up() {
  local p="tmci-$RUN_ID"
  docker run -d --name "$p-pg" --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" \
    --memory 1g -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=takemachine_integration -p 127.0.0.1::5432 \
    "${CI_PG_IMAGE:-postgres:16}" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
  docker run -d --name "$p-redis" --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" \
    --memory 512m -p 127.0.0.1::6379 "${CI_REDIS_IMAGE:-redis:7}" >/dev/null
  PG_PORT=$(docker port "$p-pg" 5432/tcp | head -1 | sed 's/.*://')
  REDIS_PORT=$(docker port "$p-redis" 6379/tcp | head -1 | sed 's/.*://')
  local i
  for i in $(seq 1 60); do
    docker exec "$p-pg" pg_isready -U postgres -d takemachine_integration >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 1
  docker exec "$p-pg" psql -U postgres -d takemachine_integration -v ON_ERROR_STOP=1 -tAc 'select 1' >/dev/null
  docker exec "$p-redis" redis-cli ping >/dev/null
  echo "postgres 16 on 127.0.0.1:$PG_PORT, redis 7 on 127.0.0.1:$REDIS_PORT"
}

need_services() {
  [[ -n "$PG_PORT" ]] && return 0
  local out
  if out=$(services_up 2>&1); then
    echo "$out" >&2
    # services_up ran in a subshell ($(...)), so the ports it read are gone:
    # read them again here, or every check falls back to 5432/6379.
    PG_PORT=$(docker port "tmci-$RUN_ID-pg" 5432/tcp | head -1 | sed 's/.*://')
    REDIS_PORT=$(docker port "tmci-$RUN_ID-redis" 6379/tcp | head -1 | sed 's/.*://')
    export PG_PORT REDIS_PORT
    record services PASS 0 - "$out"
  else
    echo "$out" >&2
    record services FAIL 0 - "could not start PostgreSQL 16 / Redis 7"
    CRIT=services
  fi
}

# Every check runs with these; nothing here is a secret and nothing points at
# production. Mirrors the `env:` blocks of the two workflows.
base_env() {
  cat <<ENVEOF
export NODE_ENV=test NEXT_TELEMETRY_DISABLED=1
export LLM_PROVIDER=stub TTS_PROVIDER=stub STORAGE_PROVIDER=stub
export SCRIPT_QUALITY_GATE_STRICT=false TTS_PERFORMANCE_QA_STRICT=false
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT:-5432}/takemachine_integration?schema=public"
export REDIS_URL="redis://127.0.0.1:${REDIS_PORT:-6379}"
ENVEOF
}

# ── real-podcast-quality.yml -> quality steps ───────────────────────────
# One entry per step of the `quality-contracts` job, in its order.
QUALITY_STEPS=(
  "quality-gate|npx tsx --conditions=react-server src/scripts/testRealPodcastQualityGate.ts"
  "editorial-gate|npm run test:editorial-gate"
  "production-release-gate|npm run test:production-release-gate"
  "semantic-repetition|npm run test:semantic-repetition"
  "opening-chapter-integrity|npm run test:opening-chapter-integrity"
  "story-clustering|npm run test:story-clustering"
  "canary-preflight|npm run test:canary-preflight"
  "provider-error-classification|npm run test:provider-error-classification"
  "llm-role-routing|npm run test:llm-role-routing"
  "llm-routing-audit|npm run audit:llm-routing" # configuration-only: no assertions to count
  "voice-audition-authz|npm run test:voice-audition-authz"
  "listener-signal-abuse|npm run test:listener-signal-abuse"
  "production-readiness|npm run test:production-readiness"
  "semantic-qa-acceptance|npm run test:semantic-qa-acceptance"
  "voice-audition|npm run test:voice-audition"
  "listener-learning|npm run test:listener-learning"
  "seven-role-pipeline|npm run test:seven-role-pipeline"
  "listener-checks|npm run test:listener-checks"
  "world-class-learning|npm run test:world-class-learning"
  "topic-freshness|npm run test:topic-freshness"
  "deployment-contract|npm run test:deployment-contract"
  "podcast-configuration-migration|npm run test:podcast-configuration-migration"
  "migration-adoption|npm run test:migration-adoption"
  "script-queue-tracking|npx tsx --conditions=react-server src/scripts/testScriptQueueTracking.ts"
  "cal-performance|npx tsx --conditions=react-server src/scripts/testCalPerformanceV2.ts"
  "host-studio-capabilities|npx tsx --conditions=react-server src/scripts/testHostStudioCapabilities.ts"
  "show-forge-capabilities|npx tsx --conditions=react-server src/scripts/testShowForgeCapabilities.ts"
  "show-forge-discoverability|npx tsx --conditions=react-server src/scripts/testShowForgeDiscoverability.ts"
  "production-chain|npm run test:production-chain"
  "audio-stitch-recovery|npm run test:audio-stitch-recovery"
)

do_quality() {
  local entry name cmd
  for entry in "${QUALITY_STEPS[@]}"; do
    name="${entry%%|*}"
    cmd="${entry#*|}"
    local flag=--test
    # The routing audit is configuration-only -- it reports and exits, with no
    # assertions to count -- so it is checked by its exit code alone.
    if [[ $name == llm-routing-audit ]]; then flag=''; fi
    if [[ $EUID -eq 0 ]]; then
      local home="/var/lib/$CI_UNPRIV_USER"
      step ${flag:+$flag} "$name" "${CI_STEP_TIMEOUT:-900}" \
        "$(base_env); export HOME='$home' npm_config_cache='$home/.npm'; runuser -u '$CI_UNPRIV_USER' -- bash -c $(printf '%q' "set -euo pipefail; cd '$TREE'; $cmd")"
    else
      step ${flag:+$flag} "$name" "${CI_STEP_TIMEOUT:-900}" "$(base_env); $cmd"
    fi
  done
}

# As root: an unprivileged user that owns the working copy, for do_quality.
unpriv_prepare() {
  [[ $EUID -eq 0 ]] || return 0
  id "$CI_UNPRIV_USER" >/dev/null 2>&1 ||
    useradd --system --create-home --home-dir "/var/lib/$CI_UNPRIV_USER" --shell /bin/bash "$CI_UNPRIV_USER"
  chmod a+rx "$CACHE"
  chown -R "$CI_UNPRIV_USER" "$TREE"
}

# ── integration.yml -> migrate + the five suites ────────────────────────
INTEGRATION_STEPS=(
  "integration-migrations|npm run test:integration-migrations"
  "integration-legacy-release|npm run test:integration-legacy-release"
  "integration-worker-health|npm run test:integration-worker-health"
  "integration-auditions|npm run test:integration-auditions"
  "integration-learning|npm run test:integration-learning"
)

do_integration() {
  local entry name cmd limit
  for entry in "${INTEGRATION_STEPS[@]}"; do
    name="${entry%%|*}"
    cmd="${entry#*|}"
    limit=900
    [[ $name == integration-worker-health ]] && limit=180 # the workflow bounded this one at 3m
    step --test "$name" "$limit" "$(base_env); $cmd"
  done
}

# ── full only: build the image and BOOT it ──────────────────────────────
# Built from a clean `git archive` of the commit, then started on an --internal
# Docker network that reaches only this run's PostgreSQL and Redis -- no
# internet, no provider APIs -- and /api/health and /api/readiness must answer
# from inside it with the database check passing.
do_image() {
  local ctx="$RD/.ctx" tag="take-machine:ci-${SHA:0:12}" net="tmci-$RUN_ID-iso" c="tmci-$RUN_ID-web"
  mkdir -p "$ctx"
  git archive --format=tar "$SHA" | tar -x -C "$ctx"
  local file="$ctx/Dockerfile"
  if [[ -n "${CI_BUILD_CA_BUNDLE:-}" ]]; then
    # Only behind a TLS-intercepting proxy (corporate networks, some cloud
    # sandboxes); the bundle must include the public roots. Added to a
    # throwaway copy of the Dockerfile, never to the repository.
    cp "$CI_BUILD_CA_BUNDLE" "$ctx/ci-proxy-ca.bundle"
    awk '{print} /^FROM /{print "COPY ci-proxy-ca.bundle /usr/local/share/ci-ca.bundle"; print "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ci-ca.bundle SSL_CERT_FILE=/usr/local/share/ci-ca.bundle"}' \
      "$ctx/Dockerfile" >"$ctx/ci.Dockerfile"
    file="$ctx/ci.Dockerfile"
    echo "image built with CI_BUILD_CA_BUNDLE (proxy CA in a throwaway copy of the Dockerfile)" >>"$RD/notes.txt"
  fi
  docker build -f "$file" -t "$tag" "$ctx"
  docker network create --internal --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" "$net" >/dev/null
  docker run -d --name "$c-db" --network "$net" --network-alias db \
    --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" --memory 1g \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=takemachine_boot \
    "${CI_PG_IMAGE:-postgres:16}" -c fsync=off >/dev/null
  docker run -d --name "$c-redis" --network "$net" --network-alias redis \
    --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" --memory 512m \
    "${CI_REDIS_IMAGE:-redis:7}" redis-server --requirepass ci-only-redis-password >/dev/null
  local i
  for i in $(seq 1 60); do
    docker exec "$c-db" pg_isready -U postgres -d takemachine_boot >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 1
  # Obviously fake, CI-only values for whatever production config demands.
  local envs=(-e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0
    -e DATABASE_URL=postgresql://postgres:postgres@db:5432/takemachine_boot
    # Production refuses a Redis without a password (src/lib/env), so the
    # boot test's Redis has a CI-only one.
    -e REDIS_URL=redis://:ci-only-redis-password@redis:6379
    -e LLM_PROVIDER=stub -e TTS_PROVIDER=stub -e STORAGE_PROVIDER=stub
    # src/lib/env refuses stub sports/research providers in production. Real
    # provider names with fake keys: the --internal network has no route out,
    # so nothing is ever called. /api/readiness then reports the missing
    # production keys/domain as failures (503), which is expected here; this
    # check only requires its database and redis checks to pass.
    -e SPORTS_PROVIDER=sportsdataio -e SPORTSDATAIO_API_KEY=ci-only-sportsdataio-key
    -e RESEARCH_PROVIDER=exa -e EXA_API_KEY=ci-only-exa-key
    -e ADMIN_PASSWORD=ci-only-admin-password-not-a-real-one-000
    -e NEXTAUTH_SECRET=ci-only-nextauth-secret-not-a-real-one-000
    -e NEXTAUTH_URL=http://127.0.0.1:3000)
  docker run --rm --network "$net" --label take-machine-ci=1 --label "take-machine-ci.run=$RUN_ID" \
    "${envs[@]}" "$tag" npx prisma migrate deploy
  docker run -d --name "$c" --network "$net" --label take-machine-ci=1 \
    --label "take-machine-ci.run=$RUN_ID" --memory 2g "${envs[@]}" "$tag" >/dev/null
  local out
  for i in $(seq 1 90); do
    if out=$(docker exec "$c" node -e "
        Promise.all(['/api/health','/api/readiness'].map(p =>
          fetch('http://127.0.0.1:3000'+p).then(async r => p+' '+r.status+' '+(await r.text()).slice(0,4000))))
          .then(rs => { console.log(rs.join('\n')); process.exit(/\/api\/health 200 /.test(rs[0]) ? 0 : 1); })
          .catch(() => process.exit(1))" 2>/dev/null); then
      echo "answered after ${i}s:"
      echo "$out"
      grep -q '"ok":true' <<<"$out" || { echo "/api/health did not report ok"; return 1; }
      grep -qE '"name":"database","status":"pass"' <<<"$out" || {
        echo "/api/readiness does not see the database from inside the container"
        return 1
      }
      grep -qE '"name":"redis","status":"pass"' <<<"$out" || {
        echo "/api/readiness does not see Redis from inside the container"
        return 1
      }
      return 0
    fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" == true ]] || break
    sleep 2
  done
  echo "the container never answered /api/health"
  docker logs "$c" 2>&1 | tail -60
  return 1
}

# ── Profiles ────────────────────────────────────────────────────────────
export REPO TREE SHA RD RUN_ID PG_PORT REDIS_PORT
export -f prepare_tree do_image

if [[ -n "$needs_docker" ]] && ! docker info >/dev/null 2>&1; then
  blocked docker "Docker is required (PostgreSQL 16 and Redis 7 run as throwaway containers) and the daemon is not reachable"
  case "$PROFILE" in
    fast | full) CRIT='' ;; # the quality half needs no services; run it and report INCOMPLETE
    *) exit 0 ;;
  esac
  SKIP_SERVICES=1
fi

STEP_CWD="$REPO" step --critical install "${CI_INSTALL_TIMEOUT:-2400}" prepare_tree

case "$PROFILE" in
  typecheck | fast | full) step typecheck "${CI_TYPECHECK_TIMEOUT:-1800}" "$(base_env); npx tsc --noEmit" ;;
esac
case "$PROFILE" in
  quality | fast | full) unpriv_prepare; do_quality ;;
esac

case "$PROFILE" in
  migrate | integration | fast | full)
    if [[ -n "${SKIP_SERVICES:-}" ]]; then
      blocked migrate-from-empty "Docker is not available, so PostgreSQL 16 could not be started"
      for entry in "${INTEGRATION_STEPS[@]}"; do
        blocked "${entry%%|*}" "Docker is not available, so PostgreSQL 16 and Redis 7 could not be started"
      done
    else
      need_services
      step migrate-from-empty 600 "$(base_env); npx prisma migrate deploy"
      [[ $PROFILE == integration || $PROFILE == fast || $PROFILE == full ]] && do_integration
    fi
    ;;
esac

# `npm run build` was the last step of the quality job; it needs the generated
# Prisma client and nothing else.
case "$PROFILE" in
  build | fast | full) step build "${CI_BUILD_TIMEOUT:-2400}" "$(base_env); npm run build" ;;
esac

case "$PROFILE" in
  image | full)
    if [[ -n "${SKIP_SERVICES:-}" ]]; then
      blocked image "Docker is not available, so the image cannot be built or booted"
    else
      STEP_CWD="$REPO" step image "${CI_IMAGE_TIMEOUT:-3600}" do_image
    fi
    ;;
esac
exit 0
