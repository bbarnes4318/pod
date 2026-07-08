"use client";

// Social clip panel (Step 9a) — auto or manual selection of a 20–45s exchange,
// rendered into a real vertical captioned clip from the episode's own audio.
// Everything here is backed by owner-gated server actions:
//   getClipCandidate → the hottest suggested range + the pickable line list.
//   generateSocialClip → creates a SocialClip + enqueues the render job.
//   getSocialClips → poll status + download links.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getClipCandidate, generateSocialClip, getSocialClips } from "../app/create/actions";

type Line = {
  lineIndex: number;
  speaker: string;
  textShort: string;
  tone: string | null;
  energy: string | null;
  durationMs: number;
  hasAudio: boolean;
};
type Clip = {
  id: string;
  status: string;
  kind: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  captionsUrl: string | null;
  durationMs: number | null;
  startLineIndex: number;
  endLineIndex: number;
  autoSelected: boolean;
  error: string | null;
  createdAt: string | Date;
};

const fmtDur = (ms: number | null) => (ms ? `${Math.round(ms / 1000)}s` : "—");

export default function SocialClipPanel({ episodeId }: { episodeId: string }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | {
    lines: Line[]; suggested: { startLineIndex: number; endLineIndex: number } | null;
    hostA: string; hostB: string; fullyVoiced: boolean;
  }>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const res: any = await getSocialClips(episodeId);
    if (res?.success) setClips(res.clips);
  }, [episodeId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while any clip is still rendering.
  useEffect(() => {
    const pending = clips.some((c) => c.status === "pending" || c.status === "rendering");
    if (pending && !pollRef.current) {
      pollRef.current = setInterval(refresh, 3000);
    } else if (!pending && pollRef.current) {
      clearInterval(pollRef.current); pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [clips, refresh]);

  const autoGenerate = async () => {
    setBusy(true); setErr(null);
    const res: any = await generateSocialClip(episodeId);
    if (res?.success === false) setErr(res.error);
    else await refresh();
    setBusy(false);
  };

  const openPicker = async () => {
    setBusy(true); setErr(null);
    const res: any = await getClipCandidate(episodeId);
    if (res?.success === false) { setErr(res.error); setBusy(false); return; }
    setPicker(res);
    if (res.suggested) setRange({ start: res.suggested.startLineIndex, end: res.suggested.endLineIndex });
    setBusy(false);
  };

  const generateRange = async () => {
    if (!range) return;
    setBusy(true); setErr(null);
    const res: any = await generateSocialClip(episodeId, { startLineIndex: range.start, endLineIndex: range.end });
    if (res?.success === false) setErr(res.error);
    else { setPicker(null); setRange(null); await refresh(); }
    setBusy(false);
  };

  // Selected-range duration estimate in the picker.
  const rangeDur = picker && range
    ? picker.lines.filter((l) => l.lineIndex >= range.start && l.lineIndex <= range.end && l.hasAudio)
        .reduce((a, l) => a + l.durationMs, 0)
    : 0;

  return (
    <div className="studioCard">
      <div className="clipHead">
        <div>
          <div className="sectionTitle" style={{ margin: 0 }}>Social clip</div>
          <div className="clipSub">A vertical 9:16 captioned cut of the spiciest exchange — for promo.</div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btnPrimary" onClick={autoGenerate} disabled={busy}>
            {busy ? "Working…" : "⚡ Auto clip"}
          </button>
          <button type="button" className="btnGhost" onClick={openPicker} disabled={busy}>Pick lines</button>
        </div>
      </div>

      {err && <div className="gateResult gate-err" style={{ marginTop: "0.8rem" }}>{err}</div>}

      {picker && (
        <div className="clipPicker">
          {!picker.fullyVoiced && (
            <div className="advNote" style={{ marginTop: 0 }}>Only voiced lines can be clipped — voice the whole episode for the full range.</div>
          )}
          <div className="clipPickerBar">
            <span className="clipPickerLabel">
              Selected: {range ? `lines ${range.start}–${range.end} · ~${Math.round(rangeDur / 1000)}s` : "click two lines"}
              {rangeDur > 0 && (rangeDur < 20000 || rangeDur > 45000) && (
                <span className="clipWarn"> (aim for 20–45s)</span>
              )}
            </span>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btnPrimary" onClick={generateRange} disabled={busy || !range}>Render this range</button>
              <button type="button" className="btnGhost" onClick={() => { setPicker(null); setRange(null); }}>Cancel</button>
            </div>
          </div>
          <div className="clipLineList">
            {picker.lines.map((l) => {
              const inRange = range && l.lineIndex >= range.start && l.lineIndex <= range.end;
              const isEdge = range && (l.lineIndex === range.start || l.lineIndex === range.end);
              const hot = l.energy === "high" || ["heated", "incredulous", "excited", "dismissive"].includes(l.tone || "");
              return (
                <button
                  key={l.lineIndex}
                  type="button"
                  className={`clipLine${inRange ? " inRange" : ""}${isEdge ? " edge" : ""}${!l.hasAudio ? " noAudio" : ""}`}
                  disabled={!l.hasAudio}
                  onClick={() => {
                    if (!range) setRange({ start: l.lineIndex, end: l.lineIndex });
                    else if (l.lineIndex < range.start) setRange({ ...range, start: l.lineIndex });
                    else if (l.lineIndex > range.end) setRange({ ...range, end: l.lineIndex });
                    else setRange({ start: l.lineIndex, end: l.lineIndex });
                  }}
                >
                  <span className="clipLineSpk">{l.speaker}</span>
                  <span className="clipLineText">{l.textShort}</span>
                  {hot && <span className="clipHot" title={`${l.energy}/${l.tone}`}>🔥</span>}
                  {!l.hasAudio && <span className="clipMuted">no audio</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {clips.length > 0 && (
        <div className="clipList">
          {clips.map((c) => (
            <div key={c.id} className="clipRow">
              <div className="clipRowMain">
                <span className={`clipStatus clip-${c.status}`}>{c.status}</span>
                <span className="clipMeta">
                  lines {c.startLineIndex}–{c.endLineIndex} · {fmtDur(c.durationMs)}
                  {c.autoSelected ? " · auto" : ""}{c.kind ? ` · ${c.kind}` : ""}
                </span>
              </div>
              {c.status === "ready" && (
                <div className="clipDownloads">
                  {c.videoUrl && <a className="btnGhost clipDl" href={c.videoUrl} download>⬇ 9:16 MP4</a>}
                  {c.audioUrl && <a className="btnGhost clipDl" href={c.audioUrl} download>⬇ Audio</a>}
                  {c.captionsUrl && <a className="btnGhost clipDl" href={c.captionsUrl} download>⬇ Captions</a>}
                </div>
              )}
              {(c.status === "pending" || c.status === "rendering") && <span className="clipSpin">rendering…</span>}
              {c.error && <div className="clipErr">{c.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
