"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import TopicGenerationForm from "./TopicGenerationForm";
import { approveTopic, rejectTopic, resetTopicToPending } from "./actions";

interface Usage {
  episodeId: string;
  episodeTitle: string;
  episodeStatus: string;
  episodePublishedAt: string | null;
  podcastId: string | null;
  podcastName: string | null;
}

interface Topic {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  controversyScore: number;
  starPowerScore: number;
  bettingRelevanceScore: number;
  recencyScore: number;
  debateScore: number;
  evidenceIds: any;
  status: string;
  createdAt: string;
  usages: Usage[];
  used: boolean;
}

interface DashboardProps {
  initialTopics: Topic[];
  initialStats: { evidenceCount: number; pendingCount: number; approvedCount: number; rejectedCount: number };
  config: { llmProvider: string; sportsProvider: string; hasRealIngestedEvidence: boolean };
}

type Tab = "unused" | "used";
type SortKey = "date-desc" | "date-asc" | "score-desc" | "score-asc";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const STATUS_META: Record<string, { label: string; cls: string; icon: string }> = {
  pending: { label: "Pending", cls: "statusPill--pending", icon: "◷" },
  approved: { label: "Approved", cls: "statusPill--approved", icon: "✓" },
  rejected: { label: "Rejected", cls: "statusPill--rejected", icon: "✕" },
  used: { label: "Used", cls: "statusPill--used", icon: "●" },
};

function StatusPill({ status }: { status: string }) {
  const m = STATUS_META[status] || { label: status, cls: "statusPill--pending", icon: "•" };
  return (
    <span className={`statusPill ${m.cls}`}>
      <span className="statusPillIcon" aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export default function TopicsDashboard({ initialTopics, initialStats, config }: DashboardProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("unused");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Filters
  const [leagueFilter, setLeagueFilter] = useState("");
  const [sportFilter, setSportFilter] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("date-desc");
  const [search, setSearch] = useState("");

  const isLlmStub = config.llmProvider.toLowerCase() === "stub";
  const isSportsStub = config.sportsProvider.toLowerCase() === "stub";
  const hasNoEvidence = !config.hasRealIngestedEvidence && initialStats.evidenceCount === 0;

  const unused = useMemo(() => initialTopics.filter((t) => !t.used), [initialTopics]);
  const used = useMemo(() => initialTopics.filter((t) => t.used), [initialTopics]);
  const pendingCount = useMemo(() => initialTopics.filter((t) => t.status === "pending").length, [initialTopics]);

  const leagues = useMemo(
    () => Array.from(new Set(initialTopics.map((t) => t.leagueId).filter(Boolean))).sort() as string[],
    [initialTopics]
  );
  const sports = useMemo(
    () => Array.from(new Set(initialTopics.map((t) => t.sport).filter(Boolean))).sort(),
    [initialTopics]
  );

  const view = useMemo(() => {
    const base = tab === "unused" ? unused : used;
    const q = search.trim().toLowerCase();
    const filtered = base.filter((t) => {
      if (leagueFilter && (t.leagueId || "") !== leagueFilter) return false;
      if (sportFilter && t.sport !== sportFilter) return false;
      if (t.debateScore < minScore) return false;
      if (q && !(`${t.title} ${t.summary ?? ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "date-asc": return +new Date(a.createdAt) - +new Date(b.createdAt);
        case "score-desc": return b.debateScore - a.debateScore;
        case "score-asc": return a.debateScore - b.debateScore;
        case "date-desc":
        default: return +new Date(b.createdAt) - +new Date(a.createdAt);
      }
    });
    return sorted;
  }, [tab, unused, used, leagueFilter, sportFilter, minScore, search, sortKey]);

  const act = async (id: string, fn: (id: string) => Promise<{ success: boolean; error?: string }>) => {
    setLoadingId(id);
    const res = await fn(id);
    if (!res.success) alert(res.error || "Action failed");
    else router.refresh(); // re-pull real DB state (status + attribution)
    setLoadingId(null);
  };

  const filtersActive = !!(leagueFilter || sportFilter || minScore || search);
  const emptyMsg = () => {
    if (tab === "unused") {
      if (leagueFilter) return `No unused ${leagueFilter} topics — generate some.`;
      if (filtersActive) return "No unused topics match these filters.";
      return "No unused topics yet — generate some from ingested evidence.";
    }
    if (filtersActive) return "No used topics match these filters.";
    return "No topics have been used in an episode yet.";
  };

  return (
    <div>
      <header className="topicsHeader">
        <div>
          <h1 className="topicsTitle">Topic Engine</h1>
          <p className="topicsSub">Debate topic candidates generated from real ingested evidence, ranked by debate score.</p>
        </div>
      </header>

      {/* Notices */}
      {isLlmStub && (
        <div className="noticeCard noticeCard--error" role="alert">
          <strong>LLM provider is stub — real generation is disabled.</strong>
          <span>Set <code>LLM_PROVIDER</code> to a real provider (OpenAI / Anthropic) to generate topics.</span>
        </div>
      )}
      {hasNoEvidence && (
        <div className="noticeCard noticeCard--warning" role="alert">
          <strong>No ingested sports evidence.</strong>
          <span>Run ingestion on the Data Sources page before generating — static leagues don’t count as evidence.</span>
        </div>
      )}
      {isSportsStub && !hasNoEvidence && (
        <div className="noticeCard noticeCard--muted" role="status">
          <strong>Stub sports provider.</strong>
          <span>New ingestion is disabled, but you can still generate from existing evidence.</span>
        </div>
      )}

      {/* KPIs */}
      <div className="kpiRow">
        <div className="kpiCard"><span className="kpiLabel">Evidence records</span><span className="kpiValue">{initialStats.evidenceCount}</span></div>
        <div className="kpiCard"><span className="kpiLabel">Unused topics</span><span className="kpiValue">{unused.length}</span></div>
        <div className="kpiCard"><span className="kpiLabel">Used topics</span><span className="kpiValue">{used.length}</span></div>
        <div className="kpiCard"><span className="kpiLabel">Pending review</span><span className="kpiValue">{pendingCount}</span></div>
      </div>

      <div className="topicsLayout">
        {/* Generation panel */}
        <aside className="topicsAside">
          <TopicGenerationForm onGenerated={() => router.refresh()} isLlmStub={isLlmStub} hasNoEvidence={hasNoEvidence} />
        </aside>

        {/* Main */}
        <section className="topicsMain">
          {/* Tabs */}
          <div className="tabsBar" role="tablist" aria-label="Topic status">
            <button role="tab" aria-selected={tab === "unused"} className={`tab ${tab === "unused" ? "tab--active" : ""}`} onClick={() => setTab("unused")}>
              Unused <span className="tabCount">{unused.length}</span>
            </button>
            <button role="tab" aria-selected={tab === "used"} className={`tab ${tab === "used" ? "tab--active" : ""}`} onClick={() => setTab("used")}>
              Used <span className="tabCount">{used.length}</span>
            </button>
          </div>

          {/* Toolbar */}
          <div className="toolbar">
            <div className="toolField">
              <label className="toolLabel" htmlFor="fLeague">League</label>
              <select id="fLeague" className="toolSelect" value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)}>
                <option value="">All</option>
                {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="toolField">
              <label className="toolLabel" htmlFor="fSport">Sport</label>
              <select id="fSport" className="toolSelect" value={sportFilter} onChange={(e) => setSportFilter(e.target.value)}>
                <option value="">All</option>
                {sports.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="toolField">
              <label className="toolLabel" htmlFor="fScore">Min score <span className="toolLabelValue">{minScore}</span></label>
              <input id="fScore" type="range" min={0} max={100} className="toolRange" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
            </div>
            <div className="toolField">
              <label className="toolLabel" htmlFor="fSort">Sort</label>
              <select id="fSort" className="toolSelect" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
                <option value="score-desc">Debate score: high to low</option>
                <option value="score-asc">Debate score: low to high</option>
              </select>
            </div>
            <div className="toolField toolField--grow">
              <label className="toolLabel" htmlFor="fSearch">Search</label>
              <input id="fSearch" type="text" className="toolInput" placeholder="Title or summary…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          {/* List */}
          {view.length === 0 ? (
            <div className="emptyState">
              <div className="emptyTitle">{emptyMsg()}</div>
              {tab === "unused" && !filtersActive && (
                <div className="emptyDesc">Use the panel on the left to draft candidates from real evidence.</div>
              )}
            </div>
          ) : (
            <ul className="topicList">
              {view.map((t) => {
                const evidence = Array.isArray(t.evidenceIds) ? t.evidenceIds : [];
                const open = !!expanded[t.id];
                return (
                  <li className="tCard" key={t.id}>
                    <div className="tCardTop">
                      <div className="tCardHead">
                        <h3 className="tTitle">{t.title}</h3>
                        <div className="tMeta">
                          <span className="pill pill--league">{t.leagueId || "GLOBAL"}</span>
                          <span className="pill pill--sport">{t.sport}</span>
                          <StatusPill status={t.status} />
                          <span className="tDate" title={new Date(t.createdAt).toISOString()}>
                            <span className="tDateIcon" aria-hidden="true">🗓</span>{fmtDate(t.createdAt)}
                          </span>
                        </div>
                      </div>
                      <div className="scorePill" title="Composite debate score">
                        <span className="scorePillValue">{Math.round(t.debateScore)}</span>
                        <span className="scorePillLabel">debate</span>
                      </div>
                    </div>

                    {t.summary && <p className="tSummary">{t.summary}</p>}

                    <div className="subScores">
                      <span className="subScore"><span className="subScoreLabel">Controversy</span><span className="subScoreVal">{t.controversyScore}</span></span>
                      <span className="subScore"><span className="subScoreLabel">Star power</span><span className="subScoreVal">{t.starPowerScore}</span></span>
                      <span className="subScore"><span className="subScoreLabel">Betting</span><span className="subScoreVal">{t.bettingRelevanceScore}</span></span>
                      <span className="subScore"><span className="subScoreLabel">Recency</span><span className="subScoreVal">{t.recencyScore}</span></span>
                    </div>

                    {/* Used → real podcast / episode attribution */}
                    {t.used && (
                      <div className="attribution">
                        <span className="attrLabel">Consumed by</span>
                        <ul className="attrList">
                          {t.usages.map((u) => (
                            <li className="attrItem" key={u.episodeId}>
                              <span className="attrPodcast">{u.podcastName || "Standalone"}</span>
                              <span className="attrSep" aria-hidden="true">›</span>
                              <Link className="attrEpisode" href={`/admin/episodes/${u.episodeId}`}>{u.episodeTitle}</Link>
                              <StatusPill status={u.episodeStatus} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="tCardFooter">
                      <button
                        className="linkBtn"
                        aria-expanded={open}
                        onClick={() => setExpanded((p) => ({ ...p, [t.id]: !p[t.id] }))}
                      >
                        {open ? "Hide" : "Show"} evidence ({evidence.length})
                      </button>

                      {/* Actions only for unused (available-to-use) topics */}
                      {!t.used && (
                        <div className="rowActions">
                          {t.status === "pending" ? (
                            <>
                              <button className="btnGhost" disabled={loadingId === t.id} onClick={() => act(t.id, rejectTopic)}>Reject</button>
                              <button className="btnPrimary" disabled={loadingId === t.id} onClick={() => act(t.id, approveTopic)}>Approve</button>
                            </>
                          ) : (
                            <button className="btnGhost" disabled={loadingId === t.id} onClick={() => act(t.id, resetTopicToPending)}>Reset to pending</button>
                          )}
                        </div>
                      )}
                    </div>

                    {open && (
                      <div className="evidenceBox">
                        {evidence.length === 0 ? (
                          <span className="evidenceEmpty">No evidence links recorded.</span>
                        ) : (
                          <ul className="evidenceList">
                            {evidence.map((ref: any, i: number) => (
                              <li className="evidenceItem" key={i}>
                                <span className="evidenceType">{String(ref?.type ?? "ref")}</span>
                                <code className="evidenceId">{String(ref?.id ?? "")}</code>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
