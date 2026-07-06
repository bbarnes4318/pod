"use client";

// The simple create flow: pick a hot take, tap once, watch it become an
// episode. Each card exposes exactly one next action; production progress
// uses listener-friendly stage language. All mutations reuse the existing
// ops server actions — no new pipeline.

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { approveTake, researchTake, produceEpisodeFromTopics, startDebate, createStandaloneEpisode } from "./actions";
import { VERTICALS } from "@/lib/verticals";
import { SEGMENT_MIN, SEGMENT_MAX, SEGMENT_DEFAULT } from "../podcasts/config";
import VoicePicker from "./VoicePicker";

export interface FlowTake {
  id: string;
  title: string;
  sport: string;
  emoji: string;
  status: string;
  hasBrief: boolean;
  debateScore: number;
  accent: { solid: string; soft: string; tint: string; deep: string };
}

export interface FlowEpisode {
  id: string;
  title: string;
  status: string;
  stageLabel: string;
  stageIndex: number; // 0..3 (Take → Produce → Review → Listen)
  ready: boolean;
  voiceLabel?: string | null; // pinned voice engine, e.g. "Fish Audio"
}

const STEPS = ["Pick the take", "We produce it", "Listen & share"];

export default function CreateFlow({ takes, episodes, highlight, defaultEngineHint }: { takes: FlowTake[]; episodes: FlowEpisode[]; highlight?: string; defaultEngineHint: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Voice engine for the next produced episode; persisted on the episode at
  // creation so re-runs keep using it. "default" = don't pin one.
  const [engine, setEngine] = useState("default");
  // Instant episode: no podcast, no take-picking — auto-select best topics.
  const [instantVertical, setInstantVertical] = useState<string>("All");
  const [instantSegments, setInstantSegments] = useState(SEGMENT_DEFAULT);

  const run = (id: string, fn: () => Promise<any>, successNote: string) => {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      try {
        const res = await fn();
        if (res && res.success === false) setNote(res.error || "That didn't work — try again in a moment.");
        else {
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

  const actionFor = (t: FlowTake) => {
    if (t.status === "pending") return { label: "Start with this take", note: "Take locked in. Tap again to start the research.", fn: () => approveTake(t.id) };
    if (!t.hasBrief) return { label: "Research it", note: "Digging into the story — takes about a minute. Refresh to continue.", fn: () => researchTake(t.id, false) };
    return {
      label: "Produce the episode",
      note: "Episode created! The hosts start arguing below.",
      fn: async () => {
        const res: any = await produceEpisodeFromTopics([t.id], engine === "default" ? undefined : engine);
        return res;
      },
    };
  };

  return (
    <div>
      <VoicePicker value={engine} onChange={setEngine} defaultHint={defaultEngineHint} />

      {/* 3-step explainer */}
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: "1.6rem", flexWrap: "wrap" }}>
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", fontSize: "0.82rem", fontWeight: 650, color: i === 0 ? "var(--u-brand)" : "var(--u-ink-3)" }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: i === 0 ? "var(--u-brand)" : "var(--u-hairline)", color: i === 0 ? "#fff" : "var(--u-ink-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 800 }}>
                {i + 1}
              </span>
              {s}
            </span>
            {i < STEPS.length - 1 && <span style={{ color: "var(--u-hairline-2)" }}>———</span>}
          </React.Fragment>
        ))}
      </div>

      {note && (
        <div role="status" style={{ background: "var(--u-brand-soft)", border: "1px solid #dfe5ff", color: "var(--u-brand)", borderRadius: 12, padding: "0.8rem 1.1rem", fontSize: "0.86rem", fontWeight: 600, marginBottom: "1.2rem" }}>
          {note}
        </div>
      )}

      {/* Instant episode — standalone, no podcast setup required */}
      <div className="uTakeCard" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.8rem", marginBottom: "1.6rem", borderColor: "var(--u-brand)", background: "var(--u-brand-soft)" }}>
        <div>
          <div className="uTakeTitle" style={{ fontSize: "0.98rem" }}>⚡ Instant episode</div>
          <p style={{ fontSize: "0.82rem", color: "var(--u-ink-2)", margin: "0.3rem 0 0", lineHeight: 1.5 }}>
            Skip the picking — we grab the best researched takes and produce a full episode.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap", alignItems: "center" }}>
          <select
            className="uWizInput"
            style={{ width: "auto", marginBottom: 0, padding: "0.5rem 0.8rem", fontSize: "0.84rem" }}
            aria-label="Vertical"
            value={instantVertical}
            onChange={(e) => setInstantVertical(e.target.value)}
          >
            {VERTICALS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select
            className="uWizInput"
            style={{ width: "auto", marginBottom: 0, padding: "0.5rem 0.8rem", fontSize: "0.84rem" }}
            aria-label="Segments"
            value={instantSegments}
            onChange={(e) => setInstantSegments(Number(e.target.value))}
          >
            {Array.from({ length: SEGMENT_MAX - SEGMENT_MIN + 1 }, (_, i) => SEGMENT_MIN + i).map((n) => (
              <option key={n} value={n}>{n} segment{n === 1 ? "" : "s"}</option>
            ))}
          </select>
          <button
            className="uPlayLg"
            style={{ background: "var(--u-brand)", padding: "0.55rem 1.2rem", fontSize: "0.84rem" }}
            disabled={pending && busyId === "instant"}
            onClick={() =>
              run(
                "instant",
                () => createStandaloneEpisode({ vertical: instantVertical, segmentCount: instantSegments }),
                "On it — your episode shows up under \"in production\" in a moment. Refresh to follow along."
              )
            }
          >
            {pending && busyId === "instant" ? "Queuing…" : "Create episode now"}
          </button>
        </div>
      </div>

      {/* In production */}
      {episodes.length > 0 && (
        <>
          <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Your episodes in production</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem", marginBottom: "2rem" }}>
            {episodes.map((ep) => (
              <div key={ep.id} className="uTakeCard" style={{ justifyContent: "space-between" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="uTakeTitle">{ep.title}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "0.55rem", maxWidth: 380 }}>
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} style={{ flex: 1, height: 5, borderRadius: 3, background: i <= ep.stageIndex ? "var(--u-brand)" : "var(--u-hairline)" }} />
                    ))}
                  </div>
                  <div className="uTakeMeta" style={{ marginTop: "0.4rem" }}>
                    {!ep.ready && !ep.status.includes("ready") && ep.status !== "draft" && (
                      <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--u-brand)", animation: "uPulse 1.6s ease-in-out infinite" }} />
                    )}
                    {ep.stageLabel}
                    {ep.voiceLabel && <span> · Voice: {ep.voiceLabel}</span>}
                  </div>
                </div>
                {ep.status === "draft" ? (
                  <button
                    className="uRecordBtn"
                    style={{ borderColor: "var(--u-brand)", color: "var(--u-brand)" }}
                    disabled={pending && busyId === ep.id}
                    onClick={() => run(ep.id, () => startDebate(ep.id) as any, "The hosts are writing — the debate takes a few minutes.")}
                  >
                    {pending && busyId === ep.id ? "Starting…" : "Start the debate"}
                  </button>
                ) : ep.ready ? (
                  <Link href={`/app/episodes/${ep.id}`} className="uRecordBtn" style={{ textDecoration: "none", borderColor: "var(--u-brand)", color: "var(--u-brand)" }}>
                    ▶ Listen
                  </Link>
                ) : (
                  <Link href={`/app/episodes/${ep.id}`} className="uRecordBtn" style={{ textDecoration: "none" }}>
                    View
                  </Link>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pick a take */}
      <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Pick a take</h2>
      {takes.length === 0 ? (
        <p style={{ color: "var(--u-ink-3)", fontSize: "0.88rem" }}>No takes available right now — check back soon.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0.9rem" }}>
          {takes.map((t) => {
            const action = actionFor(t);
            const hl = t.id === highlight;
            return (
              <div key={t.id} className="uTakeCard" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.8rem", ...(hl ? { borderColor: "var(--u-brand)", boxShadow: "0 0 0 3px var(--u-brand-soft)" } : {}) }}>
                <div style={{ display: "flex", gap: "0.9rem", alignItems: "center" }}>
                  <div className="uTakeScore" style={{ background: t.accent.tint, color: t.accent.deep }}>
                    {Math.round(t.debateScore)}
                    <small>DEBATE</small>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="uTakeTitle">{t.title}</div>
                    <div className="uTakeMeta">
                      <span>{t.emoji} {t.sport}</span>
                      {t.hasBrief && <span className="uHeat" style={{ background: t.accent.soft, color: t.accent.deep }}>Researched</span>}
                    </div>
                  </div>
                </div>
                <button
                  className="uPlayLg"
                  style={{ background: t.accent.solid, padding: "0.6rem 1.2rem", fontSize: "0.86rem", justifyContent: "center" }}
                  disabled={pending && busyId === t.id}
                  onClick={() => run(t.id, action.fn, action.note)}
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
