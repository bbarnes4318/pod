import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeTopicCutoff,
  topicDedupeCutoff,
  topicEvidenceWindow,
} from "../lib/services/topicFreshness";
import { topicsGenerateCron } from "../lib/services/sportsIngestSchedule";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");
const now = new Date("2026-08-01T12:00:00.000Z");

delete process.env.TOPIC_MAX_AGE_HOURS;
delete process.env.TOPIC_DEDUPE_WINDOW_HOURS;
delete process.env.TOPIC_NEWS_MAX_AGE_HOURS;
delete process.env.TOPICS_GENERATE_CRON;

assert.equal(activeTopicCutoff(now).toISOString(), "2026-07-30T12:00:00.000Z");
assert.equal(topicDedupeCutoff(now).toISOString(), "2026-07-25T12:00:00.000Z");
assert.equal(topicEvidenceWindow(now).newsAfter.toISOString(), "2026-07-30T12:00:00.000Z");
assert.equal(topicsGenerateCron(), "30 5,17 * * *");

const worker = source("src/lib/queue/worker.ts");
const insertStart = worker.indexOf("// Save valid TopicCandidate");
const insertEnd = worker.indexOf("// CHAIN THE RESEARCH BRIEF");
assert.ok(insertStart >= 0 && insertEnd > insertStart, "topic insert/brief chain not found");
const insertBlock = worker.slice(insertStart, insertEnd);
assert.match(insertBlock, /status: "approved"/);
assert.doesNotMatch(insertBlock, /status: "pending"/);
assert.match(worker, /is missing or outside the freshness window/);
assert.match(worker, /stats\/odds alone cannot anchor a fresh story/);
assert.match(worker, /reconcileTopicPoolOnBoot/);
assert.match(worker, /dispatchFreshTopicRunsOnBoot\(\)/);
// The boot sweep must stay CONDITIONAL. Unconditional, it turned every deploy
// into a full per-league sweep on top of the two the cron allows.
assert.match(worker, /topicSweepAlreadyRan\(windowStart\)/);
assert.match(worker, /Boot topic sweep skipped/);
// Per-league job ids bucket by sweep window, never by clock hour.
assert.match(worker, /topics-gen-\$\{leagueId\.toLowerCase\(\)\}-\$\{sweepKey\}/);
assert.doesNotMatch(worker, /topics-gen-\$\{leagueId\.toLowerCase\(\)\}-\$\{hourKey\}/);
assert.match(worker, /for \(const \[index, leagueId\] of leagues\.entries\(\)\)/);
assert.match(worker, /const delay = index \* 60_000/);
assert.match(worker, /priority: 1/);
assert.doesNotMatch(worker, /validEvidence\.length < 2/);

for (const path of [
  "src/app/studio/page.tsx",
  "src/app/studio/create/page.tsx",
  "src/app/studio/takes/page.tsx",
]) {
  assert.match(
    source(path),
    /activeTopicCutoff/,
    `${path} does not enforce the shared freshness cutoff`
  );
}

const profiles = source("src/lib/providers/llm/profiles.ts");
const verifiedStart = profiles.indexOf("function verifiedDevelopmentChain");
const researchStart = profiles.indexOf('case "research_brief":', verifiedStart);

// SCAN THE CHAIN EXPRESSION, NOT A FIXED-LENGTH WINDOW OF PROSE.
//
// This used to slice `researchStart + 700` characters and search that. Two
// separate ways for a correct chain to fail it:
//
//   * a comment above the `return` grows past the budget and pushes the chain
//     out of the window, so the test reports a model "no longer in the chain"
//     that is sitting right there on the next line. That is exactly what
//     happened when the GLM-5.2 retirement was explained here.
//   * a model NAMED IN A COMMENT inside the window counts as if it were routed,
//     so prose could satisfy — or break — an assertion about routing.
//
// The chain is the `return [...]` immediately after the case label, so slice
// precisely that. It cannot be outgrown by commentary and cannot be satisfied
// by it either.
const researchReturnAt = profiles.indexOf("return [", researchStart);
const researchReturnEnd = profiles.indexOf("];", researchReturnAt);
assert.ok(
  researchReturnAt > researchStart && researchReturnEnd > researchReturnAt,
  "could not find the research_brief chain expression in verifiedDevelopmentChain — " +
    "the case label or its return statement has been restructured"
);
const researchBlock = profiles.slice(researchReturnAt, researchReturnEnd);

// The known-working research model must lead, and the model that timed out in
// production must never precede it.
//
// ABSENCE COUNTS AS SATISFIED, and that is the whole correction here. This
// assertion used to be a bare `indexOf(nemotron) < indexOf(deepseekPro)`, which
// silently required deepseek-v4-pro to STILL BE IN THE CHAIN: drop it entirely
// and indexOf returns -1, so the comparison reads `592 < -1` and fails. The
// test then reported a regression at the exact moment the underlying problem
// was fixed properly — deepseek-v4-pro is now marked broken-in-production and
// removed from this chain, which is strictly better than ordering it second.
const nemotronAt = researchBlock.indexOf("NV.nemotron()");
const deepseekProAt = researchBlock.indexOf("NV.deepseekPro()");

assert.ok(
  nemotronAt >= 0,
  "the known-working research model (Nemotron) is no longer in the research_brief chain at all"
);
assert.ok(
  deepseekProAt === -1 || nemotronAt < deepseekProAt,
  "the known-working research model must run before the production timeout model " +
    "(deepseek-v4-pro may also be absent entirely — that is the stronger outcome)"
);

console.log("Topic freshness automation regression: PASS");
