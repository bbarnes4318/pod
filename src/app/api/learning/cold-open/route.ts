import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  countryFromHeaders,
  createPrismaLearningStore,
  recordColdOpenChoice,
  serveColdOpenTrial,
  type ColdOpenSlot,
} from "@/lib/services/listenerLearning";
import { loadEpisodeLearningContext } from "../episodeContext";

export const dynamic = "force-dynamic";

// BLIND cold-open pairwise test.
//
//   GET  ?episodeId=…&listenerId=…&consent=1  -> two openings labelled A and B
//   POST { trialToken, winnerSlot }           -> records the winner
//
// The served payload carries slot labels, the opening copy, and slot-scoped
// media URLs. It does NOT carry variant ids, archetype names, ordering derived
// from the script, or any field that would let the client work out which
// opening is which — serveColdOpenTrial() re-asserts that before returning, so
// a future edit that leaks identity fails at the boundary instead of silently
// invalidating the experiment.
//
// The listener answers with a SLOT. The variant identity is resolved
// server-side from the stored trial.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const episodeId = url.searchParams.get("episodeId") || "";
  const listenerId = url.searchParams.get("listenerId") || "";
  const consent = url.searchParams.get("consent") === "1" || url.searchParams.get("consent") === "true";

  if (!episodeId) return NextResponse.json({ ok: false, error: "episodeId is required." }, { status: 400 });
  if (!consent) return NextResponse.json({ ok: false, error: "consent_required" }, { status: 403 });

  const context = await loadEpisodeLearningContext(episodeId);
  if (!context) return NextResponse.json({ ok: false, error: "unknown_episode" }, { status: 404 });
  if (context.coldOpenVariants.length < 2) {
    return NextResponse.json({ ok: false, error: "This episode has fewer than two cold-open variants to compare." }, { status: 409 });
  }

  const store = createPrismaLearningStore(db);
  const result = await serveColdOpenTrial(store, {
    episodeId: context.episodeId,
    podcastId: context.podcastId,
    variants: [context.coldOpenVariants[0], context.coldOpenVariants[1]],
    listenerId: listenerId || null,
    consented: true,
    country: countryFromHeaders(req.headers),
  });

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, trial: result.payload });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const trialToken = typeof body.trialToken === "string" ? body.trialToken : "";
  const winnerSlot = body.winnerSlot === "A" || body.winnerSlot === "B" ? (body.winnerSlot as ColdOpenSlot) : null;

  if (!trialToken || !winnerSlot) {
    return NextResponse.json({ ok: false, error: "trialToken and winnerSlot (A|B) are required." }, { status: 400 });
  }

  const store = createPrismaLearningStore(db);
  const trial = await store.findColdOpenTrial(trialToken);
  if (!trial) return NextResponse.json({ ok: false, error: "unknown_trial" }, { status: 404 });

  const context = trial.episodeId ? await loadEpisodeLearningContext(trial.episodeId) : null;
  const result = await recordColdOpenChoice(store, {
    trialToken,
    winnerSlot,
    formatId: context?.formatId ?? null,
    hostPairKey: context?.hostPairKey ?? null,
    voicePolicyVersion: context?.voicePolicyVersion ?? null,
    productionPolicyVersion: context?.productionPolicyVersion ?? null,
    cohort: typeof body.cohort === "string" ? body.cohort : null,
  });

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
  // The response deliberately does NOT echo the winning variant id: the
  // listener may still be inside the experiment, and telling them what they
  // picked would unblind every subsequent trial they see.
  return NextResponse.json({ ok: true, recorded: true });
}
