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

import React, { useEffect, useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStudioHeader, type StudioHeaderCrumb } from "./StudioShell";

// useLayoutEffect warns when it runs during SSR, where there is no layout to
// read. On the client it matters: it resolves the portal host BEFORE the
// browser paints, so chrome-hosted controls are never visibly absent for a
// frame after hydration.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
function ChromeSlot({
  slotId,
  children,
  onPublished,
}: {
  slotId: string;
  children: React.ReactNode;
  /** Fired once this slot's content is actually in the DOM. */
  onPublished: () => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  // The slot is rendered by the shell, which is above this component in the
  // tree, so it always exists by the time this runs. Resolving it in an effect
  // (not during render) keeps the server and first client render identical,
  // which is what stops a hydration mismatch — and doing it in a LAYOUT effect
  // means the portalled control is in the DOM before the first paint.
  //
  // Portalled content is never server-rendered, so anything placed here is
  // client-only by construction. That is a real behavioural change for controls
  // that used to live in the page body: they now appear on hydration rather
  // than in the initial HTML. Keep ephemeral, page-scoped chrome here — not
  // anything that must exist for a no-JS or pre-hydration reader.
  useIsomorphicLayoutEffect(() => {
    setHost(document.getElementById(slotId));
  }, [slotId]);

  // Deliberately a PASSIVE effect keyed on `host`, not part of the layout
  // effect above. The layout effect only *finds* the host; the portal content
  // is not in the DOM until the re-render that `setHost` triggers has
  // committed. An effect that depends on `host` runs after that commit, so
  // when this fires the content is genuinely on the page — which is the whole
  // point of the signal.
  useEffect(() => {
    if (host) onPublished();
  }, [host, onPublished]);

  if (!host || children === undefined || children === null) return null;
  return createPortal(children, host);
}

export default function StudioPageHeader({ title, subtitle, breadcrumb, actions, status }: StudioPageHeaderProps) {
  const { setHeader } = useStudioHeader();
  // Identifies THIS header instance so a page unmounting after its successor
  // has mounted cannot blank the incoming title.
  const id = useId();
  const crumbKey = JSON.stringify(breadcrumb ?? null);

  // How many chrome slots this page actually fills, and how many have landed.
  // `data-header-ready` goes on the (server-rendered, always present) h1 once
  // every one of them is in the DOM — a page with no chrome controls is ready
  // as soon as it mounts.
  //
  // This exists because measuring or asserting against the chrome before the
  // portals land measures a page nobody ever sees. A fixed timeout is a guess;
  // this is the event itself.
  const expected = (actions != null ? 1 : 0) + (status != null ? 1 : 0);
  const [published, setPublished] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const onPublished = React.useCallback(() => setPublished((n) => n + 1), []);
  const ready = mounted && published >= expected;

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
      <h1 className="srOnly" data-header-ready={ready ? "true" : undefined}>{title}</h1>
      <ChromeSlot slotId="studio-topbar-actions" onPublished={onPublished}>{actions}</ChromeSlot>
      <ChromeSlot slotId="studio-subbar-status" onPublished={onPublished}>{status}</ChromeSlot>
    </>
  );
}
