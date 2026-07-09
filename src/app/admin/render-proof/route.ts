// Operator-only render driver for proving the Epidemic ingest end-to-end.
// Coolify 4.1.2 has no container exec, and the final-audio server actions are
// only referenced from the per-script detail page (so their action ids can't be
// discovered without a scriptId first). This route calls those server functions
// directly, server-side, so the whole render can be driven over HTTPS.
//
// Basic-auth gated by proxy.ts on /admin/*, plus a re-verify here.
//   GET                              -> list eligible (approved + rendered) scripts
//   POST {scriptId}                  -> forceRegenerate stitch (full / medium)
//   POST {scriptId, action:"poll"}   -> latest audio:stitch-final JobLog
//   POST {scriptId, action:"detail"} -> final-audio detail (mp3 url etc.)

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import {
  fetchFinalAudioDashboard,
  triggerFinalAudioStitch,
  fetchLatestAudioStitchJob,
  fetchFinalAudioDetail,
} from "@/app/admin/final-audio/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const d = await fetchFinalAudioDashboard({ finalAudioStatus: "ready" });
  return NextResponse.json(d);
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body: any = await req.json().catch(() => ({}));
  const scriptId: string = body?.scriptId;
  if (!scriptId) return NextResponse.json({ success: false, error: "scriptId required" }, { status: 400 });

  if (body.action === "poll") {
    return NextResponse.json(await fetchLatestAudioStitchJob(scriptId));
  }
  if (body.action === "detail") {
    return NextResponse.json(await fetchFinalAudioDetail(scriptId));
  }
  const r = await triggerFinalAudioStitch(scriptId, {
    forceRegenerate: true,
    productionStyle: typeof body.productionStyle === "string" ? body.productionStyle : "full",
    sfxDensity: typeof body.sfxDensity === "string" ? body.sfxDensity : "medium",
    includeIntro: body.includeIntro !== false,
    includeOutro: body.includeOutro !== false,
  });
  return NextResponse.json(r);
}
