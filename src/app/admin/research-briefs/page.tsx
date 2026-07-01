import React from "react";
import BriefsDashboard from "./BriefsDashboard";
import { db } from "@/lib/db";
import "./briefs.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function ResearchBriefsPage() {
  // Fetch approved topic candidates with their optional research briefs
  const topics = await db.topicCandidate.findMany({
    where: { status: "approved" },
    include: {
      researchBrief: true,
    },
    orderBy: { debateScore: "desc" },
  });

  // Serialize topics
  const serializedTopics = topics.map((t) => ({
    id: t.id,
    title: t.title,
    sport: t.sport,
    leagueId: t.leagueId,
    summary: t.summary,
    debateScore: t.debateScore,
    evidenceIds: t.evidenceIds,
    brief: t.researchBrief
      ? {
          id: t.researchBrief.id,
          topicId: t.researchBrief.topicId,
          facts: t.researchBrief.facts,
          stats: t.researchBrief.stats,
          injuryContext: t.researchBrief.injuryContext,
          oddsContext: t.researchBrief.oddsContext,
          argumentForHostA: t.researchBrief.argumentForHostA,
          argumentForHostB: t.researchBrief.argumentForHostB,
          counterArguments: t.researchBrief.counterArguments,
          unsafeClaims: t.researchBrief.unsafeClaims,
          sourceIds: t.researchBrief.sourceIds,
          classification: t.researchBrief.classification,
          mainAngle: t.researchBrief.mainAngle,
          whyMattersNow: t.researchBrief.whyMattersNow,
          keyFactsContext: t.researchBrief.keyFactsContext,
          onAirTalkingPoints: t.researchBrief.onAirTalkingPoints,
          contrarianAngle: t.researchBrief.contrarianAngle,
          strongestDebateQuestion: t.researchBrief.strongestDebateQuestion,
          suggestedHostTake: t.researchBrief.suggestedHostTake,
          sourceNotesUsed: t.researchBrief.sourceNotesUsed,
        }
      : null,
  }));

  const isLlmStub = process.env.LLM_PROVIDER?.toLowerCase() === "stub";

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="briefsHeader">
        <div className="titleGroup">
          <h2>Debate Research Briefs</h2>
          <p>
            Generate producer-grade, fact-grounded debate briefs for approved topics. Verify references and moderate unsafe claims.
          </p>
        </div>
      </div>

      {/* Dashboard */}
      <BriefsDashboard topics={serializedTopics} isLlmStub={isLlmStub} />
    </div>
  );
}
