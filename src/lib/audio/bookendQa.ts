// Post-render bookend verification.
//
// A database cue row is NOT proof that an intro/outro is audible in the
// finished master. Cues get planned, executed, mixed, mastered, and uploaded;
// any of those stages can drop a bookend (a decode failure, a zeroed clip, a
// truncated encode) while the render still reports "success". That is exactly
// how episodes have shipped with no audible outro.
//
// This module measures the RENDERED WAVEFORM with ffmpeg and answers, for the
// finished master:
//   * did the master extend beyond the last spoken word by the outro tail?
//   * is that tail actual audio (above a silence threshold), not just the
//     continuous room-tone floor?
//   * was the master truncated before the outro finished?
//   * when an intro was placed, is the head of the file audible?
//
// The caller (the stitcher) uses the result to FAIL a render whose enabled,
// placed outro is missing/silent/clipped, instead of handing out a broken
// "audio_ready" file. All returned reasons are safe (no URLs, keys, or paths).

import { getFileDurationMs, runFfmpeg } from "./assembly";

/** What the render intended for the bookends, plus the measured speech end. */
export interface BookendExpectation {
  introEnabled: boolean;
  /** An intro clip was actually placed on the timeline. */
  introPlaced: boolean;
  introDurationMs: number | null;
  outroEnabled: boolean;
  /** An outro clip was actually placed on the timeline. */
  outroPlaced: boolean;
  /** outroClip.startMs (where the outro begins, usually just under the sign-off). */
  outroStartMs: number | null;
  outroDurationMs: number | null;
  /** Max end (ms) of the dialogue (+highlight) clips — the last spoken word. */
  speechEndMs: number;
  /** RMS (dB) above which a window counts as real audio, not the room-tone
   *  floor. The foreground carries continuous pink-noise room tone near
   *  -58 dB; a real mastered bookend sits far above this. Default -45. */
  silenceThresholdDb?: number;
  /** Minimum tail (ms) beyond the last spoken word an enabled+placed outro must
   *  add. Default 300. */
  minOutroTailMs?: number;
  /** Slack (ms) for the truncation check. Default 300. */
  truncationToleranceMs?: number;
}

export interface BookendCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface BookendVerification {
  ok: boolean;
  masterDurationMs: number;
  speechEndMs: number;
  /** masterDurationMs - speechEndMs. Negative/zero means the master ended at or
   *  before the last spoken word (no tail). */
  outroTailMs: number;
  headRmsDb: number | null;
  tailRmsDb: number | null;
  introVerified: boolean;
  outroVerified: boolean;
  /** Safe failure reasons (never contain URLs/keys/paths). */
  failures: string[];
  checks: BookendCheck[];
}

/** Mean RMS (dB) over a window, via ffmpeg astats. Returns -Infinity for a
 *  silent window (astats reports "-inf") or when the meter produced no value,
 *  so a dropped/zeroed bookend reads as silence rather than throwing. */
async function windowRmsDb(
  ffmpegPath: string,
  filePath: string,
  fromSec: number,
  toSec: number
): Promise<number> {
  const from = Math.max(0, fromSec);
  const to = Math.max(from + 0.01, toSec);
  const out = await runFfmpeg(ffmpegPath, [
    "-i", filePath,
    "-af", `atrim=${from.toFixed(3)}:${to.toFixed(3)},astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none`,
    "-f", "null", "-",
  ]);
  // astats prints "RMS level dB: -18.4" or "RMS level dB: -inf" for silence.
  const m = out.match(/RMS level dB:\s*(-?inf|-?[\d.]+)/);
  if (!m) return -Infinity;
  if (/inf/i.test(m[1])) return -Infinity;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : -Infinity;
}

/**
 * Verify the intro/outro are actually present and complete in the finished
 * master. Pure measurement — never mutates anything. Safe to call on any mp3.
 */
export async function verifyBookends(
  ffmpegPath: string,
  ffprobePath: string,
  masterPath: string,
  exp: BookendExpectation
): Promise<BookendVerification> {
  const silenceThreshold = exp.silenceThresholdDb ?? -45;
  const minOutroTailMs = exp.minOutroTailMs ?? 300;
  const truncTolMs = exp.truncationToleranceMs ?? 300;

  const masterDurationMs = await getFileDurationMs(ffprobePath, masterPath);
  const speechEndMs = Math.max(0, Math.round(exp.speechEndMs));
  const outroTailMs = masterDurationMs - speechEndMs;

  const checks: BookendCheck[] = [];
  const failures: string[] = [];
  let headRmsDb: number | null = null;
  let tailRmsDb: number | null = null;
  let introVerified = false;
  let outroVerified = false;

  // --- Intro ---------------------------------------------------------------
  if (!exp.introEnabled) {
    checks.push({ name: "intro", status: "skip", detail: "intro not enabled" });
  } else if (!exp.introPlaced || !exp.introDurationMs) {
    // Enabled but no asset resolved onto the timeline: an honest skip that the
    // stitcher already warned about — not a rendered-waveform failure.
    checks.push({ name: "intro", status: "skip", detail: "intro enabled but no asset was placed (honest skip)" });
  } else {
    // The first ~1.5s is intro-only (dialogue starts under the intro's fade
    // tail). Measure that head window.
    const headMs = Math.min(exp.introDurationMs, 1500);
    headRmsDb = await windowRmsDb(ffmpegPath, masterPath, 0, headMs / 1000);
    if (headRmsDb > silenceThreshold) {
      introVerified = true;
      checks.push({ name: "intro", status: "pass", detail: `intro head audible (${headRmsDb.toFixed(1)} dB over first ${headMs} ms)` });
    } else {
      const reason = `Enabled intro is not audible in the final master (head RMS ${Number.isFinite(headRmsDb) ? headRmsDb.toFixed(1) : "-inf"} dB <= ${silenceThreshold} dB threshold).`;
      failures.push(reason);
      checks.push({ name: "intro", status: "fail", detail: reason });
    }
  }

  // --- Outro ---------------------------------------------------------------
  if (!exp.outroEnabled) {
    checks.push({ name: "outro", status: "skip", detail: "outro not enabled" });
  } else if (!exp.outroPlaced || !exp.outroDurationMs) {
    checks.push({ name: "outro", status: "skip", detail: "outro enabled but no asset was placed (honest skip)" });
  } else {
    // 1. Not truncated: the master must reach the planned end of the outro clip.
    const plannedOutroEndMs = (exp.outroStartMs ?? speechEndMs) + exp.outroDurationMs;
    const truncated = masterDurationMs < plannedOutroEndMs - truncTolMs;

    // 2. Tail beyond speech: the outro must extend past the last spoken word.
    const tailLongEnough = outroTailMs >= minOutroTailMs;

    // 3. Tail audible: the region after the last spoken word is outro-only.
    //    Measure it (bounded so a very long outro doesn't scan the whole tail).
    if (outroTailMs > 0) {
      const tailStartSec = speechEndMs / 1000;
      const tailEndSec = Math.min(masterDurationMs, speechEndMs + Math.min(outroTailMs, 2500)) / 1000;
      tailRmsDb = await windowRmsDb(ffmpegPath, masterPath, tailStartSec, tailEndSec);
    } else {
      tailRmsDb = -Infinity;
    }
    const tailAudible = tailRmsDb > silenceThreshold;

    if (truncated) {
      const reason = `Final master is truncated before the outro completes (master ${masterDurationMs} ms < planned outro end ${plannedOutroEndMs} ms).`;
      failures.push(reason);
      checks.push({ name: "outro_truncation", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_truncation", status: "pass", detail: `master reaches planned outro end (${masterDurationMs} ms >= ${plannedOutroEndMs} ms)` });
    }

    if (!tailLongEnough) {
      const reason = `Enabled outro does not extend beyond the final spoken line (tail ${outroTailMs} ms < ${minOutroTailMs} ms required).`;
      failures.push(reason);
      checks.push({ name: "outro_tail_length", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_tail_length", status: "pass", detail: `outro tail ${outroTailMs} ms >= ${minOutroTailMs} ms` });
    }

    if (!tailAudible) {
      const reason = `Enabled outro is not audible after the final spoken line (tail RMS ${Number.isFinite(tailRmsDb) ? tailRmsDb.toFixed(1) : "-inf"} dB <= ${silenceThreshold} dB threshold) - the outro disappeared during mixing/encoding.`;
      failures.push(reason);
      checks.push({ name: "outro_tail_audible", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_tail_audible", status: "pass", detail: `outro tail audible (${tailRmsDb!.toFixed(1)} dB)` });
    }

    outroVerified = !truncated && tailLongEnough && tailAudible;
  }

  return {
    ok: failures.length === 0,
    masterDurationMs,
    speechEndMs,
    outroTailMs,
    headRmsDb,
    tailRmsDb,
    introVerified,
    outroVerified,
    failures,
    checks,
  };
}
