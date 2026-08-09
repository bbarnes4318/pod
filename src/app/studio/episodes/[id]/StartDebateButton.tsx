"use client";

// The missing start.
//
// An episode sits at status `draft` until the script job is queued. Until then
// nothing is running — there is no script being written, and nothing to watch.
// The action bar nevertheless offered "Watch it being written" pointing at the
// episode page itself, so the primary control on the page linked to the page
// you were already on and clicking it did nothing at all.
//
// Worse than a dead link: a draft that was never started had NO way to start it
// from its own page. The only Start button in the product lived on the create
// flow's result screen, so an episode you navigated back to later was stranded.
//
// This is that button, wired to the same owner-gated action the create flow
// uses. It reports what happened either way, and refreshes so the production
// console takes over the moment the job is queued.

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { startDebate } from "../../../app/create/actions";

export default function StartDebateButton({ episodeId }: { episodeId: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = (await startDebate(episodeId)) as { success?: boolean; error?: string };
      if (res?.success === false) {
        setError(res.error || "Couldn't start the debate.");
        return;
      }
      // The console polls from here; refreshing swaps this button for it.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the debate.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      {error && (
        <span className="epActionBarError" role="alert" data-testid="start-debate-error">
          {error}
        </span>
      )}
      <button
        type="button"
        className="btnPrimary"
        onClick={start}
        disabled={starting}
        aria-busy={starting}
        data-testid="episode-start-debate"
      >
        {starting && <span className="btnSpin" aria-hidden="true" />}
        {starting ? "Starting…" : "Start the debate"}
      </button>
    </>
  );
}
