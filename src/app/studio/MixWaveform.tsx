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
  // Peaks are stored WITH the url they were measured from, and only drawn while
  // that url is still the one playing: an old render's picture can never show
  // against a new render, even if its decode finishes late.
  const [peaks, setPeaks] = useState<{ url: string; data: number[] } | null>(null);
  const [width, setWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A new render (or episode) is a new URL: cancel any read in flight and drop the old picture.
  useEffect(() => {
    abortRef.current?.abort();
    setState("idle"); setPeaks(null); setReason("");
    return () => abortRef.current?.abort();
  }, [url]);

  const load = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const forUrl = url;
    setState("loading");
    try {
      const res = await fetch(forUrl, { mode: "cors", signal: ac.signal });
      if (!res.ok) throw new Error(`the audio file answered ${res.status}`);
      const buf = await res.arrayBuffer();
      if (ac.signal.aborted) return;
      const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
      const audio = await ctx.decodeAudioData(buf);
      if (ac.signal.aborted) return; // the user moved to another render meanwhile
      setPeaks({ url: forUrl, data: peaksFrom(audio.getChannelData(0), BUCKETS) });
      setState("ready");
    } catch (e: any) {
      if (ac.signal.aborted || e?.name === "AbortError") return;
      setReason(e?.name === "TypeError" ? "the audio host does not let the browser read the file" : e?.message || "the browser could not decode it");
      setState("unavailable");
    }
  };

  // Redraw at the canvas's real size when the layout changes (rotation, sidebar, window resize).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(c);
    return () => ro.disconnect();
  }, [state]);

  const current = peaks && peaks.url === url ? peaks.data : null;

  useEffect(() => {
    const c = canvasRef.current;
    const peaks = current;
    if (!c || !peaks) return;
    const w = (c.width = c.clientWidth * (window.devicePixelRatio || 1));
    const h = (c.height = c.clientHeight * (window.devicePixelRatio || 1));
    const g = c.getContext("2d");
    if (!g) return;
    // Canvas cannot read a CSS custom property, so the tokens are resolved off
    // the canvas at paint time (.mixWave maps them to --accent / --text-muted).
    // The fallback mirrors globals.css, as in StudioPlayer's cssToken().
    const css = getComputedStyle(c);
    const cssToken = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const played = cssToken("--wave-played", "#FF5A1F");
    const rest = cssToken("--wave-rest", "#9BA3AF");
    g.clearRect(0, 0, w, h);
    const bw = w / peaks.length;
    const split = atFraction * peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const bh = Math.max(1, peaks[i] * h);
      g.fillStyle = i < split ? played : rest;
      g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
    }
  }, [current, atFraction, width]);

  if (state === "idle" || (state === "ready" && !current))
    return <button type="button" className="btnGhost btnSm mixWaveBtn" onClick={load}>Show waveform</button>;
  if (state === "loading")
    return (
      <p className="stageHint m-0" role="status">
        Reading the audio file… <button type="button" className="advLink" onClick={() => { abortRef.current?.abort(); setState("idle"); }}>Cancel</button>
      </p>
    );
  if (state === "unavailable")
    return (
      <p className="stageHint m-0" role="note">
        Waveform unavailable: {reason}. <button type="button" className="advLink" onClick={load}>Try again</button>
      </p>
    );
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
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.02 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.02
          : e.key === "PageUp" ? 0.1 : e.key === "PageDown" ? -0.1 : null;
        if (step !== null) { e.preventDefault(); onSeek(Math.min(1, Math.max(0, atFraction + step))); }
        else if (e.key === "Home") { e.preventDefault(); onSeek(0); }
        else if (e.key === "End") { e.preventDefault(); onSeek(1); }
      }}
    />
  );
}
