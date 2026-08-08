// Loading UI for the episode detail page. That page is the heaviest in the
// studio — it awaits the transcript VM, the mix VM, audio segments, hosts, and
// then computes a full timeline before it can paint. This holds its exact
// shape (chips + title + score card, player, tab strip, panel) meanwhile.

import React from "react";

export default function EpisodeLoading() {
  return (
    <div aria-busy="true" aria-label="Loading episode">
      {/* Header: status chips + title on the left, score badge on the right. */}
      <div className="skelHead">
        <div className="skelHeadMain">
          <div className="skelRow mb-3">
            <div className="skelChip" />
            <div className="skelChip skelChip--sm" />
            <div className="skelChip skelChip--sm" />
          </div>
          <div className="skelLine skelLine--title skelLine--h30 skelLine--w70 mb-0" />
        </div>
        <div className="skelBlock skelScore">
          <div className="skelLine skelLine--h30" />
          <div className="skelLine skelLine--short skelCentered" />
        </div>
      </div>

      {/* Player / production console slot. */}
      <div className="skelBlock skelBlock--player">
        <div className="skelLine skelLine--tiny" />
        <div className="skelLine mt-4" />
      </div>

      {/* Tab strip, then the active panel. */}
      <div className="skelRow mt-6 mb-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="skelChip skelChip--tab" key={i} />
        ))}
      </div>
      <div className="skelGrid">
        {[0, 1].map((i) => (
          <div key={i} className="skelBlock">
            <div className="skelLine skelLine--title skelLine--w48" />
            <div className="skelLine" />
            <div className="skelLine" />
            <div className="skelLine skelLine--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
