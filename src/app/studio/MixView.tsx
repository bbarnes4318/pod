"use client";

// Step 5 — mix / timeline view. A dialogue lane (per-line blocks, host-coloured,
// sized by REAL AudioSegment.durationMs), the music-bed lane from the real
// sound-design plan, cue markers from the persisted ProductionPlan, a
// play/scrub control with the active region highlighted in orange, per-line
// re-voice (line-level regen — one line of TTS, not a full re-render), and a
// cheap table-read preview. All audio is real; nothing is mocked.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getMixView, regenerateLineAudio, tableReadEpisode } from "../app/create/actions";
import type { MixVM, MixLineVM } from "@/lib/services/mixView";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function MixView({ episodeId, initialVm }: { episodeId: string; initialVm?: MixVM }) {
  const [vm, setVm] = useState<MixVM | null>(initialVm ?? null);
  const [loading, setLoading] = useState(!initialVm);
  const [note, setNote] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [posMs, setPosMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Separate element for playing individual line clips (table read / per-line
  // preview) — these are the raw AudioSegment.audioUrl files, not the mix.
  const clipRef = useRef<HTMLAudioElement | null>(null);
  const clipQueue = useRef<string[]>([]);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [tableRange, setTableRange] = useState<{ start: number; end: number } | null>(null);

  const playClips = useCallback((urls: string[]) => {
    const list = urls.filter(Boolean);
    if (list.length === 0) return;
    clipQueue.current = list.slice(1);
    setClipUrl(list[0]);
  }, []);
  const onClipEnded = () => {
    const next = clipQueue.current.shift();
    if (next) setClipUrl(next);
    else setClipUrl(null);
  };
  useEffect(() => {
    if (clipUrl && clipRef.current) {
      clipRef.current.src = clipUrl;
      clipRef.current.play().catch(() => {});
    }
  }, [clipUrl]);

  const refresh = useCallback(async () => {
    try {
      const next = (await getMixView(episodeId)) as MixVM;
      setVm(next);
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, [episodeId]);

  useEffect(() => {
    if (!initialVm) refresh();
  }, [initialVm, refresh]);

  // While a regen/table-read job runs, poll for the refreshed mix — capped so
  // it never polls forever (jobs finish in well under 2 minutes).
  const pollCount = useRef(0);
  useEffect(() => {
    if (!polling) return;
    pollCount.current = 0;
    const id = setInterval(() => {
      pollCount.current += 1;
      refresh();
      if (pollCount.current >= 40) setPolling(false); // ~2 min
    }, 3000);
    return () => clearInterval(id);
  }, [polling, refresh]);

  if (loading && !vm) return <div className="stageHint">Loading mix…</div>;
  if (!vm || !vm.ok) return <div className="emptyNote">{vm?.error || "No mix available yet."}</div>;
  if (vm.segments.length === 0) return <div className="emptyNote">No script yet — the mix appears once the debate is written.</div>;

  const colorFor = (speaker: string) => {
    const s = speaker.trim().toLowerCase();
    if (s === vm.hostA.name.toLowerCase()) return "var(--host-max)";
    if (s === vm.hostB.name.toLowerCase()) return "var(--host-doc)";
    return "var(--text-muted)";
  };

  const allLines: MixLineVM[] = vm.segments.flatMap((s) => s.lines);
  const activeLine = allLines.find((l) => posMs >= l.startMs && posMs < l.startMs + l.durationMs) || null;

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a || !vm.durationSeconds) return;
    // Map the real audio position onto our approximate line timeline.
    setPosMs((a.currentTime / a.duration) * vm.totalMs);
  };
  const seekTo = (ms: number) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = (ms / vm.totalMs) * a.duration;
    setPosMs(ms);
  };
  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };

  const revoice = async (lineIndex: number, tone?: "spicier" | "calmer") => {
    setBusyLine(lineIndex);
    setNote(null);
    try {
      const res: any = await regenerateLineAudio(episodeId, lineIndex, tone ? { tone } : undefined);
      if (res?.success === false) setNote(res.error || "Couldn't re-voice that line.");
      else {
        setNote(`Re-voicing line #${lineIndex + 1} and re-splicing the mix — only this line is re-synthesized.`);
        setPolling(true);
      }
    } finally {
      setBusyLine(null);
    }
  };

  const startTableRead = async () => {
    // A "few key lines": the first up-to-6 lines of the first non-intro segment.
    const seg = vm.segments.find((s) => s.type === "topic") || vm.segments[0];
    const idxs = seg.lines.slice(0, 6).map((l) => l.lineIndex);
    if (idxs.length === 0) return;
    setNote(null);
    const start = Math.min(...idxs), end = Math.max(...idxs);
    const res: any = await tableReadEpisode(episodeId, start, end);
    if (res?.success === false) setNote(res.error || "Couldn't start the table read.");
    else {
      setTableRange({ start, end });
      setNote("Table read queued — synthesizing a short exchange so you can hear the vibe. Hit ▶ Play table read when it's ready.");
      setPolling(true);
    }
  };

  // Lines in the requested table-read range that are now voiced.
  const tableLines = tableRange
    ? vm.segments.flatMap((s) => s.lines).filter((l) => l.lineIndex >= tableRange.start && l.lineIndex <= tableRange.end && l.hasAudio)
    : [];
  const tableReady = tableRange && tableLines.length === tableRange.end - tableRange.start + 1;

  const scale = (ms: number) => `${(ms / vm.totalMs) * 100}%`;

  return (
    <div className="mixView">
      {note && <div className="createAlert" role="status" style={{ marginBottom: "0.9rem" }}>{note}</div>}

      {/* Transport */}
      <div className="mixTransport">
        {vm.episodeAudioUrl ? (
          <>
            <button className="mixPlay" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? "⏸" : "▶"}</button>
            <div className="mixScrub" onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seekTo(((e.clientX - r.left) / r.width) * vm.totalMs);
            }}>
              <div className="mixScrubFill" style={{ width: scale(posMs) }} />
              <div className="mixPlayhead" style={{ left: scale(posMs) }} />
            </div>
            <span className="mixClock">{fmt(posMs)} / {fmt(vm.totalMs)}</span>
            <audio ref={audioRef} src={vm.episodeAudioUrl} onTimeUpdate={onTimeUpdate} onEnded={() => setPlaying(false)} preload="metadata" style={{ display: "none" }} />
          </>
        ) : (
          <div className="stageHint" style={{ margin: 0 }}>No stitched mix yet — run a table read below, or voice + mix the episode.</div>
        )}
        {tableReady ? (
          <button className="btnPrimary mixTableReadBtn" onClick={() => playClips(tableLines.map((l) => l.audioUrl!).filter(Boolean))}>▶ Play table read</button>
        ) : (
          <button className="btnGhost mixTableReadBtn" onClick={startTableRead}>🎧 Table read (first exchange)</button>
        )}
        <audio ref={clipRef} onEnded={onClipEnded} preload="none" style={{ display: "none" }} />
      </div>

      {/* Timeline */}
      <div className="mixTimeline">
        {/* Dialogue lane */}
        <div className="mixLaneLabel">Dialogue</div>
        <div className="mixLane mixDialogueLane">
          {allLines.map((l) => {
            const active = activeLine?.lineIndex === l.lineIndex;
            return (
              <div
                key={l.lineIndex}
                className={`mixBlock${active ? " mixBlock-active" : ""}${!l.hasAudio ? " mixBlock-unvoiced" : ""}${l.dirty ? " mixBlock-dirty" : ""}`}
                style={{ left: scale(l.startMs), width: `calc(${scale(l.durationMs)} - 2px)`, borderColor: colorFor(l.speaker) }}
                title={`${l.speaker}: ${l.textShort}${l.hasAudio ? "" : " (not voiced)"}`}
                onClick={() => seekTo(l.startMs)}
              >
                <span className="mixBlockBar" style={{ background: colorFor(l.speaker) }} />
              </div>
            );
          })}
        </div>

        {/* Music-bed lane */}
        <div className="mixLaneLabel">Music bed</div>
        <div className="mixLane mixBedLane">
          {vm.bed.present ? (
            <div className="mixBedBlock" style={{ width: "100%" }}>
              <span className="mixBedText">Ducked music bed · {vm.bed.style} mix{vm.bed.sfxDensity ? ` · SFX ${vm.bed.sfxDensity}` : ""}</span>
            </div>
          ) : (
            <div className="mixBedEmpty">No music bed ({vm.bed.style || "clean"} mix)</div>
          )}
          {/* Cue markers from the real ProductionPlan */}
          {vm.cues.map((c, i) => (
            <span key={i} className={`mixCue mixCue-${c.type}`} style={{ left: scale(c.startMs) }} title={`${c.type}: ${c.label}`} />
          ))}
        </div>
      </div>

      {vm.cues.length > 0 && (
        <div className="mixCueLegend">
          {vm.cues.length} sound-design cue{vm.cues.length === 1 ? "" : "s"} from the mix plan (stingers, reactions, bed).
        </div>
      )}

      {/* Per-line re-voice list */}
      <div className="mixLineList">
        <div className="sectionTitle" style={{ fontSize: "0.95rem", margin: "0 0 0.6rem" }}>Lines — re-voice individually</div>
        {!vm.fullyVoiced && (
          <div className="stageHint" style={{ marginBottom: "0.6rem" }}>
            Line re-voice re-splices the finished mix, so it needs every line voiced first. Blocks above show which lines aren&apos;t voiced yet.
          </div>
        )}
        {vm.segments.map((seg, si) => (
          <div key={si} className="mixSeg">
            <div className="chip chipAccent" style={{ marginBottom: "0.4rem" }}>{seg.title}</div>
            {seg.lines.map((l) => (
              <div key={l.lineIndex} className={`mixLineRow${activeLine?.lineIndex === l.lineIndex ? " mixLineRow-active" : ""}`}>
                <span className="mixLineSpeaker" style={{ color: colorFor(l.speaker) }}>{l.speaker}</span>
                <span className="mixLineText" onClick={() => seekTo(l.startMs)} role="button" tabIndex={0}>{l.textShort}</span>
                {l.hasAudio ? (
                  <button className="tMini" title="Play this line's clip" onClick={() => playClips([l.audioUrl!])}>▶</button>
                ) : (
                  <span className="chip" title="Not synthesized yet">unvoiced</span>
                )}
                <div className="mixLineActions">
                  <button className="tMini" disabled={busyLine === l.lineIndex || !vm.fullyVoiced} onClick={() => revoice(l.lineIndex, "spicier")}>🌶 Spicier</button>
                  <button className="tMini" disabled={busyLine === l.lineIndex || !vm.fullyVoiced} onClick={() => revoice(l.lineIndex, "calmer")}>🧊 Calmer</button>
                  <button className="tMini" disabled={busyLine === l.lineIndex || !vm.fullyVoiced} onClick={() => revoice(l.lineIndex)}>{busyLine === l.lineIndex ? "…" : "↻ Re-voice"}</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
