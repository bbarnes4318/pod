"use client";

// Real waveform of the rendered master. Decoded in the browser from the actual
// audio file, only when asked (a long episode is a big decode). If the audio
// host does not allow the file to be read (CORS) or the browser cannot decode
// it, we say so; nothing is drawn that was not measured from the file.

import React, { useEffect, useRef, useState } from "react";

/** Peak (max |sample|) per bucket, 0..1. Exported for the self-check. */
export function peaksFrom(samples: Float32Array, buckets: number): number[] {
  const out = new Array(Math.max(1, buckets)).fill(0);
  if (samples.length === 0) return out;
  const per = samples.length / out.length;
  for (let b = 0; b < out.length; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * per)));
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = Math.min(1, peak);
  }
  return out;
}

const BUCKETS = 1200;
// Decode at a low rate: plenty for a picture, and keeps memory sane for a
// 45-minute episode (~22M samples instead of ~120M at 44.1 kHz stereo).
const DECODE_RATE = 8000;

export default function MixWaveform({ url, atFraction, onSeek }: { url: string; atFraction: number; onSeek: (fraction: number) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [reason, setReason] = useState("");
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // A new render is a new URL: drop the old picture.
  useEffect(() => { setState("idle"); setPeaks(null); }, [url]);

  const load = async () => {
    setState("loading");
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`the audio file answered ${res.status}`);
      const buf = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
      const audio = await ctx.decodeAudioData(buf);
      setPeaks(peaksFrom(audio.getChannelData(0), BUCKETS));
      setState("ready");
    } catch (e: any) {
      setReason(e?.name === "TypeError" ? "the audio host does not let the browser read the file" : e?.message || "the browser could not decode it");
      setState("unavailable");
    }
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !peaks) return;
    const w = (c.width = c.clientWidth * (window.devicePixelRatio || 1));
    const h = (c.height = c.clientHeight * (window.devicePixelRatio || 1));
    const g = c.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(c);
    const played = css.getPropertyValue("--wave-played").trim() || "#f60";
    const rest = css.getPropertyValue("--wave-rest").trim() || "#888";
    g.clearRect(0, 0, w, h);
    const bw = w / peaks.length;
    const split = atFraction * peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const bh = Math.max(1, peaks[i] * h);
      g.fillStyle = i < split ? played : rest;
      g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
    }
  }, [peaks, atFraction]);

  if (state === "idle")
    return <button type="button" className="btnGhost btnSm mixWaveBtn" onClick={load}>Show waveform</button>;
  if (state === "loading") return <p className="stageHint m-0" role="status">Reading the audio file…</p>;
  if (state === "unavailable") return <p className="stageHint m-0" role="note">Waveform unavailable: {reason}.</p>;
  return (
    <canvas
      ref={canvasRef}
      className="mixWave"
      role="slider"
      aria-label="Waveform of the finished mix. Click to seek."
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(atFraction * 100)}
      tabIndex={0}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(Math.min(1, atFraction + 0.02));
        if (e.key === "ArrowLeft") onSeek(Math.max(0, atFraction - 0.02));
      }}
    />
  );
}
