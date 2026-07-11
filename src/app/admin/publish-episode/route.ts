// Operator-only route to drive content-assets -> publish over HTTPS, same
// rationale as /admin/prepare-episode: the publish server actions are bound to
// the admin React pages, so this calls the SAME underlying services server-side.
// It NEVER bypasses a gate — validateEpisodeForRss (compliance: gambling
// disclaimer, config, fact-check-passed, audio present) runs inside prepare and
// publish exactly as the UI path does.
//
//   POST {scriptId|episodeId, action:"publish"}  (default) -> content-assets
//        (audio_ready -> content_ready) -> ensurePublishAssets -> prepare ->
//        publish. Returns the published state + RSS url.
//   POST {..., action:"status"}                             -> episode + asset state
//
// Basic-auth gated by proxy.ts on /admin/*, re-verified here.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import { queueContentAssetGenerationJob } from "@/lib/queue/podcastQueue";
import { ensurePublishAssets } from "@/lib/services/publishAssetsService";
import {
  prepareEpisodeForPublishing,
  publishEpisode,
} from "@/lib/services/rssPublishingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONTENT_READY = new Set(["content_ready", "publish_ready", "published"]);

async function resolveScript(body: any) {
  if (body?.scriptId) {
    return db.script.findUnique({ where: { id: String(body.scriptId) }, include: { episode: true } });
  }
  if (body?.episodeId) {
    return db.script.findFirst({ where: { episodeId: String(body.episodeId) }, orderBy: { version: "desc" }, include: { episode: true } });
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body: any = await req.json().catch(() => ({}));
  const action: string = body?.action || "publish";
  const waitMs = Math.min(Math.max(Number(body?.waitMs) || 240000, 0), 280000);

  const script = await resolveScript(body);
  if (!script || !script.episode) {
    return NextResponse.json({ success: false, error: "Script or episode not found." }, { status: 404 });
  }
  const scriptId = script.id;
  const episodeId = script.episode.id;

  if (action === "status") {
    const ep = await db.episode.findUnique({
      where: { id: episodeId },
      select: { status: true, title: true, audioUrl: true, transcriptUrl: true, longShowNotes: true, rssImageUrl: true, publishedAt: true, rssGuid: true, podcastId: true },
    });
    return NextResponse.json({ success: true, scriptId, episodeId, episode: ep });
  }

  if (action !== "publish") {
    return NextResponse.json({ success: false, error: `Unknown action '${action}'.` }, { status: 400 });
  }

  const steps: any = {};
  try {
    // 1. Content assets (audio_ready -> content_ready). Skip if already there.
    let ep = await db.episode.findUnique({ where: { id: episodeId }, select: { status: true } });
    if (!ep) throw new Error("Episode vanished.");
    if (!CONTENT_READY.has(ep.status)) {
      const since = new Date();
      const enq = await queueContentAssetGenerationJob({ scriptId, forceRegenerate: body?.force === true });
      const deadline = Date.now() + waitMs;
      let job: any = null;
      while (Date.now() < deadline) {
        job = await db.jobLog.findFirst({
          where: { jobType: "content:generate-assets", input: { path: ["scriptId"], equals: scriptId }, createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
        });
        if (job && (job.status === "completed" || job.status === "failed")) break;
        await sleep(3000);
      }
      steps.contentAssets = { enqueuedJobId: enq.id, status: job?.status ?? "pending", error: job?.error ?? null };
      if (!job || job.status !== "completed") {
        return NextResponse.json({ success: false, stoppedAt: "content-assets", steps }, { status: 202 });
      }
    } else {
      steps.contentAssets = { status: "already " + ep.status };
    }

    // 2. Publish assets (title options + SVG cover + gambling disclaimer if betting).
    const assets = await ensurePublishAssets(episodeId);
    steps.publishAssets = { ok: assets.ok, betting: assets.betting, disclaimerAdded: assets.disclaimerAdded, coverArtUrl: assets.coverArtUrl, compliant: assets.compliance?.compliant };
    if (!assets.ok) {
      return NextResponse.json({ success: false, stoppedAt: "publish-assets", steps, error: assets.error }, { status: 422 });
    }

    // 3. Prepare (validateEpisodeForRss "prepare" -> publish_ready). Gate intact.
    const prep = await prepareEpisodeForPublishing(scriptId);
    steps.prepare = { newStatus: prep.newEpisodeStatus, rssGuid: prep.rssGuid, sizeBytes: prep.audioFileSizeBytes, missingConfig: prep.missingConfig };

    // 4. Publish (validateEpisodeForRss "publish" -> published). Gate intact.
    const pub = await publishEpisode(scriptId, { forceRepublish: body?.forceRepublish === true });
    steps.publish = { newStatus: pub.newEpisodeStatus, publishedAt: (pub as any).publishedAt ?? null, rssGuid: pub.rssGuid };

    const finalEp = await db.episode.findUnique({
      where: { id: episodeId },
      select: { status: true, title: true, audioUrl: true, transcriptUrl: true, rssImageUrl: true, publishedAt: true, rssGuid: true, podcastId: true, slug: true },
    });
    const base = process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL || "";
    return NextResponse.json({
      success: true,
      scriptId,
      episodeId,
      steps,
      episode: finalEp,
      rss: {
        global: process.env.PODCAST_RSS_URL || (base ? `${base}/rss` : "/rss"),
        perPodcast: finalEp?.podcastId ? `${base}/rss/${finalEp.podcastId}` : null,
      },
    });
  } catch (err: any) {
    // A blocked compliance/validation gate lands here with its exact reasons.
    return NextResponse.json({ success: false, steps, error: err?.message || "publish failed" }, { status: 422 });
  }
}
