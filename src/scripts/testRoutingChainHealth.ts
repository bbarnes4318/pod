// Routing chain health after dropping a model from the defaults.
//
// deepseek-v4-pro was recorded as "LIVE VERIFIED, and the cleanest of the six"
// and failed FAILED=unknown in 14-27ms on every production request, zero
// successes. Because the failure classified as UNCLASSIFIED, the router could
// not tell a broken model from a transient one and kept it in the chain, adding
// a wasted hop to every failover. It is now capacity-limited, which filters it
// out of the default profile chains.
//
// Dropping a model is not free: it removes redundancy. This asserts that no
// role was left with an empty chain, and REPORTS every role reduced to a single
// candidate — a single-candidate role has no failover left, and the survivor in
// several of these chains (zai/glm-4.7-flash) has itself been rate-limited in
// production.
//
// NETWORK-FREE. Run: npm run test:routing-chain-health

import { filterProfileChain, profileRoleMap, type RoutingProfile } from "../lib/providers/llm/profiles";
import type { LLMRole } from "../lib/providers/llm/roles";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PROFILE: RoutingProfile = "verified_development";

function main() {
  console.log(`\nChain health under profile '${PROFILE}'\n`);

  const rows: Array<{ role: string; usable: number; filtered: string[] }> = [];
  const map = profileRoleMap(PROFILE);
  for (const role of Object.keys(map) as LLMRole[]) {
    const { usable, filtered } = filterProfileChain(PROFILE, role);
    rows.push({
      role,
      usable: usable.length,
      filtered: filtered.map((f) => String(f.ref?.model ?? "?")),
    });
  }

  check("no role is left with an empty candidate chain", () => {
    const empty = rows.filter((r) => r.usable === 0);
    assert(empty.length === 0,
      `these roles have NO usable model and would fail every request: ${empty.map((e) => e.role).join(", ")}`);
  });

  check("deepseek-v4-pro is filtered out of the defaults", () => {
    const stillIn = rows.filter((r) => r.filtered.every((m) => !/deepseek-v4-pro/.test(m)) === false);
    assert(stillIn.length > 0 || rows.every((r) => !r.filtered.some((m) => /deepseek/.test(m)) || true),
      "expected deepseek-v4-pro to appear as filtered where it is referenced");
    const anyFiltered = rows.some((r) => r.filtered.some((m) => /deepseek-v4-pro/.test(m)));
    assert(anyFiltered, "deepseek-v4-pro no longer appears as a filtered candidate in any chain — is it still referenced?");
  });

  console.log("\nRedundancy report — roles with no failover left\n");
  const single = rows.filter((r) => r.usable === 1);
  if (single.length === 0) console.log("  (every role has at least two usable models)");
  for (const r of single) console.log(`  ⚠ ${r.role.padEnd(28)} 1 usable model — no failover`);

  console.log(`\n  roles total: ${rows.length}  |  single-candidate: ${single.length}  |  empty: ${rows.filter((r) => r.usable === 0).length}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
