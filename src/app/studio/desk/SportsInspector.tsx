import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { parseEvidenceRefList, refKey, type EvidenceReference } from "@/lib/services/evidenceRefs";
import { resolveTakeTeams } from "@/lib/services/takeTeamsService";
import { logoTeam } from "@/lib/data/sportsLogoIndex";
import "../shows/shows-intel.css";

/* ------------------------------------------------------------------ *
 * The evidence inspector for a sports take — the sports counterpart of
 * the inspector on the business side of the desk.
 *
 * Everything shown is read from rows the pipeline stored:
 *   · the take (TopicCandidate) and its ResearchBrief,
 *   · the records the brief cites (sourceIds), resolved to real rows.
 *     Only news items, injuries and imported articles carry a stored
 *     URL; games, odds and stats are internal records and say so,
 *   · team attribution from takeTeamsService.
 *
 * MEASURED versus ESTIMATED is kept apart, as on the business desk:
 * the heat score is a deterministic count over the stored text
 * (scoreTopicTalkability), so its parts are measured. The controversy /
 * star-power / debate numbers and every sentence of the brief were
 * written by a model, and are labelled that way.
 *
 * Takes are a shared pool by design, so this is not owner-scoped; it
 * shows only approved takes, like every production surface.
 * ------------------------------------------------------------------ */

interface Claim { text: string; refs: EvidenceReference[] }
interface Source { n: number; kind: string; label: string; detail: string; url: string | null; missing: boolean }

const TEAM_BEARING = new Set(["game", "injury", "oddsSnapshot", "teamStat", "playerStat"]);
const KIND: Record<string, string> = {
  newsItem: "News", injury: "Injury report", game: "Game", oddsSnapshot: "Odds", teamStat: "Team stat",
  playerStat: "Player stat", topicSource: "Imported article", research: "Transient research",
};
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const scalar = (v: unknown) => (typeof v === "number" || typeof v === "string" ? ` ${v}` : "");
const httpUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

function claims(value: unknown): Claim[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): Claim => {
      if (typeof item === "string") return { text: item, refs: [] };
      const o = (item ?? {}) as { text?: unknown; claim?: unknown; evidenceRefs?: unknown };
      return { text: String(o.text ?? o.claim ?? "").trim(), refs: parseEvidenceRefList(o.evidenceRefs).refs };
    })
    .filter((c) => c.text);
}

/** Resolve cited refs to real rows, in a fixed number of queries. */
async function resolveSources(refs: EvidenceReference[], topicId: string): Promise<Map<string, Source>> {
  const ids = (type: string) => refs.filter((r) => r.type === type).map((r) => r.id);
  const some = <T,>(list: string[], run: () => Promise<T[]>) => (list.length ? run().catch(() => [] as T[]) : Promise.resolve([] as T[]));
  const [news, injuries, games, odds, teamStats, playerStats, imported] = await Promise.all([
    some(ids("newsItem"), () => db.newsItem.findMany({ where: { id: { in: ids("newsItem") } }, select: { id: true, title: true, source: true, url: true, publishedAt: true } })),
    some(ids("injury"), () => db.injury.findMany({ where: { id: { in: ids("injury") } }, select: { id: true, status: true, description: true, reportedAt: true, sourceUrl: true, player: { select: { name: true } }, team: { select: { name: true } } } })),
    some(ids("game"), () => db.game.findMany({ where: { id: { in: ids("game") } }, select: { id: true, scheduledAt: true, status: true, homeScore: true, awayScore: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } })),
    some(ids("oddsSnapshot"), () => db.oddsSnapshot.findMany({ where: { id: { in: ids("oddsSnapshot") } }, select: { id: true, sportsbook: true, market: true, line: true, capturedAt: true, game: { select: { homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } } } })),
    some(ids("teamStat"), () => db.teamStat.findMany({ where: { id: { in: ids("teamStat") } }, select: { id: true, season: true, statType: true, value: true, team: { select: { name: true } } } })),
    some(ids("playerStat"), () => db.playerStat.findMany({ where: { id: { in: ids("playerStat") } }, select: { id: true, season: true, statType: true, value: true, player: { select: { name: true } } } })),
    // Imported articles must belong to THIS take.
    some(ids("topicSource"), () => db.topicSource.findMany({ where: { id: { in: ids("topicSource") }, topicId }, select: { id: true, title: true, publisher: true, canonicalUrl: true, publishedAt: true } })),
  ]);

  const found = new Map<string, Omit<Source, "n" | "kind" | "missing">>();
  for (const r of news) found.set(`newsItem:${r.id}`, { label: r.title, detail: [r.source, day(r.publishedAt)].filter(Boolean).join(" · "), url: httpUrl(r.url) });
  for (const r of injuries) found.set(`injury:${r.id}`, { label: `${r.player.name}${r.status ? `: ${r.status}` : ""}`, detail: [r.team?.name, r.description, day(r.reportedAt)].filter(Boolean).join(" · "), url: httpUrl(r.sourceUrl) });
  for (const r of games) found.set(`game:${r.id}`, { label: `${r.awayTeam.name} at ${r.homeTeam.name}`, detail: [day(r.scheduledAt), r.status, r.homeScore != null && r.awayScore != null ? `${r.awayScore}-${r.homeScore}` : ""].filter(Boolean).join(" · "), url: null });
  for (const r of odds) found.set(`oddsSnapshot:${r.id}`, { label: `${r.game.awayTeam.name} at ${r.game.homeTeam.name}: ${r.market}${r.line != null ? ` ${r.line}` : ""}`, detail: [r.sportsbook, day(r.capturedAt)].filter(Boolean).join(" · "), url: null });
  for (const r of teamStats) found.set(`teamStat:${r.id}`, { label: `${r.team.name}: ${r.statType}${scalar(r.value)}`, detail: r.season, url: null });
  for (const r of playerStats) found.set(`playerStat:${r.id}`, { label: `${r.player.name}: ${r.statType}${scalar(r.value)}`, detail: r.season, url: null });
  for (const r of imported) found.set(`topicSource:${r.id}`, { label: r.title || r.canonicalUrl, detail: [r.publisher, day(r.publishedAt)].filter(Boolean).join(" · "), url: httpUrl(r.canonicalUrl) });

  const out = new Map<string, Source>();
  refs.forEach((ref, i) => {
    const hit = found.get(refKey(ref));
    out.set(refKey(ref), {
      n: i + 1,
      kind: KIND[ref.type] ?? ref.type,
      label: hit?.label ?? "Record no longer available",
      detail: hit?.detail ?? "",
      url: hit?.url ?? null,
      missing: !hit,
    });
  });
  return out;
}

export default async function SportsInspector({ takeId, closeHref }: { takeId: string; closeHref: string }) {
  const take = await db.topicCandidate
    .findFirst({ where: { id: takeId, status: "approved" }, include: { researchBrief: true } })
    .catch(() => null);

  if (!take) {
    return (
      <div className="sportsInspectorWrap">
        <aside className="deskInspector" aria-label="Take evidence" data-testid="sports-inspector">
          <p className="deskProse">That take is not on the board any more. It may have been withdrawn.</p>
          <div><Link href={closeHref} className="btnGhost">Back to the board</Link></div>
        </aside>
      </div>
    );
  }

  const brief = take.researchBrief;
  const talk = scoreTopicTalkability({ title: take.title, summary: take.summary, createdAt: take.createdAt, brief: brief as never });
  const refs = parseEvidenceRefList(brief?.sourceIds).refs;
  const [sources, teamRefs] = await Promise.all([
    resolveSources(refs, take.id),
    resolveTakeTeams([take]).catch(() => new Map<string, { leagueId: string; teamSlug: string }[]>()),
  ]);
  const sourceList = [...sources.values()];
  const teams = (teamRefs.get(take.id) ?? []).map((r) => logoTeam(r.leagueId, r.teamSlug)?.name).filter((n): n is string => !!n);
  // Same rule takeTeamsService applies: evidence first, text only as fallback.
  const byEvidence = parseEvidenceRefList(take.evidenceIds).refs.some((r) => TEAM_BEARING.has(r.type));

  const facts = claims(brief?.keyFactsContext ?? brief?.facts);
  const points = claims(brief?.onAirTalkingPoints ?? brief?.stats);
  const counters = claims(brief?.counterArguments);
  const rejected = (Array.isArray(brief?.unsafeClaims) ? (brief!.unsafeClaims as { claim?: unknown; reason?: unknown }[]) : [])
    .map((u) => ({ claim: String(u?.claim ?? "").trim(), reason: String(u?.reason ?? "").trim() }))
    .filter((u) => u.claim);
  const whyNow = brief?.whyMattersNow?.trim() || take.summary?.trim() || null;
  const ageHours = Math.max(0, Math.round((Date.now() - take.createdAt.getTime()) / 3600000));

  const axes = Object.entries(talk.axes) as [string, { score: number; max: number; detail: string }][];
  const linked = sourceList.filter((s) => s.url).length;
  const gone = sourceList.filter((s) => s.missing).length;

  // Weaknesses are stated from what is and is not stored, never softened.
  const weak: { label: string; text: string }[] = [];
  if (!brief) weak.push({ label: "No research brief", text: "This take has not been researched, so there is no evidence to inspect yet." });
  if (brief && sourceList.length === 0) weak.push({ label: "No cited records", text: "The brief cites no stored evidence." });
  if (sourceList.length > 0 && linked === 0) weak.push({ label: "No linked article", text: "Its evidence is internal game, odds or stat records only. Nothing here can be opened and read." });
  if (gone > 0) weak.push({ label: "Missing records", text: `${gone} cited record${gone === 1 ? " is" : "s are"} no longer in the database.` });
  if (brief && counters.length === 0) weak.push({ label: "No counter-argument", text: "The brief holds no grounded counter-argument, so the debate may be one-sided." });
  if (teams.length === 0) weak.push({ label: "No team", text: "Neither the evidence nor the title places this take on a team." });
  for (const [name, a] of axes) if (a.score < a.max / 2) weak.push({ label: `Weak ${name}`, text: `${a.score} of ${a.max}: ${a.detail}.` });
  for (const u of rejected) weak.push({ label: "Claim rejected in research", text: `${u.claim}${u.reason ? ` (${u.reason})` : ""}` });

  const cite = (c: Claim) =>
    c.refs.map((r) => sources.get(refKey(r))).filter((s): s is Source => !!s).map((s) => (
      <React.Fragment key={s.n}>{" "}{s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">[{s.n}]</a> : <span>[{s.n}]</span>}</React.Fragment>
    ));
  const claimList = (items: Claim[]) => (
    <ul className="deskWeak">{items.map((c, i) => <li key={i}><span className="deskClaimText">{c.text}{cite(c)}</span></li>)}</ul>
  );

  return (
    <div className="sportsInspectorWrap">
      <aside className="deskInspector" aria-label="Take evidence" data-testid="sports-inspector" data-take={take.id}>
        <header className="bizStackTight">
          <div className="sportsInspectorHead">
            <div className="deskRowMeta">
              <span className="chip">{take.sport}</span>
              {teams.map((t) => <span key={t} className="chip">{t}</span>)}
              <span>{ageHours < 1 ? "under an hour old" : ageHours < 48 ? `${ageHours}h old` : `${Math.round(ageHours / 24)}d old`}</span>
            </div>
            <Link href={closeHref} className="btnSubtle btnSm">Close</Link>
          </div>
          <h2 className="deskInspectorTitle">{take.title}</h2>
          {brief?.strongestDebateQuestion?.trim() && <p className="deskQuestion">{brief.strongestDebateQuestion}</p>}
        </header>

        {whyNow && (
          <section className="deskBlock">
            <h3 className="deskBlockTitle">Why now <span className="bizNote">(written by the research model)</span></h3>
            <p className="deskProse">{whyNow}</p>
          </section>
        )}

        <section className="deskBlock">
          <div className="deskSignals">
            <div className="deskSignalGroup">
              <h3 className="deskBlockTitle">Measured: heat {talk.total} of 100</h3>
              <p className="bizNote">Counted from the stored brief text. No model judgement.</p>
              <dl className="deskFacts">
                {axes.map(([name, a]) => (
                  <div key={name} title={a.detail}><dt>{name[0].toUpperCase() + name.slice(1)} <span className="bizNote">{a.detail}</span></dt><dd>{a.score} / {a.max}</dd></div>
                ))}
                <div><dt>Cited records</dt><dd>{sourceList.length}</dd></div>
                <div><dt>With a link you can open</dt><dd>{linked}</dd></div>
              </dl>
            </div>
            <div className="deskSignalGroup">
              <h3 className="deskBlockTitle">Estimated by the topic model</h3>
              <p className="bizNote">Scores the model gave when it proposed the take. Its opinion, not a measurement.</p>
              <dl className="deskFacts">
                <div><dt>Debate</dt><dd>{Math.round(take.debateScore)}</dd></div>
                <div><dt>Controversy</dt><dd>{Math.round(take.controversyScore)}</dd></div>
                <div><dt>Star power</dt><dd>{Math.round(take.starPowerScore)}</dd></div>
                <div><dt>Recency</dt><dd>{Math.round(take.recencyScore)}</dd></div>
                <div><dt>Betting relevance</dt><dd>{Math.round(take.bettingRelevanceScore)}</dd></div>
                {take.editorialScore > 0 && <div><dt>Editorial</dt><dd>{Math.round(take.editorialScore)}</dd></div>}
              </dl>
            </div>
          </div>
        </section>

        <section className="deskBlock">
          <h3 className="deskBlockTitle">Teams</h3>
          <p className="deskProse">
            {teams.length === 0
              ? "Not attributed to a team."
              : <><strong>{teams.join(", ")}</strong>. {byEvidence ? "From the take's own evidence records (games, injuries, stats or odds that name the team)." : "Matched from team names in the title and summary, within the take's league. No evidence record names a team."}</>}
          </p>
        </section>

        {(facts.length > 0 || points.length > 0) && (
          <section className="deskBlock">
            <h3 className="deskBlockTitle">Facts and stats in the brief</h3>
            <p className="bizNote">Worded by the research model; each one had to cite a stored record to be kept. Numbers in brackets point to the sources below.</p>
            {claimList([...facts, ...points])}
          </section>
        )}

        {brief && (brief.injuryContext?.trim() || brief.oddsContext?.trim()) && (
          <section className="deskBlock">
            <h3 className="deskBlockTitle">Context</h3>
            {brief.injuryContext?.trim() && <p className="deskProse"><strong>Injuries:</strong> {brief.injuryContext}</p>}
            {brief.oddsContext?.trim() && <p className="deskProse"><strong>Odds:</strong> {brief.oddsContext}</p>}
          </section>
        )}

        {brief && (
          <section className="deskBlock">
            <h3 className="deskBlockTitle">The argument <span className="bizNote">(written by the research model)</span></h3>
            {brief.mainAngle?.trim() && <p className="deskProse"><strong>Angle:</strong> {brief.mainAngle}</p>}
            <p className="deskProse"><strong>One side:</strong> {brief.argumentForHostA}</p>
            <p className="deskProse"><strong>The other:</strong> {brief.argumentForHostB}</p>
            {brief.contrarianAngle?.trim() && <p className="deskProse"><strong>Contrarian:</strong> {brief.contrarianAngle}</p>}
            {counters.length > 0 && claimList(counters)}
          </section>
        )}

        <section className="deskBlock">
          <h3 className="deskBlockTitle">Sources ({sourceList.length})</h3>
          {sourceList.length === 0 ? (
            <p className="deskProse">No stored records are cited.</p>
          ) : (
            <ol className="deskClaims">
              {sourceList.map((s) => (
                <li key={s.n} className="deskClaim">
                  <span className="chip">{s.n} · {s.kind}</span>
                  <span className="deskClaimText">
                    {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.label}</a> : s.label}
                    {s.detail && <span className="bizNote"> {s.detail}</span>}
                    {!s.url && !s.missing && <span className="bizNote"> · internal record, no link</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {weak.length > 0 && (
          <section className="deskBlock">
            <h3 className="deskBlockTitle">Weaknesses and missing evidence</h3>
            <ul className="deskWeak">{weak.map((w, i) => <li key={i}><strong>{w.label}.</strong> {w.text}</li>)}</ul>
          </section>
        )}

        <div className="deskDecide">
          <Link href={`/studio/create?topic=${take.id}`} className="btnPrimary">Generate Episode</Link>
          <Link href={`/studio/shows/new?topic=${take.id}`} className="btnGhost">Build a show around this</Link>
        </div>
      </aside>
    </div>
  );
}
