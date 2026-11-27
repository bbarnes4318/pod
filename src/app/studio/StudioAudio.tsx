"use client";

// One player for the whole Studio.
//
// Audio used to exist only on the episode page: leave the page and the episode
// stopped, and there was no way to hear anything from a list. This is a single
// <audio> element owned by the shell, so playback survives navigation, and any
// page can start it with <PlayButton>.
//
// It plays a URL the server already decided this viewer may load — the same
// `audioUrl` the episode page hands its own player. It adds no new way to
// reach audio, so ownership rules are untouched.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "./StudioIcons";

export interface StudioTrack {
  /** Stable id (the episode id) — what "is this the one playing?" compares. */
  id: string;
  src: string;
  title: string;
  /** Show name, or whatever places the track. */
  subtitle?: string;
  /** Where the track lives in the Studio. */
  href?: string;
}

interface AudioApi {
  track: StudioTrack | null;
  playing: boolean;
  /** Start this track, or toggle it if it is already loaded. */
  toggle: (track: StudioTrack) => void;
}

const StudioAudioContext = createContext<AudioApi>({ track: null, playing: false, toggle: () => {} });

export function useStudioAudio() {
  return useContext(StudioAudioContext);
}

const RATES = [1, 1.25, 1.5, 2, 0.75];

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function StudioAudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [track, setTrack] = useState<StudioTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  const toggle = useCallback((next: StudioTrack) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (track?.id === next.id) {
      if (audio.paused) void audio.play().catch(() => setFailed(true));
      else audio.pause();
      return;
    }
    setFailed(false);
    setTime(0);
    setDuration(0);
    setTrack(next);
    audio.src = next.src;
    audio.playbackRate = rate;
    void audio.play().catch(() => setFailed(true));
  }, [track, rate]);

  const close = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setTrack(null);
    setPlaying(false);
  }, []);

  // Two things must never play at once. The episode page has its own waveform
  // player; when anything else on the page starts, the dock yields.
  useEffect(() => {
    const onPlay = (e: Event) => {
      const audio = audioRef.current;
      if (audio && e.target !== audio && e.target instanceof HTMLMediaElement) audio.pause();
    };
    document.addEventListener("play", onPlay, true);
    return () => document.removeEventListener("play", onPlay, true);
  }, []);

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const api = useMemo(() => ({ track, playing, toggle }), [track, playing, toggle]);

  return (
    <StudioAudioContext.Provider value={api}>
      {children}
      {/* The element is always mounted so a click can start playback inside the
          same user gesture; the dock around it only appears with a track. */}
      <div className="studioDock" data-open={track ? "true" : "false"} role="region" aria-label="Player" hidden={!track}>
        <audio
          ref={audioRef}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onError={() => { if (track) setFailed(true); }}
        />
        {track && (
          <>
            <button
              type="button"
              className="studioDockPlay"
              onClick={() => toggle(track)}
              aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
            >
              {playing ? Icon.pause : Icon.play}
            </button>
            <div className="studioDockWhat">
              {track.href ? (
                <Link href={track.href} className="studioDockTitle">{track.title}</Link>
              ) : (
                <span className="studioDockTitle">{track.title}</span>
              )}
              <span className="studioDockSub">
                {failed ? "This audio could not be loaded. Open the episode to check it." : track.subtitle ?? ""}
              </span>
            </div>
            <div className="studioDockSeek">
              <span className="studioDockTime">{clock(time)}</span>
              <input
                type="range"
                className="studioDockRange"
                min={0}
                max={duration > 0 ? duration : 0}
                step={1}
                value={Math.min(time, duration || 0)}
                disabled={!(duration > 0)}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  if (audioRef.current) audioRef.current.currentTime = t;
                  setTime(t);
                }}
                aria-label="Seek"
                aria-valuetext={`${clock(time)} of ${clock(duration)}`}
              />
              <span className="studioDockTime">{duration > 0 ? clock(duration) : "–:––"}</span>
            </div>
            <button type="button" className="studioDockRate" onClick={cycleRate} aria-label={`Playback speed ${rate}×. Change speed`}>
              {rate}×
            </button>
            <button type="button" className="studioDockClose" onClick={close} aria-label="Close player">
              {Icon.close}
            </button>
          </>
        )}
      </div>
    </StudioAudioContext.Provider>
  );
}

/** Start (or pause) a track in the Studio player. One click, no navigation. */
export function PlayButton({ track, className }: { track: StudioTrack; className?: string }) {
  const { track: current, playing, toggle } = useStudioAudio();
  const isThis = current?.id === track.id;
  const active = isThis && playing;
  return (
    <button
      type="button"
      className={className ?? "playBtn"}
      data-playing={active ? "true" : "false"}
      aria-pressed={active}
      aria-label={active ? `Pause ${track.title}` : `Play ${track.title}`}
      onClick={() => toggle(track)}
    >
      {active ? Icon.pause : Icon.play}
    </button>
  );
}
