import React from "react";

/**
 * One icon set for the whole Studio: 24px grid, 1.75 stroke, round caps.
 * Decorative by default (aria-hidden) — every icon sits beside a text label
 * or inside a control that carries its own accessible name.
 */
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  home: <Svg><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5v-5h4v5" /></Svg>,
  desk: <Svg><path d="M4 5h11a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3Z" /><path d="M8 9h6M8 13h6" /><path d="M18 10h2v7a2 2 0 0 1-2 2" /></Svg>,
  play: <Svg><path d="M7 4.5v15l12-7.5Z" fill="currentColor" stroke="none" /></Svg>,
  pause: <Svg><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></Svg>,
  close: <Svg><path d="M6 6l12 12M18 6 6 18" /></Svg>,
  sun: <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
  moon: <Svg><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></Svg>,
  activity: <Svg><path d="M3 12h4l3-8 4 16 3-8h4" /></Svg>,
  alert: <Svg><path d="M12 3 2.5 20h19Z" /><path d="M12 10v4M12 17v.5" /></Svg>,
  check: <Svg><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>,
  clock: <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>,
  pen: <Svg><path d="M4 20h4L19 9l-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></Svg>,
  board: <Svg><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>,
  shows: <Svg><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></Svg>,
  create: <Svg><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></Svg>,
  episodes: <Svg><path d="M4 12v0M8 8v8M12 5v14M16 9v6M20 12v0" /></Svg>,
  takes: <Svg><path d="M12 3c1.5 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.2.4-2.2 1-3 .2 1 .8 1.6 1.5 1.8C10.6 7.7 10.5 5.2 12 3Z" /></Svg>,
  hosts: <Svg><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></Svg>,
  auditions: <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></Svg>,
  audio: <Svg><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>,
  publishing: <Svg><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" /></Svg>,
  analytics: <Svg><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></Svg>,
  plan: <Svg><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6.5 15h4" /></Svg>,
  settings: <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></Svg>,
  search: <Svg><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>,
  plus: <Svg><path d="M12 5v14M5 12h14" /></Svg>,
  chevronLeft: <Svg><path d="M15 5l-7 7 7 7" /></Svg>,
  chevronDown: <Svg><path d="m6 9 6 6 6-6" /></Svg>,
  chevronRight: <Svg><path d="m9 6 6 6-6 6" /></Svg>,
  menu: <Svg><path d="M4 6h16M4 12h16M4 18h16" /></Svg>,
  collapse: <Svg><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 9l-3 3 3 3" /></Svg>,
  console: <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></Svg>,
  listen: <Svg><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="3" y="14" width="4" height="7" rx="1.5" /><rect x="17" y="14" width="4" height="7" rx="1.5" /></Svg>,
  signOut: <Svg><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>,
  arrowRight: <Svg><path d="M5 12h14M13 6l6 6-6 6" /></Svg>,
  enter: <Svg><path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></Svg>,
};
