import { NextResponse } from "next/server";
import { intakeIssueSignalContext, intakeListenerSignal } from "@/lib/services/listenerLearning";
import { learningIntakeDeps, readCappedBody, requestOrigin } from "../episodeContext";

export const dynamic = "force-dynamic";

// PUBLIC listener / panel signal collection for the closed learning loop.
//
// THIS IS AN UNAUTHENTICATED ENDPOINT REACHABLE BY ANYONE WITH curl, and the
// data it collects feeds production-policy promotion. It is therefore a
// two-step handshake, not a fire-and-forget beacon:
//
//   GET  ?episodeId=…  -> { context }   a short-lived HMAC-signed grant
//   POST { context, signalKey, value, listenerId, consent }
//
// The signed context is what makes attribution trustworthy: the EPISODE is
// named inside the token by the server, so a client cannot report a signal
// against a show it was never served, and it cannot mint its own grant.
//
// Everything the boundary enforces — strict per-signal ranges, the closed
// metadata allow-list, body/metadata size caps, (listener, episode, signal)
// dedupe, per-listener and per-source rate limits, consent, and the refusal of
// any client-named variant identity — lives in listenerLearning.ts section 8
// and is proved offline by src/scripts/testListenerSignalAbuse.ts. This handler
// deliberately contains NO rules of its own: a rule that lived here would be a
// rule the adversarial suite could not reach.
//
// PRIVACY: the raw listenerId is hashed and never persisted; the source IP is
// salted-hashed into a coarse bucket and never stored as an address; geo is a
// 2-letter country from an edge header at most.
//
// NOTE ON WHAT THIS DATA MAY DO: nothing collected here can move production
// settings on its own. A promotion whose deciding signal came from this
// endpoint is STAGED for a named human — see productionPolicy.ts.

/** Issue a signed context for one episode. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const episodeId = url.searchParams.get("episodeId") || "";
  const { sourceIp } = requestOrigin(req);

  const result = await intakeIssueSignalContext(learningIntakeDeps(), { episodeId, sourceIp });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.code, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json(
    { ok: true, ...result.body },
    // A grant is minted per request and per source; caching one would hand the
    // same token to every listener behind a shared cache.
    { headers: { "cache-control": "no-store" } }
  );
}

/** Record one signal against the episode named in the signed context. */
export async function POST(req: Request) {
  const rawBody = await readCappedBody(req);
  const { sourceIp, country } = requestOrigin(req);

  const result = await intakeListenerSignal(learningIntakeDeps(), { rawBody, sourceIp, country });
  if (!result.ok) {
    const headers: Record<string, string> = {};
    if (result.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: result.code, reason: result.reason }, { status: result.status, headers });
  }
  return NextResponse.json({ ok: true, ...result.body });
}
