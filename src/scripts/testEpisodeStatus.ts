// The Episode.status ladder is a single definition with one boundary.
//
// This file exists because the produced-or-later set had been hand-copied into
// four services. Season progression now depends on that boundary, and a
// duplicated literal fails SILENTLY IN BOTH DIRECTIONS: add a status and
// continuity either commits too early or stops committing, with nothing raised.
//
// The exhaustiveness assertion is the point: a new status cannot be added
// without someone deciding which side of the produced boundary it falls on.

import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  EPISODE_STATUS_LADDER,
  EPISODE_STATUS_OFF_LADDER,
  PRE_PRODUCTION,
  PRODUCED_OR_LATER,
  episodeStatusIndex,
  isProducedOrLater,
} from "../lib/episodeStatus";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log("Episode status ladder\n");

check("every status on the ladder is classified EXACTLY once", () => {
  for (const s of EPISODE_STATUS_LADDER) {
    const produced = PRODUCED_OR_LATER.has(s);
    const pre = PRE_PRODUCTION.has(s);
    assert(
      produced !== pre,
      `'${s}' is ${produced && pre ? "in BOTH" : "in NEITHER"} PRODUCED_OR_LATER and PRE_PRODUCTION. ` +
        `Every status must fall on exactly one side of the produced boundary — decide which.`
    );
  }
  assert(
    PRODUCED_OR_LATER.size + PRE_PRODUCTION.size === EPISODE_STATUS_LADDER.length,
    `the two sides (${PRODUCED_OR_LATER.size} + ${PRE_PRODUCTION.size}) must partition the ${EPISODE_STATUS_LADDER.length}-rung ladder`
  );
});

check("the produced boundary is contiguous and starts at audio_ready", () => {
  const firstProduced = EPISODE_STATUS_LADDER.findIndex((s) => PRODUCED_OR_LATER.has(s));
  assert(EPISODE_STATUS_LADDER[firstProduced] === "audio_ready", `the boundary starts at '${EPISODE_STATUS_LADDER[firstProduced]}', expected audio_ready`);
  // Everything from there on must be produced; nothing before it may be.
  EPISODE_STATUS_LADDER.forEach((s, i) => {
    assert(
      PRODUCED_OR_LATER.has(s) === i >= firstProduced,
      `'${s}' at index ${i} breaks contiguity — the produced set must be a suffix of the ladder`
    );
  });
});

check("there is NO 'completed' Episode status", () => {
  assert(!(EPISODE_STATUS_LADDER as readonly string[]).includes("completed"), "'completed' is a JobLog status, not an Episode status — the stale schema comment claiming otherwise caused a real design error");
  assert(!PRODUCED_OR_LATER.has("completed"), "'completed' must not be treated as produced");
});

check("off-ladder statuses are not on the ladder", () => {
  for (const s of EPISODE_STATUS_OFF_LADDER) {
    assert(episodeStatusIndex(s) === -1, `'${s}' is off-ladder and must not appear in the ordered sequence`);
    assert(!isProducedOrLater(s), `'${s}' must not count as produced`);
  }
});

check("no service re-declares the produced set from a literal", () => {
  // The whole point of the extraction. If this fails, someone has hand-copied
  // the boundary again and the silent-drift failure mode is back.
  const roots = ["src/lib/services", "src/app/admin", "src/lib/queue"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // directory may not exist in a trimmed checkout
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        if (/(const|let)\s+PRODUCED_OR_LATER\s*=\s*new Set/.test(readFileSync(full, "utf8"))) {
          offenders.push(full);
        }
      }
    }
  };
  for (const r of roots) walk(join(__dirname, "..", "..", r));
  assert(
    offenders.length === 0,
    `these files re-declare the produced set instead of importing it from @/lib/episodeStatus:\n      ${offenders.join("\n      ")}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
