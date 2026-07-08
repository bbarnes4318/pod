"use client";

// The premium episode player — the payoff moment of the product.
//
// - Canvas waveform decoded from the real audio (Web Audio API). If decode
//   fails (CORS, codec), falls back to a deterministic pseudo-waveform so
//   the player always works.
// - Click/drag scrubbing, keyboard control (space, ←/→ = ±5s), speed cycle.
// - Host strip: who's talking when (host A = signal orange, host B = ice
//   blue — a functional data color, the one sanctioned second hue).
// - Chapter markers from the script's segments; click to jump.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PlayerChapter {
  title: string;
  type: string;
  startFrac: number; // 0..1
}

export interface HostSpan {
  hostSlot: 0 | 1;
  startFrac: number;
  endFrac: number;
}

interface Props {
  audioUrl: string;
  title: string;
  chapters: PlayerChapter[];
  hostSpans: HostSpan[];
  hostNames: [string, string];
  episodeId?: string; // for the play-event beacon (Step 9b analytics)
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const HOST_COLORS = ["#ff5a1f", "#58a6ff"]; // A = signal orange, B = ice blue (functional)

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Deterministic fallback waveform (seeded), used when decoding isn't possible. */
function pseudoPeaks(n: number, seed = 7): number[] {
  const out: number[] = [];
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    const r = a / 4294967296;
    const envelope = 0.55 + 0.45 * Math.sin((i / n) * Math.PI);
    out.push(0.25 + r * 0.75 * envelope);
  }
  return out;
}

export default function StudioPlayer({ audioUrl, title, chapters, hostSpans, hostNames, episodeId }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Fire the play beacon at most once per mount (real "play" event, deduped
  // server-side per client/day). Fire-and-forget; never blocks playback.
  const beaconSentRef = useRef(false);
  const sendPlayBeacon = () => {
    if (beaconSentRef.current || !episodeId) return;
    beaconSentRef.current = true;
    try {
      const body = JSON.stringify({ episodeId });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/analytics/play", new Blob([body], { type: "application/json" }));
      else void fetch("/api/analytics/play", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
    } catch {
      /* analytics must never break the player */
    }
  };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const peaksRef = useRef<number[]>(pseudoPeaks(160));
  const rafRef = useRef<number>(0);
  const draggingRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [decoded, setDecoded] = useState(false);

  // ---- Decode real waveform (best effort) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(audioUrl, { mode: "cors" });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const AC: typeof AudioContext = (window.AudioContext || (window as any).webkitAudioContext);
        const ctx = new AC();
        const audio = await ctx.decodeAudioData(buf);
        const ch = audio.getChannelData(0);
        const buckets = 160;
        const per = Math.floor(ch.length / buckets);
        const peaks: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let max = 0;
          const start = i * per;
          for (let j = 0; j < per; j += 32) {
            const v = Math.abs(ch[start + j] || 0);
            if (v > max) max = v;
          }
          peaks.push(Math.max(0.06, Math.min(1, max * 1.4)));
        }
        if (!cancelled) {
          peaksRef.current = peaks;
          setDecoded(true);
        }
        ctx.close();
      } catch {
        /* keep pseudo waveform */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  // ---- Draw ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const peaks = peaksRef.current;
    const n = peaks.length;
    const gap = 2;
    const bw = Math.max(2, (w - gap * (n - 1)) / n);
    const playedFrac = audio.duration ? audio.currentTime / audio.duration : 0;

    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const bh = Math.max(3, peaks[i] * (h - 6));
      const y = (h - bh) / 2;
      const frac = i / n;
      if (frac <= playedFrac) {
        const grad = g.createLinearGradient(0, y, 0, y + bh);
        grad.addColorStop(0, "#ffb224");
        grad.addColorStop(1, "#ff5a1f");
        g.fillStyle = grad;
      } else {
        g.fillStyle = "rgba(151, 160, 181, 0.28)";
      }
      g.beginPath();
      g.roundRect(x, y, bw, bh, 2);
      g.fill();
    }
  }, []);

  useEffect(() => {
    const loop = () => {
      draw();
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setCurrent(audio.currentTime);
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    if (playing) {
      rafRef.current = requestAnimationFrame(loop);
    } else {
      draw();
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, draw, decoded, current]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // ---- Controls ----
  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + delta));
    setCurrent(a.currentTime);
  }, []);

  const seekFrac = useCallback((frac: number) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = Math.max(0, Math.min(0.999, frac)) * a.duration;
    setCurrent(a.currentTime);
  }, []);

  const fracFromEvent = useCallback((e: { clientX: number }) => {
    const el = wrapRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return (e.clientX - rect.left) / rect.width;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        seekBy(-5);
      } else if (e.key === "ArrowRight") {
        seekBy(5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seekBy]);

  const speed = SPEEDS[speedIdx];
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const currentChapter = useMemo(() => {
    if (!duration || chapters.length === 0) return null;
    const frac = current / duration;
    let found: PlayerChapter | null = null;
    for (const c of chapters) {
      if (c.startFrac <= frac) found = c;
    }
    return found;
  }, [current, duration, chapters]);

  return (
    <div className="studioCard" style={{ padding: "1.5rem" }}>
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onPlay={() => { setPlaying(true); sendPlayBeacon(); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => !playing && setCurrent(e.currentTarget.currentTime)}
      />

      {/* Transport row */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.9rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <button
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="btnPrimary"
          style={{ width: 56, height: 56, borderRadius: "50%", fontSize: "1.3rem", padding: 0 }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btnGhost" onClick={() => seekBy(-15)} aria-label="Back 15 seconds">↺ 15</button>
        <button className="btnGhost" onClick={() => seekBy(15)} aria-label="Forward 15 seconds">15 ↻</button>
        <button className="btnGhost" onClick={() => setSpeedIdx((speedIdx + 1) % SPEEDS.length)} aria-label="Playback speed">
          {speed}×
        </button>
        <div style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "0.9rem", color: "var(--text-secondary)" }}>
          <span style={{ color: "var(--text-primary)" }}>{fmt(current)}</span> / {fmt(duration)}
        </div>
      </div>

      {/* Waveform (scrubbable) */}
      <div
        ref={wrapRef}
        role="slider"
        aria-label={`Seek within ${title}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
        style={{ position: "relative", cursor: "pointer", userSelect: "none" }}
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFrac(fracFromEvent(e));
        }}
        onPointerMove={(e) => draggingRef.current && seekFrac(fracFromEvent(e))}
        onPointerUp={() => (draggingRef.current = false)}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: 96, display: "block" }} />

        {/* Chapter tick marks */}
        {chapters.map((c, i) => (
          <button
            key={i}
            title={c.title}
            aria-label={`Jump to ${c.title}`}
            onClick={(e) => {
              e.stopPropagation();
              seekFrac(c.startFrac);
            }}
            style={{
              position: "absolute",
              left: `${c.startFrac * 100}%`,
              top: -6,
              width: 2,
              height: 10,
              background: "var(--text-secondary)",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      {/* Host strip — who's talking */}
      {hostSpans.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--bg-tertiary)" }}>
            {hostSpans.map((s, i) => (
              <div
                key={i}
                title={hostNames[s.hostSlot]}
                style={{
                  position: "absolute",
                  left: `${s.startFrac * 100}%`,
                  width: `${Math.max(0.4, (s.endFrac - s.startFrac) * 100)}%`,
                  top: 0,
                  bottom: 0,
                  background: HOST_COLORS[s.hostSlot],
                  opacity: 0.85,
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: "1.25rem", marginTop: 6, fontSize: "0.72rem", color: "var(--text-secondary)" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: HOST_COLORS[0], marginRight: 6 }} />{hostNames[0]}</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: HOST_COLORS[1], marginRight: 6 }} />{hostNames[1]}</span>
            <span style={{ marginLeft: "auto" }}>space = play · ←/→ = ±5s</span>
          </div>
        </div>
      )}

      {/* Chapter chips */}
      {chapters.length > 0 && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "1rem" }}>
          {chapters.map((c, i) => (
            <button
              key={i}
              onClick={() => seekFrac(c.startFrac)}
              className="chip"
              style={
                currentChapter === c
                  ? { background: "var(--accent-muted)", color: "var(--accent-color)", borderColor: "rgba(255,90,31,0.35)", cursor: "pointer" }
                  : { cursor: "pointer" }
              }
            >
              {c.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
