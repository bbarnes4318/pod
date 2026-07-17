// READ-ONLY audio-asset ownership audit. Run: npm run audit:audio-assets
//
// Reports the classification state of every AudioAsset without writing
// anything: scope, ownership, source, metadata completeness, license/rights
// state, references, and integrity violations. This is the review tool an
// operator uses before/after the Prompt 6 migration and when classifying
// legacy assets.
//
// SECURITY: prints asset IDs and names — NEVER raw storage URLs or keys.

import { db } from "../lib/db";

function flag(b: boolean): string { return b ? "YES" : "no"; }

async function main() {
  console.log("\n=== Audio-asset ownership audit (read-only) ===\n");

  const assets = await db.audioAsset.findMany({
    orderBy: [{ scope: "asc" }, { kind: "asc" }, { createdAt: "asc" }],
    include: { podcast: { select: { id: true, ownerId: true } } },
  });
  const usageCounts = await db.soundCueUsage.groupBy({ by: ["assetId"], _count: { assetId: true } });
  const usageByAsset = new Map(usageCounts.map((u) => [u.assetId, u._count.assetId]));
  const config = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
  const configIds = new Set(
    [config?.themeIntroAssetId, config?.themeOutroAssetId, config?.bedAssetId,
     ...(Array.isArray(config?.stingerAssetIds) ? (config!.stingerAssetIds as string[]) : [])].filter(Boolean) as string[]
  );

  const byScope: Record<string, number> = {};
  const violations: string[] = [];
  let missingHash = 0, missingMeta = 0, reviewRequired = 0, archived = 0, orphanPrivate = 0;

  for (const a of assets) {
    byScope[a.scope] = (byScope[a.scope] || 0) + 1;
    if (!a.contentHash) missingHash++;
    if (!a.mimeType || !a.fileSizeBytes) missingMeta++;
    if (a.legacyScopeReviewRequired) reviewRequired++;
    if (a.isArchived) archived++;

    // Integrity checks (mirror the DB constraints + service invariants):
    if (!["shared_system", "owner_private", "podcast_private", "legacy_global"].includes(a.scope)) {
      violations.push(`${a.id} has invalid scope '${a.scope}'`);
    }
    if (a.scope === "shared_system" && (a.ownerId || a.podcastId)) {
      violations.push(`${a.id} is shared_system but carries owner/podcast`);
    }
    if (a.scope === "owner_private" && !a.ownerId) { violations.push(`${a.id} is owner_private with no owner (orphaned)`); orphanPrivate++; }
    if (a.scope === "podcast_private") {
      if (!a.ownerId || !a.podcastId) { violations.push(`${a.id} is podcast_private missing owner/podcast`); orphanPrivate++; }
      else if (a.podcast && a.podcast.ownerId !== a.ownerId) {
        violations.push(`${a.id} is podcast_private but asset.ownerId != Podcast.ownerId (cross-owner violation)`);
      }
    }
    if (a.source === "seed" && a.scope !== "shared_system" && !a.supersededByAssetId) {
      violations.push(`${a.id} is a current seed asset but not shared_system`);
    }
    if (!a.storageKey && !a.audioUrl) violations.push(`${a.id} has no storage reference at all`);
  }

  console.log("Scope distribution:");
  for (const [scope, n] of Object.entries(byScope)) console.log(`  ${scope.padEnd(16)} ${n}`);
  console.log(`\nTotals: ${assets.length} assets`);
  console.log(`  archived:                    ${archived}`);
  console.log(`  legacy review required:      ${reviewRequired}`);
  console.log(`  missing contentHash:         ${missingHash}  (repair: npm run repair:audio-asset-metadata)`);
  console.log(`  missing technical metadata:  ${missingMeta}`);
  console.log(`  orphaned private assets:     ${orphanPrivate}`);

  console.log("\nPer-asset report (id | kind | scope | src | ready | arch | hash | license | rights | cfg-ref | usage):");
  for (const a of assets) {
    const inConfig = configIds.has(a.id);
    const usage = usageByAsset.get(a.id) ?? 0;
    console.log(
      `  ${a.id.slice(0, 8)} | ${a.kind.padEnd(11)} | ${a.scope.padEnd(15)} | ${a.source.padEnd(6)} | ` +
      `${a.processingStatus.padEnd(10)} | ${flag(a.isArchived).padEnd(4)} | ${a.contentHash ? a.contentHash.slice(0, 8) : "--------"} | ` +
      `${a.licenseStatus.padEnd(13)} | ${a.rightsStatus.padEnd(12)} | ${flag(inConfig).padEnd(7)} | ${usage}` +
      (a.legacyScopeReviewRequired ? "  [OWNERSHIP REVIEW REQUIRED]" : "") +
      (a.supersededByAssetId ? "  [superseded]" : "")
    );
  }

  // Orphan usage rows: usage pointing at a nonexistent asset.
  const assetIds = new Set(assets.map((a) => a.id));
  const orphanUsage = usageCounts.filter((u) => !assetIds.has(u.assetId));
  if (orphanUsage.length > 0) {
    console.log(`\nOrphan SoundCueUsage: ${orphanUsage.length} asset id(s) with usage but no asset row:`);
    for (const u of orphanUsage) console.log(`  ${u.assetId} (${u._count.assetId} rows)`);
  } else {
    console.log("\nOrphan SoundCueUsage: none");
  }

  // System default profile references:
  console.log("\nSystem default profile (SoundDesignConfig 'default'):");
  if (!config) console.log("  (not configured)");
  else {
    for (const [slot, id] of [
      ["intro", config.themeIntroAssetId], ["outro", config.themeOutroAssetId], ["bed", config.bedAssetId],
    ] as const) {
      if (!id) { console.log(`  ${slot}: (empty)`); continue; }
      const a = assets.find((x) => x.id === id);
      console.log(`  ${slot}: ${id.slice(0, 8)} ${a ? `${a.kind}/${a.scope}${a.isArchived ? " [ARCHIVED]" : ""}${a.scope === "legacy_global" ? " [LEGACY — compatibility default; admin classification recommended]" : ""}` : "[MISSING ASSET]"}`);
      if (!a) violations.push(`system default '${slot}' references missing asset ${id}`);
    }
  }

  if (violations.length > 0) {
    console.log(`\nVIOLATIONS (${violations.length}):`);
    for (const v of violations) console.log(`  ! ${v}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo integrity violations.");
  }
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
