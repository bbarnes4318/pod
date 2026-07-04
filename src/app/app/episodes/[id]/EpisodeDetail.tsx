"use client";

// Episode detail — listener-first. Chapters seek within the persistent
// player; the transcript reads like a script, hosts color-coded with the
// episode's accent + the functional host blue.

import React, { useState } from "react";
import { usePlayer, Track } from "../../PlayerBar";
import { fmtClock } from "../../lib";

export interface DetailChapter {
  title: string;
  startFrac: number;
  startSec: number;
}

export interface DetailLine {
  speaker: "MAX" | "DOC";
  text: string;
}

export interface DetailSegment {
  title: string;
  lines: DetailLine[];
}

interface Props {
  track: Track | null; // null when no audio yet
  emoji: string;
  accent: { solid: string; soft: string; tint: string; deep: string };
  meta: string[];
  title: string;
  chapters: DetailChapter[];
  transcript: DetailSegment[];
  stageLabel: string | null; // set when audio not ready
}

export default function EpisodeDetail({ track, emoji, accent, meta, title, chapters, transcript, stageLabel }: Props) {
  const { play, playAt, track: current, playing } = usePlayer();
  const [showTranscript, setShowTranscript] = useState(false);
  const isCurrent = current?.id === track?.id && track !== null;

  return (
    <div className="uContent" style={{ maxWidth: 920 }}>
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "2rem", alignItems: "center", marginBottom: "2rem" }}>
        <div
          className="uHeroCover"
          style={{ background: `linear-gradient(140deg, ${accent.soft}, ${accent.tint} 65%, #fff)`, border: "1px solid var(--u-hairline)" }}
        >
          <span
            className={emoji === "“" ? "quoteMark" : undefined}
            style={{ fontSize: emoji === "“" ? "8rem" : "4.5rem", color: emoji === "“" ? accent.solid : undefined }}
            aria-hidden="true"
          >
            {emoji}
          </span>
        </div>
        <div>
          <div className="uHeroKicker" style={{ color: accent.deep }}>Episode</div>
          <h1 className="uHeroTitle" style={{ fontSize: "1.9rem" }}>{title}</h1>
          <div className="uHeroMeta">
            {meta.map((m, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="uDot" />}
                <span>{m}</span>
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap" }}>
            {track ? (
              <button className="uPlayLg" style={{ background: accent.solid }} onClick={() => play(track)}>
                {isCurrent && playing ? "❚❚ Pause" : "▶ Play episode"}
              </button>
            ) : (
              <span className="uHeat" style={{ background: accent.soft, color: accent.deep, fontSize: "0.85rem", padding: "0.6rem 1.2rem" }}>
                {stageLabel || "In production"}
              </span>
            )}
            {transcript.length > 0 && (
              <button className="uGhostBtn" onClick={() => setShowTranscript((v) => !v)}>
                {showTranscript ? "Hide transcript" : "Read transcript"}
              </button>
            )}
            <button
              className="uGhostBtn"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.share) {
                  void navigator.share({ title, url: window.location.href });
                } else {
                  void navigator.clipboard?.writeText(window.location.href);
                }
              }}
            >
              Share
            </button>
          </div>
        </div>
      </div>

      {/* Chapters */}
      {track && chapters.length > 0 && (
        <>
          <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Chapters</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "2rem" }}>
            {chapters.map((c, i) => (
              <button
                key={i}
                onClick={() => playAt(track, c.startFrac)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.9rem",
                  background: "var(--u-surface)",
                  border: "1px solid var(--u-hairline)",
                  borderRadius: 12,
                  padding: "0.65rem 0.9rem",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 0.15s ease, transform 0.12s ease",
                  fontSize: "0.88rem",
                  fontWeight: 600,
                  color: "var(--u-ink)",
                }}
              >
                <span style={{ fontVariantNumeric: "tabular-nums", color: accent.deep, fontWeight: 700, width: 44 }}>
                  {fmtClock(c.startSec)}
                </span>
                {c.title}
                <span style={{ marginLeft: "auto", color: "var(--u-ink-3)" }}>▶</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Transcript */}
      {showTranscript && (
        <div style={{ background: "var(--u-surface)", border: "1px solid var(--u-hairline)", borderRadius: 16, padding: "1.5rem", marginBottom: "2rem" }}>
          {transcript.map((seg, si) => (
            <div key={si} style={{ marginBottom: "1.4rem" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--u-ink-3)", marginBottom: "0.7rem" }}>
                {seg.title}
              </div>
              {seg.lines.map((line, li) => (
                <div key={li} style={{ display: "flex", gap: "0.8rem", marginBottom: "0.6rem", fontSize: "0.92rem", lineHeight: 1.6 }}>
                  <span style={{ flexShrink: 0, width: 44, fontWeight: 800, fontSize: "0.72rem", paddingTop: 3, color: line.speaker === "DOC" ? "#3E7BD6" : accent.deep }}>
                    {line.speaker}
                  </span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
