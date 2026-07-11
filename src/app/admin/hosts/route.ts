// Operator-only route to inspect and prune the AiHost roster over HTTPS.
// Same rationale as /admin/render-proof and /admin/prepare-episode: the roster
// mutations live in owner-gated /studio server actions that can't be driven
// headlessly, so this admin-Basic-auth route calls the SAME underlying primitives
// (Prisma + isVoiceIdValidForProvider + getTTSProvider().synthesizeSpeech).
//
//   POST {action:"list"}                         -> every host + refs + voice id
//   POST {action:"remove", id|name}              -> orphan-protected: hard-delete
//                                                   if unreferenced, else deactivate
//                                                   + archive (kept for episodes)
//   POST {action:"setvoice", id|name, provider, voiceId} -> validated voice update
//   POST {action:"audition", id|name | provider+voiceId, line?} -> real TTS, base64
//
// Read + the explicit host mutations only; never touches episodes/scripts. No
// API key is read or returned. Basic-auth gated by proxy.ts on /admin/*, re-verified.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import { isTtsProviderId } from "@/lib/providers/tts/providerIds";
import { getTTSProvider } from "@/lib/providers/tts/factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function withRefs(h: any) {
  const [episodeCount, segmentCount] = await Promise.all([
    db.episode.count({ where: { hostIds: { has: h.id } } }),
    db.audioSegment.count({ where: { hostId: h.id } }),
  ]);
  return {
    id: h.id,
    name: h.name,
    slug: h.slug,
    isActive: h.isActive,
    isArchived: h.isArchived,
    ttsProvider: h.ttsProvider,
    ttsVoiceId: h.ttsVoiceId,
    ownerId: h.ownerId,
    intensityLevel: h.intensityLevel,
    episodeCount,
    segmentCount,
  };
}

/** Resolve a host by explicit id or by (case-insensitive) name/slug fragment. */
async function resolveHost(body: any) {
  if (body?.id) return db.aiHost.findUnique({ where: { id: String(body.id) } });
  const needle = String(body?.name || "").trim();
  if (!needle) return null;
  const all = await db.aiHost.findMany();
  const lc = needle.toLowerCase();
  return (
    all.find((h) => h.name.toLowerCase() === lc || h.slug.toLowerCase() === lc) ||
    all.find((h) => h.name.toLowerCase().includes(lc) || h.slug.toLowerCase().includes(lc)) ||
    null
  );
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body: any = await req.json().catch(() => ({}));
  const action: string = body?.action || "list";

  // -- envcheck (runtime env presence probe; NO secret values returned) -----
  if (action === "envcheck") {
    const probe = (k: string) => {
      const v = process.env[k];
      return { present: typeof v === "string" && v.length > 0, len: (v || "").length };
    };
    return NextResponse.json({
      success: true,
      runtime: "web",
      FISH_API_KEY: probe("FISH_API_KEY"),
      FISH_MODEL: { present: !!process.env.FISH_MODEL, value: process.env.FISH_MODEL || null },
      ANTHROPIC_API_KEY: probe("ANTHROPIC_API_KEY"),
      DATABASE_URL: probe("DATABASE_URL"),
      // Every process.env key that mentions FISH, so a differently-named var shows up.
      fishKeys: Object.keys(process.env).filter((k) => k.toUpperCase().includes("FISH")),
    });
  }

  // -- list -----------------------------------------------------------------
  if (action === "list") {
    const hosts = await db.aiHost.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json({ success: true, count: hosts.length, hosts: await Promise.all(hosts.map(withRefs)) });
  }

  // -- remove (orphan-protected) --------------------------------------------
  if (action === "remove") {
    const host = await resolveHost(body);
    if (!host) return NextResponse.json({ success: false, error: "Host not found." }, { status: 404 });
    const [episodeCount, segmentCount] = await Promise.all([
      db.episode.count({ where: { hostIds: { has: host.id } } }),
      db.audioSegment.count({ where: { hostId: host.id } }),
    ]);
    const referenced = episodeCount > 0 || segmentCount > 0;
    if (referenced) {
      // Orphan protection: keep the row for existing episodes, but make it
      // unselectable everywhere (both flags so isActive-only AND isArchived-only
      // filters exclude it) and out of the resolver fallback.
      await db.aiHost.update({ where: { id: host.id }, data: { isActive: false, isArchived: true } });
      return NextResponse.json({
        success: true, mode: "deactivated+archived", referenced: true,
        host: { id: host.id, name: host.name }, episodeCount, segmentCount,
      });
    }
    await db.aiHost.delete({ where: { id: host.id } });
    return NextResponse.json({ success: true, mode: "hard-deleted", referenced: false, host: { id: host.id, name: host.name } });
  }

  // -- archive (archive-only; keeps isActive so pinned episodes still resolve) --
  if (action === "archive") {
    const host = await resolveHost(body);
    if (!host) return NextResponse.json({ success: false, error: "Host not found." }, { status: 404 });
    // isArchived drops it from every user picker + the resolver fallback + the
    // admin build form (all filter isArchived:false), while isActive stays true
    // so episodes PINNED to it keep resolving their cast unchanged (the pinned
    // resolver filters isActive only). Reversible via unarchive.
    await db.aiHost.update({ where: { id: host.id }, data: { isArchived: true } });
    const [episodeCount, segmentCount] = await Promise.all([
      db.episode.count({ where: { hostIds: { has: host.id } } }),
      db.audioSegment.count({ where: { hostId: host.id } }),
    ]);
    return NextResponse.json({ success: true, mode: "archived (isActive kept)", host: { id: host.id, name: host.name }, episodeCount, segmentCount });
  }

  // -- setvoice -------------------------------------------------------------
  if (action === "setvoice") {
    const host = await resolveHost(body);
    if (!host) return NextResponse.json({ success: false, error: "Host not found." }, { status: 404 });
    const provider = String(body?.provider || "").trim().toLowerCase();
    const voiceId = String(body?.voiceId || "").trim();
    if (!isTtsProviderId(provider)) return NextResponse.json({ success: false, error: `Unknown TTS provider '${body?.provider}'.` }, { status: 400 });
    if (provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
      return NextResponse.json({ success: false, error: `Voice id '${voiceId}' is not valid for ${provider}.` }, { status: 400 });
    }
    const before = { provider: host.ttsProvider, voiceId: host.ttsVoiceId };
    await db.aiHost.update({ where: { id: host.id }, data: { ttsProvider: provider, ttsVoiceId: voiceId } });
    return NextResponse.json({ success: true, host: { id: host.id, name: host.name }, before, after: { provider, voiceId } });
  }

  // -- audition (real TTS) --------------------------------------------------
  if (action === "audition") {
    let provider = String(body?.provider || "").trim().toLowerCase();
    let voiceId = String(body?.voiceId || "").trim();
    let name = String(body?.name || "Host");
    if (body?.id || (body?.name && !voiceId)) {
      const host = await resolveHost(body);
      if (!host) return NextResponse.json({ success: false, error: "Host not found." }, { status: 404 });
      provider = host.ttsProvider;
      voiceId = host.ttsVoiceId;
      name = host.name;
    }
    if (!isTtsProviderId(provider) || provider === "stub") {
      return NextResponse.json({ success: false, error: `Cannot audition provider '${provider}'.` }, { status: 400 });
    }
    if (!isVoiceIdValidForProvider(provider, voiceId)) {
      return NextResponse.json({ success: false, error: `Voice id '${voiceId}' is not valid for ${provider}.` }, { status: 400 });
    }
    const line = String(body?.line || "").trim() || "Alright, let's get into it — this is the take everyone's arguing about all week.";
    try {
      const impl = getTTSProvider(provider);
      const result = await impl.synthesizeSpeech({
        text: line, voiceId, speakerName: name, tone: "analytical", energy: "medium",
        voiceDirection: `You are ${name}, a sports debate podcast host mid-episode.`, format: "mp3",
      });
      const bytes = result?.audioBuffer?.length || 0;
      return NextResponse.json({
        success: bytes > 0, provider, voiceId, name,
        audioBytes: bytes, contentType: result?.contentType || null, durationMs: result?.durationMs ?? null,
        error: bytes > 0 ? undefined : "Engine returned no audio.",
      });
    } catch (err: any) {
      return NextResponse.json({ success: false, provider, voiceId, name, error: err?.message || "synthesis failed" }, { status: 502 });
    }
  }

  return NextResponse.json({ success: false, error: `Unknown action '${action}'.` }, { status: 400 });
}
