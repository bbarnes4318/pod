// ADVERSARIAL proof for the PUBLIC listener-signal endpoints.
//
// /api/learning/* is unauthenticated and reachable by anyone with curl, and the
// data it collects feeds production-policy promotion. So the question this file
// answers is not "does the happy path work" but "can a script move the policy".
//
// Everything here runs offline against the in-memory store and an injected
// clock, so the boundary is proven without a database, a network, or a secret.

import assert from "node:assert/strict";
import {
  LEARNING_RATE_LIMITS,
  MAX_INTAKE_BODY_BYTES,
  MAX_METADATA_KEYS,
  SIGNAL_INTAKE_RULES,
  buildLearningEvent,
  computeAggregates,
  consumeLearningRateLimit,
  createInMemoryLearningStore,
  createInMemoryRateLimitStore,
  hashListenerId,
  intakeIssueColdOpenTrial,
  intakeIssueSignalContext,
  intakeListenerSignal,
  intakeResolveColdOpenTrial,
  purgeExpiredLearningEvents,
  signLearningContext,
  type LearningIntakeDeps,
} from "../lib/services/listenerLearning";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const SECRET = "test-learning-secret-not-a-real-one";
const EPISODE = "episode-abc-123";
const NOW = new Date("2026-08-02T12:00:00.000Z");

function makeDeps(overrides: Partial<LearningIntakeDeps> = {}): LearningIntakeDeps & {
  store: ReturnType<typeof createInMemoryLearningStore>;
} {
  const store = createInMemoryLearningStore();
  return {
    store,
    rateLimiter: createInMemoryRateLimitStore(),
    loadEpisode: async (id) =>
      id === EPISODE
        ? {
            episodeId: EPISODE,
            podcastId: "podcast-1",
            formatId: "two_host_debate",
            openingVariant: "accusation",
            hostPairKey: "host-a|host-b",
            voicePolicyVersion: 1,
            productionPolicyVersion: 1,
            coldOpenVariants: [
              { variantId: "accusation", text: "You signed off on that extension on a Tuesday." },
              { variantId: "consequence", text: "Three players found out from the team account." },
            ],
          }
        : null,
    secret: SECRET,
    now: NOW,
    ...overrides,
  } as LearningIntakeDeps & { store: ReturnType<typeof createInMemoryLearningStore> };
}

/** A legitimately server-issued context for the signal endpoint. */
function goodContext(episodeId = EPISODE, issuedAt = NOW) {
  return signLearningContext(
    { kind: "signal", episodeId, issuedAt: Math.floor(issuedAt.getTime() / 1000) } as never,
    SECRET
  );
}

function body(o: unknown) {
  return JSON.stringify(o);
}

async function main() {
  console.log("\nListener-signal abuse resistance\n");

  // =======================================================================
  console.log("  -- the endpoint refuses to run unconfigured --");
  await check("no LEARNING_SIGNAL_SECRET fails CLOSED, it does not collect anyway", async () => {
    const deps = makeDeps({ secret: null });
    const r = await intakeIssueSignalContext(deps, { episodeId: EPISODE, sourceIp: "1.2.3.4" });
    assert.equal(r.ok, false, "an unconfigured secret must refuse");
    const post = await intakeListenerSignal(deps, { rawBody: body({}), sourceIp: "1.2.3.4", country: null });
    assert.equal(post.ok, false, "an unconfigured secret must refuse the POST too");
    assert.equal(deps.store.dump().events.length, 0, "nothing may be recorded while unconfigured");
  });

  // =======================================================================
  console.log("  -- forged / tampered / cross-show attribution --");
  await check("a client cannot mint its own context", async () => {
    const deps = makeDeps();
    const forged = signLearningContext(
      { kind: "signal", episodeId: EPISODE, issuedAt: Math.floor(NOW.getTime() / 1000) } as never,
      "the-attacker-guessed-this-secret"
    );
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: forged, signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: true }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "a context signed with the wrong secret must be refused");
    assert.equal(deps.store.dump().events.length, 0);
  });

  await check("a TAMPERED context payload is refused", async () => {
    const deps = makeDeps();
    const good = goodContext();
    // Flip a character in the payload half, keeping the signature.
    const dot = good.indexOf(".");
    const tampered = `${good.slice(0, dot - 1)}X.${good.slice(dot + 1)}`;
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: tampered, signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: true }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "a tampered context must be refused");
  });

  await check("an EXPIRED context is refused", async () => {
    const long = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const deps = makeDeps();
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(EPISODE, long), signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: true }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "an expired grant must be refused");
  });

  await check("CROSS-SHOW: the episode comes from the token, never the body", async () => {
    const deps = makeDeps();
    // A grant for an episode the client was actually served...
    const ctx = goodContext(EPISODE);
    // ...but the body claims a different episode entirely.
    const r = await intakeListenerSignal(deps, {
      rawBody: body({
        context: ctx,
        episodeId: "some-other-episode",
        podcastId: "someone-elses-podcast",
        signalKey: "retention_15s",
        value: 1,
        listenerId: "listener-aaaaaaaa",
        consent: true,
      }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    if (r.ok) {
      const ev = deps.store.dump().events.at(-1)!;
      assert.equal(ev.episodeId, EPISODE, "attribution must come from the signed token, not the body");
      assert.notEqual(ev.podcastId, "someone-elses-podcast", "a client must not choose its podcast attribution");
    } else {
      // Refusing an unexpected body key outright is also correct.
      assert.equal(deps.store.dump().events.length, 0);
    }
  });

  // =======================================================================
  console.log("  -- malformed values --");
  for (const [label, value] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a string", "1" as unknown as number],
    ["null", null as unknown as number],
    ["out of range", 999999],
  ] as Array<[string, number]>) {
    await check(`value ${label} is refused`, async () => {
      const deps = makeDeps();
      const r = await intakeListenerSignal(deps, {
        rawBody: body({ context: goodContext(), signalKey: "retention_15s", value, listenerId: "listener-aaaaaaaa", consent: true }),
        sourceIp: "1.2.3.4",
        country: null,
      });
      assert.equal(r.ok, false, `value ${label} must be refused`);
      assert.equal(deps.store.dump().events.length, 0, `value ${label} must record nothing`);
    });
  }

  await check("an unknown signal key is refused", async () => {
    const deps = makeDeps();
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(), signalKey: "totallyMadeUp", value: 1, listenerId: "listener-aaaaaaaa", consent: true }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "an unknown signal must be refused");
  });

  await check("a PRODUCTION-side signal cannot be asserted by a client", async () => {
    const clientForbidden = Object.entries(SIGNAL_INTAKE_RULES).filter(([, r]) => !r.clientSubmittable);
    assert.ok(clientForbidden.length > 0, "some signals must be server-derived only");
    const deps = makeDeps();
    const [key] = clientForbidden[0];
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(), signalKey: key, value: 0.5, listenerId: "listener-aaaaaaaa", consent: true }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, `${key} is a production measurement; a client must not assert its own quality score`);
  });

  // =======================================================================
  console.log("  -- oversized input --");
  await check("an oversized BODY is refused", async () => {
    const deps = makeDeps();
    const huge = "x".repeat(MAX_INTAKE_BODY_BYTES + 512);
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(), signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: true, pad: huge }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "an oversized body must be refused");
  });

  await check("unexpected metadata keys are refused", async () => {
    const deps = makeDeps();
    const r = await intakeListenerSignal(deps, {
      rawBody: body({
        context: goodContext(),
        signalKey: "retention_15s",
        value: 1,
        listenerId: "listener-aaaaaaaa",
        consent: true,
        metadata: { thisKeyIsNotAllowed: "x" },
      }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "a metadata key outside the allow-list must be refused");
  });

  await check("too many metadata keys are refused", async () => {
    const deps = makeDeps();
    const meta: Record<string, string> = {};
    for (let i = 0; i < MAX_METADATA_KEYS + 5; i++) meta[`k${i}`] = "v";
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(), signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: true, metadata: meta }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "excessive metadata must be refused");
  });

  // =======================================================================
  console.log("  -- consent --");
  await check("collection without consent is refused", async () => {
    const deps = makeDeps();
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: goodContext(), signalKey: "retention_15s", value: 1, listenerId: "listener-aaaaaaaa", consent: false }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "no consent, no collection");
    assert.equal(deps.store.dump().events.length, 0);
  });

  // =======================================================================
  console.log("  -- dedupe: the same listener cannot inflate a signal --");
  await check("the SAME listener repeated 25x yields one credible event", async () => {
    const deps = makeDeps();
    let accepted = 0;
    for (let i = 0; i < 25; i++) {
      const r = await intakeListenerSignal(deps, {
        rawBody: body({ context: goodContext(), signalKey: "retention_15s", value: 1, listenerId: "listener-repeater", consent: true }),
        sourceIp: "1.2.3.4",
        country: null,
      });
      if (r.ok) accepted += 1;
    }
    const hash = hashListenerId("listener-repeater");
    const mine = deps.store.dump().events.filter((e) => e.listenerHash === hash && e.signalKey === "retention_15s" && e.episodeId === EPISODE);
    assert.ok(mine.length <= 1, `dedupe must keep at most one row per (listener, episode, signal); got ${mine.length} from ${accepted} accepted posts`);
  });

  // =======================================================================
  console.log("  -- rate limiting --");
  await check("rate limiting triggers, then recovers after the window", async () => {
    const limiter = createInMemoryRateLimitStore();
    const rule = LEARNING_RATE_LIMITS.signal_per_source;
    let blockedAt = -1;
    for (let i = 0; i < rule.limit + 3; i++) {
      const v = await consumeLearningRateLimit(limiter, "signal_per_source", "source-x", NOW);
      if (!v.allowed && blockedAt < 0) blockedAt = i;
    }
    assert.ok(blockedAt >= 0, "the limiter must eventually refuse");
    const later = new Date(NOW.getTime() + (rule.windowSeconds + 5) * 1000);
    const after = await consumeLearningRateLimit(limiter, "signal_per_source", "source-x", later);
    assert.equal(after.allowed, true, "the limiter must recover after its window");
  });

  await check("ROTATING listener ids from one source are rate limited", async () => {
    const deps = makeDeps();
    let accepted = 0;
    for (let i = 0; i < LEARNING_RATE_LIMITS.signal_per_source.limit + 25; i++) {
      const r = await intakeListenerSignal(deps, {
        rawBody: body({ context: goodContext(), signalKey: "retention_15s", value: 1, listenerId: `rotating-id-${i}-aaaa`, consent: true }),
        sourceIp: "9.9.9.9",
        country: null,
      });
      if (r.ok) accepted += 1;
    }
    assert.ok(
      accepted <= LEARNING_RATE_LIMITS.signal_per_source.limit,
      `a single source minting fresh ids must not exceed its per-source budget (accepted ${accepted})`
    );
  });

  // =======================================================================
  console.log("  -- cold-open pairwise: server-issued, blind, single-use --");
  await check("the served trial does not reveal which variant is which", async () => {
    const deps = makeDeps();
    const r = await intakeIssueColdOpenTrial(deps, {
      episodeId: EPISODE, listenerId: "listener-pairwise-1", consent: true, sourceIp: "1.2.3.4", country: null,
    });
    assert.equal(r.ok, true, `issuing a trial should succeed: ${JSON.stringify(r)}`);
    if (r.ok) {
      const blob = JSON.stringify(r.body.trial);
      assert.ok(!blob.includes("accusation"), "the payload leaked a variant id");
      assert.ok(!blob.includes("consequence"), "the payload leaked a variant id");
    }
  });

  await check("a client-named variant identity is refused", async () => {
    const deps = makeDeps();
    const issued = await intakeIssueColdOpenTrial(deps, {
      episodeId: EPISODE, listenerId: "listener-pairwise-2", consent: true, sourceIp: "1.2.3.4", country: null,
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const r = await intakeResolveColdOpenTrial(deps, {
      rawBody: body({ context: issued.body.context, winnerSlot: "A", variantId: "accusation" }),
      sourceIp: "1.2.3.4",
      country: null,
    });
    assert.equal(r.ok, false, "a body asserting variant identity must be refused outright");
  });

  await check("REPLAY: a trial cannot be resolved twice", async () => {
    const deps = makeDeps();
    const issued = await intakeIssueColdOpenTrial(deps, {
      episodeId: EPISODE, listenerId: "listener-pairwise-3", consent: true, sourceIp: "1.2.3.4", country: null,
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const first = await intakeResolveColdOpenTrial(deps, {
      rawBody: body({ context: issued.body.context, winnerSlot: "A" }), sourceIp: "1.2.3.4", country: null,
    });
    assert.equal(first.ok, true, `the first resolution should succeed: ${JSON.stringify(first)}`);
    const second = await intakeResolveColdOpenTrial(deps, {
      rawBody: body({ context: issued.body.context, winnerSlot: "B" }), sourceIp: "1.2.3.4", country: null,
    });
    assert.equal(second.ok, false, "a trial must resolve exactly once");
  });

  // =======================================================================
  console.log("  -- raw vs aggregate, and retention --");
  await check("aggregates are DERIVED and recompute from raw events", async () => {
    const events = [
      buildLearningEvent({ signalKey: "retention_15s", value: 1, episodeId: EPISODE, podcastId: "p1", listenerId: "aaaa-1111", consented: true }),
      buildLearningEvent({ signalKey: "retention_15s", value: 0, episodeId: EPISODE, podcastId: "p1", listenerId: "bbbb-2222", consented: true }),
    ].flatMap((r) => (r.ok ? [r.event] : []));
    assert.equal(events.length, 2, "both fixtures must build");
    const first = computeAggregates(events);
    const again = computeAggregates(events);
    assert.deepEqual(first, again, "aggregation must be a pure function of the raw events");
  });

  await check("the retention purge is callable against a store", async () => {
    const deps = makeDeps();
    const built = buildLearningEvent({
      signalKey: "retention_15s", value: 1, episodeId: EPISODE, podcastId: "p1",
      listenerId: "cccc-3333", consented: true,
      occurredAt: new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000),
      retentionDays: 1,
    });
    assert.equal(built.ok, true);
    if (built.ok) await deps.store.insertEvents([built.event]);
    const purged = await purgeExpiredLearningEvents(deps.store, NOW);
    assert.ok(purged >= 1, `an expired event must be purgeable, purged=${purged}`);
  });

  // =======================================================================
  console.log("  -- CONTROL: legitimate traffic still works --");
  await check("a well-formed, consented, in-range signal is recorded", async () => {
    const deps = makeDeps();
    const ctx = await intakeIssueSignalContext(deps, { episodeId: EPISODE, sourceIp: "5.5.5.5" });
    assert.equal(ctx.ok, true, `issuing a context should succeed: ${JSON.stringify(ctx)}`);
    if (!ctx.ok) return;
    const r = await intakeListenerSignal(deps, {
      rawBody: body({ context: ctx.body.context, signalKey: "retention_15s", value: 1, listenerId: "legit-listener-1", consent: true }),
      sourceIp: "5.5.5.5",
      country: null,
    });
    assert.equal(r.ok, true, `a legitimate signal must be accepted: ${JSON.stringify(r)}`);
    assert.ok(deps.store.dump().events.length >= 1, "a legitimate signal must be recorded");
    const ev = deps.store.dump().events.at(-1)!;
    assert.equal(ev.episodeId, EPISODE, "attribution comes from the server");
    assert.ok(!JSON.stringify(ev).includes("legit-listener-1"), "the RAW listener id must never be persisted");
  });

  console.log(
    failed === 0
      ? "\nAll listener-signal abuse checks passed.\n"
      : `\n${failed} abuse check(s) FAILED.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
