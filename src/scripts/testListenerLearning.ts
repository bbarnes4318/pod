// Executed proofs for the CLOSED listener-learning loop.
//
// No network, no database: the persistence layer is injectable, so every claim
// below is proved against the in-memory LearningStore. Postgres is unreachable
// from here, and a loop whose guarantees can only be checked in production is
// not a guarantee.
//
//   1. COLLECTION        all 14 signals record and round-trip
//   2. RAW vs AGGREGATE  aggregates are derived; recompute reproduces them
//   3. PRIVACY           no raw identifier stored, stable hashing, no PII
//   4. BLINDNESS         the pairwise payload cannot reveal which is which
//   5. INSUFFICIENT      below the sample floor nothing promotes, reason logged
//   6. PROMOTION         above it the version increments with its evidence
//   7. IMMUTABLE FIELDS  evidence/safety/character proposals are rejected
//   8. SHOW ISOLATION    a promotion on show A never touches show B
//   9. ROLLBACK          restores the prior version exactly; twice is safe

import assert from "node:assert/strict";
import {
  LEARNING_SIGNALS,
  LEARNING_SIGNAL_KEYS,
  buildLearningEvent,
  computeAggregates,
  createInMemoryLearningStore,
  deriveProductionSignals,
  hashListenerId,
  hostPairKey,
  purgeExpiredLearningEvents,
  recomputeAggregates,
  recordColdOpenChoice,
  recordLearningEvents,
  sanitizeMetadata,
  serveColdOpenTrial,
  assertColdOpenPayloadIsBlind,
  type ColdOpenBlindPayload,
  type InMemoryLearningStore,
  type LearningEventInput,
  type LearningSignalKey,
} from "../lib/services/listenerLearning";
import {
  DEFAULT_POLICY_PREFERENCES,
  DEFAULT_PROMOTION_THRESHOLDS,
  IMMUTABLE_POLICY_RULES,
  getActivePolicyVersion,
  promoteProductionPolicy,
  resolveEffectivePolicy,
  resolveThresholds,
  rollbackProductionPolicy,
  approveStagedPolicyPromotion,
  runLearningPromotionCycle,
  validatePolicyProposal,
} from "../lib/services/productionPolicy";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${e instanceof Error ? e.stack?.split("\n").slice(0, 4).join("\n      ") : String(e)}`);
  }
}

const EPOCH = "test-epoch-2026-08";
const T0 = new Date("2026-08-01T00:00:00.000Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** One valid input per signal, respecting each signal's source rules. */
function inputForSignal(key: LearningSignalKey, i: number, podcastId: string, episodeId: string): LearningEventInput {
  const descriptor = LEARNING_SIGNALS[key];
  const base: LearningEventInput = {
    signalKey: key,
    value: descriptor.unit === "usd_per_minute" ? 1.25 : 0.5,
    episodeId,
    podcastId,
    formatId: "two_host_debate",
    openingVariant: "accusation",
    hostPairKey: hostPairKey(["cal", "zabala"]),
    voicePolicyVersion: 3,
    productionPolicyVersion: 1,
    occurredAt: at(i),
  };
  if (descriptor.source === "production") return base;
  return { ...base, listenerId: `listener-${i}`, hashEpoch: EPOCH, consented: true, cohort: "panel-a" };
}

async function main() {
  console.log("\nClosed listener-learning loop\n");

  /* ================= 1. COLLECTION ================= */

  await test("1. all 14 signals are recorded and round-trip through the store", async () => {
    const store = createInMemoryLearningStore();
    assert.equal(LEARNING_SIGNAL_KEYS.length, 14, "the catalogue must define exactly 14 signals");

    const inputs = LEARNING_SIGNAL_KEYS.map((key, i) => inputForSignal(key, i, "show-a", "ep-1"));
    const { recorded, rejected } = await recordLearningEvents(store, inputs);
    assert.equal(rejected.length, 0, `unexpected rejections: ${JSON.stringify(rejected)}`);
    assert.equal(recorded.length, 14);

    const events = await store.listEvents({ podcastId: "show-a" });
    assert.equal(events.length, 14);
    assert.deepEqual([...events.map((e) => e.signalKey)].sort(), [...LEARNING_SIGNAL_KEYS].sort());

    for (const key of LEARNING_SIGNAL_KEYS) {
      const row = events.find((e) => e.signalKey === key)!;
      const descriptor = LEARNING_SIGNALS[key];
      assert.equal(row.source, descriptor.source, `${key} source`);
      assert.equal(row.unit, descriptor.unit, `${key} unit`);
      assert.equal(row.value, descriptor.unit === "usd_per_minute" ? 1.25 : 0.5, `${key} value round-trip`);
      assert.equal(row.episodeId, "ep-1");
      assert.equal(row.podcastId, "show-a");
      assert.equal(row.formatId, "two_host_debate");
      assert.equal(row.hostPairKey, "cal|zabala");
      assert.equal(row.voicePolicyVersion, 3);
      assert.equal(row.productionPolicyVersion, 1);
      if (descriptor.source === "production") {
        assert.equal(row.listenerHash, null, `${key} must not carry a listener identifier`);
      } else {
        assert.ok(row.listenerHash, `${key} must carry an anonymous identifier`);
        assert.equal(row.consented, true);
      }
    }
  });

  await test("1b. the 6 production signals derive from real artifacts, and absent inputs emit nothing", async () => {
    const derived = deriveProductionSignals({
      episodeId: "ep-9",
      podcastId: "show-a",
      scriptLines: [
        { text: "The county paid eleven million for that stadium bond.", isFactualClaim: true, evidenceRefs: [{ type: "news", id: "n1" }] },
        { text: "Leadership never disclosed the shortfall to the council.", isFactualClaim: true, evidenceRefs: [] },
        { text: "The county paid eleven million for that stadium bond.", isFactualClaim: true, evidenceRefs: [{ type: "news", id: "n1" }] },
        { text: "So who actually signed off on that number?" },
      ],
      semanticQa: { wordErrorRate: 0.04, speakerAttributionErrorRate: 0.01 },
      voiceRegeneration: { regeneratedLines: 2, totalLines: 40 },
      cost: { totalUsd: 6.4, publishableMinutes: 32 },
      occurredAt: T0,
    });
    const keys = derived.map((d) => d.signalKey).sort();
    assert.deepEqual(keys, [
      "cost_per_publishable_minute",
      "repeated_point_rate",
      "speaker_attribution_error_rate",
      "transcript_word_error_rate",
      "unsupported_claim_rate",
      "voice_regeneration_rate",
    ]);
    const byKey = Object.fromEntries(derived.map((d) => [d.signalKey, d.value]));
    assert.equal(byKey.unsupported_claim_rate, 1 / 3, "1 of 3 factual claims carries no evidence ref");
    assert.ok(byKey.repeated_point_rate > 0, "the duplicated line is detected as a repeated point");
    assert.equal(byKey.voice_regeneration_rate, 2 / 40);
    assert.equal(byKey.transcript_word_error_rate, 0.04);
    assert.equal(byKey.speaker_attribution_error_rate, 0.01);
    assert.equal(byKey.cost_per_publishable_minute, 0.2);

    // An unmeasured quantity must never enter the loop as a zero.
    const nothing = deriveProductionSignals({ episodeId: "ep-10", podcastId: "show-a" });
    assert.equal(nothing.length, 0);
  });

  await test("1c. collection without consent is refused, with a reason", async () => {
    const noConsent = buildLearningEvent({ signalKey: "completion", value: 1, podcastId: "show-a", listenerId: "abc" });
    assert.equal(noConsent.ok, false);
    if (!noConsent.ok) assert.equal(noConsent.code, "consent_required");

    const panelNoConsent = buildLearningEvent({ signalKey: "sounds_human", value: 0.8, podcastId: "show-a", listenerId: "abc", consented: false });
    assert.equal(panelNoConsent.ok, false);

    // A production measurement must not be able to smuggle in a person.
    const identified = buildLearningEvent({ signalKey: "transcript_word_error_rate", value: 0.1, podcastId: "show-a", listenerId: "abc" });
    assert.equal(identified.ok, false);
    if (!identified.ok) assert.equal(identified.code, "identifier_forbidden");
  });

  /* ================= 2. RAW vs AGGREGATE ================= */

  await test("2. aggregates are DERIVED — recomputing from raw events reproduces the same numbers", async () => {
    const store = createInMemoryLearningStore();
    const values = [1, 1, 0, 1, 0, 1, 1, 0];
    await recordLearningEvents(
      store,
      values.map((v, i) => ({
        signalKey: "completion" as const,
        value: v,
        podcastId: "show-agg",
        episodeId: i < 4 ? "ep-1" : "ep-2",
        formatId: "two_host_debate",
        openingVariant: "accusation",
        listenerId: `l-${i}`,
        hashEpoch: EPOCH,
        consented: true,
        occurredAt: at(i),
      }))
    );

    const first = await recomputeAggregates(store, "show-agg");
    const stored = await store.listAggregates("show-agg");
    assert.deepEqual(stored.sort((a, b) => a.scopeKind.localeCompare(b.scopeKind) || a.scopeKey.localeCompare(b.scopeKey)), first.slice().sort((a, b) => a.scopeKind.localeCompare(b.scopeKind) || a.scopeKey.localeCompare(b.scopeKey)));

    // Hand-computed truth from the RAW events, not from the aggregate table.
    const raw = await store.listEvents({ podcastId: "show-agg" });
    assert.equal(raw.length, 8, "the raw events are still all there — aggregation consumes nothing");
    const showRow = first.find((r) => r.scopeKind === "show" && r.scopeKey === "show-agg" && r.signalKey === "completion")!;
    assert.equal(showRow.sampleSize, 8);
    assert.equal(showRow.mean, 5 / 8);
    assert.equal(showRow.sum, 5);
    const ep1 = first.find((r) => r.scopeKind === "episode" && r.scopeKey === "ep-1")!;
    const ep2 = first.find((r) => r.scopeKind === "episode" && r.scopeKey === "ep-2")!;
    assert.equal(ep1.mean, 3 / 4);
    assert.equal(ep2.mean, 2 / 4);
    assert.equal(ep1.sampleSize + ep2.sampleSize, showRow.sampleSize);

    // Blow the derived table away entirely and rebuild it: byte-identical.
    await store.replaceAggregates("show-agg", []);
    assert.equal((await store.listAggregates("show-agg")).length, 0);
    assert.equal((await store.listEvents({ podcastId: "show-agg" })).length, 8, "purging aggregates must not touch the record");
    const second = await recomputeAggregates(store, "show-agg");
    assert.deepEqual(second, first);

    // The pure derivation agrees with what the store persisted.
    assert.deepEqual(computeAggregates(raw), first);

    // Every scope the events can support is present, with a sample size and a
    // confidence label on every single row.
    const kinds = [...new Set(first.map((r) => r.scopeKind))].sort();
    assert.deepEqual(kinds, ["episode", "format", "opening_variant", "show"]);
    for (const row of first) {
      assert.ok(row.sampleSize > 0);
      assert.ok(["low", "moderate", "high"].includes(row.confidence));
    }
    // 8 observations is not confidence, however tidy the numbers look.
    assert.equal(showRow.confidence, "low");
  });

  await test("2b. the retention window has a working purge path, and aggregates recompute after it", async () => {
    const store = createInMemoryLearningStore();
    await recordLearningEvents(store, [
      { signalKey: "completion", value: 1, podcastId: "show-purge", listenerId: "a", hashEpoch: EPOCH, consented: true, occurredAt: at(0), retentionDays: 1 },
      { signalKey: "completion", value: 0, podcastId: "show-purge", listenerId: "b", hashEpoch: EPOCH, consented: true, occurredAt: at(0), retentionDays: 400 },
    ]);
    await recomputeAggregates(store, "show-purge");
    const removed = await purgeExpiredLearningEvents(store, new Date(T0.getTime() + 2 * 24 * 3600 * 1000));
    assert.equal(removed, 1);
    const after = await recomputeAggregates(store, "show-purge");
    assert.equal(after.find((r) => r.scopeKind === "show")!.sampleSize, 1);
  });

  /* ================= 3. PRIVACY ================= */

  await test("3. no raw identifier is stored, the same listener hashes stably, and the row holds no PII", async () => {
    const store = createInMemoryLearningStore();
    const RAW_ID = "session-9f3a-secret-listener-token";
    await recordLearningEvents(store, [
      {
        signalKey: "retention_60s",
        value: 1,
        podcastId: "show-priv",
        episodeId: "ep-1",
        listenerId: RAW_ID,
        hashEpoch: EPOCH,
        consented: true,
        country: "us",
        metadata: {
          email: "listener@example.com",
          ipAddress: "203.0.113.9",
          fullName: "Jane Q. Listener",
          userAgent: "Mozilla/5.0 (iPhone)",
          contact: "jane@example.com",
          playerBuild: "web-1.4.2",
          bufferedSeconds: 61,
        },
      },
    ]);

    const [row] = await store.listEvents({ podcastId: "show-priv" });
    const serialized = JSON.stringify(row);

    assert.ok(!serialized.includes(RAW_ID), "the raw identifier must never be persisted");
    assert.notEqual(row.listenerHash, RAW_ID);
    assert.match(row.listenerHash!, /^[0-9a-f]{32}$/, "the identifier is a truncated sha256");

    for (const pii of ["listener@example.com", "203.0.113.9", "Jane Q. Listener", "Mozilla", "jane@example.com"]) {
      assert.ok(!serialized.includes(pii), `PII leaked into the stored row: ${pii}`);
    }
    assert.deepEqual(row.metadata, { playerBuild: "web-1.4.2", bufferedSeconds: 61 }, "only non-identifying context survives");
    assert.equal(row.country, "US", "geo is 2-letter country and nothing finer");

    // Stability inside an epoch, unlinkability across epochs.
    assert.equal(hashListenerId(RAW_ID, { epoch: EPOCH }), hashListenerId(RAW_ID, { epoch: EPOCH }));
    assert.equal(row.listenerHash, hashListenerId(RAW_ID, { epoch: EPOCH }));
    assert.notEqual(hashListenerId(RAW_ID, { epoch: EPOCH }), hashListenerId(RAW_ID, { epoch: "another-epoch" }));
    assert.notEqual(hashListenerId(RAW_ID, { epoch: EPOCH }), hashListenerId("someone-else", { epoch: EPOCH }));

    // The sanitizer reports what it dropped rather than silently swallowing it.
    const { clean, dropped } = sanitizeMetadata({ email: "a@b.co", city: "Toronto", latitude: 43.6 });
    assert.deepEqual(clean, { city: "Toronto" });
    assert.deepEqual(dropped.sort(), ["email", "latitude"]);
  });

  /* ================= 4. BLINDNESS ================= */

  await test("4. the cold-open pairwise payload cannot reveal which variant is which", async () => {
    const store = createInMemoryLearningStore();
    const variants: [{ variantId: string; text: string }, { variantId: string; text: string }] = [
      { variantId: "accusation", text: "You keep calling it patience. Nobody who paid for it agrees." },
      { variantId: "consequence", text: "Four hundred families found out by letter. That is the whole story." },
    ];

    const served = await serveColdOpenTrial(store, {
      episodeId: "ep-blind",
      podcastId: "show-blind",
      variants,
      listenerId: "listener-blind",
      hashEpoch: EPOCH,
      consented: true,
      trialToken: "token-blind-1",
      now: T0,
    });
    assert.equal(served.ok, true);
    if (!served.ok) return;
    const payload: ColdOpenBlindPayload = served.payload;
    const serialized = JSON.stringify(payload);

    // The literal assertion on the serialized payload.
    assert.ok(!serialized.includes("accusation"), "payload leaked the variant id 'accusation'");
    assert.ok(!serialized.includes("consequence"), "payload leaked the variant id 'consequence'");
    assert.ok(!/variantId/i.test(serialized), "payload must not carry a variantId field at all");
    assert.deepEqual(payload.options.map((o) => o.slot), ["A", "B"]);
    for (const option of payload.options) {
      assert.deepEqual(Object.keys(option).sort(), ["mediaUrl", "slot", "text"]);
      assert.ok(!/accusation|consequence/i.test(option.mediaUrl), "even the media URL must be slot-scoped");
    }
    // And the guard itself actually fires when identity does leak.
    assert.throws(
      () =>
        assertColdOpenPayloadIsBlind(
          { ...payload, options: [{ slot: "A", text: "the accusation opening", mediaUrl: "/x" }, payload.options[1]] },
          ["accusation", "consequence"]
        ),
      /leaked variant identity/
    );

    // Identity IS held server-side, and slot order is not the caller's order.
    const trial = (await store.findColdOpenTrial("token-blind-1"))!;
    assert.deepEqual([trial.slotAVariantId, trial.slotBVariantId].sort(), ["accusation", "consequence"]);
    const orders = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = await serveColdOpenTrial(store, {
        episodeId: "ep-blind",
        podcastId: "show-blind-order",
        variants,
        consented: true,
        trialToken: `order-${i}`,
        now: T0,
      });
      if (r.ok) {
        const t = (await store.findColdOpenTrial(`order-${i}`))!;
        orders.add(t.slotAVariantId);
      }
    }
    assert.equal(orders.size, 2, "slot A must not always hold the same variant");

    // The listener answers with a SLOT; the server resolves the identity.
    const choice = await recordColdOpenChoice(store, { trialToken: "token-blind-1", winnerSlot: "A", now: at(1) });
    assert.equal(choice.ok, true);
    if (choice.ok) assert.equal(choice.winnerVariantId, trial.slotAVariantId);
    const events = await store.listEvents({ podcastId: "show-blind" });
    assert.equal(events.length, 2, "a pairwise result records one winner row and one loser row");
    assert.equal(events.find((e) => e.openingVariant === trial.slotAVariantId)!.value, 1);
    assert.equal(events.find((e) => e.openingVariant === trial.slotBVariantId)!.value, 0);
    // A trial cannot be voted twice.
    const again = await recordColdOpenChoice(store, { trialToken: "token-blind-1", winnerSlot: "B", now: at(2) });
    assert.equal(again.ok, false);
  });

  /* ================= shared fixture for 5-9 ================= */

  /** Run `count` blind pairwise trials, `winsForFirst` of them won by `winner`. */
  async function seedPairwise(
    store: InMemoryLearningStore,
    opts: { podcastId: string; count: number; winsForWinner: number; winner: string; loser: string; episodes: string[]; cohort: string }
  ) {
    for (let i = 0; i < opts.count; i++) {
      const token = `${opts.podcastId}-t${i}`;
      const r = await serveColdOpenTrial(store, {
        episodeId: opts.episodes[i % opts.episodes.length],
        podcastId: opts.podcastId,
        // The copy deliberately does NOT name its archetype — serveColdOpenTrial
        // refuses to serve a payload whose text would unblind the trial.
        variants: [
          { variantId: opts.winner, text: `You keep calling it patience, take ${i}.` },
          { variantId: opts.loser, text: `Four hundred families found out by letter, take ${i}.` },
        ],
        listenerId: `l-${opts.podcastId}-${i}`,
        hashEpoch: EPOCH,
        consented: true,
        trialToken: token,
        now: at(i),
      });
      assert.equal(r.ok, true);
      const trial = (await store.findColdOpenTrial(token))!;
      const desired = i < opts.winsForWinner ? opts.winner : opts.loser;
      const slot = trial.slotAVariantId === desired ? "A" : "B";
      const res = await recordColdOpenChoice(store, {
        trialToken: token,
        winnerSlot: slot,
        cohort: opts.cohort,
        formatId: "two_host_debate",
        hostPairKey: hostPairKey(["cal", "zabala"]),
        // Real traffic arrives attested: the intake boundary stamps the salted
        // source bucket onto every event that cleared its controls, and only
        // attested events count toward a promotion's sample. Spread across many
        // sources because credibility caps each one at
        // MAX_CREDIBLE_LISTENERS_PER_SOURCE — one machine cannot be a panel.
        sourceKey: `src-${opts.podcastId}-${Math.floor(i / 2)}`,
        now: at(i),
      });
      assert.equal(res.ok, true);
    }
  }

  /* ================= 5. INSUFFICIENT SAMPLE ================= */

  await test("5. below the minimum sample size nothing is promoted, and the reason is recorded", async () => {
    const store = createInMemoryLearningStore();
    await seedPairwise(store, {
      podcastId: "show-small",
      count: 12,
      winsForWinner: 11,
      winner: "accusation",
      loser: "consequence",
      episodes: ["ep-s1"],
      cohort: "organic",
    });

    const aggregates = await recomputeAggregates(store, "show-small");
    const winnerRow = aggregates.find((r) => r.scopeKind === "opening_variant" && r.scopeKey === "accusation")!;
    assert.equal(winnerRow.sampleSize, 12);
    assert.ok(winnerRow.sampleSize < DEFAULT_PROMOTION_THRESHOLDS.minSamplePerArm);

    const before = await getActivePolicyVersion(store, "show-small", T0);
    const result = await runLearningPromotionCycle(store, {
      podcastId: "show-small",
      aggregates,
      events: await store.listEvents({ podcastId: "show-small" }),
      actor: "test",
      now: at(100),
    });

    assert.equal(result.promoted, false);
    assert.equal(result.code, "insufficient_sample");

    const after = await getActivePolicyVersion(store, "show-small", at(101));
    assert.equal(after.version, before.version, "the version must not move");
    assert.deepEqual(after.preferences, DEFAULT_POLICY_PREFERENCES, "the preferences must not move");

    const decisions = await store.listPolicyDecisions("show-small");
    const rejection = decisions.find((d) => d.code === "insufficient_sample");
    assert.ok(rejection, "the refusal must be recorded");
    assert.equal(rejection!.outcome, "rejected");
    assert.match(rejection!.reason, /Need .*per arm/);
    assert.equal(rejection!.resultingVersion, null);

    // A caller cannot argue the gate down.
    const loosened = resolveThresholds({ minSamplePerArm: 2, minTotalSample: 3, minZScore: 0.1, minEffect: 0 });
    assert.deepEqual(loosened, DEFAULT_PROMOTION_THRESHOLDS, "thresholds may only be tightened");
    const stillRejected = await runLearningPromotionCycle(store, {
      podcastId: "show-small",
      aggregates,
      actor: "test",
      thresholds: { minSamplePerArm: 2, minTotalSample: 3, minZScore: 0.1, minEffect: 0 },
      now: at(102),
    });
    assert.equal(stillRejected.promoted, false);
  });

  /* ================= 6-9 on one show, with an untouched sibling ================= */

  const store = createInMemoryLearningStore();

  await seedPairwise(store, {
    podcastId: "show-a",
    count: 120,
    winsForWinner: 90,
    winner: "accusation",
    loser: "consequence",
    episodes: ["ep-a1", "ep-a2", "ep-a3"],
    cohort: "organic-rss",
  });
  // Show B is a DIFFERENT show with the OPPOSITE preference and its own data.
  await seedPairwise(store, {
    podcastId: "show-b",
    count: 20,
    winsForWinner: 18,
    winner: "consequence",
    loser: "accusation",
    episodes: ["ep-b1"],
    cohort: "organic-rss",
  });

  const aggA = await recomputeAggregates(store, "show-a");
  await recomputeAggregates(store, "show-b");
  const eventsA = await store.listEvents({ podcastId: "show-a" });
  const baselineA = await getActivePolicyVersion(store, "show-a", T0);
  const baselinePreferences = structuredClone(baselineA.preferences);

  await test("6. above the threshold with a clear winner the policy version increments, with its evidence", async () => {
    const winner = aggA.find((r) => r.scopeKind === "opening_variant" && r.scopeKey === "accusation")!;
    const loser = aggA.find((r) => r.scopeKind === "opening_variant" && r.scopeKey === "consequence")!;
    assert.equal(winner.sampleSize, 120);
    assert.equal(loser.sampleSize, 120);
    assert.equal(winner.mean, 0.75);
    assert.equal(loser.mean, 0.25);
    assert.ok(winner.sampleSize >= DEFAULT_PROMOTION_THRESHOLDS.minSamplePerArm);

    // CONTRACT: a listener-sourced signal is collected from a PUBLIC,
    // unauthenticated endpoint. Even with overwhelming evidence, the automated
    // cycle STAGES the change rather than applying it — anonymous traffic does
    // not get to move production policy on its own. A named human applies it.
    const staged = await runLearningPromotionCycle(store, {
      podcastId: "show-a",
      aggregates: aggA,
      events: eventsA,
      actor: "test-operator",
      now: at(500),
    });
    assert.equal(staged.promoted, false, "listener-sourced evidence must not auto-apply");
    assert.equal(staged.code, "awaiting_human_approval", `expected staging, got ${JSON.stringify(staged)}`);
    assert.equal(staged.decision.outcome, "staged");
    assert.equal(staged.decision.resultingVersion, null, "nothing may move before a human approves");
    // The evidence a human will read is already on the staged decision.
    const stagedStats = (staged.decision.detail as { stats?: { credible?: { winner: number; challenger: number } } })?.stats;
    assert.ok((stagedStats?.credible?.winner ?? 0) >= 60, "the staged decision must record CREDIBLE listeners, not raw hits");

    const result = await approveStagedPolicyPromotion(store, {
      podcastId: "show-a",
      decisionId: staged.decision.id,
      humanActor: "producer@example.com",
      aggregates: aggA,
      events: eventsA,
      now: at(501),
    });
    assert.equal(result.promoted, true, `expected promotion after human approval, got ${JSON.stringify(result)}`);
    if (!result.promoted) return;

    assert.equal(result.version.version, baselineA.version + 1);
    assert.equal(result.version.status, "active");
    assert.equal(result.version.promotedFromVersion, baselineA.version);

    // Only bounded preferences moved, and they stayed inside their bounds.
    const weights = result.version.preferences.coldOpenArchetypeWeights as Record<string, number>;
    assert.ok(weights.accusation > 0.4 && weights.accusation <= 0.5, `accusation weight out of bounds: ${weights.accusation}`);
    assert.ok(weights.consequence >= 0.15 && weights.consequence < 1 / 3, `consequence weight out of bounds: ${weights.consequence}`);
    assert.equal(weights.contradiction, 1 / 3, "an untested archetype is not touched");
    assert.ok(weights.consequence >= 0.15, "a losing archetype is narrowed, never eliminated");

    // EXPLAINABLE: which episodes and which cohorts caused this.
    const evidence = result.version.evidence as {
      episodeIds: string[];
      cohorts: string[];
      winner: { scopeKey: string; sampleSize: number };
      challenger: { scopeKey: string; sampleSize: number };
      zScore: number;
      changedFields: string[];
    };
    assert.deepEqual(evidence.episodeIds, ["ep-a1", "ep-a2", "ep-a3"]);
    assert.deepEqual(evidence.cohorts, ["organic-rss"]);
    assert.equal(evidence.winner.scopeKey, "accusation");
    assert.equal(evidence.winner.sampleSize, 120);
    assert.equal(evidence.challenger.scopeKey, "consequence");
    assert.ok(evidence.zScore >= DEFAULT_PROMOTION_THRESHOLDS.minZScore);
    assert.deepEqual(evidence.changedFields, ["coldOpenArchetypeWeights"]);
    assert.ok(result.version.rationale.includes("accusation"));

    const decisions = await store.listPolicyDecisions("show-a");
    assert.ok(decisions.some((d) => d.outcome === "promoted" && d.resultingVersion === 2));

    const active = await getActivePolicyVersion(store, "show-a", at(501));
    assert.equal(active.version, 2);
    const versions = await store.listPolicyVersions("show-a");
    assert.equal(versions.find((v) => v.version === 1)!.status, "superseded");
  });

  /* ================= 7. IMMUTABLE FIELDS ================= */

  await test("7. a proposal touching evidence, safety or character rules is REJECTED", async () => {
    const attempts: { label: string; proposal: Record<string, unknown> }[] = [
      { label: "evidence", proposal: { evidenceRequiredForFactualClaims: false } },
      { label: "evidence (min refs)", proposal: { minEvidenceRefsPerClaim: 0 } },
      { label: "safety", proposal: { gamblingDisclaimerRequired: false } },
      { label: "safety (compliance gate)", proposal: { complianceGateEnabled: false } },
      { label: "character", proposal: { hostCharacterRulesLocked: false } },
      { label: "character (identity)", proposal: { hostIdentityLocked: false } },
      { label: "domain-shaped novel key", proposal: { factCheckStrictness: 0.2 } },
      { label: "character-shaped novel key", proposal: { personaWarmth: 0.9 } },
    ];

    const before = await getActivePolicyVersion(store, "show-a", at(600));

    for (const attempt of attempts) {
      const validation = validatePolicyProposal(attempt.proposal, before.preferences);
      assert.equal(validation.ok, false, `${attempt.label} should not validate`);
      if (!validation.ok) {
        assert.equal(validation.issues[0].code, "immutable_field", `${attempt.label} must be refused as immutable, not as unknown`);
      }

      const result = await promoteProductionPolicy(store, {
        podcastId: "show-a",
        proposal: attempt.proposal,
        comparison: { signalKey: "cold_open_pairwise", scopeKind: "opening_variant", winnerScopeKey: "accusation", challengerScopeKey: "consequence" },
        aggregates: aggA,
        events: eventsA,
        actor: "test-operator",
        now: at(601),
      });
      assert.equal(result.promoted, false, `${attempt.label} must not promote`);
      assert.equal(result.code, "immutable_field");
      assert.equal(result.decision.outcome, "rejected");
      assert.equal(result.decision.resultingVersion, null);
    }

    // Nothing moved, and mixing a legal field with an illegal one still fails.
    const mixed = await promoteProductionPolicy(store, {
      podcastId: "show-a",
      proposal: { sfxDensity: "standard", gamblingDisclaimerRequired: false },
      comparison: { signalKey: "cold_open_pairwise", scopeKind: "opening_variant", winnerScopeKey: "accusation", challengerScopeKey: "consequence" },
      aggregates: aggA,
      actor: "test-operator",
      now: at(602),
    });
    assert.equal(mixed.promoted, false);
    assert.equal(mixed.code, "immutable_field");

    const after = await getActivePolicyVersion(store, "show-a", at(603));
    assert.equal(after.version, before.version, "a rejected proposal must not bump the version");
    assert.deepEqual(after.preferences, before.preferences);

    // Out-of-bounds and oversized steps on ALLOWED fields are refused too.
    const outOfBounds = validatePolicyProposal({ musicBedGainDb: 6 }, before.preferences);
    assert.equal(outOfBounds.ok, false);
    if (!outOfBounds.ok) assert.equal(outOfBounds.issues[0].code, "out_of_bounds");
    const tooBig = validatePolicyProposal({ coldOpenTargetSeconds: 44 }, { ...before.preferences, coldOpenTargetSeconds: 22 });
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) assert.equal(tooBig.issues[0].code, "step_too_large");

    // And the immutable rules are read from code, so even a tampered stored row
    // cannot weaken them.
    await store.updatePolicyVersion("show-a", after.version, {
      immutableRules: { evidenceRequiredForFactualClaims: false, gamblingDisclaimerRequired: false } as Record<string, unknown>,
    });
    const effective = await resolveEffectivePolicy(store, "show-a", at(604));
    assert.deepEqual(effective.immutable, IMMUTABLE_POLICY_RULES);
    assert.equal(effective.immutable.evidenceRequiredForFactualClaims, true);
    assert.equal(effective.immutable.gamblingDisclaimerRequired, true);
  });

  /* ================= 8. SHOW ISOLATION ================= */

  await test("8. a policy promoted for show A does not alter show B", async () => {
    const a = await getActivePolicyVersion(store, "show-a", at(700));
    assert.equal(a.version, 2, "show A really did learn something");

    const b = await getActivePolicyVersion(store, "show-b", at(701));
    assert.equal(b.version, 1, "show B is still on its own baseline");
    assert.deepEqual(b.preferences, DEFAULT_POLICY_PREFERENCES, "show B's identity is untouched");
    assert.notDeepEqual(a.preferences, b.preferences, "the two shows are genuinely different now");

    const bVersions = await store.listPolicyVersions("show-b");
    assert.equal(bVersions.length, 1);
    assert.equal(bVersions[0].podcastId, "show-b");
    assert.equal((await store.listPolicyDecisions("show-b")).filter((d) => d.outcome === "promoted").length, 0);

    // Aggregates are show-scoped: show A's rows never mention show B's data.
    const aggB = await store.listAggregates("show-b");
    assert.ok(aggB.length > 0);
    assert.ok(aggA.every((r) => r.podcastId === "show-a"));
    assert.ok(aggB.every((r) => r.podcastId === "show-b"));
    const bWinner = aggB.find((r) => r.scopeKind === "opening_variant" && r.scopeKey === "consequence")!;
    assert.equal(bWinner.mean, 0.9, "show B's own audience prefers the opposite opening");

    // Even if show B's own cycle runs, its sample is too small to homogenize it.
    const bCycle = await runLearningPromotionCycle(store, {
      podcastId: "show-b",
      aggregates: aggB,
      events: await store.listEvents({ podcastId: "show-b" }),
      actor: "test-operator",
      now: at(702),
    });
    assert.equal(bCycle.promoted, false);
    assert.equal((await getActivePolicyVersion(store, "show-b", at(703))).version, 1);
    assert.deepEqual((await getActivePolicyVersion(store, "show-a", at(704))).preferences, a.preferences, "show B's cycle left show A alone");
  });

  /* ================= 9. ROLLBACK ================= */

  await test("9. rollback restores the prior version exactly, and rolling back twice is safe", async () => {
    const promoted = await getActivePolicyVersion(store, "show-a", at(800));
    assert.equal(promoted.version, 2);

    const first = await rollbackProductionPolicy(store, { podcastId: "show-a", actor: "test-operator", reason: "Listener complaints.", now: at(801) });
    assert.equal(first.rolledBack, true);
    if (!first.rolledBack) return;
    assert.equal(first.restoredVersion.version, 1);

    const restored = await getActivePolicyVersion(store, "show-a", at(802));
    assert.equal(restored.version, 1);
    assert.deepEqual(restored.preferences, baselinePreferences, "the prior version is restored EXACTLY");
    assert.deepEqual(
      (await resolveEffectivePolicy(store, "show-a", at(803))).preferences,
      { ...DEFAULT_POLICY_PREFERENCES, ...baselinePreferences },
      "the effective policy follows the rollback"
    );

    const versions = await store.listPolicyVersions("show-a");
    const v2 = versions.find((v) => v.version === 2)!;
    assert.equal(v2.status, "rolled_back");
    assert.equal(v2.rolledBackBy, "test-operator");
    assert.equal(v2.rolledBackReason, "Listener complaints.");
    assert.ok(v2.rolledBackAt);
    // The rolled-back version is RETAINED, so the change stays explainable.
    assert.ok((v2.evidence as { episodeIds: string[] }).episodeIds.length > 0);

    // Rolling back again: a recorded no-op, not an exception and not a wipe.
    const second = await rollbackProductionPolicy(store, { podcastId: "show-a", actor: "test-operator", reason: "again", now: at(804) });
    assert.equal(second.rolledBack, false);
    if (!second.rolledBack) assert.equal(second.code, "no_prior_version");
    const stillV1 = await getActivePolicyVersion(store, "show-a", at(805));
    assert.equal(stillV1.version, 1);
    assert.deepEqual(stillV1.preferences, baselinePreferences);
    assert.equal((await store.listPolicyVersions("show-a")).length, 2, "rollback never deletes a version");

    // A third time is still safe.
    const third = await rollbackProductionPolicy(store, { podcastId: "show-a", actor: "test-operator", now: at(806) });
    assert.equal(third.rolledBack, false);
    assert.equal((await getActivePolicyVersion(store, "show-a", at(807))).version, 1);

    // Show B never acquired a rollback either.
    assert.equal((await store.listPolicyDecisions("show-b")).filter((d) => d.outcome === "rolled_back").length, 0);
  });

  /* ================= summary ================= */

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED — ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
