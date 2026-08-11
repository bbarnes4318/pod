// Routing chain health: redundancy, routability, and the two standing
// independence invariants.
//
// NETWORK-FREE. Run: npm run test:routing-chain-health
//
// HISTORY. deepseek-v4-pro was recorded as "LIVE VERIFIED, and the cleanest of
// the six" and then failed `FAILED=unknown` in 14-27ms on every production
// request, with zero successes. It was first pulled by marking it non-routable,
// which was correct and incomplete: eight roles listed it, so pulling it left
// six of them with exactly ONE usable model, and in several cases that survivor
// was zai/glm-4.7-flash — the model that had itself been rate-limited. A chain
// of one is not a chain. Those roles now have real replacement rungs, and the
// assertion below is that they keep them.
//
// WHY THE INVARIANTS ARE HERE. Both are properties nothing else enforces and
// both fail silently: a judge that shares a model with the writer it grades
// still returns a confident score, and two host writers on one model still
// produce a script. Neither shows up as an error — only as output that is
// quietly worse. So they are asserted rather than trusted to the comments in
// profiles.ts that explain them.

import {
  declaredProfileChainFor,
  filterProfileChain,
  profileChainFor,
  profileRoleMap,
  type RoutingProfile,
} from "../lib/providers/llm/profiles";
import { isRoutableByDefault, modelCapabilities } from "../lib/providers/llm/capabilities";
import { STALENESS_LIMIT_DAYS, evaluateRoutingStaleness } from "../lib/providers/llm/routingEvidence";
import { ALL_ROLES, type LLMRole } from "../lib/providers/llm/roles";

let passed = 0,
  failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const key = (r: { provider: string; model: string }) => `${r.provider}/${r.model}`;

/**
 * Profiles that route across MULTIPLE model families, and are therefore the
 * ones the independence invariants can apply to.
 *
 * `free_independent` is excluded by design, not by oversight: it points every
 * role at one Z.ai model on purpose, to test one provider across the whole
 * chain. Under it a judge necessarily shares a model with the writer it grades
 * and the two host writers necessarily collapse onto one voice. That is the
 * known cost of that profile and the reason it is a diagnostic rather than a
 * production setting — asserting the invariants against it would either fail
 * permanently or force the profile to stop being what it is. It gets its own
 * assertion below instead.
 */
const MULTI_MODEL_PROFILES: RoutingProfile[] = ["verified_development", "frontier_development"];

/** The profile production is expected to run. */
const PRODUCTION_PROFILE: RoutingProfile = "verified_development";

function main() {
  console.log("\nRouting chain health\n");

  // ---- routability ---------------------------------------------------------

  check("no runnable chain contains a non-routable model, in any profile", () => {
    // Guards the filter itself. Every candidate routing can actually reach must
    // have availability "available" — if a non-routable model survives into a
    // usable chain, every request to that role pays a guaranteed-losing attempt.
    const leaks: string[] = [];
    for (const profile of [...MULTI_MODEL_PROFILES, "free_independent" as RoutingProfile]) {
      for (const role of ALL_ROLES) {
        for (const ref of profileChainFor(profile, role)) {
          const caps = modelCapabilities(ref.provider, ref.model);
          if (!isRoutableByDefault(caps)) {
            leaks.push(`${profile}/${role}: ${key(ref)} is ${caps.availability}`);
          }
        }
      }
    }
    assert(leaks.length === 0, `non-routable models survived the availability filter:\n      ${leaks.join("\n      ")}`);
  });

  check("every filtered candidate is given a reason that names its actual failure", () => {
    // The reason string is the operator's only explanation for a missing model.
    // It was once a single sentence shared by every non-routable state, which
    // reported "503 capacity" for a model that had never returned a 503.
    const wrong: string[] = [];
    for (const profile of MULTI_MODEL_PROFILES) {
      for (const role of ALL_ROLES) {
        for (const f of filterProfileChain(profile, role).filtered) {
          const expectFragment =
            f.availability === "unavailable-for-account"
              ? "404"
              : f.availability === "capacity-limited"
                ? "503"
                : "real pipeline traffic failed";
          if (!f.reason.includes(expectFragment)) {
            wrong.push(`${profile}/${role}: ${key(f.ref)} is ${f.availability} but its reason reads "${f.reason}"`);
          }
        }
      }
    }
    assert(wrong.length === 0, `filter reasons do not match the availability they describe:\n      ${wrong.join("\n      ")}`);
  });

  // ---- redundancy ----------------------------------------------------------

  check(`${PRODUCTION_PROFILE}: no role has an empty candidate chain`, () => {
    const empty = ALL_ROLES.filter((r) => profileChainFor(PRODUCTION_PROFILE, r).length === 0);
    assert(empty.length === 0, `these roles have NO usable model and would fail every request: ${empty.join(", ")}`);
  });

  check(`${PRODUCTION_PROFILE}: every role keeps at least one failover`, () => {
    // The regression this exists to catch: removing a broken model from a chain
    // without replacing it. A single-candidate role has no failover at all, and
    // a transient blip on its one model is a failed episode.
    const single = ALL_ROLES.filter((r) => profileChainFor(PRODUCTION_PROFILE, r).length === 1).map(
      (r) => `${r} (only ${key(profileChainFor(PRODUCTION_PROFILE, r)[0])})`
    );
    assert(
      single.length === 0,
      `these roles are down to ONE usable model, so they have no failover left:\n      ${single.join("\n      ")}\n` +
        `      Give each a replacement rung in verifiedDevelopmentChain rather than accepting the exposure.`
    );
  });

  check(`${PRODUCTION_PROFILE}: no role declares a model it cannot run`, () => {
    // Distinct from the filter test: this says the DECLARED map is honest. The
    // production profile is meant to be the observed-working map, so a declared
    // candidate that gets filtered out means the map is describing an intention,
    // which is what frontier_development is for.
    const declaredButUnusable: string[] = [];
    for (const role of ALL_ROLES) {
      for (const f of filterProfileChain(PRODUCTION_PROFILE, role).filtered) {
        declaredButUnusable.push(`${role}: ${key(f.ref)} (${f.availability})`);
      }
    }
    assert(
      declaredButUnusable.length === 0,
      `'${PRODUCTION_PROFILE}' is the observed-working map but declares models that are filtered out:\n` +
        `      ${declaredButUnusable.join("\n      ")}\n` +
        `      Either replace the rung or move the intent to frontier_development.`
    );
  });

  // ---- invariant (a): judges are independent of the writer ------------------

  for (const profile of MULTI_MODEL_PROFILES) {
    check(`${profile}: neither judge shares a model with script_movement`, () => {
      const writers = new Set(profileChainFor(profile, "script_movement").map(key));
      for (const judge of ["quality_judge", "cold_open_judge"] as LLMRole[]) {
        const shared = profileChainFor(profile, judge).map(key).filter((m) => writers.has(m));
        assert(
          shared.length === 0,
          `${judge} can be served by ${shared.join(", ")}, which also writes script_movement — ` +
            `a model would be grading its own output and would still return a confident score`
        );
      }
    });

    check(`${profile}: the two judges have different primaries`, () => {
      const q = profileChainFor(profile, "quality_judge");
      const c = profileChainFor(profile, "cold_open_judge");
      assert(q.length > 0 && c.length > 0, "a judge role has no usable candidate at all");
      assert(
        key(q[0]) !== key(c[0]),
        `quality_judge and cold_open_judge both lead with ${key(q[0])}. The cold open and the finished script are ` +
          `two different judgements; landing them on one model makes one of the two verdicts redundant for free.`
      );
    });

    // ---- invariant (b): the two hosts are written by different models -------

    check(`${profile}: host_a_writer and host_b_writer DECLARE different primaries`, () => {
      // Asserted on the declared map for every profile: inverting the two host
      // chains is the design decision, and it must survive an edit to profiles.ts.
      const a = declaredProfileChainFor(profile, "script_host_a_writer");
      const b = declaredProfileChainFor(profile, "script_host_b_writer");
      assert(a.length > 0 && b.length > 0, "a host writer role declares no candidate at all");
      assert(
        key(a[0]) !== key(b[0]),
        `both host writers are declared leading with ${key(a[0])} — the inversion that makes "the hosts do not ` +
          `sound like one model" structural has been edited away`
      );
    });
  }

  check(`${PRODUCTION_PROFILE}: the host writers still differ AFTER availability filtering`, () => {
    // The declared assertion above is not enough on its own, and frontier is the
    // proof: it declares mistral-then-kimi against kimi-then-mistral, but kimi is
    // 404 for this account, so BOTH runnable chains collapse to mistral-first and
    // one model writes both characters. Nothing errors when that happens — the
    // episode is produced, just with two hosts in one voice. The production
    // profile is the one that must hold at runtime, so it is asserted here and
    // frontier's convergence is reported below rather than asserted away.
    const a = profileChainFor(PRODUCTION_PROFILE, "script_host_a_writer");
    const b = profileChainFor(PRODUCTION_PROFILE, "script_host_b_writer");
    assert(a.length > 0 && b.length > 0, "a host writer role has no usable candidate at all");
    assert(
      key(a[0]) !== key(b[0]),
      `both host writers RESOLVE to ${key(a[0])} once unavailable models are filtered out. The declared chains ` +
        `invert, so this is a filtering collapse, not an edit: a model in one of the two chains has become ` +
        `non-routable and there is no different-family replacement behind it.`
    );
  });

  check("free_independent is still the single-model profile the invariants exempt", () => {
    // If this ever fails, free_independent has gained a second model and the
    // exemption above needs re-deciding rather than silently continuing.
    const distinct = new Set<string>();
    for (const role of ALL_ROLES) for (const ref of declaredProfileChainFor("free_independent", role)) distinct.add(key(ref));
    assert(
      distinct.size === 1,
      `free_independent now routes to ${distinct.size} distinct models (${[...distinct].join(", ")}). It is exempted ` +
        `from the judge-independence and host-independence invariants ON THE BASIS that it is deliberately one model. ` +
        `That basis no longer holds — either restore it or bring the profile under the invariants.`
    );
  });

  // ---- evidence freshness --------------------------------------------------
  //
  // The real evidence is currently well inside the limit, so the STALE path
  // would never execute without a fixed clock. A staleness check that has never
  // been observed to fire is not a check.

  check("evidence inside the limit is not reported stale", () => {
    const ages = evaluateRoutingStaleness(new Date("2026-08-11T00:00:00Z"));
    assert(ages.length > 0, "no evidence sources are registered at all");
    assert(
      ages.every((a) => !a.stale),
      `evidence declared 2026-07-26 is 16 days old and must not be stale: ${ages
        .filter((a) => a.stale)
        .map((a) => a.source.id)
        .join(", ")}`
    );
  });

  check("evidence past the limit IS reported stale", () => {
    // Same declared dates, clock moved a year on.
    const ages = evaluateRoutingStaleness(new Date("2027-08-11T00:00:00Z"));
    assert(
      ages.every((a) => a.stale),
      "a year-old measurement was reported as fresh"
    );
    assert(ages.every((a) => a.ageDays > STALENESS_LIMIT_DAYS), "ageDays must exceed the limit for a stale source");
  });

  check("the boundary is exclusive: exactly 90 days is still ok", () => {
    const at90 = evaluateRoutingStaleness(new Date("2026-10-24T00:00:00Z")); // 2026-07-26 + 90d
    assert(at90.every((a) => a.ageDays === 90), `expected exactly 90 days, got ${at90.map((a) => a.ageDays).join(",")}`);
    assert(at90.every((a) => !a.stale), "90 days is the limit, not past it");
    const at91 = evaluateRoutingStaleness(new Date("2026-10-25T00:00:00Z"));
    assert(at91.every((a) => a.stale), "91 days must be stale");
  });

  check("a NEWER artifact on disk overrides the declared date", () => {
    const ages = evaluateRoutingStaleness(new Date("2027-08-11T00:00:00Z"), {
      "/x/artifacts/role-experiment-dialogue.json": new Date("2027-08-01T00:00:00Z"),
    });
    const dialogue = ages.find((a) => a.source.id === "role-experiment-dialogue")!;
    assert(dialogue.basis === "artifact", "a fresh artifact must be preferred over a stale declared date");
    assert(!dialogue.stale, `a 10-day-old artifact must not be stale, got ${dialogue.ageDays} days`);
    // ...and it must not rescue the other sources.
    assert(
      ages.filter((a) => a.source.id !== "role-experiment-dialogue").every((a) => a.stale),
      "one fresh artifact silently cleared unrelated evidence sources"
    );
  });

  check("an OLDER artifact does not override a newer declared date", () => {
    // Someone re-ran the measurement, updated the comment, and left the old file
    // behind. The deliberate record wins over the stale leftover.
    const ages = evaluateRoutingStaleness(new Date("2026-08-11T00:00:00Z"), {
      "/x/artifacts/role-experiment-dialogue.json": new Date("2025-01-01T00:00:00Z"),
    });
    const dialogue = ages.find((a) => a.source.id === "role-experiment-dialogue")!;
    assert(dialogue.basis === "declared", "a stale leftover artifact overrode the declared date");
    assert(!dialogue.stale, "the declared date is inside the limit, so this source must not be stale");
  });

  check("a missing artifacts directory is not itself a failure", () => {
    // /artifacts/* is gitignored, so every fresh checkout and CI runner has
    // none. Treating absence as staleness would make the check fire everywhere
    // and be ignored everywhere.
    const ages = evaluateRoutingStaleness(new Date("2026-08-11T00:00:00Z"), {});
    assert(ages.every((a) => a.basis === "declared"), "with no artifacts, every source must fall back to its declared date");
    assert(ages.every((a) => !a.stale), "absence of an artifact must not be reported as stale evidence");
  });

  // ---- report --------------------------------------------------------------

  for (const profile of MULTI_MODEL_PROFILES) {
    const map = profileRoleMap(profile);
    const single = (Object.keys(map) as LLMRole[]).filter((r) => map[r].length === 1);
    const empty = (Object.keys(map) as LLMRole[]).filter((r) => map[r].length === 0);
    console.log(`\n${profile}: ${ALL_ROLES.length} roles | single-candidate: ${single.length} | empty: ${empty.length}`);
    for (const r of single) console.log(`  ⚠ ${r.padEnd(28)} 1 usable model (${key(map[r][0])}) — no failover`);
    const ha = profileChainFor(profile, "script_host_a_writer");
    const hb = profileChainFor(profile, "script_host_b_writer");
    if (ha.length && hb.length && key(ha[0]) === key(hb[0])) {
      console.log(
        `  ⚠ host writers CONVERGE at runtime on ${key(ha[0])} — the declared chains invert, but filtering\n` +
          `    collapsed them, so one model would write both characters under this profile.`
      );
    }
    if (profile !== PRODUCTION_PROFILE && single.length > 0) {
      console.log(
        `  (frontier_development is the documented INTENT map, not the running one — its gaps are\n` +
          `   kimi 404 and deepseek capacity, both account-level and not fixable from this repo.)`
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
