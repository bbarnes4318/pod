"use client";

// Step-by-step podcast creation wizard: one decision per screen, visible
// progress, back/next, inline validation, animated transitions, review, and
// a celebratory success state. Also powers editing (pass podcastId).

import React, { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { createPodcast, updatePodcast } from "../actions";
import { WEEKDAYS, WEEKDAY_LABELS, SEGMENT_MIN, SEGMENT_MAX, SEGMENT_DEFAULT, PodcastInput } from "../config";
import { VERTICALS, TEAM_LEAGUE_BY_VERTICAL, teamLeagueIdsForVerticals } from "@/lib/verticals";

export interface WizardHost { id: string; name: string; role: string }
export interface WizardTeam { id: string; leagueId: string; name: string }
export interface WizardInitial {
  name?: string;
  cadence?: "one_time" | "recurring";
  scheduleDays?: string[];
  verticals?: string[];
  teams?: string[];
  segmentCount?: number;
  hostIds?: string[];
}

const VERTICAL_EMOJI: Record<string, string> = {
  All: "🌐", NFL: "🏈", NBA: "🏀", MLB: "⚾", NHL: "🏒",
  "College Football": "🏟️", "College Basketball": "🎓",
  "Gambling/Point Spread": "🎲", "Fantasy Sports": "🏆", Poker: "🃏",
};

const LEAGUE_LABEL: Record<string, string> = {
  NFL: "NFL", NBA: "NBA", MLB: "MLB", NHL: "NHL",
  NCAAF: "College Football", NCAAB: "College Basketball",
};

type StepId = "name" | "verticals" | "teams" | "segments" | "hosts" | "review";

export default function PodcastWizard({
  hosts,
  teams,
  initial,
  podcastId,
}: {
  hosts: WizardHost[];
  teams: WizardTeam[];
  initial?: WizardInitial;
  podcastId?: string; // set = edit mode (saves instead of creating)
}) {
  const editing = !!podcastId;

  const [name, setName] = useState(initial?.name ?? "");
  const [cadence, setCadence] = useState<"one_time" | "recurring">(initial?.cadence ?? "one_time");
  const [scheduleDays, setScheduleDays] = useState<string[]>(initial?.scheduleDays ?? []);
  const [verticals, setVerticals] = useState<string[]>(initial?.verticals ?? []);
  const [teamIds, setTeamIds] = useState<string[]>(initial?.teams ?? []);
  const [segmentCount, setSegmentCount] = useState(initial?.segmentCount ?? SEGMENT_DEFAULT);
  const [hostIds, setHostIds] = useState<string[]>(
    initial?.hostIds ?? hosts.map((h) => h.id) // everyone in the booth by default
  );
  const [teamSearch, setTeamSearch] = useState("");

  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  // "All" behaves as select-everything.
  const allSelected = verticals.includes("All");
  const effectiveVerticals = allSelected ? VERTICALS.filter((v) => v !== "All") : verticals;
  const teamLeagues = teamLeagueIdsForVerticals(effectiveVerticals);
  const hasTeamStep = teamLeagues.length > 0;

  const steps: { id: StepId; label: string }[] = useMemo(() => {
    const s: { id: StepId; label: string }[] = [
      { id: "name", label: "Name" },
      { id: "verticals", label: "Verticals" },
    ];
    if (hasTeamStep) s.push({ id: "teams", label: "Teams" });
    s.push({ id: "segments", label: "Segments" }, { id: "hosts", label: "Hosts" }, { id: "review", label: "Review" });
    return s;
  }, [hasTeamStep]);

  const step = steps[Math.min(stepIndex, steps.length - 1)];

  const validateStep = (id: StepId): string | null => {
    if (id === "name") {
      if (!name.trim()) return "Give your podcast a name to continue.";
      if (name.trim().length > 80) return "Keep the name under 80 characters.";
      if (cadence === "recurring" && scheduleDays.length === 0) return "Pick at least one day of the week.";
    }
    if (id === "verticals" && verticals.length === 0) return "Pick at least one vertical.";
    if (id === "hosts" && hostIds.length === 0) return "Pick at least one host.";
    return null;
  };

  const goNext = () => {
    const problem = validateStep(step.id);
    if (problem) { setError(problem); return; }
    setError(null);
    setDirection("fwd");
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };
  const goBack = () => {
    setError(null);
    setDirection("back");
    setStepIndex((i) => Math.max(i - 1, 0));
  };
  const jumpTo = (id: StepId) => {
    const idx = steps.findIndex((s) => s.id === id);
    if (idx >= 0) { setError(null); setDirection("back"); setStepIndex(idx); }
  };

  const toggle = (list: string[], set: (v: string[]) => void, value: string) => {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const toggleVertical = (v: string) => {
    setError(null);
    if (v === "All") {
      setVerticals(allSelected ? [] : ["All"]);
      return;
    }
    const next = verticals.includes(v)
      ? verticals.filter((x) => x !== v && x !== "All")
      : [...verticals.filter((x) => x !== "All"), v];
    setVerticals(next);
  };

  // Drop team picks that no longer match the chosen verticals.
  const visibleTeams = teams.filter((t) => teamLeagues.includes(t.leagueId));
  const selectedTeams = teamIds.filter((id) => visibleTeams.some((t) => t.id === id));

  const submit = () => {
    setError(null);
    const input: PodcastInput = {
      name: name.trim(),
      cadence,
      scheduleDays: cadence === "recurring" ? scheduleDays : [],
      verticals,
      teams: selectedTeams,
      segmentCount,
      hostIds,
    };
    startTransition(async () => {
      const res = editing ? await updatePodcast(podcastId!, input) : await createPodcast(input);
      if (res.success) setDone(true);
      else setError(res.error || "Something went wrong — try again.");
    });
  };

  // ---------- success ----------
  if (done) {
    return (
      <div className="uWizSuccess">
        <div className="uWizCheck" aria-hidden="true">
          <svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none" /><path fill="none" d="M14 27l8 8 16-17" /></svg>
        </div>
        <h2 className="uWizSuccessTitle">{editing ? "Changes saved" : "Your podcast is ready"}</h2>
        <p className="uWizSuccessSub">
          <strong>{name.trim()}</strong>
          {cadence === "recurring"
            ? ` will generate new episodes every ${scheduleDays.map((d) => WEEKDAY_LABELS[d]).join(", ")}.`
            : " is set up as a one-time show — generate its episodes whenever you like."}
        </p>
        <div className="uWizSuccessActions">
          <Link href="/app/podcasts" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none" }}>
            View my podcasts
          </Link>
          {/* plain anchor: hard reload resets the wizard state */}
          <a href="/app/podcasts/new" className="uRecordBtn" style={{ textDecoration: "none" }}>
            Create another
          </a>
        </div>
      </div>
    );
  }

  // ---------- screens ----------
  const screen = (() => {
    switch (step.id) {
      case "name":
        return (
          <div>
            <h2 className="uWizQuestion">What's the show called?</h2>
            <input
              className="uWizInput"
              autoFocus
              placeholder="e.g. Monday Night Overreactions"
              value={name}
              maxLength={81}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && goNext()}
            />
            <div className="uWizChoiceRow">
              <button type="button" className={`uWizCard ${cadence === "one_time" ? "sel" : ""}`} onClick={() => setCadence("one_time")}>
                <span className="uWizCardEmoji">🎯</span>
                <span className="uWizCardTitle">One-time</span>
                <span className="uWizCardSub">Generate episodes when you say so</span>
              </button>
              <button type="button" className={`uWizCard ${cadence === "recurring" ? "sel" : ""}`} onClick={() => setCadence("recurring")}>
                <span className="uWizCardEmoji">🔁</span>
                <span className="uWizCardTitle">Recurring</span>
                <span className="uWizCardSub">Fresh episodes on a weekly schedule</span>
              </button>
            </div>
            {cadence === "recurring" && (
              <div className="uWizDayRow" role="group" aria-label="Days of the week">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`uWizDay ${scheduleDays.includes(d) ? "sel" : ""}`}
                    aria-pressed={scheduleDays.includes(d)}
                    onClick={() => { toggle(scheduleDays, setScheduleDays, d); setError(null); }}
                  >
                    {WEEKDAY_LABELS[d].slice(0, 3)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );

      case "verticals":
        return (
          <div>
            <h2 className="uWizQuestion">What's it about?</h2>
            <p className="uWizHint">Pick as many as you like — "All" grabs everything.</p>
            <div className="uWizGrid">
              {VERTICALS.map((v) => {
                const sel = verticals.includes(v) || (allSelected && v !== "All") || (v === "All" && allSelected);
                return (
                  <button key={v} type="button" className={`uWizCard ${sel ? "sel" : ""}`} aria-pressed={sel} onClick={() => toggleVertical(v)}>
                    <span className="uWizCardEmoji">{VERTICAL_EMOJI[v]}</span>
                    <span className="uWizCardTitle">{v}</span>
                    {TEAM_LEAGUE_BY_VERTICAL[v] === undefined && v !== "All" && (
                      <span className="uWizCardSub">No team picks</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );

      case "teams":
        return (
          <div>
            <h2 className="uWizQuestion">Follow specific teams?</h2>
            <p className="uWizHint">Optional — skip this and the show covers the whole vertical.</p>
            <input
              className="uWizInput"
              placeholder="Search teams…"
              value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)}
              style={{ marginBottom: "0.9rem" }}
            />
            {teamLeagues.map((lg) => {
              const inLeague = visibleTeams.filter(
                (t) => t.leagueId === lg && t.name.toLowerCase().includes(teamSearch.toLowerCase())
              );
              if (inLeague.length === 0) return null;
              return (
                <div key={lg} style={{ marginBottom: "1rem" }}>
                  <div className="uWizLeagueLabel">{LEAGUE_LABEL[lg] || lg}</div>
                  <div className="uWizChipWrap">
                    {inLeague.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`uWizChip ${teamIds.includes(t.id) ? "sel" : ""}`}
                        aria-pressed={teamIds.includes(t.id)}
                        onClick={() => toggle(teamIds, setTeamIds, t.id)}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {selectedTeams.length > 0 && (
              <p className="uWizHint">{selectedTeams.length} team{selectedTeams.length === 1 ? "" : "s"} selected</p>
            )}
          </div>
        );

      case "segments":
        return (
          <div>
            <h2 className="uWizQuestion">How many segments per episode?</h2>
            <p className="uWizHint">Each segment is one debate topic the hosts argue over.</p>
            <div className="uWizStepper">
              <button type="button" className="uWizStepBtn" aria-label="Fewer segments" disabled={segmentCount <= SEGMENT_MIN} onClick={() => setSegmentCount((n) => Math.max(SEGMENT_MIN, n - 1))}>−</button>
              <div className="uWizStepValue">
                <span className="uWizStepNum">{segmentCount}</span>
                <span className="uWizStepUnit">segment{segmentCount === 1 ? "" : "s"}</span>
              </div>
              <button type="button" className="uWizStepBtn" aria-label="More segments" disabled={segmentCount >= SEGMENT_MAX} onClick={() => setSegmentCount((n) => Math.min(SEGMENT_MAX, n + 1))}>＋</button>
            </div>
            <div className="uWizSegDots" aria-hidden="true">
              {Array.from({ length: SEGMENT_MAX }, (_, i) => (
                <span key={i} className={i < segmentCount ? "on" : ""} />
              ))}
            </div>
          </div>
        );

      case "hosts":
        return (
          <div>
            <h2 className="uWizQuestion">Who's in the booth?</h2>
            <p className="uWizHint">Pick up to two for the debate — pick one and we pair them with a sparring partner. (More formats are available in show settings after creation.)</p>
            {hosts.length === 0 ? (
              <p className="uWizHint" style={{ color: "var(--u-ink-2)" }}>No hosts are available right now — you can still finish and pick hosts later.</p>
            ) : (
              <div className="uWizChoiceRow" style={{ flexWrap: "wrap" }}>
                {hosts.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className={`uWizCard ${hostIds.includes(h.id) ? "sel" : ""}`}
                    aria-pressed={hostIds.includes(h.id)}
                    onClick={() => {
                      // Cap at the debate format's two seats (Prompt 7 fixed
                      // the unbounded picker that the server then rejected).
                      setHostIds((prev) => prev.includes(h.id)
                        ? prev.filter((x) => x !== h.id)
                        : prev.length < 2 ? [...prev, h.id] : [prev[0], h.id]);
                      setError(null);
                    }}
                  >
                    <span className="uWizCardEmoji">🎙️</span>
                    <span className="uWizCardTitle">{h.name}</span>
                    <span className="uWizCardSub">{h.role}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );

      case "review": {
        const rows: { label: string; value: string; edit: StepId }[] = [
          { label: "Name", value: name.trim(), edit: "name" },
          {
            label: "Cadence",
            value: cadence === "recurring" ? `Recurring — ${scheduleDays.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(", ")}` : "One-time",
            edit: "name",
          },
          { label: "Verticals", value: allSelected ? "All" : verticals.join(", "), edit: "verticals" },
          ...(hasTeamStep
            ? [{
                label: "Teams",
                value: selectedTeams.length
                  ? visibleTeams.filter((t) => selectedTeams.includes(t.id)).map((t) => t.name).join(", ")
                  : "Whole vertical",
                edit: "teams" as StepId,
              }]
            : []),
          { label: "Segments", value: String(segmentCount), edit: "segments" },
          { label: "Hosts", value: hosts.filter((h) => hostIds.includes(h.id)).map((h) => h.name).join(", ") || "—", edit: "hosts" },
        ];
        return (
          <div>
            <h2 className="uWizQuestion">Look good?</h2>
            <div className="uWizReview">
              {rows.map((r) => (
                <div key={r.label} className="uWizReviewRow">
                  <span className="uWizReviewLabel">{r.label}</span>
                  <span className="uWizReviewValue">{r.value}</span>
                  <button type="button" className="uWizReviewEdit" onClick={() => jumpTo(r.edit)}>Edit</button>
                </div>
              ))}
            </div>
          </div>
        );
      }
    }
  })();

  return (
    <div className="uWiz">
      {/* progress */}
      <div className="uWizProgress" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
        <div className="uWizProgressBar">
          <span style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="uWizProgressSteps">
          {steps.map((s, i) => (
            <span key={s.id} className={`uWizProgressStep ${i === stepIndex ? "now" : i < stepIndex ? "past" : ""}`}>
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div key={`${step.id}-${direction}`} className={`uWizScreen ${direction === "fwd" ? "uWizFwd" : "uWizBack"}`}>
        {screen}
      </div>

      {error && <div role="alert" className="uWizError">{error}</div>}

      <div className="uWizNav">
        {stepIndex > 0 ? (
          <button type="button" className="uRecordBtn" onClick={goBack}>← Back</button>
        ) : <span />}
        {step.id === "review" ? (
          <button type="button" className="uPlayLg uWizNext" disabled={pending} onClick={submit}>
            {pending ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "🎉 Create podcast"}
          </button>
        ) : (
          <button type="button" className="uPlayLg uWizNext" onClick={goNext}>
            {step.id === "teams" && selectedTeams.length === 0 ? "Skip — whole vertical" : "Next →"}
          </button>
        )}
      </div>
    </div>
  );
}
