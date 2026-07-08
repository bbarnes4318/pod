import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordPlayEvent } from "@/lib/services/analyticsService";

export const dynamic = "force-dynamic";

// Stable, shareable direct-download URL for a published episode's MP3.
// 302-redirects to the stored audio file (S3/local). Published episodes are
// public (they're in the feed), so no auth is required — but only published
// episodes with real audio resolve.
//
// This route is ALSO the single download-tracking chokepoint (Step 9b): the RSS
// <enclosure> URLs point here with ?src=rss, and the in-app download button
// points here directly. Every fetch records an IAB-deduped download event
// (privacy-safe — see analyticsService) BEFORE the redirect. Tracking never
// blocks or breaks the audio: recordPlayEvent swallows all errors.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ep = await db.episode.findUnique({
    where: { id },
    select: { status: true, audioUrl: true },
  });
  if (!ep || ep.status !== "published" || !ep.audioUrl) {
    return new NextResponse("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const src = new URL(req.url).searchParams.get("src");
  await recordPlayEvent({
    episodeId: id,
    kind: "download",
    source: src === "rss" ? "rss" : "direct",
    headers: req.headers,
  });

  return NextResponse.redirect(ep.audioUrl, { status: 302 });
}
