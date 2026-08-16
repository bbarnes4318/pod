// Environment variable NAMES that cannot survive a deployment.
//
// WHY THIS EXISTS — a real outage, 2026-08-16.
//
// A variable was added through the Coolify UI named `CEREBRAS API KEY`, with
// spaces instead of underscores. Coolify accepted it. Then the next build ran:
//
//   /artifacts/build-time.env: line 134: CEREBRAS: command not found
//   ERROR: docker: 'docker buildx build' requires 1 argument
//
// Two separate failures from one name. `source build-time.env` parsed
// `CEREBRAS API KEY=csk-...` as the command `CEREBRAS` with two arguments, and
// `--build-arg CEREBRAS API KEY` split into three argv entries, leaving docker
// with a malformed command line.
//
// THE PART THAT MADE IT AN OUTAGE rather than a failed deploy: Coolify's
// handler is "Deployment failed. Removing the new version of your application."
// — and the running web container went with it. The site returned 503 with no
// container at all, not even a stopped one. A typo in a text field took
// production down, and the only signal was a build log nobody was watching.
//
// The blast radius is both apps: the same variable set feeds web and worker, so
// one bad name blocks every future deploy of the whole system until someone
// reads the build output closely enough to spot it.
//
// This guard turns that into a readiness warning. It is deliberately a NAME
// check only — it never reads or reports a value, so it is safe to run against
// the full environment including credentials.

/**
 * POSIX-portable environment variable name: letter or underscore, then letters,
 * digits or underscores. This is the set `source` can assign and `--build-arg`
 * can carry without quoting.
 *
 * Deliberately stricter than what a shell will tolerate in some positions. A
 * name that needs quoting to survive is a name that will eventually meet a
 * context that does not quote it — which is exactly what happened.
 */
export const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvNameProblem {
  key: string;
  /** Why this name breaks, in terms of what it does to a build. */
  reason: string;
}

/** Human-readable diagnosis for one bad name. */
export function diagnoseEnvName(key: string): string | null {
  if (VALID_ENV_NAME.test(key)) return null;
  if (/\s/.test(key)) {
    return (
      `contains a space. \`source\` parses "${key}=..." as a command rather than an assignment, ` +
      `and \`--build-arg ${key}\` splits into separate arguments — this breaks the docker build ` +
      `for BOTH apps and can remove the running container.`
    );
  }
  if (/^[0-9]/.test(key)) {
    return "starts with a digit, which is not a valid shell identifier — the assignment is rejected.";
  }
  if (/-/.test(key)) {
    return "contains a hyphen, which a shell reads as subtraction rather than part of the name.";
  }
  return (
    "contains a character that is not a letter, digit or underscore, so it cannot be assigned by " +
    "`source` or passed as a build argument."
  );
}

/**
 * Every environment name that would break a build, from a supplied set of keys.
 *
 * Takes keys rather than reading process.env itself so the caller decides the
 * scope — a readiness page checks the live environment; a test supplies a
 * fixture. NEVER touches values.
 */
export function findEnvNameProblems(keys: Iterable<string>): EnvNameProblem[] {
  const out: EnvNameProblem[] = [];
  for (const key of keys) {
    const reason = diagnoseEnvName(key);
    if (reason) out.push({ key, reason });
  }
  return out;
}

/**
 * Names the platform injects, which no operator can rename and which never
 * become build arguments.
 *
 * WHY A FILTER AT ALL, given this is a safety check. Scanning the raw process
 * environment surfaces things nobody controls: Windows defines
 * `ProgramFiles(x86)` and `CommonProgramFiles(x86)` on every machine, and
 * tracing middleware injects header-shaped names like `SENTRY-TRACE`. Reporting
 * those as deploy blockers would put three permanent failures on the readiness
 * page, and a warning that is always red is a warning nobody reads — which is
 * exactly how the outage this guard exists to prevent went unnoticed in a build
 * log.
 *
 * The filter is deliberately NARROW and pattern-based rather than a list of
 * specific keys: parenthesised architecture suffixes, and names containing a
 * hyphen that are all-caps header style. An operator-typed key like
 * `CEREBRAS API KEY` matches neither and is still caught. The risk is real
 * though — a filter that grows will eventually hide a genuine problem, so
 * anything added here needs to be something an operator provably cannot set.
 */
const PLATFORM_INJECTED = [
  /\(x86\)$/i, // Windows: ProgramFiles(x86), CommonProgramFiles(x86)
  /^[A-Z0-9]+(-[A-Z0-9]+)+$/, // header-derived: SENTRY-TRACE, X-REQUEST-ID
];

function isPlatformInjected(key: string): boolean {
  return PLATFORM_INJECTED.some((re) => re.test(key));
}

/**
 * The live environment's bad names, excluding platform-injected ones.
 *
 * Names only — no values are read, so this is safe to run against an
 * environment full of credentials.
 */
export function currentEnvNameProblems(): EnvNameProblem[] {
  return findEnvNameProblems(Object.keys(process.env).filter((k) => !isPlatformInjected(k)));
}
