import React from "react";
import Link from "next/link";
import type { BusinessProfile } from "@prisma/client";
import { showHue, showInitials } from "../../lib";
import StudioPageHeader from "../../StudioPageHeader";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { friendlyStage } from "@/app/app/lib";
import { ADVANCED_SECTIONS, FINDING_FIELDS, readAnswers, readFindings } from "@/lib/business/profileSchema";
import { pendingQuestions } from "@/lib/business/adaptiveQuestions";
import type { DossierContent } from "@/lib/business/businessDossier";
import { DiscoveryButton, FindingRow, AdvancedAnswersForm } from "./BusinessProfileClient";
import {
  AdaptiveQuestion, AskQuestions, CancelRun, HostPicker, OpportunityActions, RefineOpportunity, ScriptActions, StartResearch,
} from "./BusinessResearchClient";

export const BUSINESS_TABS = [
  // In the order the work happens: know the business, research the industry,
  // choose a topic, verify it, produce it.
  { id: "overview", label: "Overview" },
  { id: "radar", label: "Discover" },
  { id: "topics", label: "Topics" },
  { id: "insider", label: "Insider angles" },
  { id: "dossiers", label: "Dossiers" },
  { id: "episodes", label: "Episodes" },
] as const;
export type BusinessTab = (typeof BUSINESS_TABS)[number]["id"];

const FIELD_LABEL = (f: string) => f.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const STATUS_CHIP: Record<string, string> = {
  CANDIDATE: "chip", HELD: "chip bizChipWarn", APPROVED: "chip chipSuccess", REJECTED: "chip bizChipDanger", PRODUCED: "chip chipAccent",
  READY: "chip chipSuccess", HOLD: "chip bizChipWarn", RESEARCHING: "chip", FAILED: "chip bizChipDanger",
  completed: "chip chipSuccess", partial: "chip bizChipWarn", failed: "chip bizChipDanger", cancelled: "chip", running: "chip chipAccent", queued: "chip",
};
const VERDICT_CHIP: Record<string, string> = { SOURCE_SUPPORTED: "chip chipSuccess", SOURCE_CONTRADICTED: "chip bizChipDanger", UNVERIFIED: "chip bizChipWarn" };
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

interface Props {
  podcast: { id: string; name: string };
  profile: BusinessProfile;
  tab: BusinessTab;
}

export default async function BusinessShowView({ podcast, profile, tab }: Props) {
  return (
    <div className="fadeUp" data-testid="business-show-hq">
      <StudioPageHeader
        title={podcast.name}
        subtitle={`Business podcast · ${profile.businessName} · ${profile.industry}`}
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
        actions={
          <>
            <DiscoveryButton podcastId={podcast.id} status={profile.discoveryStatus} hasRun={!!profile.discoveredAt} />
            <Link href={`/studio/desk?desk=business&show=${podcast.id}`} className="btnPrimary">New episode</Link>
          </>
        }
      />
      <header className="showHead showHead--tight">
        <span className="showArt showArt--lg" data-hue={showHue(podcast.id)} aria-hidden="true">{showInitials(podcast.name)}</span>
        <div className="showHeadText">
          <div className="overline">{profile.businessName} · {profile.industry}</div>
          <p className="showHeadPromise">
            This show is researched, not improvised. Every episode starts from a topic the research found, a dossier that verified it, and a script checked against its sources.
          </p>
        </div>
      </header>
      <nav className="bizTabs" aria-label="Business show sections">
        {BUSINESS_TABS.map((t) => (
          <Link key={t.id} href={`/studio/shows/${podcast.id}?tab=${t.id}`} aria-current={t.id === tab ? "page" : undefined}>{t.label}</Link>
        ))}
      </nav>
      {tab === "overview" && <Overview profile={profile} />}
      {tab === "radar" && <Radar podcastId={podcast.id} />}
      {(tab === "topics" || tab === "insider") && <Opportunities podcastId={podcast.id} insiderOnly={tab === "insider"} profile={profile} />}
      {tab === "dossiers" && <Dossiers podcastId={podcast.id} />}
      {tab === "episodes" && <Episodes podcastId={podcast.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

const humanize = (v: string) => (/[_]/.test(v) || v === v.toLowerCase() ? v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : v);

async function Overview({ profile }: { profile: BusinessProfile }) {
  const findings = readFindings(profile.findings);
  const answers = readAnswers(profile.answers);
  const visible = findings.filter((f) => f.status !== "rejected");
  const pendingCount = visible.filter((f) => f.status === "pending").length;
  const byField = FINDING_FIELDS.map((field) => ({ field, items: visible.filter((f) => f.field === field) })).filter((g) => g.items.length);
  const answered = Object.values(answers.fields).filter((v) => v.trim()).length;
  const totalAdvanced = ADVANCED_SECTIONS.reduce((n, s) => n + s.fields.length, 0);
  const questions = pendingQuestions(profile.answers);
  const podcastId = profile.podcastId;

  const [pod, industryRuns, approved, episodes] = await Promise.all([
    db.podcast.findUnique({ where: { id: podcastId }, select: { hostIds: true, productionConfig: { select: { hostIds: true } } } }),
    db.businessResearchRun.count({ where: { podcastId, kind: "industry", status: { in: ["completed", "partial"] } } }).catch(() => 0),
    db.businessTopicOpportunity.count({ where: { podcastId, editorialStatus: { in: ["APPROVED", "PRODUCED"] } } }).catch(() => 0),
    db.episode.count({ where: { podcastId } }).catch(() => 0),
  ]);
  const hostCount = (pod?.productionConfig?.hostIds?.length ? pod.productionConfig.hostIds : pod?.hostIds ?? []).filter(Boolean).length;

  // The path to a first episode, in the order the pipeline needs it. Each step
  // reads a real row count, so the checklist can never claim work that has
  // not happened.
  const steps = [
    { label: "Company profile", done: true, detail: profile.businessName, href: null },
    { label: "Read your website", done: profile.discoveryStatus === "complete" || !!profile.discoveredAt, detail: profile.discoveryStatus === "running" ? "Running now" : profile.discoveryStatus === "failed" ? "Last run failed" : "Run discovery from the top bar", href: null },
    { label: "Choose hosts", done: hostCount > 0, detail: hostCount > 0 ? `${hostCount} host${hostCount === 1 ? "" : "s"} assigned` : "Pick a lead host below", href: null },
    { label: "Research the industry", done: industryRuns > 0, detail: industryRuns > 0 ? `${industryRuns} completed run${industryRuns === 1 ? "" : "s"}` : "Start a run in Industry Radar", href: `/studio/shows/${podcastId}?tab=radar` },
    { label: "Approve a topic", done: approved > 0, detail: approved > 0 ? `${approved} approved` : "Review proposals in Topic Opportunities", href: `/studio/shows/${podcastId}?tab=topics` },
    { label: "Produce an episode", done: episodes > 0, detail: episodes > 0 ? `${episodes} episode${episodes === 1 ? "" : "s"}` : "Generate from an approved topic's dossier", href: `/studio/shows/${podcastId}?tab=episodes` },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <div className="bizOverview">
      <div className="bizOverviewMain">
        <section className="studioCard bizSetup" aria-labelledby="biz-setup-title">
          <div className="bizCardHead">
            <div>
              <h2 id="biz-setup-title" className="m-0">Get this show on air</h2>
              <p className="bizLead">{doneCount === steps.length ? "Every step is complete. New episodes come from approved topics." : `${doneCount} of ${steps.length} steps complete.`}</p>
            </div>
            <div className="bizSetupMeter" role="img" aria-label={`${doneCount} of ${steps.length} steps complete`}>
              <span className="bizSetupMeterFill" style={{ "--pct": `${Math.round((doneCount / steps.length) * 100)}%` } as React.CSSProperties} />
            </div>
          </div>
          <ol className="bizSteps">
            {steps.map((step, i) => (
              <li key={step.label} className="bizStep" data-state={step.done ? "done" : i === nextIndex ? "next" : "todo"}>
                <span className="bizStepMark" aria-hidden="true">{step.done ? "✓" : i + 1}</span>
                <span className="bizStepText">
                  <span className="bizStepLabel">{step.label}<span className="srOnly">{step.done ? " — complete" : i === nextIndex ? " — next step" : ""}</span></span>
                  <span className="bizStepDetail">{step.detail}</span>
                </span>
                {!step.done && step.href && <Link href={step.href} className={i === nextIndex ? "btnGhost btnSm" : "btnSubtle btnSm"}>Open</Link>}
              </li>
            ))}
          </ol>
        </section>

        <section className="studioCard bizSection">
          <div className="bizCardHead">
            <div>
              <h2 className="m-0">Questions about your business</h2>
              <p className="bizLead">Three to five questions that sharpen the research. Skip any you like — skipped questions aren&apos;t asked again.</p>
            </div>
            <AskQuestions podcastId={podcastId} />
          </div>
          {questions.length === 0
            ? <p className="bizNote">No open questions.</p>
            : questions.map(([id, q]) => <AdaptiveQuestion key={id} podcastId={podcastId} id={id} question={q.question} why={q.why} />)}
        </section>

        <section className="studioCard bizSection">
          <div>
            <h2 className="m-0">What we learned about your business{pendingCount > 0 && <span className="statusPill statusPill--warn bizHeadPill">{pendingCount} to review</span>}</h2>
            <p className="bizLead">
              Every item is checked against the page it came from. <strong>Source supports</strong>: the quoted text exists and agrees.
              <strong> Contradicts</strong>: the page says something different — never used in research. <strong>Unverified</strong> and <strong>inferred</strong>: the model&apos;s reading.
            </p>
          </div>
          {profile.discoveryStatus === "failed" && <p role="alert" className="callout calloutErr">Discovery failed: {profile.discoveryError}</p>}
          {byField.length === 0 ? (
            <p className="bizNote">{profile.discoveryStatus === "running" ? "Reading your website…" : "Nothing yet. Run discovery to read your website and description."}</p>
          ) : (
            byField.map((g) => (
              <div key={g.field} className="bizStackTight">
                <div className="fieldLabel bizFlush">{FIELD_LABEL(g.field)}</div>
                {g.items.map((f) => <FindingRow key={f.id} podcastId={podcastId} finding={f} />)}
              </div>
            ))
          )}
        </section>

        <section className="studioCard bizSection">
          <div className="bizCardHead">
            <div>
              <h2 className="m-0">Deeper context</h2>
              <p className="bizLead">Optional. Each answer is routed to the research passes that use it — queries, topics, insider analysis, dossiers, scripts and exclusions.</p>
            </div>
            <span className="statusPill">{answered} of {totalAdvanced} answered</span>
          </div>
          <AdvancedAnswersForm podcastId={podcastId} version={profile.version} sections={ADVANCED_SECTIONS} initial={answers} />
        </section>
      </div>

      <aside className="bizOverviewSide">
        <section className="studioCard bizSection" aria-labelledby="biz-profile-title">
          <h2 id="biz-profile-title" className="m-0">Company profile</h2>
          <dl className="bizFacts">
            <div><dt>Company</dt><dd>{profile.businessName}</dd></div>
            <div><dt>Industry</dt><dd>{profile.industry}{profile.subIndustries.length > 0 && <span className="bizFactSub">{profile.subIndustries.join(", ")}</span>}</dd></div>
            <div><dt>Goal</dt><dd>{humanize(profile.primaryGoal)}</dd></div>
            {profile.targetAudiences.length > 0 && <div><dt>Audience</dt><dd>{profile.targetAudiences.join(", ")}</dd></div>}
            {profile.geographicMarkets.length > 0 && <div><dt>Markets</dt><dd>{profile.geographicMarkets.join(", ")}</dd></div>}
            {profile.websiteUrl && <div><dt>Website</dt><dd><a href={profile.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">{profile.websiteUrl.replace(/^https?:\/\//, "")}</a></dd></div>}
          </dl>
          {profile.description && <p className="bizBody">{profile.description}</p>}
        </section>
        <Hosts podcastId={podcastId} />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Limitation { adapter: string; status: string; message: string }
interface Usage { apiRequests?: Record<string, number>; llmCalls?: number; llmCostUsd?: number; estProviderCostUsd?: number; cacheHits?: number }

async function Radar({ podcastId }: { podcastId: string }) {
  const runs = await db.businessResearchRun.findMany({ where: { podcastId, kind: { in: ["industry", "discovery"] } }, orderBy: { createdAt: "desc" }, take: 8 });
  const latest = runs.find((r) => r.kind === "industry") ?? null;
  const [sources, observations] = latest
    ? await Promise.all([
        db.businessResearchSource.findMany({ where: { runId: latest.id, podcastId }, orderBy: { retrievedAt: "desc" }, take: 40 }),
        db.demandObservation.findMany({ where: { runId: latest.id, podcastId }, orderBy: { observedAt: "desc" }, take: 40 }),
      ])
    : [[], []];
  const running = runs.some((r) => r.kind === "industry" && (r.status === "queued" || r.status === "running"));
  const limitations = latest ? asArray<Limitation>(latest.limitations) : [];

  return (
    <>
      <section className="studioCard bizSection">
        <div className="bizCardHead">
          <div>
            <h2 className="m-0">Industry radar</h2>
            <p className="bizLead">Research reads industry sources, measures listener demand where a real data source exists, and proposes topics. Every limitation is listed — nothing is estimated where we have no data.</p>
          </div>
          <StartResearch podcastId={podcastId} running={running} />
        </div>
        {runs.length === 0 ? <p className="bizNote">No research yet.</p> : (
          <div className="bizTableWrap">
            <table className="bizTable">
              <thead><tr><th>Started</th><th>Kind</th><th>Depth</th><th>Status</th><th>Progress</th><th>Usage</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const p = (r.progress ?? {}) as { message?: string; pct?: number };
                  const u = (r.usage ?? {}) as Usage;
                  const cost = (u.llmCostUsd ?? 0) + (u.estProviderCostUsd ?? 0);
                  return (
                    <tr key={r.id}>
                      <td>{fmtDate(r.startedAt ?? r.createdAt)}</td>
                      <td>{r.kind}</td>
                      <td>{r.depth}</td>
                      <td><span className={STATUS_CHIP[r.status] ?? "chip"}>{r.status}</span>{r.error && <div className="bizError">{r.error}</div>}</td>
                      <td>
                        <progress className="bizProgress" max={100} value={p.pct ?? 0} aria-label="Research progress" />
                        <div className="bizNote">{p.message ?? ""}</div>
                      </td>
                      <td className="bizNote">
                        {Object.entries(u.apiRequests ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}
                        {u.llmCalls ? ` · ${u.llmCalls} model calls` : ""}
                        {u.cacheHits ? ` · ${u.cacheHits} cached` : ""}
                        {cost > 0 ? ` · ~$${cost.toFixed(2)}` : ""}
                      </td>
                      <td>{(r.status === "queued" || r.status === "running") && <CancelRun podcastId={podcastId} runId={r.id} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {latest && (
        <>
          <section className="studioCard bizSection">
            <h2 className="m-0">What this research could not measure</h2>
            {limitations.length === 0 ? <p className="bizNote">No limitations recorded.</p> : (
              <ul className="bizReasons">
                {limitations.map((l, i) => <li key={i}><strong>{l.adapter}</strong> ({l.status.toLowerCase().replace(/_/g, " ")}): {l.message}</li>)}
              </ul>
            )}
          </section>
          <section className="studioCard bizSection">
            <h2 className="m-0">Demand observations <span className="chip bizCount">{observations.length}</span></h2>
            {observations.length === 0 ? <p className="bizNote">No demand data was observed in the latest run.</p> : (
              <div className="bizTableWrap">
                <table className="bizTable">
                  <thead><tr><th>Source</th><th>Query</th><th>Metric</th><th>Value</th><th>Window</th><th>Limitations</th></tr></thead>
                  <tbody>
                    {observations.map((o) => (
                      <tr key={o.id}>
                        <td>{o.url ? <a href={o.url} target="_blank" rel="noopener noreferrer nofollow">{o.adapter}</a> : o.adapter}</td>
                        <td>{o.query}</td>
                        <td>{o.observedMetric} <span className="bizNote">({o.metricKind})</span></td>
                        <td>{o.metricValue ?? "not measured"}</td>
                        <td>{o.measurementWindow}</td>
                        <td className="bizNote">{o.limitations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="studioCard bizSection">
            <h2 className="m-0">Sources read <span className="chip bizCount">{sources.length}</span></h2>
            {sources.length === 0 ? <p className="bizNote">No sources were retrieved in the latest run.</p> : (
              <ul className="bizReasons">
                {sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.canonicalUrl} target="_blank" rel="noopener noreferrer nofollow">{s.title || s.canonicalUrl}</a>
                    {" "}<span className="bizNote">{s.publisher ?? ""}{s.publishedAt ? ` · ${s.publishedAt.toISOString().slice(0, 10)}` : ""} · {s.sourceType.toLowerCase().replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface KeyClaim { claim: string; verdict: string; url?: string; authority?: string }
const INSIDER_FIELDS = ["COMMON_OPERATIONAL_PROBLEMS", "HIDDEN_COSTS", "INDUSTRY_PRICING_MECHANISMS", "OPERATIONAL_BOTTLENECKS"];

async function Opportunities({ podcastId, insiderOnly, profile }: { podcastId: string; insiderOnly: boolean; profile: BusinessProfile }) {
  const opps = await db.businessTopicOpportunity.findMany({
    where: { podcastId, ...(insiderOnly ? { category: { in: ["INSIDER_INTELLIGENCE", "HIDDEN_OPPORTUNITY"] } } : {}) },
    include: { dossier: { select: { status: true } } },
    orderBy: [{ opportunityScore: "desc" }],
    take: 60,
  });
  const dossierRuns = await db.businessResearchRun.findMany({
    where: { podcastId, kind: "dossier", opportunityId: { in: opps.map((o) => o.id) } },
    orderBy: { createdAt: "desc" },
    select: { opportunityId: true, status: true, error: true, progress: true },
  });
  const lastRun = new Map<string, (typeof dossierRuns)[number]>();
  for (const r of dossierRuns) if (r.opportunityId && !lastRun.has(r.opportunityId)) lastRun.set(r.opportunityId, r);
  const order: Record<string, number> = { APPROVED: 0, CANDIDATE: 1, HELD: 2, PRODUCED: 3, REJECTED: 4 };
  opps.sort((a, b) => (order[a.editorialStatus] ?? 9) - (order[b.editorialStatus] ?? 9));
  const fields = readAnswers(profile.answers).fields;
  const noInsiderInput = !INSIDER_FIELDS.some((k) => (fields[k] ?? "").trim());

  return (
    <section className="studioCard bizSection">
      <div>
        <h2 className="m-0">{insiderOnly ? "Insider intelligence" : "Topic opportunities"} <span className="chip bizCount">{opps.length}</span></h2>
        <p className="bizLead">
          {insiderOnly
            ? "Mechanisms most outsiders miss and undercovered angles. Insider topics need a high information-advantage score or they are held."
            : "Potential IAS is what the topic could deliver; achieved IAS is measured after the dossier verifies it. Demand confidence (how sure we are) is separate from demand strength (how much interest exists)."}
        </p>
        {insiderOnly && noInsiderInput && <p className="bizNote">Tip: answering the insider questions under Overview → Deeper context gives this pass much better material.</p>}
      </div>
      {opps.length === 0 && <p className="bizNote">No topics yet. Run research from Industry Radar.</p>}
      {opps.map((o) => {
        const holds = asArray<string>(o.holdReasons);
        const claims = asArray<KeyClaim>(o.keyClaims);
        const limits = asArray<string>(o.researchLimitations);
        return (
          <article key={o.id} className="bizCard">
            <div className="bizCardHead">
              <h3 className="bizCardTitle">{o.title}</h3>
              <span className="bizChips">
                <span className="chip">{o.category.toLowerCase().replace(/_/g, " ")}</span>
                <span className={STATUS_CHIP[o.editorialStatus] ?? "chip"}>{o.editorialStatus.toLowerCase()}</span>
                {o.dossier && <span className={STATUS_CHIP[o.dossier.status] ?? "chip"}>dossier {o.dossier.status.toLowerCase()}</span>}
              </span>
            </div>
            <div className="bizScores">
              <span>Opportunity <strong>{o.opportunityScore}</strong></span>
              <span>Potential IAS <strong>{o.potentialIas}</strong></span>
              <span>Achieved IAS <strong>{o.achievedIas ?? "—"}</strong></span>
              <span>Demand <strong>{o.demandStrength.toLowerCase()}</strong> · confidence <strong>{Math.round(o.demandConfidence * 100)}%</strong></span>
              <span>Evidence <strong>{Math.round(o.evidenceQuality * 100)}%</strong></span>
            </div>
            <p className="bizBody"><strong>{o.targetListener}:</strong> {o.coreQuestion}</p>
            <p className="bizNote">{o.whyItMatters}</p>
            {o.undercoveredInformation && <p className="bizNote">Undercovered: {o.undercoveredInformation}</p>}
            {o.potentialOriginalAnalysis && <p className="bizNote">Proposed analysis (not yet done): {o.potentialOriginalAnalysis}</p>}
            {claims.length > 0 && (
              <ul className="bizReasons">
                {claims.map((k, i) => (
                  <li key={i}>
                    <span className={VERDICT_CHIP[k.verdict] ?? "chip"}>{k.verdict.replace("SOURCE_", "").toLowerCase()}</span>{" "}
                    {k.claim}{k.authority === "FIRST_PARTY" ? " (company's own claim)" : ""}
                    {k.url && <> — <a href={k.url} target="_blank" rel="noopener noreferrer nofollow">source</a></>}
                  </li>
                ))}
              </ul>
            )}
            {holds.length > 0 && <ul className="bizReasons">{holds.map((h, i) => <li key={i}>Held: {h}</li>)}</ul>}
            {limits.length > 0 && <p className="bizNote">Limitations: {limits.join(" · ")}</p>}
            {(() => {
              const r = lastRun.get(o.id);
              if (!r || r.status === "completed") return null;
              const msg = ((r.progress ?? {}) as { message?: string }).message;
              return (
                <p className="bizNote" role="status">
                  Dossier research: <span className={STATUS_CHIP[r.status] ?? "chip"}>{r.status}</span>{msg ? ` — ${msg}` : ""}
                  {r.error && <span className="bizError"> {r.error}</span>}
                </p>
              );
            })()}
            <OpportunityActions podcastId={podcastId} opportunityId={o.id} status={o.editorialStatus} dossierStatus={o.dossier?.status ?? null}
              researching={["queued", "running"].includes(lastRun.get(o.id)?.status ?? "")} />
            {o.editorialStatus !== "PRODUCED" && (
              <RefineOpportunity podcastId={podcastId} opportunityId={o.id} title={o.title} coreQuestion={o.coreQuestion} targetListener={o.targetListener} />
            )}
          </article>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------

async function Hosts({ podcastId }: { podcastId: string }) {
  const user = await currentUser();
  const [pod, hosts] = await Promise.all([
    db.podcast.findUnique({ where: { id: podcastId }, select: { hostIds: true, productionConfig: { select: { hostIds: true } } } }),
    db.aiHost.findMany({
      where: { isActive: true, isArchived: false, OR: [{ ownerId: user?.id ?? "" }, { ownerId: null }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true },
    }),
  ]);
  const current = pod?.productionConfig?.hostIds?.length ? pod.productionConfig.hostIds : pod?.hostIds ?? [];
  return (
    <section className="studioCard bizSection">
      <div>
        <h2 className="m-0">Hosts</h2>
        <p className="bizLead">
          One host makes a solo show; two make a conversation.
          {current.length === 0 && " None chosen yet — episodes fall back to the first active hosts."}
        </p>
      </div>
      {hosts.length === 0
        ? <p className="bizNote">No hosts yet. <Link href="/studio/hosts">Create one in Hosts</Link>.</p>
        : <HostPicker podcastId={podcastId} hosts={hosts} current={current} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

async function Dossiers({ podcastId }: { podcastId: string }) {
  const dossiers = await db.businessResearchDossier.findMany({
    where: { podcastId },
    include: { opportunity: { select: { title: true } } },
    orderBy: { updatedAt: "desc" },
    take: 30,
  });
  return (
    <section className="studioCard bizSection">
      <div>
        <h2 className="m-0">Research dossiers <span className="chip bizCount">{dossiers.length}</span></h2>
        <p className="bizLead">Every fact below was checked against its source. Removed and unverified claims are listed under uncertainties. A dossier needs at least three verified facts from two independent origins to be READY.</p>
      </div>
      {dossiers.length === 0 && <p className="bizNote">No dossiers yet. Start one from a topic.</p>}
      {dossiers.map((d) => {
        // A dossier still researching (or that failed first time) holds the "{}" default.
        const raw = d.content as Partial<DossierContent> | null;
        const c = typeof raw?.premise === "string" ? (raw as DossierContent) : null;
        const holds = asArray<string>(d.holdReasons);
        const more = asArray<string>(d.additionalResearch);
        const facts = c ? [...c.verifiedFacts, ...c.verifiedStatistics, ...c.industryContext] : [];
        return (
          <details key={d.id} className="bizDetails">
            <summary>
              {d.opportunity.title} <span className={STATUS_CHIP[d.status] ?? "chip"}>{d.status.toLowerCase()}</span>
              <span className="bizDetailsWhy">v{d.version} · {d.verifiedClaimCount} verified · {d.unsupportedClaimCount} not supported</span>
            </summary>
            <div className="bizDetailsBody">
              {holds.length > 0 && <ul className="bizReasons">{holds.map((h, i) => <li key={i}>On hold: {h}</li>)}</ul>}
              {more.length > 0 && <ul className="bizReasons">{more.map((h, i) => <li key={i}>Needs: {h}</li>)}</ul>}
              {!c && d.status === "RESEARCHING" && <p className="bizNote">Research in progress. Refresh to see it when it finishes.</p>}
              {c && (
                <>
                  <p className="bizBody"><strong>Premise:</strong> {c.premise}</p>
                  <p className="bizBody"><strong>Central question:</strong> {c.centralQuestion}</p>
                  <p className="bizBody"><strong>Hook:</strong> {c.hook}</p>
                  <div className="fieldLabel">Verified facts</div>
                  <ul className="bizReasons">
                    {facts.map((f, i) => <li key={i}>{f.claim}{f.authority === "FIRST_PARTY" ? " (company's own claim)" : ""} — <a href={f.url} target="_blank" rel="noopener noreferrer nofollow">{f.publisher ?? "source"}</a></li>)}
                  </ul>
                  {c.mechanisms.length > 0 && <><div className="fieldLabel">Mechanisms</div><ul className="bizReasons">{c.mechanisms.map((m, i) => <li key={i}>{m.explanation}</li>)}</ul></>}
                  {c.originalAnalysis.length > 0 && (
                    <>
                      <div className="fieldLabel">Original analysis</div>
                      <ul className="bizReasons">{c.originalAnalysis.map((a, i) => <li key={i}>[{a.status}] {a.finding} — {a.result}{a.inputs.some((x) => x.hypothetical) ? " (uses labelled hypothetical inputs)" : ""}</li>)}</ul>
                    </>
                  )}
                  {c.practicalApplications.length > 0 && <><div className="fieldLabel">Practical applications</div><ul className="bizReasons">{c.practicalApplications.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
                  {c.uncertainties.length > 0 && <><div className="fieldLabel">Uncertainties</div><ul className="bizReasons">{c.uncertainties.map((u, i) => <li key={i}>{u}</li>)}</ul></>}
                  {c.storyStructure.length > 0 && <><div className="fieldLabel">Story structure</div><ol className="bizReasons">{c.storyStructure.map((b, i) => <li key={i}>{b.beat} — {b.purpose}</li>)}</ol></>}
                  <div className="fieldLabel">Sources ({c.sourceReferences.length})</div>
                  <ul className="bizReasons">{c.sourceReferences.map((s) => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || s.url}</a> <span className="bizNote">{s.publisher ?? ""}</span></li>)}</ul>
                </>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------

async function Episodes({ podcastId }: { podcastId: string }) {
  const episodes = await db.episode.findMany({
    where: { podcastId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true, title: true, status: true,
      scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, status: true, factCheckResults: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errors: true } } } },
    },
  });
  return (
    <section className="studioCard bizSection">
      <div>
        <h2 className="m-0">Episodes <span className="chip bizCount">{episodes.length}</span></h2>
        <p className="bizLead">Scripts are written only from the episode&apos;s frozen dossier. You approve the script; fact-checking then runs and audio follows the normal production path.</p>
      </div>
      {episodes.length === 0 && <p className="bizNote">No episodes yet. Approve a topic with a READY dossier and generate one.</p>}
      {episodes.map((e) => {
        const s = e.scripts[0];
        const fc = s?.factCheckResults[0];
        const errors = asArray<string>(fc?.errors);
        return (
          <article key={e.id} className="bizCard">
            <div className="bizCardHead">
              <h3 className="bizCardTitle"><Link href={`/studio/episodes/${e.id}`}>{e.title}</Link></h3>
              <span className="bizChips">
                <span className="chip">{friendlyStage(e.status, "business").label}</span>
                {s && <span className={s.status === "needs_revision" ? "chip bizChipWarn" : s.status === "approved" ? "chip chipSuccess" : "chip"}>script v{s.version} {s.status.replace(/_/g, " ")}</span>}
                {fc && <span className={fc.status === "passed" ? "chip chipSuccess" : fc.status === "failed" ? "chip bizChipDanger" : "chip bizChipWarn"}>fact-check {fc.status.replace(/_/g, " ")}</span>}
              </span>
            </div>
            {!s && <p className="bizNote">Writing the script…</p>}
            {errors.length > 0 && <ul className="bizReasons">{errors.slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul>}
            {s && <ScriptActions podcastId={podcastId} episodeId={e.id} canApprove={s.status === "draft"} />}
          </article>
        );
      })}
    </section>
  );
}
