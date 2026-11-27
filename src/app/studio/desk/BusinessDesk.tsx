import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { ownerScope, type ScopeViewer } from "@/lib/ownerScope";
import { OpportunityActions } from "../shows/[id]/BusinessResearchClient";
import { Icon } from "../StudioIcons";
import { showHue, showInitials } from "../lib";

/* ------------------------------------------------------------------ *
 * The business side of the Editorial desk.
 *
 * Research used to live inside each show, behind six tabs, so "what is
 * the best thing I could make next?" had no single answer. This is that
 * answer: every topic the research engine has proposed across the
 * viewer's business shows, ranked, with the evidence one click away and
 * the real decision buttons beside it.
 *
 * The flow is the pipeline itself — Discover → Investigate → Approve →
 * Produce — and each topic sits at the stage its own row says it is at.
 *
 * MEASURED versus ESTIMATED is kept visibly apart, because they are
 * different kinds of fact: a count of cited sources is a count; an
 * opportunity score is the model's judgement. Nothing here is computed
 * for display that the research engine did not store.
 * ------------------------------------------------------------------ */

type Stage = "discover" | "investigate" | "approve" | "produce";

const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: "discover", label: "Discover", hint: "Proposed, not yet researched" },
  { key: "investigate", label: "Investigate", hint: "Dossier in progress or held" },
  { key: "approve", label: "Approve", hint: "Researched, waiting on your call" },
  { key: "produce", label: "Produce", hint: "Approved, ready to make" },
];

interface KeyClaim { claim: string; verdict: string; url?: string; authority?: string }
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const words = (s: string) => s.toLowerCase().replace(/_/g, " ");

const VERDICT: Record<string, { label: string; tone: string }> = {
  SOURCE_SUPPORTED: { label: "Supported by a source", tone: "ok" },
  SOURCE_CONTRADICTED: { label: "Contradicted by a source", tone: "err" },
  UNVERIFIED: { label: "Not yet verified", tone: "warn" },
};

function stageOf(o: { editorialStatus: string; dossier: { status: string } | null }): Stage {
  if (o.editorialStatus === "APPROVED") return "produce";
  if (o.editorialStatus === "HELD") return "investigate";
  if (!o.dossier) return "discover";
  if (o.dossier.status === "READY") return "approve";
  return "investigate";
}

export default async function BusinessDesk({
  viewer,
  stage: rawStage,
  topicId,
  showId,
}: {
  viewer: ScopeViewer | null;
  stage?: string;
  topicId?: string;
  showId?: string;
}) {
  const shows = await db.podcast.findMany({
    where: { ...ownerScope(viewer), intelligenceType: "BUSINESS" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true },
  });

  if (shows.length === 0) {
    return (
      <div className="emptyState">
        <span className="emptyStateIcon">{Icon.desk}</span>
        <div className="emptyStateTitle">No business show to research yet</div>
        <p className="emptyStateBody">
          A business show researches its own industry: the company, its market, what insiders know and what listeners are asking. Set one up and its topics appear here, ranked.
        </p>
        <Link href="/studio/shows/new/business" className="btnPrimary">Set up a business show</Link>
      </div>
    );
  }

  const scopedShow = shows.find((s) => s.id === showId) ?? null;
  const all = await db.businessTopicOpportunity.findMany({
    where: {
      podcastId: scopedShow ? scopedShow.id : { in: shows.map((s) => s.id) },
      editorialStatus: { in: ["CANDIDATE", "HELD", "APPROVED"] },
    },
    include: { dossier: { select: { status: true, verifiedClaimCount: true, unsupportedClaimCount: true } } },
    orderBy: [{ opportunityScore: "desc" }],
    take: 120,
  });
  const showName = new Map(shows.map((s) => [s.id, s.name]));

  const counts: Record<Stage, number> = { discover: 0, investigate: 0, approve: 0, produce: 0 };
  for (const o of all) counts[stageOf(o)] += 1;
  const stage = STAGES.some((s) => s.key === rawStage) ? (rawStage as Stage) : null;
  const rows = stage ? all.filter((o) => stageOf(o) === stage) : all;
  const selected = rows.find((o) => o.id === topicId) ?? rows[0] ?? null;

  const href = (over: { stage?: Stage | null; topic?: string; show?: string | null }) => {
    const q = new URLSearchParams({ desk: "business" });
    const st = over.stage === undefined ? stage : over.stage;
    const sh = over.show === undefined ? scopedShow?.id : over.show;
    if (st) q.set("stage", st);
    if (sh) q.set("show", sh);
    if (over.topic) q.set("topic", over.topic);
    return `/studio/desk?${q.toString()}`;
  };

  // Is research still running for the selected topic? Drives the button state.
  const run = selected
    ? await db.businessResearchRun.findFirst({
        where: { podcastId: selected.podcastId, kind: "dossier", opportunityId: selected.id },
        orderBy: { createdAt: "desc" },
        select: { status: true, error: true, progress: true },
      })
    : null;

  return (
    <div className="deskBiz">
      {/* The pipeline is the filter. Each step says how many topics sit at it. */}
      <nav className="deskFlow" aria-label="Research pipeline">
        <Link href={href({ stage: null })} className="deskFlowStep" aria-current={stage === null ? "page" : undefined}>
          <span className="deskFlowCount">{all.length}</span>
          <span className="deskFlowLabel">All open topics</span>
        </Link>
        {STAGES.map((s) => (
          <Link key={s.key} href={href({ stage: s.key })} className="deskFlowStep" aria-current={stage === s.key ? "page" : undefined} title={s.hint}>
            <span className="deskFlowCount">{counts[s.key]}</span>
            <span className="deskFlowLabel">{s.label}</span>
          </Link>
        ))}
      </nav>

      {shows.length > 1 && (
        <nav className="deskShowFilter" aria-label="Filter by show">
          <Link href={href({ show: null })} className="chip" aria-current={!scopedShow ? "page" : undefined}>Every show</Link>
          {shows.map((s) => (
            <Link key={s.id} href={href({ show: s.id })} className="chip" aria-current={scopedShow?.id === s.id ? "page" : undefined}>{s.name}</Link>
          ))}
        </nav>
      )}

      {all.length === 0 ? (
        <div className="emptyState">
          <div className="emptyStateTitle">No open topics</div>
          <p className="emptyStateBody">Run industry research from a show and the topics it finds are ranked here.</p>
          <Link href={`/studio/shows/${(scopedShow ?? shows[0]).id}?tab=radar`} className="btnPrimary">Research {(scopedShow ?? shows[0]).name}</Link>
        </div>
      ) : rows.length === 0 || !selected ? (
        <div className="emptyState">
          <div className="emptyStateTitle">Nothing at this stage</div>
          <p className="emptyStateBody">No topic is waiting here right now.</p>
          <Link href={href({ stage: null })} className="btnGhost">See all open topics</Link>
        </div>
      ) : (
        <div className="deskSplit">
          <ol className="deskList" aria-label="Topics, ranked by the research engine">
            {rows.map((o, i) => {
              const st = STAGES.find((s) => s.key === stageOf(o))!;
              const current = o.id === selected.id;
              return (
                <li key={o.id}>
                  <Link href={href({ topic: o.id })} className="deskRow" aria-current={current ? "true" : undefined} scroll={false}>
                    <span className="deskRank">{i + 1}</span>
                    <span className="deskRowBody">
                      <span className="deskRowTitle">{o.title}</span>
                      <span className="deskRowMeta">
                        <span className="showArt showArt--xs" data-hue={showHue(o.podcastId)} aria-hidden="true">{showInitials(showName.get(o.podcastId) ?? "?")}</span>
                        <span>{showName.get(o.podcastId)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{words(o.category)}</span>
                      </span>
                    </span>
                    <span className="deskRowStage" data-stage={st.key}>{st.label}</span>
                  </Link>
                </li>
              );
            })}
          </ol>

          <aside className="deskInspector" aria-label="Evidence for the selected topic">
            <div className="overline">{showName.get(selected.podcastId)} · {words(selected.category)}</div>
            <h2 className="deskInspectorTitle">{selected.title}</h2>
            <p className="deskQuestion">{selected.coreQuestion}</p>

            <section className="deskBlock">
              <h3 className="deskBlockTitle">Why this topic</h3>
              <p className="deskProse"><strong>For {selected.targetListener}.</strong> {selected.whyItMatters}</p>
              {selected.whyNow && <p className="deskProse"><strong>Why now.</strong> {selected.whyNow}</p>}
              {selected.undercoveredInformation && <p className="deskProse"><strong>What others miss.</strong> {selected.undercoveredInformation}</p>}
              {selected.potentialOriginalAnalysis && <p className="deskProse"><strong>An angle to try (not yet done).</strong> {selected.potentialOriginalAnalysis}</p>}
            </section>

            <section className="deskBlock">
              <h3 className="deskBlockTitle">Signals</h3>
              <div className="deskSignals">
                <div className="deskSignalGroup">
                  <div className="overline">Measured</div>
                  <dl className="deskFacts">
                    <div><dt>Sources cited</dt><dd>{selected.citedSourceIds.length}</dd></div>
                    <div>
                      <dt>Listener demand</dt>
                      <dd>{selected.demandStrength === "UNMEASURED" ? "Not measured" : words(selected.demandStrength)}</dd>
                    </div>
                    <div>
                      <dt>Claims verified</dt>
                      <dd>{selected.dossier ? `${selected.dossier.verifiedClaimCount} verified, ${selected.dossier.unsupportedClaimCount} unsupported` : "No dossier yet"}</dd>
                    </div>
                    <div><dt>Information advantage achieved</dt><dd>{selected.achievedIas ?? "Measured after the dossier"}</dd></div>
                  </dl>
                </div>
                <div className="deskSignalGroup">
                  <div className="overline">Estimated by the research model</div>
                  <dl className="deskFacts">
                    <div><dt>Opportunity score</dt><dd>{selected.opportunityScore} / 100</dd></div>
                    <div><dt>Information advantage possible</dt><dd>{selected.potentialIas} / 100</dd></div>
                    <div><dt>Confidence in the demand read</dt><dd>{pct(selected.demandConfidence)}</dd></div>
                    <div><dt>Evidence quality</dt><dd>{pct(selected.evidenceQuality)}</dd></div>
                  </dl>
                </div>
              </div>
            </section>

            {asArray<KeyClaim>(selected.keyClaims).length > 0 && (
              <section className="deskBlock">
                <h3 className="deskBlockTitle">Key claims</h3>
                <ul className="deskClaims">
                  {asArray<KeyClaim>(selected.keyClaims).map((k, i) => {
                    const v = VERDICT[k.verdict] ?? { label: words(k.verdict), tone: "idle" };
                    return (
                      <li key={i} className="deskClaim">
                        <span className={`statusPill statusPill--${v.tone}`}>{v.label}</span>
                        <span className="deskClaimText">
                          {k.claim}
                          {k.authority === "FIRST_PARTY" ? " (the company's own claim)" : ""}
                          {k.url && <> <a href={k.url} target="_blank" rel="noopener noreferrer nofollow">Open source</a></>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {(asArray<string>(selected.researchLimitations).length > 0 || asArray<string>(selected.holdReasons).length > 0) && (
              <section className="deskBlock">
                <h3 className="deskBlockTitle">Weaknesses</h3>
                <ul className="deskWeak">
                  {asArray<string>(selected.holdReasons).map((h, i) => <li key={`h${i}`}><strong>Held:</strong> {h}</li>)}
                  {asArray<string>(selected.researchLimitations).map((l, i) => <li key={`l${i}`}>{l}</li>)}
                </ul>
              </section>
            )}

            {run && run.status !== "completed" && (
              <p className="callout" role="status">
                Dossier research is {run.status}
                {((run.progress ?? {}) as { message?: string }).message ? `: ${((run.progress ?? {}) as { message?: string }).message}` : "."}
                {run.error ? ` ${run.error}` : ""}
              </p>
            )}

            <div className="deskDecide">
              <OpportunityActions
                podcastId={selected.podcastId}
                opportunityId={selected.id}
                status={selected.editorialStatus}
                dossierStatus={selected.dossier?.status ?? null}
                researching={["queued", "running"].includes(run?.status ?? "")}
              />
              <Link href={`/studio/shows/${selected.podcastId}?tab=dossiers`} className="sectionAction">Open the show&apos;s research {Icon.arrowRight}</Link>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
