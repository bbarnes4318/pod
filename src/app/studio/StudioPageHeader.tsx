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
// serializable props; this component publishes them to the shell's context.
// `actions` and `status` accept ReactNode, which a server component may pass to
// a client component — so server-rendered buttons still work.
//
// The <h1> below is real, server-rendered, and visually hidden. The topbar's
// visible title is a <div>, so the document always has exactly one h1 and it is
// present on first paint rather than after hydration.

import React, { useEffect, useId } from "react";
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

export default function StudioPageHeader({ title, subtitle, breadcrumb, actions, status }: StudioPageHeaderProps) {
  const { setHeader } = useStudioHeader();
  // Identifies THIS header instance so a page unmounting after its successor
  // has mounted cannot blank the incoming title.
  const id = useId();

  useEffect(() => {
    setHeader({ id, title, subtitle, breadcrumb, actions, status });
    return () => setHeader({ id, clear: true });
    // `actions`/`status` are elements recreated each render; including them
    // would republish on every parent render. Their content is derived from
    // the same data as `title`/`subtitle`, which are compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, title, subtitle, JSON.stringify(breadcrumb), actions, status]);

  return <h1 className="srOnly">{title}</h1>;
}
