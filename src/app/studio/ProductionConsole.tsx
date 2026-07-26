"use client";

// The live production console — what the user watches from "Start the debate"
// until the episode is ready. It replaces the old dead end (a static "No audio
// yet" card that required a manual browser refresh to ever change).
//
// Everything rendered here is a real read of the pipeline (see
// lib/services/createProgress.ts). The two progress affordances are NOT
// interchangeable:
//   · a filled bar means a real counted fraction, and only voicing has one
//   · a sweeping bar means "running, no honest percentage exists"
// The stages that finish in one atomic write get the sweep plus real elapsed
// time measured against this deployment's own median — never a fake percentage.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getEpisodeProgress, retryProductionStage, approveEpisodeScript } from "../app/create/actions";
import type { CreateProgressVM, ProgressStageVM } from "@/lib/services/createProgress";

/** "2m 14s" / "48s" — compact and stable in width thanks to tabular figures. */
function fmtDur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Compare live elapsed against the historical median, without crying wolf. */
function paceNote(elapsedMs: number | null, typicalMs: number | null): string | null {
  if (elapsedMs === null || typicalMs === null || typicalMs <= 0) return null;
  if (elapsedMs > typicalMs * 1.75) return `usually ${fmtDur(typicalMs)} — this one is taking longer than normal`;
  return `usually about ${fmtDur(typicalMs)}`;
}

export default function ProductionConsole({
  episodeId,
  initialVm,
  offEpisodePage = false,
}: {
  episodeId: string;
  initialVm?: CreateProgressVM;
  /**
   * True when the console is rendered somewhere other than the episode page
   * (i.e. the create flow). It controls both the "Open episode" link and
   * whether in-page tab hashes need to be qualified with the episode URL.
   */
  offEpisodePage?: boolean;
}) {
  const router = useRouter();
  const [vm, setVm] = useState<CreateProgressVM | null>(initialVm ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // The one human checkpoint (createFlow: only `review` has checkpoint:true).
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveReasons, setApproveReasons] = useState<string[]>([]);
  // Milliseconds since the last successful read, held as state rather than
  // computed from Date.now() during render (which would be an impure render and
  // could produce a different number on every incidental re-render). It resets
  // to 0 on each poll, so the displayed timers re-sync instead of drifting.
  const [sinceFetch, setSinceFetch] = useState(0);
  // Bumped after every poll attempt so a failed poll still re-arms the loop
  // (on failure `vm` is unchanged, so it alone can't retrigger the effect).
  const [pollNonce, setPollNonce] = useState(0);

  // Once the pipeline finishes we refresh the server page exactly once, so the
  // real player/tabs replace the console without a full reload.
  const refreshedOnDone = useRef(false);

  const poll = useCallback(async () => {
    try {
      const next = (await getEpisodeProgress(episodeId)) as CreateProgressVM | { ok: false; error: string };
      if (!next || next.ok === false) {
        setLoadError(("error" in next && next.error) || "Couldn't read progress.");
        return;
      }
      setVm(next as CreateProgressVM);
      setSinceFetch(0);
      setLoadError(null);
    } catch {
      // A dropped poll isn't worth blanking the UI for — keep rendering the
      // last known state and let the next tick recover.
      setLoadError("Lost contact with the studio — retrying…");
    } finally {
      setPollNonce((n) => n + 1);
    }
  }, [episodeId]);

  // Poll on the cadence the server asks for: faster while voicing visibly
  // ticks, slower on opaque stages, 0 once nothing can change on its own.
  // Everything (including the very first read) goes through setTimeout, so no
  // state is set synchronously during the effect. Paused while the tab is
  // hidden, so a backgrounded tab never keeps hitting the server.
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    const wait = vm ? vm.pollAfterMs : 0;
    if (vm && !wait) return;
    const id = setTimeout(() => void poll(), wait);
    return () => clearTimeout(id);
  }, [vm, poll, pollNonce]);

  // Resume immediately when the user comes back to the tab.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) setPollNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Local 1s tick so elapsed counters move between polls. Displayed elapsed is
  // always (server-measured elapsed + time since that read).
  useEffect(() => {
    if (!vm || vm.done || vm.failure || vm.awaitingUser) return;
    const id = setInterval(() => setSinceFetch((s) => s + 1000), 1000);
    return () => clearInterval(id);
  }, [vm]);

  useEffect(() => {
    if (vm?.done && !refreshedOnDone.current) {
      refreshedOnDone.current = true;
      router.refresh();
    }
  }, [vm?.done, router]);

  const onRetry = async (stageKey: string) => {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = (await retryProductionStage(episodeId, stageKey)) as { success?: boolean; error?: string };
      if (res?.success === false) {
        setRetryError(res.error || "Couldn't restart that step.");
        return;
      }
      await poll();
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "Couldn't restart that step.");
    } finally {
      setRetrying(false);
    }
  };

  // Approving IS the human review: it runs the safety gates, flips the script to
  // approved, and queues fact-check — which now chains voices → mix → notes.
  // Before this existed the console told the customer to "approve" and offered
  // nowhere to do it; the only routes onward were /admin links behind Basic Auth.
  const onApprove = async () => {
    setApproving(true);
    setApproveError(null);
    setApproveReasons([]);
    try {
      const res = (await approveEpisodeScript(episodeId)) as {
        success?: boolean;
        error?: string;
        reasons?: string[];
      };
      if (res?.success === false) {
        setApproveError(res.error || "Couldn't approve the script.");
        setApproveReasons(Array.isArray(res.reasons) ? res.reasons : []);
        return;
      }
      await poll();
      router.refresh();
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Couldn't approve the script.");
    } finally {
      setApproving(false);
    }
  };

  if (!vm) return <ConsoleSkeleton />;

  const liveElapsed = (s: ProgressStageVM) =>
    s.elapsedMs === null ? null : s.state === "active" ? s.elapsedMs + sinceFetch : s.elapsedMs;

  const active = vm.stages.find((s) => s.state === "active" || s.state === "failed" || s.state === "checkpoint");
  const headElapsed = active ? liveElapsed(active) : null;

  // Episode tabs are hash-addressable (EpisodeWorkspace). From the create flow
  // the hash alone would be a no-op, so qualify it with the episode URL.
  const tabHref = (tab: string) => (offEpisodePage ? `/studio/episodes/${episodeId}#${tab}` : `#${tab}`);

  return (
    <section className="prodConsole" data-testid="production-console" aria-label="Episode production progress">
      {/* A single polite live region carries stage changes to screen readers;
          the ticking timers are aria-hidden so they never spam announcements.
          The failure detail is deliberately NOT repeated here — it already has
          its own role="alert" below, and duplicating it announces twice. */}
      <p className="srOnly" aria-live="polite">{vm.headline}</p>

      <header className="prodHead">
        <div className="prodHeadMain">
          <span
            className={`statusPill ${
              vm.failure ? "statusPill--err" : vm.done ? "statusPill--ok" : vm.awaitingUser || vm.stalled ? "statusPill--warn" : "statusPill--live"
            }`}
          >
            {vm.failure ? "Stopped" : vm.done ? "Ready" : vm.awaitingUser ? "Your turn" : vm.stalled ? "Waiting" : "On air"}
          </span>
          <h2 className="prodHeadline" data-testid="prod-headline">{vm.headline}</h2>
          <p className="prodSub">{vm.title}</p>
        </div>
        {headElapsed !== null && !vm.done && (
          <div className="prodElapsedWrap" aria-hidden="true">
            <div className="prodElapsed">{fmtDur(headElapsed)}</div>
            <div className="prodElapsedLabel">on this step</div>
          </div>
        )}
      </header>

      <ol className="prodRail">
        {vm.stages.map((s, i) => (
          <li key={s.key} className={`prodStage prodStage--${s.state}`} data-testid={`prod-stage-${s.key}`} data-state={s.state}>
            <div className="prodStageMark">
              <span className="prodDot">
                {s.state === "done" ? "✓" : s.state === "failed" ? "!" : i + 1}
              </span>
            </div>
            <div className="prodStageBody">
              <div className="prodStageTop">
                <span className="prodStageLabel">{s.label}</span>
                {s.state === "done" && s.elapsedMs !== null && (
                  <span className="prodStageTime">{fmtDur(s.elapsedMs)}</span>
                )}
                {(s.state === "active" || s.state === "failed") && (
                  <span className="prodStageTime">
                    {paceNote(liveElapsed(s), s.typicalMs) ?? (s.typicalMs ? `usually about ${fmtDur(s.typicalMs)}` : "")}
                  </span>
                )}
              </div>

              {(s.state === "active" || s.state === "checkpoint" || s.state === "failed") && (
                <p className="prodStageBlurb">{s.blurb}</p>
              )}

              {/* Voicing is the one stage with a real denominator, so it is the
                  one stage allowed to draw a filled bar. */}
              {s.state === "active" && s.progress && s.progress.total ? (
                <>
                  <div className="prodBarTrack">
                    <div
                      className="prodBarFill"
                      style={{ width: `${Math.min(100, Math.round((s.progress.done / s.progress.total) * 100))}%` }}
                    />
                  </div>
                  <div className="prodCount">
                    <b>{s.progress.done}</b> of {s.progress.total} {s.progress.unit} recorded
                    {s.progress.failed > 0 && ` · ${s.progress.failed} to redo`}
                  </div>
                </>
              ) : s.state === "active" && s.progress && s.progress.total === null ? (
                <>
                  <div className="prodBarTrack prodBarSweep" />
                  <div className="prodCount">
                    <b>{s.progress.done}</b> {s.progress.unit} recorded
                  </div>
                </>
              ) : s.state === "active" ? (
                <div className="prodBarTrack prodBarSweep" />
              ) : null}

              {s.state === "failed" && s.error && (
                <div className="prodNote prodNote--error" role="alert">
                  <div>{s.error}</div>
                  <div className="prodNoteActions">
                    <button type="button" className="btnPrimary" disabled={retrying} onClick={() => onRetry(s.key)} data-testid="prod-retry">
                      {retrying && <span className="btnSpin" aria-hidden="true" />}
                      {retrying ? "Restarting…" : "Try this step again"}
                    </button>
                  </div>
                  {retryError && <div style={{ marginTop: "0.5rem" }}>{retryError}</div>}
                </div>
              )}

              {s.state === "checkpoint" && (
                <>
                  <div className="prodNoteActions">
                    {/* The action that actually advances the episode. Everything
                        downstream is automatic once this is pressed. */}
                    <button
                      type="button"
                      className="btnPrimary"
                      disabled={approving}
                      onClick={onApprove}
                      data-testid="prod-approve-cta"
                    >
                      {approving && <span className="btnSpin" aria-hidden="true" />}
                      {approving ? "Approving…" : "Approve & start production"}
                    </button>
                    <a href={tabHref("transcript")} className="btnGhost" data-testid="prod-review-cta">Read the draft first</a>
                  </div>
                  {approveError && (
                    <div className="prodNote prodNote--error" role="alert" data-testid="prod-approve-error">
                      <div>{approveError}</div>
                      {approveReasons.length > 0 && (
                        // The gate's own reasons, rendered where the customer is.
                        // A correct server-side refusal that never reaches the
                        // screen is only half a guard.
                        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
                          {approveReasons.map((r) => <li key={r}>{r}</li>)}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      {vm.stalled && !vm.failure && (
        <div style={{ padding: "0 1.35rem 0.4rem" }}>
          <div className="prodNote prodNote--warn" role="status">
            This step hasn&apos;t been picked up by a production worker yet. Your work is saved — if it doesn&apos;t
            start shortly, restarting the step will re-queue it.
            <div className="prodNoteActions">
              <button type="button" className="btnGhost" disabled={retrying} onClick={() => onRetry(vm.stage)}>
                {retrying && <span className="btnSpin" aria-hidden="true" />}
                {retrying ? "Re-queueing…" : "Re-queue this step"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="prodFoot">
        {vm.done ? (
          <>
            <span className="prodSafe">✓ Episode built{vm.script ? ` · ${vm.script.lineCount} lines` : ""}</span>
            {offEpisodePage && (
              <Link href={`/studio/episodes/${episodeId}`} className="btnPrimary">Open episode →</Link>
            )}
          </>
        ) : (
          <>
            <span className="prodSafe">
              ⌁ This runs on our servers — you can close this tab and come back to it.
            </span>
            {offEpisodePage && (
              <Link href={`/studio/episodes/${episodeId}`} className="btnGhost">Open episode</Link>
            )}
          </>
        )}
        {loadError && <span className="prodSafe" role="status">{loadError}</span>}
      </footer>
    </section>
  );
}

/** First paint, before the first progress read lands. Mirrors the console's
 *  real geometry (header + six rail rows) so nothing jumps when data arrives. */
export function ConsoleSkeleton() {
  return (
    <section className="prodConsole" aria-busy="true" aria-label="Loading production progress">
      <div className="prodHead">
        <div className="prodHeadMain" style={{ flex: 1 }}>
          <div className="skelChip" />
          <div className="skelLine skelLine--title" style={{ marginTop: "0.8rem" }} />
          <div className="skelLine skelLine--short" />
        </div>
      </div>
      <ol className="prodRail">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="prodStage prodStage--todo">
            <div className="prodStageMark"><span className="prodDot">{i + 1}</span></div>
            <div className="prodStageBody">
              <div className="skelLine skelLine--tiny" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
