// Operator-only JSON ingest endpoint for the Epidemic Sound crate.
//
// Why a route (not the uploadAudioAsset server action): file-taking server
// actions require React's Flight multipart reply encoding, which is impractical
// to drive from a plain HTTP client. This route takes JSON describing assets
// whose WAVs are ALREADY in S3 (uploaded out-of-band by the operator, who holds
// the Epidemic key locally — so the key never touches the server), and upserts
// AudioAsset rows, optionally deactivating the synth seeds and repointing the
// SoundDesignConfig onto the Epidemic assets.
//
// Gated twice: proxy.ts enforces Basic auth on /admin/* at the edge, and this
// handler re-verifies (defense in depth per Next.js "verify inside each
// server function"). Runs in the web container (DB reachable there).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import { ASSET_KINDS, SFX_CATEGORIES } from "@/lib/audio/soundDesignShared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IngestAsset {
  name: string;
  kind: string;
  category: string | null;
  tags: string[];
  audioUrl: string;
  storageKey?: string | null;
  durationMs?: number | null;
  license: string;
  licenseNote?: string | null;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
  }

  const assets: IngestAsset[] = Array.isArray(body?.assets) ? body.assets : [];
  const created: Array<{ name: string; id: string; kind: string }> = [];
  const updated: Array<{ name: string; id: string; kind: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const a of assets) {
    try {
      if (!a?.name || !a?.kind || !a?.audioUrl || !a?.license) throw new Error("missing required field");
      if (!(ASSET_KINDS as readonly string[]).includes(a.kind)) throw new Error(`unknown kind '${a.kind}'`);
      if (a.kind === "sfx" && !(SFX_CATEGORIES as readonly string[]).includes(a.category || "")) {
        throw new Error(`sfx needs a valid category (got '${a.category}')`);
      }
      // Admin-ingested licensed crate assets are SHARED SYSTEM library entries
      // (Prompt 6): scoped, structured license/rights, no fabricated owner.
      const canonical = {
        scope: "shared_system",
        ownerId: null,
        podcastId: null,
        licenseStatus: "licensed" as const,
        licenseName: a.license,
        rightsStatus: "confirmed" as const,
        rightsConfirmedAt: new Date(),
        rightsConfirmedByAdminIdentity: "admin:ingest-epidemic",
        allowedUse: "podcast_production",
        legacyScopeReviewRequired: false,
        processingStatus: "ready",
      };
      const metadata = {
        name: a.name,
        kind: a.kind,
        category: a.kind === "sfx" ? a.category : null,
        tags: a.tags ?? [],
        durationMs: a.durationMs ?? null,
        license: a.license,
        licenseNote: a.licenseNote ?? null,
        rightsConfirmed: true,
        isActive: true,
        source: "upload",
      };
      const existing = await db.audioAsset.findFirst({ where: { name: a.name } });
      let row;
      if (existing) {
        // Media content is IMMUTABLE on a ready asset: a re-ingest may refresh
        // metadata/licensing, but never swap the bytes another render used.
        // Same-URL re-ingests are no-ops on content; changed-URL re-ingests
        // must supersede via a NEW asset.
        if (existing.audioUrl === a.audioUrl) {
          row = await db.audioAsset.update({ where: { id: existing.id }, data: { ...metadata, ...canonical } });
        } else {
          row = await db.audioAsset.create({
            data: { ...metadata, ...canonical, audioUrl: a.audioUrl, storageKey: a.storageKey ?? null },
          });
          await db.audioAsset.update({
            where: { id: existing.id },
            data: {
              supersededByAssetId: row.id,
              isArchived: true,
              archivedAt: new Date(),
              archiveReason: "Superseded by re-ingested crate version.",
              isActive: false,
            },
          });
        }
      } else {
        row = await db.audioAsset.create({
          data: { ...metadata, ...canonical, audioUrl: a.audioUrl, storageKey: a.storageKey ?? null },
        });
      }
      (existing ? updated : created).push({ name: a.name, id: row.id, kind: a.kind });
    } catch (e: any) {
      failed.push({ name: a?.name || "(unknown)", error: e?.message || String(e) });
    }
  }

  let seedsDeactivated = 0;
  if (body?.deactivateSeeds) {
    const r = await db.audioAsset.updateMany({ where: { source: "seed" }, data: { isActive: false } });
    seedsDeactivated = r.count;
  }

  let config: any = null;
  if (body?.repoint) {
    const up = await db.audioAsset.findMany({ where: { source: "upload", isActive: true }, orderBy: { createdAt: "asc" } });
    const firstOf = (k: string) => up.find((x) => x.kind === k);
    const intro = firstOf("theme_intro");
    const outro = firstOf("theme_outro");
    const bed = firstOf("bed");
    const stingerAssetIds = up.filter((x) => x.kind === "stinger").slice(0, 5).map((x) => x.id);
    const existingCfg = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
    const cfg = {
      themeIntroAssetId: intro?.id ?? existingCfg?.themeIntroAssetId ?? null,
      themeOutroAssetId: outro?.id ?? existingCfg?.themeOutroAssetId ?? null,
      bedAssetId: bed?.id ?? existingCfg?.bedAssetId ?? null,
      stingerAssetIds: stingerAssetIds.length ? stingerAssetIds : (existingCfg?.stingerAssetIds ?? []),
      defaultStyle: existingCfg?.defaultStyle ?? "full",
      defaultSfxDensity: (typeof body?.sfxDensity === "string" ? body.sfxDensity : existingCfg?.defaultSfxDensity) ?? "medium",
    };
    await db.soundDesignConfig.upsert({ where: { id: "default" }, create: { id: "default", ...cfg }, update: cfg });
    config = { ...cfg, introName: intro?.name, outroName: outro?.name, bedName: bed?.name };
  }

  const byKind: Record<string, number> = {};
  for (const a of [...created, ...updated]) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  return NextResponse.json({ success: true, created: created.length, updated: updated.length, byKind, seedsDeactivated, config, failed });
}
