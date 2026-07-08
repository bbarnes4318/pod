import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Stable, shareable direct-download URL for a published episode's MP3.
// 302-redirects to the stored audio file (S3/local). Published episodes are
// public (they're in the feed), so no auth is required — but only published
// episodes with real audio resolve.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ep = await db.episode.findUnique({
    where: { id },
    select: { status: true, audioUrl: true },
  });
  if (!ep || ep.status !== "published" || !ep.audioUrl) {
    return new NextResponse("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.redirect(ep.audioUrl, { status: 302 });
}
