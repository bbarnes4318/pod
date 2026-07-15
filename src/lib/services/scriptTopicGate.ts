// Snapshot-first pre-generation topic validation + content (talkability) gate.
//
// Extracted so it can be unit/integration-tested WITHOUT the LLM-heavy
// scriptService. EVERY decision here reads the immutable snapshot when present
// (content AND the selection-time talkability report), so a later edit of the
// live TopicCandidate/ResearchBrief cannot change or break an already-created
// episode's gate result. Legacy rows (no snapshot) fall back to live data.

import { scoreTopicTalkability, TalkabilityReport, TalkabilityAxis } from "./talkabilityService";
import { resolveEpisodeTopicContent, briefLikeFromContent } from "./topicSnapshot";

/** A talkability report as the gate consumes it: always a total, and the full
 *  axis breakdown when computed live (snapshot reports carry only `total`). */
type GateTalkReport = { total: number; axes?: TalkabilityReport["axes"] };

/** One EpisodeTopic as accepted by the resolver — snapshot + optional live topic. */
type EpisodeTopicLike = Parameters<typeof resolveEpisodeTopicContent>[0];

export interface TopicGateOptions {
  /** "block" (default) | "warn". */
  gateMode?: string;
  /** Minimum average talkability to pass (default 50). */
  gateMin?: number;
}

export interface TopicGateResult {
  ok: boolean;
  /** Set when a topic fails hard validation (facts/sources/args). */
  blockingError?: string;
  /** Set when the content gate blocks on weak material (gateMode=block). */
  gateBlocked: boolean;
  gateMessage?: string;
  avgTalkability: number;
  talkabilityReports: { title: string; report: GateTalkReport }[];
  reasons: string[];
  /** True when EVERY topic's content came from a valid snapshot. */
  allFromSnapshot: boolean;
}

/**
 * Validate + gate an episode's topics for script generation. Pure and
 * synchronous — the caller applies throws for `blockingError` / `gateBlocked`.
 */
export function evaluateEpisodeTopicsForScript(
  episodeTopics: Array<EpisodeTopicLike>,
  opts: TopicGateOptions = {}
): TopicGateResult {
  const gateMode = (opts.gateMode ?? process.env.CONTENT_GATE_MODE ?? "block").toLowerCase();
  const gateMin = opts.gateMin ?? (Number(process.env.CONTENT_GATE_MIN) || 50);

  const reasons: string[] = [];
  const talkabilityReports: { title: string; report: GateTalkReport }[] = [];
  let allFromSnapshot = true;

  for (const et of episodeTopics) {
    const content = resolveEpisodeTopicContent(et);
    if (!content.fromSnapshot) allFromSnapshot = false;
    if (content.snapshotStatus === "corrupt" || content.snapshotStatus === "unsupported_version") {
      reasons.push(`Topic '${content.title}': snapshot ${content.snapshotStatus} — fell back to live content.`);
    }

    // Hard validation.
    const facts = Array.isArray(content.facts) ? content.facts : [];
    const sourceIds = Array.isArray(content.sourceIds) ? content.sourceIds : [];
    if (facts.length === 0 || sourceIds.length === 0) {
      return { ok: false, blockingError: `Topic '${content.title}' has empty facts or sourceIds.`, gateBlocked: false, avgTalkability: 0, talkabilityReports, reasons, allFromSnapshot };
    }
    if (!content.argumentForHostA?.trim() || !content.argumentForHostB?.trim()) {
      return { ok: false, blockingError: `Topic '${content.title}' is missing host arguments.`, gateBlocked: false, avgTalkability: 0, talkabilityReports, reasons, allFromSnapshot };
    }

    // Talkability: use the FROZEN selection-time report when the snapshot has
    // one; otherwise compute from resolved content + the snapshot's creation
    // timestamp (never the live topic).
    let report: GateTalkReport | null | undefined = content.talkability;
    if (!report || typeof report.total !== "number") {
      report = scoreTopicTalkability({
        title: content.title,
        summary: content.summary,
        createdAt: content.topicCreatedAt ? new Date(content.topicCreatedAt) : new Date(),
        brief: briefLikeFromContent(content),
      });
    }
    talkabilityReports.push({ title: content.title, report });
  }

  const avgTalkability =
    talkabilityReports.reduce((a, r) => a + r.report.total, 0) / Math.max(1, talkabilityReports.length);

  for (const tr of talkabilityReports) {
    const axes = tr.report.axes
      ? Object.entries(tr.report.axes).map(([k, v]: [string, TalkabilityAxis]) => `${k} ${v.score}/${v.max}`).join(", ")
      : "";
    reasons.push(`Talkability '${tr.title}': ${tr.report.total}/100${axes ? ` (${axes})` : ""}`);
  }

  let gateBlocked = false;
  let gateMessage: string | undefined;
  if (avgTalkability < gateMin) {
    const weakest = [...talkabilityReports].sort((a, b) => a.report.total - b.report.total)[0];
    gateMessage = `Content gate: source material scores ${Math.round(avgTalkability)}/100 talkability (minimum ${gateMin}). Weakest topic: '${weakest?.title}' at ${weakest?.report.total}. Enrich the research brief or pick stronger topics.`;
    reasons.push(gateMessage);
    if (gateMode !== "warn") gateBlocked = true;
  }

  return { ok: true, gateBlocked, gateMessage, avgTalkability, talkabilityReports, reasons, allFromSnapshot };
}
