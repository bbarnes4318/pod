"use client";

// The one place a Studio page declares who it is.
//
// Before this existed, `.pageTitle` was hand-placed in 15 files and `.pageSub`
// in 13 — one of them a bare <h1> with no class, another overriding the margin
// inline. Each copy spent roughly 100px of vertical space restating what the
// nav rail already highlighted, which is most of why every route pushed its
// first control below 190px.
//
// WHY A CLIENT COMPONENT: the title has to render inside the shell's topbar,
// which is above the page in the tree, and RSC has no way to hand data upward.
// A page (server component) renders <StudioPageHeader title="…" /> with plain
// serializable props. `actions` and `status` accept ReactNode, which a server
// component may pass to a client component — so server-rendered buttons work.
//
// TWO DIFFERENT CHANNELS, DELIBERATELY:
//
//   · title/subtitle/breadcrumb are PRIMITIVES, published through context. The
//     effect's dependencies compare by value, so publishing settles after one
//     pass.
//
//   · actions/status are ELEMENTS, rendered through a PORTAL. They must not go
//     through context: a React element is a fresh object on every render, so
//     effect deps containing one never compare equal — publish re-renders the
//     shell, the shell re-renders the page, the page builds a new element, and
//     the effect fires again. That is an infinite render loop, and it hung
//     every page carrying `status` (the create flow's save state) until this
//     was split out. A portal re-renders with the page, touches no shell state,
//     and cannot loop.
//
// The <h1> below is real, server-rendered, and visually hidden. The topbar's
// visible title is a <div>, so the document always has exactly one h1 and it is
// present on first paint rather than after hydration.

import React, { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useStudioHeader, type StudioHeaderCrumb } from "./StudioShell";

export interface StudioPageHeaderProps {
  /** Shown in the topbar. Sentence case. */
  title: string;
  /** One short line in the subbar. Omit rather than pad it. */
  subtitle?: string;
  /** Ancestors only — the current page is never a crumb. */
  breadcrumb?: StudioHeaderCrumb[];
  /** Page-level controls, rendered in the topbar before Generate. */
  actions?: React.ReactNode;
  /** Right-aligned subbar slot: save state, counts, freshness. */
  status?: React.ReactNode;
}

/** Portals `children` into a shell-owned slot once that slot exists in the DOM. */
function ChromeSlot({ slotId, children }: { slotId: string; children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  // The slot is rendered by the shell, which is above this component in the
  // tree, so it always exists by the time this effect runs. Resolving it in an
  // effect (not during render) keeps the server and first client render
  // identical, which is what stops a hydration mismatch.
  useEffect(() => {
    setHost(document.getElementById(slotId));
  }, [slotId]);

  if (!host || children === undefined || children === null) return null;
  return createPortal(children, host);
}

export default function StudioPageHeader({ title, subtitle, breadcrumb, actions, status }: StudioPageHeaderProps) {
  const { setHeader } = useStudioHeader();
  // Identifies THIS header instance so a page unmounting after its successor
  // has mounted cannot blank the incoming title.
  const id = useId();
  const crumbKey = JSON.stringify(breadcrumb ?? null);

  useEffect(() => {
    setHeader({ id, title, subtitle, breadcrumb: breadcrumb ?? undefined });
    return () => setHeader({ id, clear: true });
    // `breadcrumb` is compared through crumbKey; including the array itself
    // would republish on every parent render for the same reason `actions`
    // cannot live here at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, title, subtitle, crumbKey, setHeader]);

  return (
    <>
      <h1 className="srOnly">{title}</h1>
      <ChromeSlot slotId="studio-topbar-actions">{actions}</ChromeSlot>
      <ChromeSlot slotId="studio-subbar-status">{status}</ChromeSlot>
    </>
  );
}
