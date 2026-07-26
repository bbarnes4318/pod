// The Attendance Ledger read model.
//
// The rules that decide what counts as an entry are the part that can be
// silently wrong — a page that quietly drops or invents rows looks correct.

import { summarizeLedger, type LedgerSourceRow } from "../lib/services/ledgerView";

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

const row = (
  id: string,
  claim: Partial<{ attendanceClaimed: number | null; attendanceReal: number | null }> | null,
  podcastId: string | null = "pod-1"
): LedgerSourceRow => ({
  id,
  title: `Episode ${id}`,
  slug: `ep-${id}`,
  publishedAt: null,
  podcastId,
  continuityUpdate: claim === null ? null : { unityBeatPresent: true, ...claim },
});

console.log("Attendance Ledger\n");

check("an empty ledger reports empty — no invented rows, no projected total", () => {
  const l = summarizeLedger([]);
  assert(l.isEmpty, "no rows must report empty");
  assert(l.phantomTotal === 0, `total must be 0, got ${l.phantomTotal}`);
  assert(l.entries.length === 0 && l.biggest === null, "there must be nothing to show");
});

check("episodes with no claim, or a null attendance, are not entries", () => {
  const l = summarizeLedger([
    row("a", null),
    row("b", { attendanceClaimed: null, attendanceReal: null }),
    row("c", { attendanceClaimed: 6492, attendanceReal: null }),
  ]);
  assert(l.isEmpty, `only complete claims are entries, got ${JSON.stringify(l.entries)}`);
});

check("the total is the sum of inventions, and biggest is the largest single one", () => {
  const l = summarizeLedger([
    row("a", { attendanceClaimed: 6492, attendanceReal: 5200 }), // +1292
    row("b", { attendanceClaimed: 7311, attendanceReal: 5200 }), // +2111
    row("c", { attendanceClaimed: 4877, attendanceReal: 3100 }), // +1777
  ]);
  assert(l.phantomTotal === 1292 + 2111 + 1777, `total is ${l.phantomTotal}`);
  assert(l.episodesWithClaim === 3, `expected 3 entries, got ${l.episodesWithClaim}`);
  assert(l.biggest?.episodeId === "b", `biggest should be b (+2111), got ${l.biggest?.episodeId}`);
});

check("a non-inflated figure is NOT a ledger entry", () => {
  // The bit is that he inflates. An accurate or under-stated figure is not an
  // entry — showing it as one would make the joke read as an error.
  const l = summarizeLedger([
    row("a", { attendanceClaimed: 5200, attendanceReal: 5200 }),
    row("b", { attendanceClaimed: 4000, attendanceReal: 5200 }),
  ]);
  assert(l.isEmpty, `neither an exact nor an under-stated figure is an entry, got ${JSON.stringify(l.entries)}`);
});

check("a stored claim that no longer validates is skipped, never guessed at", () => {
  const bad: LedgerSourceRow = {
    ...row("x", null),
    continuityUpdate: { attendanceClaimed: "six thousand", attendanceReal: 5200, unityBeatPresent: true },
  };
  const l = summarizeLedger([bad, row("y", { attendanceClaimed: 6492, attendanceReal: 5200 })]);
  assert(l.episodesWithClaim === 1, `the unparseable row must be skipped, got ${l.episodesWithClaim}`);
  assert(l.phantomTotal === 1292, `only the valid row counts, got ${l.phantomTotal}`);
});

check("multi-show: the ledger scopes to one podcast rather than mixing shows", () => {
  const l = summarizeLedger([
    row("a", { attendanceClaimed: 6492, attendanceReal: 5200 }, "pod-1"),
    row("b", { attendanceClaimed: 7311, attendanceReal: 5200 }, "pod-1"),
    row("c", { attendanceClaimed: 9999, attendanceReal: 1000 }, "pod-2"),
  ]);
  assert(l.podcastId === "pod-1", `expected the podcast with most entries, got ${l.podcastId}`);
  assert(l.episodesWithClaim === 2, `only pod-1's entries, got ${l.episodesWithClaim}`);
  assert(l.phantomTotal === 1292 + 2111, `totals must not mix shows, got ${l.phantomTotal}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
