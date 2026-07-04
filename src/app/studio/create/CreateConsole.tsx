"use client";

// The guided take → episode flow. Each take card exposes exactly ONE next
// step (approve → research → create episode → write script), and each
// in-flight episode shows a stage stepper with its single next action.
// All mutations reuse the existing ops server actions — no new pipeline.

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { approveTopic } from "../../admin/topics/actions";
import { triggerResearchBriefGeneration } from "../../admin/research-briefs/actions";
import { createEpisodeFromSelectedTopics, triggerScriptGeneration } from "../../admin/episodes/actions";

const STAGES = ["Take", "Script", "Fact-check", "Voices", "Mix", "Publish"] as const;

function stageIndexFor(status: string): number {
  switch (status) {
    case "draft": return 1;
    case "script_draft": return 1;
    case "script_approved": return 2;
    case "fact_checked": return 3;
    case "audio_segments_ready": return 4;
    case "audio_stitching": return 4;
    case "audio_ready":
    case "content_ready":
    case "publish_ready": return 5;
    case "published": return 6;
    default: return 0;
  }
}

interface TakeVM {
  id: string;
  title: string;
  sport: string;
  status: string;
  hasBrief: boolean;
  talkability: number;
  scores: { label: string; value: number }[];
}

interface EpisodeVM {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  scriptId: string | null;
  nextLabel: string;
  nextHref: string;
}

export default function CreateConsole({ takes, episodes, highlightTopic }: {
  takes: TakeVM[];
  episodes: EpisodeVM[];
  highlightTopic?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = (id: string, fn: () => Promise<{ success?: boolean; error?: string } | void>, successNote: string) => {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      try {
        const res = await fn();
        if (res && res.success === false) {
          setNote(res.error || "That didn't work — check the ops console.");
        } else {
          setNote(successNote);
          router.refresh();
        }
      } catch (err: unknown) {
        setNote(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setBusyId(null);
      }
    });
  };

  const takeAction = (t: TakeVM) => {
    if (t.status === "pending") {
      return { label: "Approve this take", fn: () => approveTopic(t.id), note: "Take approved. Next: research it." };
    }
    if (!t.hasBrief) {
      return {
        label: "Research it",
        fn: () => triggerResearchBriefGeneration(t.id, false),
        note: "Research queued — the brief lands in about a minute. Refresh to continue.",
      };
    }
    return {
      label: "Create the episode",
      fn: async () => {
        const res: any = await createEpisodeFromSelectedTopics([t.id]);
        return res;
      },
      note: "Episode created — now write the script below.",
    };
  };

  return (
    <div>
      {note && (
        <div className="studioCard" role="status" style={{ borderColor: "rgba(255,90,31,0.4)", marginBottom: "1.25rem", fontSize: "0.9rem" }}>
          {note}
        </div>
      )}

      {/* ---- In production ---- */}
      {episodes.length > 0 && (
        <>
          <div className="sectionHead" style={{ marginTop: 0 }}>
            <h2 className="sectionTitle">In production</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1rem" }}>
            {episodes.map((ep) => {
              const idx = stageIndexFor(ep.status);
              return (
                <div key={ep.id} className="studioCard">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="epTitle" style={{ fontSize: "1.02rem", marginBottom: "0.7rem" }}>{ep.title}</div>
                      {/* Stage stepper */}
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        {STAGES.map((s, i) => (
                          <React.Fragment key={s}>
                            <span
                              className="chip"
                              style={
                                i < idx
                                  ? { background: "var(--success-muted)", color: "var(--success-color)", borderColor: "var(--success-border)" }
                                  : i === idx
                                    ? { background: "var(--accent-muted)", color: "var(--accent-color)", borderColor: "rgba(255,90,31,0.4)" }
                                    : {}
                              }
                            >
                              {i < idx ? "✓ " : ""}{s}
                            </span>
                            {i < STAGES.length - 1 && <span style={{ color: "var(--border-hover)" }}>—</span>}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                    {ep.status === "draft" ? (
                      <button
                        className="btnPrimary"
                        disabled={pending && busyId === ep.id}
                        onClick={() => run(ep.id, () => triggerScriptGeneration(ep.id) as any, "Script generation queued — it'll appear in Scripts for review in a couple of minutes.")}
                      >
                        {pending && busyId === ep.id ? "Queuing…" : "Write the script"}
                      </button>
                    ) : (
                      <Link href={ep.nextHref} className="btnPrimary">{ep.nextLabel} →</Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---- Start from a take ---- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Start from a take</h2>
        <Link href="/studio/takes" className="sectionAction">Browse all takes →</Link>
      </div>
      {takes.length === 0 ? (
        <div className="emptyNote">
          No takes available. <Link href="/admin/topics" style={{ color: "var(--accent-color)" }}>Generate topics</Link> in ops first.
        </div>
      ) : (
        <div className="grid2">
          {takes.map((t) => {
            const action = takeAction(t);
            const highlighted = t.id === highlightTopic;
            return (
              <div key={t.id} className="studioCard" style={highlighted ? { borderColor: "var(--accent-color)", boxShadow: "var(--shadow-accent)" } : undefined}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="epMeta" style={{ marginBottom: "0.35rem" }}>
                      <span className="chip">{t.sport}</span>
                      {t.hasBrief && <span className="chip chipSuccess">Researched</span>}
                      {t.status === "pending" && <span className="chip">Needs approval</span>}
                    </div>
                    <div className="epTitle" style={{ fontSize: "1.02rem" }}>{t.title}</div>
                  </div>
                  <div className="scoreBadge">{t.talkability}<small>/100</small></div>
                </div>
                <div style={{ margin: "0.75rem 0 0.9rem" }}>
                  {t.scores.map((s) => (
                    <div key={s.label} className="axisRow">
                      <span>{s.label}</span>
                      <div className="scoreBarTrack"><div className="scoreBarFill" style={{ width: `${Math.min(100, s.value)}%` }} /></div>
                      <strong>{Math.round(s.value)}</strong>
                    </div>
                  ))}
                </div>
                <button
                  className="btnPrimary"
                  style={{ width: "100%" }}
                  disabled={pending && busyId === t.id}
                  onClick={() => run(t.id, action.fn as any, action.note)}
                >
                  {pending && busyId === t.id ? "Working…" : action.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
