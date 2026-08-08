import { NextResponse } from "next/server";
import { intakeIssueColdOpenTrial, intakeResolveColdOpenTrial } from "@/lib/services/listenerLearning";
import { learningIntakeDeps, readCappedBody, requestOrigin } from "../episodeContext";

export const dynamic = "force-dynamic";

// BLIND cold-open pairwise test, on a PUBLIC endpoint.
//
//   GET  ?episodeId=…&listenerId=…&consent=1
//        -> { trial: { trialToken, options: [{slot:"A"…},{slot:"B"…}] }, context }
//   POST { context, winnerSlot: "A" | "B" }
//        -> records the winner
//
// SERVER-ISSUED ASSIGNMENT. The server chooses which variant occupies which
// slot, stores that mapping, and serves slot labels only — no variant ids, no
// archetype names, and no ordering derived from the script. The listener
// answers with a SIDE. The variant identity is resolved server-side from the
// stored trial, so the client never learns it and can never assert it: a body
// carrying any variant-identity field is refused outright.
//
// A trial resolves EXACTLY ONCE. Replay protection is a compare-and-set on the
// trial row (the `decidedAt: null` predicate lives in the SQL WHERE clause), so
// two concurrent submissions cannot both be counted.
//
// All of it lives in listenerLearning.ts section 8 and is proved offline by
// src/scripts/testListenerSignalAbuse.ts. This handler adds no rules.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const episodeId = url.searchParams.get("episodeId") || "";
  const listenerId = url.searchParams.get("listenerId") || null;
  const consent = url.searchParams.get("consent") === "1" || url.searchParams.get("consent") === "true";
  const { sourceIp, country } = requestOrigin(req);

  const result = await intakeIssueColdOpenTrial(learningIntakeDeps(), { episodeId, listenerId, consent, sourceIp, country });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.code, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json({ ok: true, ...result.body }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rawBody = await readCappedBody(req);
  const { sourceIp, country } = requestOrigin(req);

  const result = await intakeResolveColdOpenTrial(learningIntakeDeps(), { rawBody, sourceIp, country });
  if (!result.ok) {
    const headers: Record<string, string> = {};
    if (result.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: result.code, reason: result.reason }, { status: result.status, headers });
  }
  // Deliberately does NOT echo the winning variant: the listener may still be
  // inside the experiment, and telling them what they picked would unblind
  // every subsequent trial they see.
  return NextResponse.json({ ok: true, ...result.body });
}
