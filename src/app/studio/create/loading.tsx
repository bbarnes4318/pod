// Loading UI for /studio/create. Mirrors the rundown builder's real geometry —
// title, step rail, then the two-column picker/tray — so the swap to the live
// builder doesn't shift anything on screen (CLS).
//
// The page does four sequential DB round-trips before it can render, which is
// exactly the wait this covers.

import React from "react";

export default function CreateLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the rundown builder">
      <div className="skelLine skelLine--title" style={{ height: 28, width: "26%" }} />
      <div className="skelLine skelLine--short" style={{ marginBottom: "1.5rem" }} />

      {/* Step rail — five pills, same footprint as the real one. */}
      <div className="skelRow" style={{ marginBottom: "1.5rem" }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skelChip" style={{ width: 96, height: 30 }} />
        ))}
      </div>

      <div className="rundownTwoCol">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skelBlock">
              <div className="skelRow" style={{ marginBottom: "0.9rem" }}>
                <div className="skelChip" />
                <div className="skelChip" style={{ width: 60 }} />
              </div>
              <div className="skelLine" />
              <div className="skelLine skelLine--short" />
            </div>
          ))}
        </div>
        <div className="rundownTrayCol">
          <div className="skelBlock">
            <div className="skelLine skelLine--title" style={{ width: "55%" }} />
            <div className="skelLine" />
            <div className="skelLine" />
            <div className="skelLine skelLine--short" />
          </div>
        </div>
      </div>
    </div>
  );
}
