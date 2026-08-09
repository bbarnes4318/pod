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
      <div className="skelLine skelLine--title skelLine--h28 skelLine--w26" />
      <div className="skelLine skelLine--short mb-6" />

      {/* Step rail — five pills, same footprint as the real one. */}
      <div className="skelRow mb-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="skelChip skelChip--btn" key={i} />
        ))}
      </div>

      <div className="rundownTwoCol">
        <div className="skelStack">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skelBlock">
              <div className="skelRow mb-4">
                <div className="skelChip" />
                <div className="skelChip skelChip--sm" />
              </div>
              <div className="skelLine" />
              <div className="skelLine skelLine--short" />
            </div>
          ))}
        </div>
        <div className="rundownTrayCol">
          <div className="skelBlock">
            <div className="skelLine skelLine--title skelLine--w55" />
            <div className="skelLine" />
            <div className="skelLine" />
            <div className="skelLine skelLine--short" />
          </div>
        </div>
      </div>
    </div>
  );
}
