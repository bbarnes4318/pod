// Assert the four render conditions against a captured worker log.
//
//   npm run verify:llm-cost-render -- path/to/worker.log
//
// NETWORK-FREE. Reads a log file, parses its `[LLMCost]` lines, and checks the
// things a human would otherwise verify by squinting at a few hundred lines and
// hoping they did not miss one.
//
// WHY IT EXISTS. Two of the changes this branch makes are only observable in a
// real render — prompt caching and dollar telemetry — and both fail QUIETLY.
// A cache that never hits still produces a correct episode, just an expensive
// one; an unpriced ledger still logs every call, just without the number that
// makes it useful. Neither shows up as an error, so "we checked" has to mean
// something more repeatable than one person reading a log once.
//
// See docs/verification/first-render-checklist.md for how to produce the log.

import fs from "fs";

/** One parsed `[LLMCost]` line. */
export interface CostLine {
  raw: string;
  lineNumber: number;
  stage: string;
  role?: string;
  profile?: string;
  provider: string;
  model: string;
  tkIn: number;
  tkOut: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
  retries: number;
  fallbacks: number;
  repairs: number;
  failure?: string;
  /** null = the line said `cost=unpriced`. */
  costUsd: number | null;
}

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse the `[LLMCost]` lines out of a worker log.
 *
 * Tolerant of surrounding log furniture (timestamps, container prefixes, ANSI)
 * because real captured logs have all three — the marker is `[LLMCost]`, not the
 * start of the line.
 */
export function parseCostLines(text: string): CostLine[] {
  const out: CostLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const at = raw.indexOf("[LLMCost]");
    if (at === -1) continue;
    const body = raw.slice(at);
    const field = (name: string): string | undefined =>
      body.match(new RegExp(`\\b${name}=([^\\s]+)`))?.[1];

    const provider = field("provider");
    const model = field("model");
    if (!provider || !model) continue; // not a well-formed cost line

    const costRaw = field("cost");
    out.push({
      raw: body,
      lineNumber: i + 1,
      stage: field("stage") ?? "(none)",
      role: field("role"),
      profile: field("profile"),
      provider,
      model,
      tkIn: num(field("in")),
      tkOut: num(field("out")),
      cacheRead: num(field("cacheRead")),
      cacheWrite: num(field("cacheWrite")),
      ms: num(field("ms")),
      retries: num(field("retries")),
      fallbacks: num(field("fallbacks")),
      repairs: num(field("repairs")),
      failure: field("FAILED"),
      costUsd: !costRaw || costRaw === "unpriced" ? null : Number(costRaw.replace(/^\$/, "")),
    });
  }
  return out;
}

export interface Finding {
  id: string;
  title: string;
  status: "pass" | "fail" | "inconclusive";
  detail: string;
}

const BROKEN_MODEL = "deepseek-ai/deepseek-v4-pro";

/** The four conditions, evaluated independently so one gap does not hide another. */
export function evaluateRender(lines: CostLine[]): Finding[] {
  const findings: Finding[] = [];
  const ok = (l: CostLine) => !l.failure;

  // ---- 1. prompt caching actually engaged ---------------------------------
  //
  // Scoped to Anthropic because that is the only provider where cacheableContext
  // becomes a real cache breakpoint — the OpenAI-compatible adapters concatenate
  // it into the system prompt, which is behaviour-neutral and caches nothing.
  const anthropic = lines.filter((l) => l.provider === "anthropic");
  if (anthropic.length === 0) {
    findings.push({
      id: "cache-read",
      title: "cacheRead > 0 on Anthropic calls after the first",
      status: "inconclusive",
      detail:
        "No Anthropic-served calls in this log. Under verified_development, Anthropic is the PAID BACKUP and a " +
        "healthy run never reaches it — so this is the expected shape of a clean render, and it means the caching " +
        "change is UNPROVEN rather than proven. Re-run with the host writers pinned to Anthropic (see the " +
        "checklist) to actually exercise it.",
    });
  } else if (anthropic.length === 1) {
    findings.push({
      id: "cache-read",
      title: "cacheRead > 0 on Anthropic calls after the first",
      status: "inconclusive",
      detail:
        "Exactly one Anthropic call in this log. The first call WRITES the cache; a read can only happen on a " +
        "later one, so there is nothing to check yet. Pin the host writers to Anthropic so a host makes several " +
        "calls in one episode.",
    });
  } else {
    const after = anthropic.slice(1);
    const cold = after.filter((l) => l.cacheRead === 0);
    findings.push({
      id: "cache-read",
      title: "cacheRead > 0 on Anthropic calls after the first",
      status: cold.length === 0 ? "pass" : "fail",
      detail:
        cold.length === 0
          ? `${after.length} of ${anthropic.length} Anthropic calls followed the first, and every one read from ` +
            `cache (${after.reduce((s, l) => s + l.cacheRead, 0).toLocaleString()} cached tokens total).`
          : `${cold.length} of ${after.length} Anthropic calls after the first read NOTHING from cache. ` +
            `The cached prefix is being invalidated between calls — something per-call has got into the static ` +
            `block. Offending stages: ${[...new Set(cold.map((l) => `${l.stage}${l.role ? `/${l.role}` : ""}`))].join(", ")}.`,
    });
  }

  // ---- 2. the broken model is not being attempted -------------------------
  const broken = lines.filter((l) => l.model.includes(BROKEN_MODEL));
  findings.push({
    id: "no-deepseek-pro",
    title: `zero calls to ${BROKEN_MODEL}`,
    status: broken.length === 0 ? "pass" : "fail",
    detail:
      broken.length === 0
        ? "The model does not appear in this log at all, so no stage paid a guaranteed-losing attempt on it."
        : `${broken.length} call(s) still went to it: ${[...new Set(broken.map((l) => `${l.stage}${l.role ? `/${l.role}` : ""}`))].join(", ")}. ` +
          `It is marked broken-in-production and should have been filtered out of every default chain — a call ` +
          `here means either an explicit role override is pointing at it, or the profile in force is not one of ` +
          `the filtered ones.`,
  });

  // ---- 3. the two repaired continuity roles ran first-try ------------------
  for (const role of ["continuity_report", "script_continuity_editor"]) {
    const forRole = lines.filter((l) => l.role === role);
    if (forRole.length === 0) {
      findings.push({
        id: `first-attempt-${role}`,
        title: `${role} completes on its new primary at the first attempt`,
        status: "inconclusive",
        detail:
          `No calls recorded for ${role}. Continuity in this show is OPTIONAL and topic-gated, so an episode ` +
          `that did not trigger it produces no line — that is normal, and it also means this condition was not ` +
          `exercised. Render a continuity-eligible topic to check it.`,
      });
      continue;
    }
    const first = forRole[0];
    const clean = ok(first) && first.fallbacks === 0 && first.retries === 0;
    findings.push({
      id: `first-attempt-${role}`,
      title: `${role} completes on its new primary at the first attempt`,
      status: clean ? "pass" : "fail",
      detail: clean
        ? `Served by ${first.provider}/${first.model} on the first attempt — no fallback, no retry.`
        : `First ${role} call was ${first.provider}/${first.model} with ` +
          `fallbacks=${first.fallbacks} retries=${first.retries}` +
          `${first.failure ? ` FAILED=${first.failure}` : ""}. The replacement rung is not holding the role.`,
    });
  }

  // ---- 4. the paid rung reports dollars -----------------------------------
  if (anthropic.length === 0) {
    findings.push({
      id: "priced",
      title: "cost= shows dollars on the Anthropic rung",
      status: "inconclusive",
      detail: "No Anthropic calls in this log — nothing to price. See the note on the caching condition above.",
    });
  } else {
    const unpriced = anthropic.filter((l) => l.costUsd === null);
    findings.push({
      id: "priced",
      title: "cost= shows dollars on the Anthropic rung",
      status: unpriced.length === 0 ? "pass" : "fail",
      detail:
        unpriced.length === 0
          ? `All ${anthropic.length} Anthropic calls priced; total $${anthropic
              .reduce((s, l) => s + (l.costUsd ?? 0), 0)
              .toFixed(4)}.`
          : `${unpriced.length} of ${anthropic.length} Anthropic calls logged cost=unpriced. Set ` +
            `LLM_PRICE_ANTHROPIC_IN and _OUT on the worker (COOLIFY_ENV_CHANGES.md §2). Both are required — ` +
            `one without the other resolves to no rate at all.`,
    });
  }

  return findings;
}

function main() {
  const path = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!path) {
    console.error(
      "\nUsage: npm run verify:llm-cost-render -- <path-to-worker-log>\n\n" +
        "Capture the log first — see docs/verification/first-render-checklist.md.\n"
    );
    process.exit(2);
  }
  if (!fs.existsSync(path)) {
    console.error(`\nNo such file: ${path}\n`);
    process.exit(2);
  }

  const lines = parseCostLines(fs.readFileSync(path, "utf8"));
  console.log(`\nLLM cost render verification — ${path}`);
  console.log(`${lines.length} [LLMCost] line(s) parsed\n`);

  if (lines.length === 0) {
    console.error(
      "No [LLMCost] lines found. Either the capture missed them (check you grabbed the WORKER log, not the web\n" +
        "one) or the render never reached an LLM call. Nothing can be concluded from this file.\n"
    );
    process.exit(2);
  }

  // Per-stage summary first: the numbers a human would want anyway.
  const byStage = new Map<string, { calls: number; tkIn: number; tkOut: number; cacheRead: number; cost: number | null }>();
  for (const l of lines) {
    const agg = byStage.get(l.stage) ?? { calls: 0, tkIn: 0, tkOut: 0, cacheRead: 0, cost: null as number | null };
    agg.calls++;
    agg.tkIn += l.tkIn;
    agg.tkOut += l.tkOut;
    agg.cacheRead += l.cacheRead;
    if (l.costUsd !== null) agg.cost = (agg.cost ?? 0) + l.costUsd;
    byStage.set(l.stage, agg);
  }
  console.log("stage".padEnd(34) + "calls".padStart(6) + "in".padStart(10) + "out".padStart(9) + "cacheRead".padStart(11) + "cost".padStart(11));
  console.log("-".repeat(81));
  for (const [stage, a] of [...byStage.entries()].sort((x, y) => y[1].tkIn - x[1].tkIn)) {
    console.log(
      stage.slice(0, 33).padEnd(34) +
        String(a.calls).padStart(6) +
        a.tkIn.toLocaleString().padStart(10) +
        a.tkOut.toLocaleString().padStart(9) +
        a.cacheRead.toLocaleString().padStart(11) +
        (a.cost === null ? "unpriced" : `$${a.cost.toFixed(4)}`).padStart(11)
    );
  }

  const findings = evaluateRender(lines);
  console.log("\nConditions\n");
  for (const f of findings) {
    const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
    console.log(`  ${mark} ${f.title}`);
    console.log(`      ${f.detail}\n`);
  }

  const failed = findings.filter((f) => f.status === "fail");
  const inconclusive = findings.filter((f) => f.status === "inconclusive");
  console.log(
    `${findings.length - failed.length - inconclusive.length} passed, ${failed.length} failed, ` +
      `${inconclusive.length} inconclusive\n`
  );
  if (inconclusive.length && !failed.length) {
    console.log(
      "INCONCLUSIVE IS NOT PASS. A condition that could not be evaluated is unproven — say so in the PR rather\n" +
        "than reporting a green run.\n"
    );
  }
  // Exit 1 on a real failure; 3 on inconclusive-only, so a caller can tell
  // "this render disproved something" from "this render proved nothing".
  process.exit(failed.length ? 1 : inconclusive.length ? 3 : 0);
}

const invokedDirectly = process.argv[1] && /verifyLlmCostRender\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main();
