// E2E-ONLY: run grounded research for a topic synchronously.
//
// The Playwright harness has no queue worker (Redis is an external boundary it
// deliberately does without), so "Admin clicks Start Research" can only enqueue
// — nothing would ever consume it. This route stands in for the worker's
// consumption step so the browser can drive the whole workflow.
//
// WHAT IS STUBBED: the model's output, and only that.
// WHAT IS REAL: the topic's own persisted TopicSource rows, the usability
// filter, the packet/allowlist, validateBriefResult, promoteCitedSources, and
// the database writes. That is the point — a test that stubbed the validator
// would prove nothing about grounding, so the rejection cases below
// (topic-self, foreign source) are refused by the SAME code that refuses a real
// model, not by an assertion in a test.
//
// SAFETY: 404s unless E2E_TEST_MODE=1, which is set only on the dev server the
// harness spawns and never in production. It weakens no authorization — the
// /admin surface is still Basic-Auth gated by the proxy — and it cannot
// manufacture eligibility, because everything it writes went through the real
// validation first.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { e2eEnabled } from "@/lib/e2eSeam";
import { armE2EResearch, e2eResearchResult, type E2EResearchMode } from "@/lib/research/e2eResearchStub";
import {
  selectUsableSources, buildAllowedKeys, validateBriefResult, promoteCitedSources,
  type PacketTopicSource,
} from "@/lib/services/researchBriefService";
import { parseEvidenceRefList } from "@/lib/services/evidenceRefs";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Inert outside the harness. Not "disabled" — absent.
  if (!e2eEnabled()) return new NextResponse("Not found", { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    topicId?: string;
    mode?: E2EResearchMode;
    foreignSourceId?: string;
  };
  const topicId = body.topicId;
  const mode: E2EResearchMode = body.mode ?? "grounded";
  if (!topicId) return NextResponse.json({ ok: false, error: "topicId is required" }, { status: 400 });

  const topic = await db.topicCandidate.findUnique({ where: { id: topicId } });
  if (!topic) return NextResponse.json({ ok: false, error: "topic not found" }, { status: 404 });

  // The REAL precondition — research refuses a topic that isn't approved.
  if (topic.status !== "approved") {
    return NextResponse.json({ ok: false, error: `topic is ${topic.status}, not approved` }, { status: 409 });
  }

  // REAL sources, REAL usability filter.
  const rows = await db.topicSource.findMany({ where: { topicId } });
  const usable = selectUsableSources(rows as unknown as PacketTopicSource[], topicId);

  armE2EResearch(topicId, mode, body.foreignSourceId);
  const llmResult = e2eResearchResult(topicId, usable.map((s) => s.id), "Host A", "Host B");
  if (!llmResult) return NextResponse.json({ ok: false, error: "stub not armed" }, { status: 500 });

  // REAL packet + REAL validation. This is what rejects the topic-self and
  // foreign-source payloads — the same function a real model's output meets.
  const allowedKeys = buildAllowedKeys({
    evidenceIds: parseEvidenceRefList(topic.evidenceIds).refs,
    sources: usable,
    researchCount: 0,
  });
  const validated = validateBriefResult({ llmResult, allowedKeys, topicId, hostAName: "Host A", hostBName: "Host B" });

  if (!validated.ok) {
    // A failed run persists NO brief and promotes NO evidence — the topic stays
    // honestly blocked, exactly as in production.
    return NextResponse.json({ ok: false, failure: validated.failure, unsafeClaims: validated.unsafeClaims.length });
  }

  // REAL promotion (re-checks every ref against the database) + REAL writes.
  const promotion = await promoteCitedSources({ db: db as never }, topicId, validated.citedTopicSourceRefs, topic.evidenceIds);

  const briefData = {
    facts: validated.facts as unknown as Prisma.InputJsonValue,
    stats: validated.stats as unknown as Prisma.InputJsonValue,
    argumentForHostA: validated.argumentForHostA,
    argumentForHostB: validated.argumentForHostB,
    counterArguments: validated.counterArguments as unknown as Prisma.InputJsonValue,
    unsafeClaims: validated.unsafeClaims as unknown as Prisma.InputJsonValue,
    sourceIds: validated.sourceIds as unknown as Prisma.InputJsonValue,
    keyFactsContext: validated.facts as unknown as Prisma.InputJsonValue,
    onAirTalkingPoints: validated.stats as unknown as Prisma.InputJsonValue,
    classification: String(llmResult.classification ?? "news_reaction"),
    mainAngle: String(llmResult.mainAngle ?? ""),
    whyMattersNow: String(llmResult.whyMattersNow ?? ""),
    contrarianAngle: String(llmResult.contrarianAngle ?? ""),
    strongestDebateQuestion: String(llmResult.strongestDebateQuestion ?? ""),
    suggestedHostTake: String(llmResult.suggestedHostTake ?? ""),
  };

  await db.$transaction(async (tx) => {
    await tx.researchBrief.upsert({ where: { topicId }, create: { topicId, ...briefData }, update: briefData });
    if (promotion.promoted.length > 0) {
      await tx.topicCandidate.update({
        where: { id: topicId },
        data: { evidenceIds: promotion.evidenceIds as unknown as Prisma.InputJsonValue },
      });
    }
  });

  return NextResponse.json({
    ok: true,
    promoted: promotion.promoted.map((r) => r.id),
    sourceIds: validated.sourceIds,
    dropped: promotion.dropped.map((d) => ({ ref: `${d.ref.type}:${d.ref.id}`, reason: d.reason })),
  });
}
