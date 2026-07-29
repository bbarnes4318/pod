import type { SVGProps } from "react";

type IconName = "board" | "shows" | "plus" | "episodes" | "takes" | "hosts" | "publish" | "analytics" | "plan" | "settings" | "bolt" | "menu" | "chevronLeft" | "chevronDown" | "headphones" | "logout" | "admin" | "search" | "more" | "play" | "edit" | "copy" | "archive" | "volume";

const paths: Record<IconName, React.ReactNode> = {
  board: <><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>,
  shows: <><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.25"/><path d="M12 15.25V21"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  episodes: <path d="M4 12h.01M8 8v8M12 5v14M16 9v6M20 12h.01"/>,
  takes: <path d="M12 3c1.5 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.2.4-2.2 1-3 .2 1 .8 1.6 1.5 1.8C10.6 7.7 10.5 5.2 12 3Z"/>,
  hosts: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8"/></>,
  publish: <><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/></>,
  analytics: <><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/></>,
  plan: <path d="m12 2 2.4 5 5.6.8-4 3.9 1 5.6L12 20l-5 2.6 1-5.6-4-3.9 5.6-.8z"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></>,
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13V2Z"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  chevronLeft: <path d="m15 18-6-6 6-6"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  headphones: <><path d="M4 14a8 8 0 0 1 16 0"/><path d="M4 14v4a2 2 0 0 0 2 2h2v-8H6a2 2 0 0 0-2 2ZM20 14v4a2 2 0 0 1-2 2h-2v-8h2a2 2 0 0 1 2 2Z"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
  admin: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 14h4"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  play: <path d="m9 6 9 6-9 6V6Z"/>,
  edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
  archive: <><path d="M3 6h18M5 6v14h14V6M9 10h6"/><path d="M4 3h16v3H4z"/></>,
  volume: <><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"/></>,
};

export function StudioIcon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
