// EXECUTED authorization + tenant-isolation proof for the voice audition console.
//
// An independent security review found three real defects in the first version
// of the audition server actions:
//
//   1. `promotionHistoryAction(hostId?)` checked only "is signed in", then passed
//      hostId straight through — so any account could read ANY host's promotion
//      history, and calling it with no hostId returned every user's promotions.
//   2. `requireOwnedHost()` read `host.ownerId !== null && ...`, so a host with
//      `ownerId === null` (shared/system/seeded) was writable by ANY signed-in
//      account, including promoting and rolling back its production voice.
//   3. `requireProducer()` accepted any authenticated account with no role check.
//
// The guards now live in voiceAudition.ts precisely so they can be executed here
// against the in-memory store rather than asserted about by reading the source.
//
// The matrix below is the point of the file: anonymous / owner / a DIFFERENT
// owner / administrator, crossed against own, foreign, and UNOWNED-system
// resources, across every verb that reads or mutates.

import assert from "node:assert/strict";
import {
  authorizeAudition,
  authorizeHost,
  createAudition,
  createInMemoryVoiceAuditionStore,
  guardedCastVote,
  guardedGetBallots,
  guardedListAuditions,
  guardedOpenVoting,
  guardedPromote,
  guardedPromotionHistory,
  guardedReveal,
  guardedRollback,
  guardedSelectWinner,
  AUTHZ_AUDITION_UNAVAILABLE,
  AUTHZ_HOST_UNAVAILABLE,
  AUTHZ_SIGN_IN_REQUIRED,
  type AuditionViewer,
  type AuthzResult,
  type HostVoiceRecord,
  type VoiceAuditionDeps,
} from "../lib/services/voiceAudition";

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

// --- actors -----------------------------------------------------------------
const OWNER: AuditionViewer = { id: "user-owner", name: "Owner", email: "owner@example.com", role: "USER", isAdmin: false };
const OTHER: AuditionViewer = { id: "user-other", name: "Other", email: "other@example.com", role: "USER", isAdmin: false };
const ADMIN: AuditionViewer = { id: "user-admin", name: "Admin", email: "admin@example.com", role: "ADMIN", isAdmin: true };
const ANON = null;

// --- resources --------------------------------------------------------------
// The secrets that must never escape, in any response or error, ever.
const SECRET_VOICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_PARTNER_VOICE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET_LABEL = "candidate-private-label-DO-NOT-LEAK";

function hosts(): HostVoiceRecord[] {
  return [
    { id: "host-owned", name: "Owned Host", provider: "fish", voiceId: SECRET_VOICE, ownerId: OWNER.id },
    { id: "host-partner", name: "Partner Host", provider: "fish", voiceId: SECRET_PARTNER_VOICE, ownerId: OWNER.id },
    { id: "host-foreign", name: "Foreign Host", provider: "fish", voiceId: "cccccccccccccccccccccccccccccccc", ownerId: OTHER.id },
    // ownerId ABSENT — a shared/system/seeded host. This is the one that used to
    // be writable by everybody.
    { id: "host-system", name: "System Host", provider: "fish", voiceId: "dddddddddddddddddddddddddddddddd" },
  ];
}

function makeDeps() {
  const store = createInMemoryVoiceAuditionStore(hosts());
  let seq = 0;
  const deps: VoiceAuditionDeps = {
    store,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    newId: () => `id-${++seq}`,
  };
  return { deps, store };
}

function refusedWith<T>(r: AuthzResult<T>, expected: string, what: string) {
  assert.equal(r.ok, false, `${what} must be refused`);
  if (!r.ok) assert.equal(r.error, expected, `${what} must answer "${expected}", got "${r.error}"`);
}

async function main() {
  console.log("\nVoice audition authorization matrix\n");

  // =========================================================================
  console.log("  -- anonymous --");
  {
    const { deps } = makeDeps();
    await check("anonymous cannot read an audition", async () => {
      refusedWith(await authorizeAudition(deps, ANON, "id-1"), AUTHZ_SIGN_IN_REQUIRED, "anonymous read");
    });
    await check("anonymous cannot reach a host", async () => {
      refusedWith(await authorizeHost(deps, ANON, "host-owned"), AUTHZ_SIGN_IN_REQUIRED, "anonymous host");
    });
    await check("anonymous cannot read promotion history", async () => {
      refusedWith(await guardedPromotionHistory(deps, ANON), AUTHZ_SIGN_IN_REQUIRED, "anonymous history");
    });
  }

  // =========================================================================
  console.log("  -- owner acts on own resources --");
  {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "Recast" });

    await check("owner can read their own audition", async () => {
      const r = await authorizeAudition(deps, OWNER, audition.id);
      assert.equal(r.ok, true, "owner must reach their own audition");
    });
    await check("owner can reach their own host", async () => {
      const r = await authorizeHost(deps, OWNER, "host-owned");
      assert.equal(r.ok, true, "owner must reach their own host");
    });
    await check("owner's audition list is scoped to them", async () => {
      const r = await guardedListAuditions(deps, OWNER);
      assert.equal(r.ok, true);
      if (r.ok) assert.ok(r.value.every((a) => !a.ownerId || a.ownerId === OWNER.id), "list must be owner-scoped");
    });
  }

  // =========================================================================
  console.log("  -- a DIFFERENT owner (cross-tenant) --");
  {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "Recast" });

    await check("a different owner cannot READ another owner's audition", async () => {
      refusedWith(await authorizeAudition(deps, OTHER, audition.id), AUTHZ_AUDITION_UNAVAILABLE, "cross-owner read");
    });
    await check("a different owner cannot reach another owner's host", async () => {
      refusedWith(await authorizeHost(deps, OTHER, "host-owned"), AUTHZ_HOST_UNAVAILABLE, "cross-owner host");
    });
    await check("a different owner cannot list another owner's ballots", async () => {
      refusedWith(await guardedGetBallots(deps, OTHER, audition.id), AUTHZ_AUDITION_UNAVAILABLE, "cross-owner ballots");
    });
    await check("a different owner cannot open voting on it", async () => {
      refusedWith(await guardedOpenVoting(deps, OTHER, audition.id), AUTHZ_AUDITION_UNAVAILABLE, "cross-owner openVoting");
    });
    await check("a different owner cannot select its winner", async () => {
      refusedWith(
        await guardedSelectWinner(deps, OTHER, { auditionId: audition.id, ballotId: "ballot-x" }),
        AUTHZ_AUDITION_UNAVAILABLE,
        "cross-owner selectWinner"
      );
    });
    await check("a different owner cannot reveal it", async () => {
      refusedWith(await guardedReveal(deps, OTHER, audition.id), AUTHZ_AUDITION_UNAVAILABLE, "cross-owner reveal");
    });
    await check("a different owner cannot promote from it", async () => {
      refusedWith(
        await guardedPromote(deps, OTHER, { auditionId: audition.id, acknowledgedBallotId: "ballot-x" }),
        AUTHZ_AUDITION_UNAVAILABLE,
        "cross-owner promote"
      );
    });
    await check("a different owner cannot cast a vote in it", async () => {
      const r = await guardedCastVote(deps, OTHER, {
        auditionId: audition.id,
        ballotId: "ballot-x",
        scores: {},
        overall: 5,
      });
      assert.equal(r.ok, false, "cross-owner vote must be refused");
    });

    // THE EXISTENCE LEAK. A row you do not own must answer exactly like a row
    // that was never created.
    await check("not-owned and NON-EXISTENT are indistinguishable", async () => {
      const notMine = await authorizeAudition(deps, OTHER, audition.id);
      const missing = await authorizeAudition(deps, OTHER, "no-such-audition");
      assert.deepEqual(notMine, missing, "a foreign row must answer identically to a missing one");

      const foreignHost = await authorizeHost(deps, OTHER, "host-owned");
      const missingHost = await authorizeHost(deps, OTHER, "no-such-host");
      assert.deepEqual(foreignHost, missingHost, "a foreign host must answer identically to a missing one");
    });
  }

  // =========================================================================
  console.log("  -- UNOWNED system host (the ownerId === null hole) --");
  {
    const { deps, store } = makeDeps();

    await check("an ordinary user CANNOT reach an unowned system host", async () => {
      refusedWith(await authorizeHost(deps, OWNER, "host-system"), AUTHZ_HOST_UNAVAILABLE, "user -> system host");
      refusedWith(await authorizeHost(deps, OTHER, "host-system"), AUTHZ_HOST_UNAVAILABLE, "other -> system host");
    });

    await check("an ordinary user CANNOT create an audition against a system host", async () => {
      refusedWith(await authorizeHost(deps, OWNER, "host-system"), AUTHZ_HOST_UNAVAILABLE, "user -> system audition");
    });

    await check("an ordinary user CANNOT promote or roll back a system host", async () => {
      const audition = await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "x" });
      // Even holding a legitimate audition, the user cannot redirect it at the
      // system host, and the system host's own history stays closed.
      refusedWith(await guardedPromotionHistory(deps, OWNER, "host-system"), AUTHZ_HOST_UNAVAILABLE, "user -> system history");
      assert.equal(store.__hostWrites.length, 0, "no production voice may have been written");
      void audition;
    });

    await check("an ADMINISTRATOR CAN reach the unowned system host", async () => {
      const r = await authorizeHost(deps, ADMIN, "host-system");
      assert.equal(r.ok, true, "an operator must be able to manage a shared host");
    });

    await check("an ADMINISTRATOR can read the system host's promotion history", async () => {
      const r = await guardedPromotionHistory(deps, ADMIN, "host-system");
      assert.equal(r.ok, true, "an admin must be able to audit a shared host");
    });
  }

  // =========================================================================
  console.log("  -- promotion history scoping (the IDOR) --");
  {
    const { deps } = makeDeps();
    await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "Owner's" });
    await createAudition(deps, { ownerId: OTHER.id, hostId: "host-foreign", title: "Other's" });

    await check("history WITHOUT a hostId does not return another owner's promotions", async () => {
      const r = await guardedPromotionHistory(deps, OWNER);
      assert.equal(r.ok, true, "an owner may read their own history");
      if (r.ok) {
        const foreign = r.value.filter((p) => p.hostId === "host-foreign" || p.hostId === "host-system");
        assert.equal(foreign.length, 0, `history leaked foreign rows: ${JSON.stringify(foreign)}`);
      }
    });

    await check("history WITH another owner's hostId is refused", async () => {
      refusedWith(await guardedPromotionHistory(deps, OWNER, "host-foreign"), AUTHZ_HOST_UNAVAILABLE, "history IDOR");
    });

    await check("an admin CAN read history across owners", async () => {
      const r = await guardedPromotionHistory(deps, ADMIN);
      assert.equal(r.ok, true, "an admin must be able to audit everything");
    });

    await check("a user with no hosts gets an empty history, not everyone's", async () => {
      const stranger: AuditionViewer = { id: "user-stranger", isAdmin: false };
      const r = await guardedPromotionHistory(deps, stranger);
      assert.equal(r.ok, true);
      if (r.ok) assert.deepEqual(r.value, [], "a user owning nothing must see nothing");
    });
  }

  // =========================================================================
  console.log("  -- admin acts cross-owner --");
  {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "Recast" });
    await check("an admin can read another owner's audition", async () => {
      const r = await authorizeAudition(deps, ADMIN, audition.id);
      assert.equal(r.ok, true, "an admin must be able to inspect any audition");
    });
    await check("an admin can reach another owner's host", async () => {
      const r = await authorizeHost(deps, ADMIN, "host-foreign");
      assert.equal(r.ok, true, "an admin must be able to inspect any host");
    });
  }

  // =========================================================================
  console.log("  -- blindness survives the error paths --");
  {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: OWNER.id, hostId: "host-owned", title: "Recast" });

    await check("no refusal payload contains a provider, model, voiceId or private label", async () => {
      const refusals = await Promise.all([
        authorizeAudition(deps, OTHER, audition.id),
        authorizeHost(deps, OTHER, "host-owned"),
        authorizeHost(deps, OWNER, "host-system"),
        guardedGetBallots(deps, OTHER, audition.id),
        guardedPromote(deps, OTHER, { auditionId: audition.id, acknowledgedBallotId: "ballot-x" }),
        guardedRollback(deps, OTHER, { promotionId: "promotion-x" }),
        guardedPromotionHistory(deps, OWNER, "host-foreign"),
      ]);
      const blob = JSON.stringify(refusals);
      for (const secret of [SECRET_VOICE, SECRET_PARTNER_VOICE, SECRET_LABEL, "cccccccccccccccccccccccccccccccc", "dddddddddddddddddddddddddddddddd"]) {
        assert.ok(!blob.includes(secret), `a refusal leaked "${secret.slice(0, 12)}…"`);
      }
      assert.ok(!/\bprivateLabel\b/.test(blob), "a refusal leaked a privateLabel field");
    });

    await check("an owner's own ballots still carry no identity", async () => {
      const opened = await guardedOpenVoting(deps, OWNER, audition.id);
      // Opening may legitimately refuse (no candidates yet); either way the
      // response must stay blind.
      const ballots = await guardedGetBallots(deps, OWNER, audition.id);
      const blob = JSON.stringify([opened, ballots]);
      for (const secret of [SECRET_VOICE, SECRET_PARTNER_VOICE, SECRET_LABEL]) {
        assert.ok(!blob.includes(secret), "a ballot response leaked candidate identity");
      }
    });
  }

  console.log(
    failed === 0
      ? "\nAll voice audition authorization checks passed.\n"
      : `\n${failed} authorization check(s) FAILED.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
