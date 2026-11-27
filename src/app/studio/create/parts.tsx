"use client";

// The rundown builder's smaller pieces: automatic-selection preferences, the
// review step, the result screen and the voice-override helpers. Split out of
// RundownBuilder.tsx unchanged, so the builder file holds only the flow.

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { createStudioEpisode, startDebate, setEpisodeQualityTier } from "../../app/create/actions";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import { estimateRundown } from "@/lib/services/episodeEstimate";
import { MAX_DESCRIPTION_LEN } from "@/lib/episodeLimits";
import ProductionConsole from "../ProductionConsole";
import QualityTierPicker from "../QualityTierPicker";
import { DEFAULT_QUALITY_TIER, formatTierCost, formatTierDuration, tierInfo, type QualityTier } from "@/lib/providers/llm/qualityTiers";

export type Mode = "manual" | "automatic" | "hybrid";
export interface BuilderPodcast { id: string; name: string; verticals: string[]; teamIds: string[]; teamNames: string[]; segmentCount: number; hostIds: string[]; format?: string | null; }
export interface BuilderHost { id: string; name: string; intensity: number; }
export type CreateResult = Awaited<ReturnType<typeof createStudioEpisode>>;

/* ---------------- Auto/Hybrid selection preferences (item 5) ---------------- */
export function AutoPrefs({
  mode, topics, podcastScoped, verticals, setVerticals, leagueIds, setLeagueIds, sport, setSport, teams, setTeams, minDebateScore, setMinDebateScore,
}: {
  mode: Mode; topics: StudioTopicVM[]; podcastScoped: boolean;
  verticals: string[]; setVerticals: (v: string[]) => void;
  leagueIds: string[]; setLeagueIds: (v: string[]) => void;
  sport: string; setSport: (v: string) => void;
  teams: string[]; setTeams: (v: string[]) => void;
  minDebateScore: number | null; setMinDebateScore: (v: number | null) => void;
}) {
  const sports = useMemo(() => [...new Set(topics.map((t) => t.sport).filter(Boolean))].sort(), [topics]);
  const leagues = useMemo(() => [...new Set(topics.map((t) => t.leagueId).filter(Boolean) as string[])].sort(), [topics]);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <details className="advPanel mt-3" data-testid="auto-prefs" open>
      <summary className="advPanelHead u-clickable">Selection preferences <span className="stageHint">— these steer the {mode} pick (separate from the board filters below)</span></summary>
      <div className="rundownPrefsGrid mt-3">
        <div>
          <div className="fieldLabel">Sport</div>
          <select className="input" data-testid="pref-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
            <option value="">Any</option>
            {sports.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div className="fieldLabel">Min debate score: {minDebateScore === null ? "any" : minDebateScore}</div>
          {/* 0 maps EXPLICITLY to "any" (a ≥0 threshold filters nothing, so
              they are the same query). The old `|| null` coerced every falsy
              value blindly — same wire value, but by accident, and the label
              rendered "0" while the state said null. */}
          <input type="range" min={0} max={100} step={5} value={minDebateScore ?? 0} data-testid="pref-mindebate"
            aria-valuetext={minDebateScore === null ? "any" : String(minDebateScore)}
            onChange={(e) => { const v = Number(e.target.value); setMinDebateScore(v === 0 ? null : v); }} className="u-full" />
        </div>
        {leagues.length > 0 && (
          <div className="u-span">
            <div className="fieldLabel">Leagues</div>
            <div className="segRow u-wrap">
              {leagues.map((l) => <button key={l} type="button" data-testid={`pref-league-${l}`} className={`segBtn${leagueIds.includes(l) ? " on" : ""}`} aria-pressed={leagueIds.includes(l)} onClick={() => toggle(leagueIds, l, setLeagueIds)}>{l}</button>)}
            </div>
          </div>
        )}
        <div className="u-span">
          <div className="fieldLabel">Verticals</div>
          <div className="segRow u-wrap">
            {sports.map((s) => <button key={s} type="button" data-testid={`pref-vertical-${s}`} className={`segBtn${verticals.includes(s) ? " on" : ""}`} aria-pressed={verticals.includes(s)} onClick={() => toggle(verticals, s, setVerticals)}>{s}</button>)}
          </div>
          {podcastScoped && <p className="stageHint">Verticals/teams start inherited from the show; change them to override just this episode.</p>}
        </div>
        <div className="u-span">
          <div className="fieldLabel">Team names (comma-separated)</div>
          <input className="input" data-testid="pref-teams" value={teams.join(", ")} placeholder="e.g. Chiefs, Eagles" onChange={(e) => setTeams(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </div>
      </div>
    </details>
  );
}

/* ---------------- Review ---------------- */
export function ReviewStep({
  mode, podcast, orderedSelected, leadTopicId, targetTopicCount, hosts, ttsProvider, productionStyle, sfxDensity,
  title, setTitle, description, setDescription, estimate, validation, prefs, qualityTier,
}: {
  mode: Mode; podcast: BuilderPodcast | null; orderedSelected: StudioTopicVM[]; leadTopicId: string | null; targetTopicCount: number;
  hosts: BuilderHost[]; ttsProvider: string; productionStyle: string; sfxDensity: string; qualityTier: QualityTier | null;
  title: string; setTitle: (v: string) => void; description: string; setDescription: (v: string) => void;
  estimate: ReturnType<typeof estimateRundown>; validation: { ok: boolean; error?: string };
  prefs: { verticals: string[]; leagueIds: string[]; teams: string[]; sport: string; minDebateScore: number | null };
}) {
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - orderedSelected.length) : mode === "automatic" ? targetTopicCount : 0;
  const lead = leadTopicId && orderedSelected.some((t) => t.id === leadTopicId) ? leadTopicId : orderedSelected[0]?.id;
  const warnings = orderedSelected.filter((t) => t.readiness !== "ready" || t.usedByShowRecent);
  const prefSummary = [prefs.sport && `sport ${prefs.sport}`, prefs.verticals.length && `verticals ${prefs.verticals.join("/")}`, prefs.leagueIds.length && `leagues ${prefs.leagueIds.join("/")}`, prefs.teams.length && `teams ${prefs.teams.join("/")}`, prefs.minDebateScore != null && `min debate ${prefs.minDebateScore}`].filter(Boolean).join(" · ");
  return (
    <div className="studioCard">
      <h2 className="sectionTitle mt-0">Review the rundown</h2>

      {/* Naming happens here, where the rundown is finally visible. */}
      <label className="fieldLabel" htmlFor="epTitle">Episode title <span className="stageHint">(optional)</span></label>
      <input id="epTitle" data-testid="episode-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-generated if left blank" />

      <label className="fieldLabel mt-3" htmlFor="epDesc">Description <span className="stageHint">(optional)</span></label>
      <textarea id="epDesc" data-testid="episode-description" value={description} maxLength={MAX_DESCRIPTION_LEN} rows={3} onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LEN))} placeholder="Show notes / summary for this episode" className="input u-resizeY" />
      <div className="stageHint u-right" data-testid="desc-count">{description.length}/{MAX_DESCRIPTION_LEN}</div>

      <dl className="reviewGrid mt-4">
        {description && (<><dt className="fieldLabel">Description</dt><dd data-testid="review-description">{description}</dd></>)}
        <dt className="fieldLabel">Show</dt><dd>{podcast ? podcast.name : "Standalone episode"}</dd>
        <dt className="fieldLabel">Mode</dt><dd className="u-caps" data-testid="review-mode">{mode}</dd>
        <dt className="fieldLabel">Rundown</dt>
        <dd>
          {mode === "automatic" ? <span>{targetTopicCount} topics selected automatically at creation.</span> : (
            <ol className="reviewList" data-testid="review-rundown">
              {orderedSelected.map((t) => (
                <li key={t.id}>{t.id === lead && <span className="chip chipAccent">★ Lead</span>} {t.title}{t.readiness !== "ready" && <span className="noteWarn"> ⚠ {t.readiness.replace("_", " ")}</span>}</li>
              ))}
            </ol>
          )}
          {autoSlots > 0 && <p className="stageHint">+ {autoSlots} auto-selected slot{autoSlots === 1 ? "" : "s"}.</p>}
        </dd>
        {mode !== "manual" && prefSummary && (<><dt className="fieldLabel">Auto preferences</dt><dd data-testid="review-prefs">{prefSummary}</dd></>)}
        <dt className="fieldLabel">Hosts</dt><dd>{hosts.map((h) => h.name).join(" + ") || "Default pairing"}</dd>
        <dt className="fieldLabel">Voice</dt><dd>{ttsProvider || "Host default"}</dd>
        <dt className="fieldLabel">Production</dt><dd>{productionStyle} · {sfxDensity} SFX</dd>
        {/* The review grid summarised every setting that changes how the episode
            SOUNDS and none of the one that decides what it costs. */}
        <dt className="fieldLabel">Writing</dt>
        <dd data-testid="review-tier">
          {qualityTier ? (
            <>
              {tierInfo(qualityTier).label} · {formatTierCost(qualityTier)} · {formatTierDuration(qualityTier)}
              {tierInfo(qualityTier).speedWarning ? <span className="noteWarn"> ⚠ slower tier</span> : null}
            </>
          ) : podcast ? (
            "Inherits this show's tier"
          ) : (
            `${tierInfo(DEFAULT_QUALITY_TIER).label} (default) · ${formatTierCost(DEFAULT_QUALITY_TIER)} · ${formatTierDuration(DEFAULT_QUALITY_TIER)}`
          )}
        </dd>
        <dt className="fieldLabel">Estimate</dt><dd>~{estimate.estimatedDurationMinutes} min · ~{estimate.estimatedWords.toLocaleString()} words · {estimate.estimatedCostUsd !== null ? `~$${estimate.estimatedCostUsd.toFixed(2)}` : "cost provider-dependent"}</dd>
      </dl>
      {warnings.length > 0 && (
        <div role="note" className="noteWarn noteSmall mt-3">
          {warnings.map((t) => <div key={t.id}>⚠ {t.title}: {t.usedByShowRecent ? "recently used by this show" : t.readiness.replace("_", " ")}</div>)}
        </div>
      )}
      {!validation.ok && <p role="alert" className="noteWarn mt-3">{validation.error}</p>}
    </div>
  );
}

/* ---------------- Result (item 13: startDebate error handling) ---------------- */
/**
 * THE LAST SCREEN BEFORE ANY MONEY IS SPENT.
 *
 * "Start the debate" is the button that actually commits an episode to a set of
 * models — nothing before it calls a paid provider. The tier was choosable four
 * steps earlier, on the Production step of a five-step wizard, and then never
 * mentioned again: the rundown, the confirmation copy and the button itself all
 * stayed silent about whether pressing it would cost $1.75 or nothing, and
 * whether it would take three minutes or twelve.
 *
 * That is not a real choice. A setting buried behind a step the user has
 * already walked past is one they will not remember making, and the first time
 * they learn which tier they are on is when the bill or the wait arrives. So
 * the tier is restated HERE, changeable in place (setEpisodeQualityTier accepts
 * it for exactly as long as the episode is still a draft, which is now), with
 * the cost and the duration next to the button that commits to both.
 */
export function ResultView({
  result,
  topicsById,
  initialTier,
  inheritsFromShow,
}: {
  result: Extract<CreateResult, { success: true }>;
  topicsById: Map<string, StudioTopicVM>;
  initialTier: QualityTier | null;
  inheritsFromShow: boolean;
}) {
  const reduced = result.finalOrder.length < result.requestedCount;
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [tier, setTier] = useState<QualityTier | null>(initialTier);

  // What the run will ACTUALLY use when nothing was picked. An unchosen tier
  // resolves episode -> podcast -> deployment default at generation time
  // (worker.ts), so the only honest thing to show for a standalone episode is
  // the deployment default itself rather than a blank.
  const effective = tier ?? (inheritsFromShow ? null : DEFAULT_QUALITY_TIER);

  const saveTier = async (next: QualityTier) => {
    if (!result.episodeId) throw new Error("No episode id.");
    const res = await setEpisodeQualityTier(result.episodeId, next);
    // QualityTierPicker renders a thrown message inline; returning quietly on a
    // rejected save would leave the card showing a tier the server never took.
    if (!res.ok) throw new Error(res.error);
    setTier(next);
  };
  const start = async () => {
    setStarting(true); setStartError(null);
    try {
      if (!result.episodeId) throw new Error("No episode id.");
      const res = (await startDebate(result.episodeId)) as { success?: boolean; error?: string };
      if (res && res.success === false) { setStartError(res.error || "Couldn't start the debate."); return; }
      // Stay put and hand over to the live console. The old behaviour was a hard
      // window.location navigation into a server-rendered page that showed no
      // progress — a white flash followed by a static card.
      setStarted(true);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Couldn't start the debate.");
    } finally { setStarting(false); }
  };

  if (started && result.episodeId) {
    return (
      <div className="fadeUp">
        <ProductionConsole episodeId={result.episodeId} offEpisodePage />
      </div>
    );
  }

  return (
    <div className="studioCard">
      {/* "🎬 Episode created" alone read as DONE. Nothing is running at this
          point — the episode is a draft and the studio is waiting for the
          customer to press Start. In the audit run that headline cost 25 minutes
          of watching a static screen for progress that was never coming. The
          heading now names the state, and the line below says what has to happen
          next in the same breath. */}
      <h2 className="sectionTitle mt-0">🎬 Rundown locked — not started yet</h2>
      <div className="createAlert mb-3" role="status" data-testid="not-started-notice">
        <strong>Nothing is generating yet.</strong> Your episode is saved as a draft. Press
        <strong> Start the debate</strong> below to begin writing the script — it takes several minutes
        and runs on our servers, so you can close the tab and come back.
      </div>
      {result.draftCleanupWarning && <div className="createAlert mb-3" role="status" data-testid="draft-warning">{result.draftCleanupWarning}</div>}
      {reduced && (
        <div className="createAlert mb-3" role="status" data-testid="reduced-notice">
          {result.concurrentlyDroppedIds.length > 0
            ? `One or more automatically selected topics became unavailable while the episode was being created. Your episode was created with ${result.finalOrder.length} topic${result.finalOrder.length === 1 ? "" : "s"} instead of ${result.requestedCount}.`
            : `The studio found ${result.finalOrder.length} eligible topic${result.finalOrder.length === 1 ? "" : "s"} (you requested ${result.requestedCount}).`}
        </div>
      )}
      <p className="stageHint">This is the final rundown the studio actually created (from the backend), in order:</p>
      <ol className="reviewList" data-testid="result-final-order">
        {result.finalOrder.map((id, i) => {
          const ref = result.selectedTopics.find((s) => s.id === id);
          return <li key={id} data-testid={`final-${id}`}>{i === 0 && <span className="chip chipAccent">★ Lead</span>} {ref?.title ?? topicsById.get(id)?.title ?? id} {ref && !ref.pinned && <span className="chip">auto</span>}</li>;
        })}
      </ol>
      {result.rejectedTopics.length > 0 && (
        <div role="note" className="noteSmall mt-3">
          <div className="fieldLabel">Not included</div>
          <ul className="createReasons">{result.rejectedTopics.map((r, i) => <li key={i}>{topicsById.get(r.id)?.title ?? r.id}: {r.reason}</li>)}</ul>
        </div>
      )}
      {/* The free-or-paid choice, at the moment it is actually being made. */}
      <div className="mt-4" data-testid="result-tier">
        <QualityTierPicker value={tier} onChange={saveTier} disabled={starting} />
        {tier === null && inheritsFromShow ? (
          <p className="hintText mt-2">Not set for this episode — it will use the show&apos;s tier.</p>
        ) : null}
      </div>

      {startError && <p role="alert" data-testid="start-error" className="noteWarn mt-3">{startError}</p>}

      {/* Cost and wait restated ON the commit, not four steps behind it. The
          free tier's wait is the headline here for the same reason it leads its
          badge: it is the surprise, and this is the last chance to avoid it. */}
      {effective ? (
        <p className="stageHint mt-3" data-testid="start-cost-note">
          Pressing Start writes this episode with <strong>{tierInfo(effective).label}</strong> —{" "}
          {formatTierCost(effective)}, about {formatTierDuration(effective)} before the script is ready.
          {tierInfo(effective).speedWarning ? " That wait is normal for this tier, not a stall." : ""}
        </p>
      ) : null}

      <div className="stageActions mt-4">
        <Link href={`/studio/episodes/${result.episodeId}`} className="btnGhost">Open episode</Link>
        <button type="button" data-testid="start-debate" className="btnPrimary u-mlAuto" disabled={starting} aria-busy={starting} onClick={start}>
          {starting && <span className="btnSpin" aria-hidden="true" />}
          {starting ? "Starting…" : effective ? `Start the debate — ${formatTierCost(effective)} →` : "Start the debate →"}
        </button>
      </div>
    </div>
  );
}

/** Re-scoping the board to another show refetches the topic pool. Hold the
 *  column's shape with take-card placeholders instead of collapsing it to a
 *  line of text, which used to make the whole picker jump. */
export function TopicPickerSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading takes" className="skelStack">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skelBlock">
          <div className="skelRow mb-4">
            <div className="skelChip" />
            <div className="skelChip" style={{ "--skel-w": "60px" } as React.CSSProperties} />
          </div>
          <div className="skelLine" />
          <div className="skelLine skelLine--short" />
        </div>
      ))}
    </div>
  );
}

export function topicTitle(byId: Map<string, StudioTopicVM>, id: string): string { return byId.get(id)?.title ?? id; }
export function buildVoiceOverrides(picks: Record<string, string>, engine: string): Record<string, { provider: string; voiceId: string }> | undefined {
  if (!engine) return undefined;
  const out: Record<string, { provider: string; voiceId: string }> = {};
  for (const [hostId, voiceId] of Object.entries(picks)) { const v = voiceId.trim(); if (v) out[hostId] = { provider: engine, voiceId: v }; }
  return Object.keys(out).length > 0 ? out : undefined;
}
export function voicePicksFromOverrides(overrides: unknown): Record<string, string> {
  if (!overrides || typeof overrides !== "object") return {};
  const out: Record<string, string> = {};
  for (const [hostId, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).voiceId === "string") out[hostId] = String((v as Record<string, unknown>).voiceId);
  }
  return out;
}
