import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  countryFromHeaders,
  createPrismaLearningStore,
  isLearningSignalKey,
  recordLearningEvents,
  signalDescriptor,
} from "@/lib/services/listenerLearning";
import { loadEpisodeLearningContext } from "../episodeContext";

export const dynamic = "force-dynamic";

// Listener / panel signal collection for the closed learning loop.
//
// CONSENT IS THE GATE: a body without `consent: true` is refused with a reason
// rather than quietly stored. The raw `listenerId` the client sends is hashed
// inside recordLearningEvents() and never persisted; nothing else identifying
// is read from the request — no IP, no user-agent, only an edge geo header's
// 2-letter country when one exists.
//
// The attribution dimensions (show, format, host pair, opening variant, policy
// versions) are resolved SERVER-SIDE from the episode, so a client can neither
// choose nor spoof what a signal is attributed to.

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const episodeId = typeof body.episodeId === "string" ? body.episodeId : "";
  const signalKey = body.signalKey;
  const listenerId = typeof body.listenerId === "string" ? body.listenerId : "";

  if (!episodeId || !isLearningSignalKey(signalKey)) {
    return NextResponse.json({ ok: false, error: "episodeId and a known signalKey are required." }, { status: 400 });
  }
  const descriptor = signalDescriptor(signalKey);
  if (descriptor.source === "production") {
    // Production measurements are derived from artifacts by the worker, not
    // reported by a client that could assert any number it likes.
    return NextResponse.json({ ok: false, error: `"${signalKey}" is a production-side measurement and is not accepted from clients.` }, { status: 400 });
  }
  if (body.consent !== true) {
    return NextResponse.json({ ok: false, error: "consent_required" }, { status: 403 });
  }
  if (!listenerId) {
    return NextResponse.json({ ok: false, error: "listenerId is required (it is hashed and never stored)." }, { status: 400 });
  }

  const context = await loadEpisodeLearningContext(episodeId);
  if (!context) return NextResponse.json({ ok: false, error: "unknown_episode" }, { status: 404 });

  const store = createPrismaLearningStore(db);
  const { recorded, rejected } = await recordLearningEvents(store, [
    {
      signalKey,
      value: Number(body.value ?? 1),
      episodeId: context.episodeId,
      podcastId: context.podcastId,
      formatId: context.formatId,
      openingVariant: context.openingVariant,
      hostPairKey: context.hostPairKey,
      voicePolicyVersion: context.voicePolicyVersion,
      productionPolicyVersion: context.productionPolicyVersion,
      listenerId,
      cohort: typeof body.cohort === "string" ? body.cohort : null,
      consented: true,
      country: countryFromHeaders(req.headers),
      metadata: (body.metadata as Record<string, unknown>) ?? null,
    },
  ]);

  if (!recorded.length) {
    return NextResponse.json({ ok: false, error: rejected[0]?.code ?? "rejected", reason: rejected[0]?.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, recorded: recorded.length });
}
