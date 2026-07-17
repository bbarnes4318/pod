// Audio-asset ownership + isolation tests. Run: npm run test:audio-asset-isolation
//
// THE ONE THING THIS PROVES: the canonical access service (audioAssetAccess.ts)
// plus the database constraints make cross-owner access IMPOSSIBLE, media
// content IMMUTABLE, and legacy assets FAIL-CLOSED — with real Postgres
// enforcing the trigger and CHECK constraints, not mocks.
//
// No LLM, TTS, storage-provider, or network call happens. Embedded PostgreSQL,
// migrated with `prisma migrate deploy`.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
  createAudioAsset,
  listAccessibleAudioAssets,
  getAccessibleAudioAsset,
  assertAudioAssetAssignable,
  assertAudioAssetUsableForRender,
  rightsUsableForNewUse,
  updateAudioAssetMetadata,
  archiveAudioAsset,
  restoreAudioAsset,
  classifyLegacyAudioAssetAdmin,
  findDuplicateInScope,
  toSafeAudioAssetDto,
  type AudioAssetActor,
} from "../lib/services/audioAssetAccess";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function uploadInput(over: Partial<Parameters<typeof createAudioAsset>[2]> = {}) {
  return {
    name: "Test Stinger",
    kind: "stinger",
    scope: "owner_private" as const,
    audioUrl: "http://storage.test/objects/x",
    storageKey: "audio-assets/test/x",
    contentHash: HASH_A,
    mimeType: "audio/mpeg",
    fileSizeBytes: 1000,
    durationMs: 1500,
    ...over,
  };
}

async function main() {
  console.log("\nAudio-asset isolation — scopes, access, immutability\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-asset-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("assets");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/assets`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    // --- Fixtures: two owners, each with a podcast --------------------------
    const alice = await db.user.create({ data: { email: "a@x.test", name: "Alice", passwordHash: "x" } });
    const bob = await db.user.create({ data: { email: "b@x.test", name: "Bob", passwordHash: "x" } });
    const alicePod = await db.podcast.create({ data: { name: "Alice Show", cadence: "one_time", slug: "alice-show", ownerId: alice.id } });
    const bobPod = await db.podcast.create({ data: { name: "Bob Show", cadence: "one_time", slug: "bob-show", ownerId: bob.id } });
    const A: AudioAssetActor = { kind: "user", userId: alice.id };
    const B: AudioAssetActor = { kind: "user", userId: bob.id };
    const ADMIN: AudioAssetActor = { kind: "admin", adminIdentity: "admin:test" };

    // --- Creation scope rules ----------------------------------------------
    let aliceAssetId = "";
    await check("a user creates an owner_private asset for themself", async () => {
      const r = await createAudioAsset(db, A, uploadInput());
      assert(r.ok, JSON.stringify(r));
      if (r.ok) aliceAssetId = r.assetId;
      const row = await db.audioAsset.findUnique({ where: { id: aliceAssetId } });
      assert(row!.scope === "owner_private" && row!.ownerId === alice.id, "scoped to Alice");
      assert(row!.uploadedByUserId === alice.id, "upload attribution recorded");
    });

    let alicePodAssetId = "";
    await check("a user creates a podcast_private asset for a podcast they own", async () => {
      const r = await createAudioAsset(db, A, uploadInput({ name: "Alice Pod Bed", kind: "bed", scope: "podcast_private", podcastId: alicePod.id, contentHash: HASH_B, storageKey: "audio-assets/test/y", audioUrl: "http://storage.test/objects/y" }));
      assert(r.ok, JSON.stringify(r));
      if (r.ok) alicePodAssetId = r.assetId;
      const row = await db.audioAsset.findUnique({ where: { id: alicePodAssetId } });
      assert(row!.podcastId === alicePod.id && row!.ownerId === alice.id, "podcast + owner set");
    });

    await check("a user CANNOT create an asset on another owner's podcast", async () => {
      const r = await createAudioAsset(db, A, uploadInput({ scope: "podcast_private", podcastId: bobPod.id }));
      assert(!r.ok && r.error.code === "podcast_not_owned", JSON.stringify(r));
    });

    await check("a user CANNOT create a shared_system asset", async () => {
      const r = await createAudioAsset(db, A, uploadInput({ scope: "shared_system" as never }));
      assert(!r.ok && r.error.code === "scope_requires_admin", JSON.stringify(r));
    });

    let sharedAssetId = "";
    await check("admin creates a shared_system asset (identity recorded)", async () => {
      const r = await createAudioAsset(db, ADMIN, uploadInput({ name: "System Stinger", scope: "shared_system" as never, contentHash: "c".repeat(64), storageKey: "audio-assets/system/z", audioUrl: "http://storage.test/objects/z", licenseStatus: "original", rightsStatus: "confirmed" }));
      assert(r.ok, JSON.stringify(r));
      if (r.ok) sharedAssetId = r.assetId;
      const row = await db.audioAsset.findUnique({ where: { id: sharedAssetId } });
      assert(row!.ownerId === null && row!.podcastId === null, "unowned");
      assert(row!.createdByAdminIdentity === "admin:test", "admin identity recorded");
    });

    // --- Visibility isolation ----------------------------------------------
    await check("CORE: user B cannot list or read user A's private assets", async () => {
      const list = await listAccessibleAudioAssets(db, B);
      const ids = new Set(list.map((a) => a.id));
      assert(!ids.has(aliceAssetId) && !ids.has(alicePodAssetId), "A's assets invisible to B");
      assert(ids.has(sharedAssetId), "shared asset visible to B");
      const direct = await getAccessibleAudioAsset(db, B, aliceAssetId);
      assert(direct === null, "direct read returns null (not forbidden)");
    });

    await check("admin does NOT automatically see private user libraries", async () => {
      const list = await listAccessibleAudioAssets(db, ADMIN, { includeArchived: true });
      const ids = new Set(list.map((a) => a.id));
      assert(!ids.has(aliceAssetId), "Alice's private asset not in admin listing");
      assert(ids.has(sharedAssetId), "shared asset in admin listing");
    });

    // --- Assignability -------------------------------------------------------
    await check("shared asset is assignable to any podcast; own assets to own podcast", async () => {
      const r1 = await assertAudioAssetAssignable(db, A, sharedAssetId, { id: alicePod.id, ownerId: alice.id });
      assert(r1.ok, "shared OK");
      const r2 = await assertAudioAssetAssignable(db, A, aliceAssetId, { id: alicePod.id, ownerId: alice.id });
      assert(r2.ok, "owner_private OK for own podcast");
      const r3 = await assertAudioAssetAssignable(db, A, alicePodAssetId, { id: alicePod.id, ownerId: alice.id });
      assert(r3.ok, "podcast_private OK for its own podcast");
    });

    await check("CORE: cross-owner assignment reads as NOT FOUND (no existence leak)", async () => {
      const r = await assertAudioAssetAssignable(db, B, aliceAssetId, { id: bobPod.id, ownerId: bob.id });
      assert(!r.ok && r.error.code === "asset_not_found", JSON.stringify(r));
    });

    await check("a podcast_private asset cannot be assigned to a different podcast", async () => {
      // Alice's second podcast:
      const alicePod2 = await db.podcast.create({ data: { name: "Alice 2", cadence: "one_time", slug: "alice-2", ownerId: alice.id } });
      const r = await assertAudioAssetAssignable(db, A, alicePodAssetId, { id: alicePod2.id, ownerId: alice.id });
      assert(!r.ok && r.error.code === "asset_not_found", JSON.stringify(r));
    });

    await check("a legacy_global asset is blocked from new assignment until classified", async () => {
      const legacy = await db.audioAsset.create({ data: { name: "Legacy Mystery", kind: "stinger", tags: [], audioUrl: "http://storage.test/objects/l", license: "unknown", scope: "legacy_global", legacyScopeReviewRequired: true } });
      const r = await assertAudioAssetAssignable(db, ADMIN, legacy.id, { id: alicePod.id, ownerId: alice.id });
      assert(!r.ok && r.error.code === "legacy_review_required", JSON.stringify(r));
    });

    await check("failed, archived, and highlight assets are not assignable", async () => {
      const failedAsset = await db.audioAsset.create({ data: { name: "Failed", kind: "sfx", category: "whoosh", tags: [], audioUrl: "http://storage.test/objects/f", license: "x", scope: "owner_private", ownerId: alice.id, processingStatus: "failed" } });
      const r1 = await assertAudioAssetAssignable(db, A, failedAsset.id, { id: alicePod.id, ownerId: alice.id });
      assert(!r1.ok && r1.error.code === "asset_not_ready", "failed blocked");

      await archiveAudioAsset(db, A, aliceAssetId, "test");
      const r2 = await assertAudioAssetAssignable(db, A, aliceAssetId, { id: alicePod.id, ownerId: alice.id });
      assert(!r2.ok && r2.error.code === "asset_archived", "archived blocked");
      await restoreAudioAsset(db, A, aliceAssetId);

      const highlight = await db.audioAsset.create({ data: { name: "Clip", kind: "highlight", tags: [], audioUrl: "http://storage.test/objects/h", license: "x", rightsConfirmed: true, scope: "owner_private", ownerId: alice.id, rightsStatus: "confirmed" } });
      const r3 = await assertAudioAssetAssignable(db, A, highlight.id, { id: alicePod.id, ownerId: alice.id });
      assert(!r3.ok && r3.error.code === "highlight_requires_explicit_selection", "highlight blocked from pools");
    });

    // --- Rights rules ---------------------------------------------------------
    await check("revoked/expired/rejected rights and licenses block new use", () => {
      const base = { kind: "stinger", rightsStatus: "not_required", rightsExpiresAt: null, licenseStatus: "original", allowedUse: null };
      assert(rightsUsableForNewUse({ ...base }).ok, "clean asset OK");
      assert(!rightsUsableForNewUse({ ...base, rightsStatus: "revoked" }).ok, "revoked blocked");
      assert(!rightsUsableForNewUse({ ...base, rightsStatus: "rejected" }).ok, "rejected blocked");
      assert(!rightsUsableForNewUse({ ...base, licenseStatus: "expired" }).ok, "expired license blocked");
      assert(!rightsUsableForNewUse({ ...base, rightsExpiresAt: new Date(Date.now() - 1000) }).ok, "past expiry blocked");
      assert(rightsUsableForNewUse({ ...base, rightsExpiresAt: new Date(Date.now() + 86400000) }).ok, "future expiry OK");
      assert(!rightsUsableForNewUse({ ...base, kind: "highlight", rightsStatus: "pending" }).ok, "unconfirmed highlight blocked");
      assert(rightsUsableForNewUse({ ...base, kind: "highlight", rightsStatus: "confirmed" }).ok, "confirmed highlight OK");
      assert(!rightsUsableForNewUse({ ...base, licenseStatus: "restricted" }).ok, "restricted without allowedUse blocked");
      assert(rightsUsableForNewUse({ ...base, licenseStatus: "restricted", allowedUse: "podcast_production" }).ok, "restricted with matching allowedUse OK");
      assert(!assertAudioAssetUsableForRender({ ...base, processingStatus: "processing" }).ok, "non-ready blocked at render");
    });

    // --- Immutability -----------------------------------------------------------
    await check("CORE: the DB trigger blocks changing content on a ready asset", async () => {
      let raised = false;
      try {
        await db.audioAsset.update({ where: { id: aliceAssetId }, data: { contentHash: "f".repeat(64) } });
      } catch (err) { raised = /immutable/i.test((err as Error).message); }
      assert(raised, "contentHash change must RAISE");
      let raised2 = false;
      try {
        await db.audioAsset.update({ where: { id: aliceAssetId }, data: { audioUrl: "http://storage.test/other" } });
      } catch (err) { raised2 = /immutable/i.test((err as Error).message); }
      assert(raised2, "audioUrl change must RAISE");
    });

    await check("updateAudioAssetMetadata allows safe fields, rejects content fields", async () => {
      const ok = await updateAudioAssetMetadata(db, A, aliceAssetId, { name: "Renamed Stinger", tags: ["hype"] });
      assert(ok.ok, JSON.stringify(ok));
      const bad = await updateAudioAssetMetadata(db, A, aliceAssetId, { contentHash: HASH_B });
      assert(!bad.ok && bad.error.code === "immutable_content_field", "content field rejected at service");
      const badScope = await updateAudioAssetMetadata(db, A, aliceAssetId, { scope: "shared_system" });
      assert(!badScope.ok, "scope change rejected (users cannot widen scope)");
    });

    await check("CHECK constraints reject invalid scope combinations at the DB", async () => {
      let rejected = false;
      try {
        await db.audioAsset.create({ data: { name: "Bad", kind: "sfx", category: "whoosh", tags: [], audioUrl: "http://x/1", license: "x", scope: "shared_system", ownerId: alice.id } });
      } catch { rejected = true; }
      assert(rejected, "owned shared_system row must be rejected");
      let rejected2 = false;
      try {
        await db.audioAsset.create({ data: { name: "Bad2", kind: "sfx", category: "whoosh", tags: [], audioUrl: "http://x/2", license: "x", scope: "owner_private", ownerId: alice.id, podcastId: alicePod.id } });
      } catch { rejected2 = true; }
      assert(rejected2, "owner_private with podcastId must be rejected");
    });

    // --- Cross-owner management ---------------------------------------------
    await check("user B cannot archive, restore, or edit user A's asset", async () => {
      const r1 = await archiveAudioAsset(db, B, aliceAssetId);
      assert(!r1.ok && r1.error.code === "asset_not_found", "archive blocked as not-found");
      const r2 = await updateAudioAssetMetadata(db, B, aliceAssetId, { name: "Stolen" });
      assert(!r2.ok, "edit blocked");
      const row = await db.audioAsset.findUnique({ where: { id: aliceAssetId } });
      assert(row!.name === "Renamed Stinger", "A's asset unchanged");
    });

    await check("a user cannot archive a shared_system asset; admin can", async () => {
      const r1 = await archiveAudioAsset(db, A, sharedAssetId);
      assert(!r1.ok, "user blocked");
      const r2 = await archiveAudioAsset(db, ADMIN, sharedAssetId, "test");
      assert(r2.ok, "admin OK");
      await restoreAudioAsset(db, ADMIN, sharedAssetId);
    });

    // --- Duplicate detection (no cross-owner leak) ---------------------------
    await check("CORE: duplicate-hash lookup never reveals another owner's identical bytes", async () => {
      const own = await findDuplicateInScope(db, A, HASH_A);
      assert(own !== null && own.id === aliceAssetId, "own duplicate found");
      const cross = await findDuplicateInScope(db, B, HASH_A);
      assert(cross === null, "another owner's identical bytes are invisible");
    });

    // --- Legacy classification ------------------------------------------------
    await check("admin classifies a legacy asset; a user cannot", async () => {
      const legacy = await db.audioAsset.create({ data: { name: "Legacy 2", kind: "bed", tags: [], audioUrl: "http://x/L2", license: "unknown", scope: "legacy_global", legacyScopeReviewRequired: true } });
      const userTry = await classifyLegacyAudioAssetAdmin(db, A, legacy.id, { scope: "shared_system" });
      assert(!userTry.ok && userTry.error.code === "scope_requires_admin", "user blocked");
      const toOwner = await classifyLegacyAudioAssetAdmin(db, ADMIN, legacy.id, { scope: "podcast_private", podcastId: alicePod.id });
      assert(toOwner.ok, JSON.stringify(toOwner));
      const row = await db.audioAsset.findUnique({ where: { id: legacy.id } });
      assert(row!.scope === "podcast_private" && row!.ownerId === alice.id && row!.podcastId === alicePod.id, "owner derived from podcast");
      assert(row!.legacyScopeReviewRequired === false, "review flag cleared");
    });

    // --- Safe DTO ------------------------------------------------------------
    await check("the safe DTO exposes no storage data or owner identity", async () => {
      const row = await db.audioAsset.findUnique({ where: { id: aliceAssetId } });
      const dto = toSafeAudioAssetDto(row!);
      const json = JSON.stringify(dto);
      assert(!json.includes("storage.test"), "no raw URL");
      assert(!json.includes("audio-assets/test"), "no storage key");
      assert(!json.includes(alice.id), "no owner id");
      assert(dto.previewPath === `/api/audio-assets/${aliceAssetId}/preview`, "preview is a route, not a URL");
    });

    // --- Audit trail -----------------------------------------------------------
    await check("asset lifecycle events are audit-trailed with actor identity", async () => {
      const events = await db.audioAssetAuditEvent.findMany({ where: { assetId: aliceAssetId }, orderBy: { createdAt: "asc" } });
      const kinds = events.map((e) => e.event);
      assert(kinds.includes("created") && kinds.includes("archived") && kinds.includes("restored"), `events: ${kinds.join(",")}`);
      const created = events.find((e) => e.event === "created")!;
      assert(created.actorType === "user" && created.userId === alice.id, "actor recorded");
      const json = JSON.stringify(events);
      assert(!json.includes("storage.test") && !json.includes("audio-assets/"), "no URLs/keys in audit metadata");
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
