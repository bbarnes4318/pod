"use client";

// Persistent bottom player — quiet, always present. The played portion of
// the waveform takes the CURRENT EPISODE's accent, not a global brand color.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface Track {
  id: string;
  title: string;
  audioUrl: string;
  accentSolid: string;
  accentSoft: string;
  coverEmoji?: string;
  hosts?: string;
}

interface PlayerCtx {
  track: Track | null;
  playing: boolean;
  play: (t: Track) => void;
  toggle: () => void;
  /** Seek within the CURRENT track (0..1). No-op if nothing is loaded. */
  seekFrac: (frac: number) => void;
  /** Load a track (if needed) and jump to a fraction of it. */
  playAt: (t: Track, frac: number) => void;
}

const Ctx = createContext<PlayerCtx>({
  track: null,
  playing: false,
  play: () => {},
  toggle: () => {},
  seekFrac: () => {},
  playAt: () => {},
});

export function usePlayer() {
  return useContext(Ctx);
}

// Deterministic waveform silhouette (identical SSR/client render).
function bars(seed: number, n = 72): number[] {
  const out: number[] = [];
  let a = (seed || 7) >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    const r = a / 4294967296;
    const envelope = 0.5 + 0.5 * Math.sin((i / n) * Math.PI * 1.1 + 0.3);
    out.push(8 + Math.round(r * 22 * envelope));
  }
  return out;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const OPEN_KEY = "tm.playerOpen";

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [open, setOpen] = useState(true);

  // Session-persisted open/closed state. Read in an effect (not lazy init)
  // so the SSR and first client render agree.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(OPEN_KEY) === "0") setOpen(false);
    } catch {
      // sessionStorage unavailable (private mode etc.) — stay open
    }
  }, []);

  const setOpenPersist = useCallback((v: boolean) => {
    setOpen(v);
    try {
      sessionStorage.setItem(OPEN_KEY, v ? "1" : "0");
    } catch {
      // best effort
    }
  }, []);

  const closePlayer = useCallback(() => {
    audioRef.current?.pause(); // closing pauses playback
    setOpenPersist(false);
  }, [setOpenPersist]);

  const play = useCallback((t: Track) => {
    const a = audioRef.current;
    if (!a) return;
    setOpenPersist(true); // starting playback always resurfaces the bar
    if (track?.id === t.id) {
      if (a.paused) void a.play();
      else a.pause();
      return;
    }
    setTrack(t);
    a.src = t.audioUrl;
    a.currentTime = 0;
    void a.play();
  }, [track, setOpenPersist]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || !track) return;
    if (a.paused) void a.play();
    else a.pause();
  }, [track]);

  const seekFracFn = useCallback((frac: number) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = Math.max(0, Math.min(0.999, frac)) * a.duration;
  }, []);

  const playAt = useCallback((t: Track, frac: number) => {
    const a = audioRef.current;
    if (!a) return;
    setOpenPersist(true); // starting playback always resurfaces the bar
    if (track?.id === t.id && a.duration) {
      a.currentTime = Math.max(0, Math.min(0.999, frac)) * a.duration;
      if (a.paused) void a.play();
      return;
    }
    setTrack(t);
    a.src = t.audioUrl;
    const onMeta = () => {
      if (a.duration) a.currentTime = Math.max(0, Math.min(0.999, frac)) * a.duration;
      a.removeEventListener("loadedmetadata", onMeta);
    };
    a.addEventListener("loadedmetadata", onMeta);
    void a.play();
  }, [track, setOpenPersist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.code === "Space" && track) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, track]);

  const waveform = useMemo(() => bars(track ? track.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) : 7), [track]);
  const playedFrac = duration > 0 ? current / duration : 0;

  const seek = (e: React.MouseEvent) => {
    const a = audioRef.current;
    const el = waveRef.current;
    if (!a || !el || !a.duration) return;
    const rect = el.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / rect.width)) * a.duration;
  };

  const value = useMemo(
    () => ({ track, playing, play, toggle, seekFrac: seekFracFn, playAt }),
    [track, playing, play, toggle, seekFracFn, playAt]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />

      {open ? (
      <div className="uPlayerBar" role="region" aria-label="Player">
        {track ? (
          <>
            <div className="uPbCover" style={{ background: track.accentSoft }} aria-hidden="true">
              {track.coverEmoji || "🎙"}
            </div>
            <div className="uPbInfo">
              <div className="uPbTitle">{track.title}</div>
              <div className="uPbHost">
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: track.accentSolid, display: "inline-block" }} />
                {track.hosts || "Max Voltage & Dr. Linebreak"}
              </div>
            </div>

            <button className="uPbBtn" aria-label="Back 15 seconds" onClick={() => { const a = audioRef.current; if (a) a.currentTime = Math.max(0, a.currentTime - 15); }}>
              ↺
            </button>
            <button
              className="uPbPlay"
              style={{ background: track.accentSolid }}
              aria-label={playing ? "Pause" : "Play"}
              onClick={toggle}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <button className="uPbBtn" aria-label="Forward 15 seconds" onClick={() => { const a = audioRef.current; if (a) a.currentTime = Math.min(a.duration || 0, a.currentTime + 15); }}>
              ↻
            </button>

            <div
              ref={waveRef}
              className="uPbWave"
              onClick={seek}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(current)}
              tabIndex={0}
            >
              {waveform.map((h, i) => (
                <span
                  key={i}
                  style={{
                    height: h,
                    background: i / waveform.length <= playedFrac ? track.accentSolid : "var(--u-hairline-2)",
                  }}
                />
              ))}
            </div>

            <div className="uPbTime">
              {fmt(current)} / {fmt(duration)}
            </div>
          </>
        ) : (
          <div className="uPbEmpty">
            <span style={{ fontSize: "1.05rem" }}>🎧</span>
            Pick an episode to start listening
          </div>
        )}
        <button className="uPbBtn uPbClose" aria-label="Close player" title="Close player" onClick={closePlayer}>
          ✕
        </button>
      </div>
      ) : (
        <button className="uPlayerPill" aria-label="Open player" onClick={() => setOpenPersist(true)}>
          <span aria-hidden="true">🎧</span>
          <span className="uPillLabel">{track ? track.title : "Player"}</span>
        </button>
      )}
    </Ctx.Provider>
  );
}
