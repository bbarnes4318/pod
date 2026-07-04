import { db } from "../db";
import crypto from "crypto";
import { scoreTopicTalkability } from "./talkabilityService";

export interface EpisodeBuildInput {
  title?: string;
  description?: string;
  topicIds?: string[];
  leagueId?: string;
  sport?: string;
  targetTopicCount?: number;
  minDebateScore?: number;
}

export interface EpisodeBuildResult {
  insertedEpisodeCount: number;
  selectedTopicCount: number;
  skippedTopicCount: number;
  invalidTopicCount: number;
  missingBriefCount: number;
  weakEvidenceCount: number;
  statusUpdateCount: number;
  selectedTopicIds: string[];
  episodeId: string | null;
  reasons: string[];
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/[^\w\-]+/g, "") // Remove all non-word chars
    .replace(/\-\-+/g, "-") // Replace multiple - with single -
    .replace(/^-+/, "") // Trim - from start
    .replace(/-+$/, ""); // Trim - from end
}

export async function buildEpisodeFromTopics(input: EpisodeBuildInput): Promise<EpisodeBuildResult> {
  const result: EpisodeBuildResult = {
    insertedEpisodeCount: 0,
    selectedTopicCount: 0,
    skippedTopicCount: 0,
    invalidTopicCount: 0,
    missingBriefCount: 0,
    weakEvidenceCount: 0,
    statusUpdateCount: 0,
    selectedTopicIds: [],
    episodeId: null,
    reasons: [],
  };

  const minScore = input.minDebateScore !== undefined ? Number(input.minDebateScore) : 70;
  const targetCount = input.targetTopicCount !== undefined ? Number(input.targetTopicCount) : 3;

  let chosenTopics: any[] = [];

  // 1. Resolve topics
  if (input.topicIds && input.topicIds.length > 0) {
    // Explicit selection
    for (const tId of input.topicIds) {
      const topic = await db.topicCandidate.findUnique({
        where: { id: tId },
        include: { researchBrief: true },
      });

      if (!topic) {
        result.invalidTopicCount++;
        const msg = `Topic candidate ${tId} not found in database.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      if (topic.status !== "approved") {
        result.invalidTopicCount++;
        const msg = `Topic candidate '${topic.title}' is not approved (status: ${topic.status}).`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      const evidenceIds = Array.isArray(topic.evidenceIds) ? topic.evidenceIds : [];
      if (evidenceIds.length === 0) {
        result.weakEvidenceCount++;
        const msg = `Topic candidate '${topic.title}' has empty evidenceIds.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      const brief = topic.researchBrief;
      if (!brief) {
        result.missingBriefCount++;
        const msg = `Topic candidate '${topic.title}' is missing its ResearchBrief.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      const facts = Array.isArray(brief.facts) ? brief.facts : [];
      if (facts.length === 0) {
        result.missingBriefCount++;
        const msg = `Topic candidate '${topic.title}' has empty facts in ResearchBrief.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
      if (sourceIds.length === 0) {
        result.weakEvidenceCount++;
        const msg = `Topic candidate '${topic.title}' has empty sourceIds in ResearchBrief.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) {
        result.missingBriefCount++;
        const msg = `Topic candidate '${topic.title}' has empty host arguments in ResearchBrief.`;
        result.reasons.push(msg);
        throw new Error(msg);
      }

      chosenTopics.push(topic);
    }
  } else {
    // Auto-select best topics — ranked by TALKABILITY (computed from the
    // actual research richness), blended with the LLM's debate score. "Most
    // recent" or "self-reported score" alone lets boring topics through.
    const rawCandidates = await db.topicCandidate.findMany({
      where: { status: "approved" },
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
    });

    const minTalkability = Number(process.env.TOPIC_MIN_TALKABILITY) || 35;
    const ranked = rawCandidates
      .map((t) => {
        const talkability = scoreTopicTalkability({
          title: t.title,
          summary: t.summary,
          createdAt: t.createdAt,
          brief: t.researchBrief as any,
        });
        // Blend: measured richness dominates, LLM's self-score tiebreaks.
        const rank = talkability.total * 0.6 + Math.min(100, t.debateScore) * 0.4;
        return { t, talkability, rank };
      })
      .sort((a, b) => b.rank - a.rank);

    const candidates: typeof rawCandidates = [];
    for (const r of ranked) {
      if (r.talkability.total < minTalkability) {
        result.skippedTopicCount++;
        result.reasons.push(
          `Skipped '${r.t.title}': talkability ${r.talkability.total}/100 below minimum ${minTalkability}.`
        );
        continue;
      }
      candidates.push(r.t);
    }

    for (const t of candidates) {
      // Filter by minDebateScore
      if (t.debateScore < minScore) {
        result.skippedTopicCount++;
        continue;
      }

      // Filter by leagueId if provided
      if (input.leagueId && t.leagueId?.toUpperCase() !== input.leagueId.toUpperCase()) {
        result.skippedTopicCount++;
        continue;
      }

      // Filter by sport if provided
      if (input.sport && t.sport.toLowerCase() !== input.sport.toLowerCase()) {
        result.skippedTopicCount++;
        continue;
      }

      // Check evidenceIds
      const evidenceIds = Array.isArray(t.evidenceIds) ? t.evidenceIds : [];
      if (evidenceIds.length === 0) {
        result.weakEvidenceCount++;
        continue;
      }

      // Check brief
      const brief = t.researchBrief;
      if (!brief) {
        result.missingBriefCount++;
        continue;
      }

      // Check facts
      const facts = Array.isArray(brief.facts) ? brief.facts : [];
      if (facts.length === 0) {
        result.missingBriefCount++;
        continue;
      }

      // Check sourceIds
      const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
      if (sourceIds.length === 0) {
        result.weakEvidenceCount++;
        continue;
      }

      // Check arguments
      if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) {
        result.missingBriefCount++;
        continue;
      }

      chosenTopics.push(t);
      if (chosenTopics.length >= targetCount) {
        break;
      }
    }
  }

  // Reject if fewer than 1 valid topic is available
  if (chosenTopics.length === 0) {
    const msg = "Fewer than 1 valid topic is available to build the episode.";
    result.reasons.push(msg);
    throw new Error(msg);
  }

  result.selectedTopicCount = chosenTopics.length;
  result.selectedTopicIds = chosenTopics.map((t) => t.id);

  // 2. Resolve title & description
  let title = input.title?.trim();
  if (!title) {
    const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    let tag = "Sports";
    if (input.leagueId) tag = input.leagueId.toUpperCase();
    else if (input.sport) tag = input.sport.charAt(0).toUpperCase() + input.sport.slice(1);
    title = `Take Machine — ${tag} Debate Briefing — ${dateStr}`;
  }

  const description = input.description?.trim() || "Draft episode assembled from approved Take Machine topics and research briefs.";

  // Generate unique slug
  let slug = slugify(title);
  const existing = await db.episode.findUnique({
    where: { slug },
  });

  if (existing) {
    // Append a unique suffix
    const suffix = crypto.randomBytes(3).toString("hex"); // e.g. "a1b2c3"
    slug = `${slug}-${suffix}`;
  }

  const rssGuid = crypto.randomUUID();

  // 3. Atomically perform creation inside a transaction
  const episode = await db.$transaction(async (tx) => {
    // Create Episode record
    const ep = await tx.episode.create({
      data: {
        title,
        slug,
        status: "draft",
        description,
        rssGuid,
        longShowNotes: null,
        durationSeconds: null,
        audioUrl: null,
        transcriptUrl: null,
        publishedAt: null,
      },
    });

    // Create EpisodeTopic join records preserving selection order
    for (let i = 0; i < chosenTopics.length; i++) {
      await tx.episodeTopic.create({
        data: {
          episodeId: ep.id,
          topicId: chosenTopics[i].id,
          orderIndex: i,
        },
      });
    }

    // Set topic candidates status to used
    for (const topic of chosenTopics) {
      await tx.topicCandidate.update({
        where: { id: topic.id },
        data: { status: "used" },
      });
    }

    return ep;
  });

  result.insertedEpisodeCount = 1;
  result.statusUpdateCount = chosenTopics.length;
  result.episodeId = episode.id;
  result.reasons.push(`Episode created successfully with ID ${episode.id}`);

  return result;
}
