// Transcript view-model: surfaces the EXISTING script + fact-check + evidence
// data as an editable transcript with real citations and a publish gate.
//
// Nothing here fabricates a citation or a status. Citations are resolved from
// the actual records a line's evidenceRefs point at (NewsItem, Injury, Game,
// OddsSnapshot, TeamStat, PlayerStat); `research` refs are web-research notes
// that have no DB row, so they surface as a labelled chip with no link.
// Per-line fact status is derived from the latest FactCheckResult's issues
// (errors / warnings / semanticLineResults) plus the line's own flags.

import { db } from "@/lib/db";

export type FactStatus = "verified" | "unverified" | "failed";

export interface Citation {
  key: string; // `${type}:${id}`
  type: string;
  name: string;
  url: string | null;
}

export interface TranscriptLineVM {
  lineIndex: number;
  speaker: string;
  speakerHostId: string | null;
  text: string;
  tone: string | null;
  isFactual: boolean;
  dirty: boolean; // edited/variant-requested since the last fact check
  requestedTone: string | null;
  citations: Citation[];
  factStatus: FactStatus | null; // null for non-factual lines
  factReason: string | null;
}

export interface TranscriptSegmentVM {
  title: string;
  type: string;
  lines: TranscriptLineVM[];
}

export interface ClaimVM {
  lineIndex: number;
  text: string;
  status: FactStatus;
  reason: string | null;
  citationCount: number;
}

export interface TranscriptVM {
  ok: boolean;
  error?: string;
  scriptId: string | null;
  scriptStatus: string | null;
  episodeStatus: string | null;
  episodeTitle: string;
  hostA: { id: string | null; name: string };
  hostB: { id: string | null; name: string };
  segments: TranscriptSegmentVM[];
  claims: ClaimVM[];
  factCheck: {
    present: boolean;
    status: string | null; // "passed" | "failed" | "needs_review"
    checkedAt: string | null;
    coveragePercent: number | null;
  };
  gate: {
    canPublish: boolean;
    unresolvedCount: number;
    dirtyCount: number;
    reasons: string[];
  };
}

/** Resolve a batch of evidence refs to real source name + (optional) link. */
async function resolveCitations(refs: { type: string; id: string }[]): Promise<Map<string, Citation>> {
  const map = new Map<string, Citation>();
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r || !r.type || !r.id) continue;
    if (!byType.has(r.type)) byType.set(r.type, new Set());
    byType.get(r.type)!.add(r.id);
  }
  const idsOf = (t: string) => [...(byType.get(t) ?? [])];
  const put = (type: string, id: string, name: string, url: string | null) =>
    map.set(`${type}:${id}`, { key: `${type}:${id}`, type, name, url });

  await Promise.all([
    // NewsItem — the one evidence type that always carries a real URL.
    idsOf("newsItem").length
      ? db.newsItem
          .findMany({ where: { id: { in: idsOf("newsItem") } }, select: { id: true, source: true, title: true, url: true } })
          .then((rows) => rows.forEach((n) => put("newsItem", n.id, n.source || n.title || "News", n.url || null)))
      : null,
    // Injury — player name + status; sourceUrl is present on some records only.
    idsOf("injury").length
      ? db.injury
          .findMany({
            where: { id: { in: idsOf("injury") } },
            select: { id: true, status: true, description: true, sourceUrl: true, player: { select: { name: true } } },
          })
          .then((rows) =>
            rows.forEach((i) =>
              put("injury", i.id, `${i.player?.name ?? "Player"}${i.status ? ` — ${i.status}` : ""}`, i.sourceUrl || null)
            )
          )
      : null,
    // Game — teams + date; the game itself has no external URL.
    idsOf("game").length
      ? db.game
          .findMany({
            where: { id: { in: idsOf("game") } },
            select: { id: true, scheduledAt: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
          })
          .then((rows) =>
            rows.forEach((g) => put("game", g.id, `${g.awayTeam?.name ?? "Away"} @ ${g.homeTeam?.name ?? "Home"}`, null))
          )
      : null,
    // OddsSnapshot — sportsbook + market; no external URL.
    idsOf("oddsSnapshot").length
      ? db.oddsSnapshot
          .findMany({ where: { id: { in: idsOf("oddsSnapshot") } }, select: { id: true, sportsbook: true, market: true, line: true } })
          .then((rows) =>
            rows.forEach((o) =>
              put("oddsSnapshot", o.id, `${o.sportsbook}${o.market ? ` · ${o.market}` : ""}${o.line != null ? ` ${o.line}` : ""}`, null)
            )
          )
      : null,
    idsOf("teamStat").length
      ? db.teamStat
          .findMany({ where: { id: { in: idsOf("teamStat") } }, select: { id: true, statType: true, team: { select: { name: true } } } })
          .then((rows) => rows.forEach((t) => put("teamStat", t.id, `${t.team?.name ?? "Team"} · ${t.statType}`, null)))
      : null,
    idsOf("playerStat").length
      ? db.playerStat
          .findMany({ where: { id: { in: idsOf("playerStat") } }, select: { id: true, statType: true, player: { select: { name: true } } } })
          .then((rows) => rows.forEach((p) => put("playerStat", p.id, `${p.player?.name ?? "Player"} · ${p.statType}`, null)))
      : null,
  ]);

  // `research` refs are web-research notes with no DB row and no stored URL —
  // surface them honestly as a labelled chip, never a fake link.
  for (const id of idsOf("research")) put("research", id, "Web research", null);

  // Any ref that didn't resolve (stale id) still gets a neutral chip so the
  // line's evidence isn't silently dropped.
  for (const r of refs) {
    const key = `${r.type}:${r.id}`;
    if (!map.has(key)) map.set(key, { key, type: r.type, name: r.type, url: null });
  }
  return map;
}

const asRefs = (v: any): { type: string; id: string }[] =>
  Array.isArray(v) ? v.filter((r) => r && r.type && r.id).map((r) => ({ type: String(r.type), id: String(r.id) })) : [];

/** Build the full transcript + fact-check + gate view-model for an episode. */
export async function getEpisodeTranscriptVM(episodeId: string): Promise<TranscriptVM> {
  const empty = (error?: string): TranscriptVM => ({
    ok: !error,
    error,
    scriptId: null,
    scriptStatus: null,
    episodeStatus: null,
    episodeTitle: "",
    hostA: { id: null, name: "Host 1" },
    hostB: { id: null, name: "Host 2" },
    segments: [],
    claims: [],
    factCheck: { present: false, status: null, checkedAt: null, coveragePercent: null },
    gate: { canPublish: false, unresolvedCount: 0, dirtyCount: 0, reasons: error ? [error] : [] },
  });

  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: {
      id: true,
      title: true,
      status: true,
      hostIds: true,
      scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, status: true, content: true } },
    },
  });
  if (!episode) return empty("Episode not found.");
  const script = episode.scripts[0] ?? null;

  // Resolve the two cast hosts (for colour coding) from the episode's real cast;
  // neutral placeholders only if no active hosts exist at all.
  const hostRows = episode.hostIds?.length
    ? await db.aiHost.findMany({ where: { id: { in: episode.hostIds } }, select: { id: true, name: true, intensityLevel: true } })
    : await db.aiHost.findMany({ where: { isActive: true, isArchived: false }, orderBy: { intensityLevel: "desc" }, take: 2, select: { id: true, name: true, intensityLevel: true } });
  const sorted = [...hostRows].sort((a, b) => b.intensityLevel - a.intensityLevel);
  const hostA = sorted[0] ? { id: sorted[0].id, name: sorted[0].name } : { id: null, name: "Host 1" };
  const hostB = sorted[1] ? { id: sorted[1].id, name: sorted[1].name } : { id: null, name: "Host 2" };

  const base = empty();
  base.scriptId = script?.id ?? null;
  base.scriptStatus = script?.status ?? null;
  base.episodeStatus = episode.status;
  base.episodeTitle = episode.title;
  base.hostA = hostA;
  base.hostB = hostB;
  if (!script) {
    base.gate.reasons = ["No script yet."];
    return base;
  }

  const content = (script.content as any) || {};
  const rawSegments: any[] = Array.isArray(content.segments) ? content.segments : [];

  // Latest fact check → per-line status maps.
  const fc = await db.factCheckResult.findFirst({ where: { scriptId: script.id }, orderBy: { checkedAt: "desc" } });
  const issues = (fc?.issues as any) || {};
  const errorLines = new Map<number, string>();
  for (const e of Array.isArray(issues.errors) ? issues.errors : []) {
    if (typeof e?.lineIndex === "number") errorLines.set(e.lineIndex, e.reason || "flagged");
  }
  const warnLines = new Map<number, string>();
  for (const w of Array.isArray(issues.warnings) ? issues.warnings : []) {
    if (typeof w?.lineIndex === "number") warnLines.set(w.lineIndex, w.reason || "needs review");
  }
  const semanticLines = new Map<number, { status: string; reason: string }>();
  for (const s of Array.isArray(issues.semanticLineResults) ? issues.semanticLineResults : []) {
    if (typeof s?.lineIndex === "number") semanticLines.set(s.lineIndex, { status: String(s.status || ""), reason: String(s.reason || "") });
  }

  // Collect every evidence ref up front and resolve in one batch.
  const allRefs: { type: string; id: string }[] = [];
  for (const seg of rawSegments) for (const ln of seg?.lines || []) allRefs.push(...asRefs(ln?.evidenceRefs));
  const citationMap = await resolveCitations(allRefs);

  const segments: TranscriptSegmentVM[] = [];
  const claims: ClaimVM[] = [];
  let dirtyCount = 0;

  for (const seg of rawSegments) {
    const lines: TranscriptLineVM[] = [];
    for (const ln of seg?.lines || []) {
      const idx = typeof ln?.lineIndex === "number" ? ln.lineIndex : lines.length;
      const refs = asRefs(ln?.evidenceRefs);
      const citations = refs.map((r) => citationMap.get(`${r.type}:${r.id}`)!).filter(Boolean);
      const isFactual = ln?.isFactualClaim === true;
      const dirty = ln?.dirty === true;
      if (dirty) dirtyCount++;

      let factStatus: FactStatus | null = null;
      let factReason: string | null = null;
      if (isFactual) {
        const sem = semanticLines.get(idx);
        if (errorLines.has(idx) || sem?.status === "unsupported") {
          factStatus = "failed";
          factReason = errorLines.get(idx) || sem?.reason || "Unsupported claim.";
        } else if (dirty) {
          factStatus = "unverified";
          factReason = "Edited since the last fact check — re-check before publishing.";
        } else if (warnLines.has(idx) || sem?.status === "needs_review" || ln?.needsHumanReview === true) {
          factStatus = "unverified";
          factReason = warnLines.get(idx) || sem?.reason || "Flagged for human review.";
        } else if (citations.length === 0) {
          factStatus = "unverified";
          factReason = "No evidence attached to this claim.";
        } else if (!fc) {
          factStatus = "unverified";
          factReason = "Not fact-checked yet.";
        } else {
          factStatus = "verified";
        }
        claims.push({ lineIndex: idx, text: String(ln?.text || ""), status: factStatus, reason: factReason, citationCount: citations.length });
      }

      lines.push({
        lineIndex: idx,
        speaker: String(ln?.speakerName || ""),
        speakerHostId: ln?.speakerHostId ?? null,
        text: String(ln?.text || ""),
        tone: ln?.tone ?? null,
        isFactual,
        dirty,
        requestedTone: ln?.requestedTone ?? null,
        citations,
        factStatus,
        factReason,
      });
    }
    segments.push({ title: String(seg?.title || seg?.type || "Segment"), type: String(seg?.type || "segment"), lines });
  }

  const coverage = (fc?.evidenceCoverage as any)?.evidenceCoveragePercent;
  base.segments = segments;
  base.claims = claims;
  base.factCheck = {
    present: !!fc,
    status: fc?.status ?? null,
    checkedAt: fc ? new Date(fc.checkedAt).toISOString() : null,
    coveragePercent: typeof coverage === "number" ? coverage : null,
  };

  const unresolvedCount = claims.filter((c) => c.status !== "verified").length;
  const reasons: string[] = [];
  if (!fc) reasons.push("Not fact-checked yet.");
  else if (fc.status !== "passed") reasons.push(`Fact check status is "${fc.status}".`);
  if (unresolvedCount > 0) reasons.push(`${unresolvedCount} unresolved claim${unresolvedCount === 1 ? "" : "s"}.`);
  if (dirtyCount > 0) reasons.push(`${dirtyCount} edited line${dirtyCount === 1 ? "" : "s"} pending re-check.`);
  base.gate = {
    canPublish: !!fc && fc.status === "passed" && unresolvedCount === 0 && dirtyCount === 0,
    unresolvedCount,
    dirtyCount,
    reasons,
  };

  return base;
}
