// The studio's proposed rundown must be deterministic, use only eligible
// topics, follow the objective when the pool can, and say so when it cannot.
import assert from "node:assert";
import { objectiveTerms, planProduction, rankForObjective, suggestCompanions, type PlanTopic } from "../lib/studio/productionPlan";

const t = (id: string, title: string, heat: number, leagueId: string, over: Partial<PlanTopic> = {}): PlanTopic => ({
  id, title, summary: null, sport: "football", leagueId, talkability: heat, debateScore: heat, evidenceCount: 4, sourceCount: 2, eligible: true, ...over,
});

const pool: PlanTopic[] = [
  t("a", "Chiefs offensive line collapses again", 80, "nfl"),
  t("b", "Eagles trade deadline gamble", 60, "nfl"),
  t("c", "Bills defence carries the week", 78, "nfl"),
  t("d", "Jets quarterback benched", 77, "nfl"),
  t("e", "Celtics trade rumours heat up", 55, "nba"),
  t("f", "Lakers rotation shake-up", 70, "nba", { eligible: false }),
];

assert.deepEqual(objectiveTerms("I want the show to focus on the trade deadline"), ["trade", "deadline"]);

// An objective outranks raw heat, within the cap.
const ranked = rankForObjective(pool, "trade deadline winners");
assert.equal(ranked[0].id, "b", "two matched words lift a 60 over an 80");
assert.ok(!ranked.some((r) => r.id === "f"), "ineligible topics are never proposed");
assert.ok(ranked[0].reasons[0].includes("trade, deadline"));

// No objective: plain heat order, deterministic.
const plain = planProduction({ topics: pool, objective: "", target: 3, maxTopics: 6 });
assert.deepEqual(plain.topics.map((x) => x.id), ["a", "c", "d"]);
assert.equal(plain.leadId, "a");
assert.deepEqual(plain, planProduction({ topics: pool, objective: "", target: 3, maxTopics: 6 }), "same input, same plan");

// Variety: with two NFL stories in, an unmatched third NFL story loses 15 points.
const wide = suggestCompanions([...pool, t("g", "Knicks win streak", 65, "nba")], ["a", "c"], "", 1);
assert.equal(wide[0].id, "g", "65 beats a penalised 77");
assert.ok(wide[0].reasons.some((r) => r.includes("different league")));

// The proposal says when the objective found nothing, and when the pool is short.
const miss = planProduction({ topics: pool, objective: "hockey goaltending", target: 3, maxTopics: 6 });
assert.ok(miss.notes[0].includes("hockey"), "no-match is stated, not hidden");
const short = planProduction({ topics: pool.slice(0, 2), objective: "", target: 5, maxTopics: 6 });
assert.equal(short.topics.length, 2);
assert.ok(short.notes.some((n) => n.includes("shorter")));
assert.equal(planProduction({ topics: [], objective: "x", target: 3, maxTopics: 6 }).leadId, null);
assert.equal(planProduction({ topics: pool, objective: "", target: 99, maxTopics: 4 }).topics.length, 4, "never above the platform maximum");

console.log("ok  production plan: deterministic, eligible-only, objective-led, honest about shortfalls");
