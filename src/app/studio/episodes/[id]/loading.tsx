// Loading UI for the episode detail page. That page is the heaviest in the
// studio — it awaits the transcript VM, the mix VM, audio segments, hosts, and
// then computes a full timeline before it can paint. This holds its exact
// shape (chips + title + score card, player, tab strip, panel) meanwhile.

import React from "react";

export default function EpisodeLoading() {
  return (
    <div aria-busy="true" aria-label="Loading episode">
      {/* Header: status chips + title on the left, score badge on the right. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <div style={{ minWidth: 0, maxWidth: 760, flex: 1 }}>
          <div className="skelRow" style={{ marginBottom: "0.7rem" }}>
            <div className="skelChip" />
            <div className="skelChip" style={{ width: 58 }} />
            <div className="skelChip" style={{ width: 66 }} />
          </div>
          <div className="skelLine skelLine--title" style={{ height: 30, width: "70%", marginBottom: 0 }} />
        </div>
        <div className="skelBlock" style={{ width: 128, padding: "0.9rem 1.2rem" }}>
          <div className="skelLine" style={{ height: 30 }} />
          <div className="skelLine skelLine--short" style={{ margin: "0.5rem auto 0" }} />
        </div>
      </div>

      {/* Player / production console slot. */}
      <div className="skelBlock" style={{ height: 104 }}>
        <div className="skelLine skelLine--tiny" />
        <div className="skelLine" style={{ marginTop: "1.1rem" }} />
      </div>

      {/* Tab strip, then the active panel. */}
      <div className="skelRow" style={{ margin: "1.75rem 0 1.25rem" }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skelChip" style={{ width: 104, height: 42 }} />
        ))}
      </div>
      <div className="skelGrid">
        {[0, 1].map((i) => (
          <div key={i} className="skelBlock">
            <div className="skelLine skelLine--title" style={{ width: "48%" }} />
            <div className="skelLine" />
            <div className="skelLine" />
            <div className="skelLine skelLine--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
