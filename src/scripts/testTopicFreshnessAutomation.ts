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
assert.equal(topicsGenerateCron(), "30 */3 * * *");

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
assert.match(worker, /dispatchFreshTopicRuns\("boot"\)/);
assert.match(worker, /for \(const leagueId of getSportsIngestLeagues\(\)\)/);
assert.match(worker, /priority: 1/);

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
const researchBlock = profiles.slice(researchStart, researchStart + 700);
assert.ok(
  researchBlock.indexOf("NV.nemotron()") < researchBlock.indexOf("NV.deepseekPro()"),
  "the known-working research model must run before the production timeout model"
);

console.log("Topic freshness automation regression: PASS");
