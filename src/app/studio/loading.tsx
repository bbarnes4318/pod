// Default loading UI for every /studio route that doesn't define its own.
//
// Next wraps page.tsx (and nested segments) in a Suspense boundary with this as
// the fallback, so the studio shell stays interactive and painted while a
// page's DB work runs. Before this existed, every force-dynamic studio page
// rendered nothing at all until all of its queries resolved.
//
// The layout itself awaits auth (requireUserPage), which this boundary sits
// below — so on a cold page load the shell resolves first and this covers the
// page's queries; on client-side navigation between studio routes the shell is
// already mounted and this paints instantly.

import React from "react";

export default function StudioLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skelLine skelLine--title" style={{ height: 28, width: "30%" }} />
      <div className="skelLine skelLine--short" style={{ marginBottom: "1.75rem" }} />
      <div className="skelGrid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skelBlock">
            <div className="skelRow" style={{ marginBottom: "1rem" }}>
              <div className="skelChip" />
            </div>
            <div className="skelLine" />
            <div className="skelLine" />
            <div className="skelLine skelLine--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
