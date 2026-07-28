// The Language Ledger read model.
//
// The rules that decide what counts as an entry are the part that can be
// silently wrong — a page that quietly drops or invents rows looks correct.
//
// The cross-episode resolution rule gets the most attention here: a phrase used
// in episode 3 and taken back in episode 9 must read as taken back on its
// episode-3 row. Showing it as still standing tells the reader the opposite of
// what the season actually did, which is the one lie this page could tell.

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

type Claim = {
  languageUsed?: { phrase: string; context?: string }[];
  languageResolved?: { phrase: string; resolution: "rejected" | "revised" }[];
};

const row = (id: string, claim: Claim | null, podcastId: string | null = "pod-1"): LedgerSourceRow => ({
  id,
  title: `Episode ${id}`,
  slug: `ep-${id}`,
  publishedAt: null,
  podcastId,
  continuityUpdate: claim === null ? null : claim,
});

const used = (...phrases: string[]) => ({ languageUsed: phrases.map((phrase) => ({ phrase, context: "a firing" })) });

console.log("Language Ledger\n");

check("an empty ledger reports empty — no invented rows, no projected total", () => {
  const l = summarizeLedger([]);
  assert(l.isEmpty, "no rows must report empty");
  assert(l.phraseCount === 0 && l.takenBackCount === 0, "there must be nothing to count");
  assert(l.entries.length === 0, "there must be nothing to show");
});

check("an episode with no claim, or a claim with no phrases, is not an entry", () => {
  const l = summarizeLedger([row("a", null), row("b", {}), row("c", { languageUsed: [] })]);
  assert(l.isEmpty, `only real phrases are entries, got ${JSON.stringify(l.entries)}`);
});

check("every phrase becomes its own row, stamped with its episode", () => {
  const l = summarizeLedger([row("a", used("culture fit", "a football decision")), row("b", used("everybody signed off"))]);
  assert(l.phraseCount === 3, `expected 3 rows, got ${l.phraseCount}`);
  assert(l.episodesWithEntry === 2, `expected 2 episodes, got ${l.episodesWithEntry}`);
  assert(l.entries.every((e) => e.status === "used"), "an unresolved phrase still stands");
  assert(l.entries[0].episodeTitle === "Episode a", "the row must name the episode it was said in");
});

check("a LATER episode's resolution rewrites the earlier row — the arc, made visible", () => {
  const l = summarizeLedger([
    row("a", used("culture fit")),
    row("b", used("everybody signed off")),
    row("c", { languageResolved: [{ phrase: "culture fit", resolution: "rejected" }] }),
  ]);
  const cultureFit = l.entries.find((e) => e.phrase === "culture fit");
  assert(cultureFit?.status === "rejected", `the earlier row must show the later retraction, got ${cultureFit?.status}`);
  assert(l.entries.find((e) => e.phrase === "everybody signed off")?.status === "used", "an unrelated phrase is untouched");
  assert(l.takenBackCount === 1, `expected one taken-back phrase, got ${l.takenBackCount}`);
});

check("resolution matching is case-insensitive and whitespace-tolerant", () => {
  const l = summarizeLedger([
    row("a", { languageUsed: [{ phrase: " Culture Fit " }] }),
    row("b", { languageResolved: [{ phrase: "culture fit", resolution: "revised" }] }),
  ]);
  assert(l.entries[0].status === "revised", `a differently-cased retraction must still land, got ${l.entries[0].status}`);
});

check("a stored claim that no longer validates is skipped, never guessed at", () => {
  const bad: LedgerSourceRow = {
    ...row("x", null),
    // The retired (Dutch Mulkey) claim shape. It must contribute nothing rather
    // than being coerced into a row.
    continuityUpdate: { attendanceClaimed: 6492, attendanceReal: 5200, unityBeatPresent: true },
  };
  const l = summarizeLedger([bad, row("y", used("culture fit"))]);
  assert(l.phraseCount === 1, `the unparseable row must be skipped, got ${l.phraseCount}`);
  assert(l.entries[0].episodeId === "y", "only the valid row counts");
});

check("multi-show: the ledger scopes to one podcast rather than mixing shows", () => {
  const l = summarizeLedger([
    row("a", used("culture fit"), "pod-1"),
    row("b", used("everybody signed off"), "pod-1"),
    row("c", used("a business decision"), "pod-2"),
  ]);
  assert(l.podcastId === "pod-1", `expected the podcast with most entries, got ${l.podcastId}`);
  assert(l.phraseCount === 2, `only pod-1's entries, got ${l.phraseCount}`);
  assert(!l.entries.some((e) => e.episodeId === "c"), "another show's phrases must not appear");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
