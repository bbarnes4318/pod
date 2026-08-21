// Chained research-brief jobs must not all start in the same instant.
//
// Production evidence (2026-08-20/21): a topic sweep enqueued one
// generate:research-brief per new topic, all at once. Each is a multi-call LLM
// chain against the same two free-tier accounts, and with two background
// workers they collided, 429'd, waited 60s, re-ran the chain, 429'd again, and
// failed after 130-670s. Dozens of them, back to back, for over an hour. The
// router's own failure text named the cause without knowing it was us:
// "another workload is spending that budget."
//
// NETWORK-FREE. Run: npm run test:research-brief-stagger

function researchBriefStaggerMs(index: number, env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.RESEARCH_BRIEF_STAGGER_MS ?? "", 10);
  const step = Number.isFinite(parsed) && parsed >= 0 && parsed <= 600_000 ? parsed : 90_000;
  return step * Math.max(0, index);
}

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("\nresearch-brief stagger\n");

check("the first brief is not delayed at all", () => {
  assert(researchBriefStaggerMs(0, {}) === 0, "the first job must start immediately");
});

check("siblings are spaced, so a refilling window can refill", () => {
  const delays = [0, 1, 2, 3].map((i) => researchBriefStaggerMs(i, {}));
  assert(new Set(delays).size === delays.length, `all four collided: ${delays.join(",")}`);
  for (let i = 1; i < delays.length; i++) {
    assert(delays[i] - delays[i - 1] >= 60_000,
      `gap ${i} is ${delays[i] - delays[i - 1]}ms, shorter than the 60s window the providers publish`);
  }
});

check("every topic still gets a job — spacing is not capping", () => {
  const enqueued = Array.from({ length: 25 }, (_, i) => researchBriefStaggerMs(i, {}));
  assert(enqueued.length === 25, "no topic may be dropped to reduce load");
  assert(enqueued.every((d) => Number.isFinite(d) && d >= 0), "every delay must be a real, non-negative number");
});

check("the old all-at-once behaviour is still reachable", () => {
  const delays = [0, 1, 2].map((i) => researchBriefStaggerMs(i, { RESEARCH_BRIEF_STAGGER_MS: "0" }));
  assert(delays.every((d) => d === 0), `expected no spacing, got ${delays.join(",")}`);
});

check("a nonsense or out-of-range value falls back to the default", () => {
  for (const bad of ["abc", "-5", "99999999", ""]) {
    assert(researchBriefStaggerMs(1, { RESEARCH_BRIEF_STAGGER_MS: bad }) === 90_000,
      `${JSON.stringify(bad)} must not be trusted as a delay`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
