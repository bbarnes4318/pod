# Studio UX audit

Measured against `main` at `0d6d1ef`, verified by driving the real UI in Chromium
through the Playwright harness (`tests/e2e/`), not by reading source.

> **Status: partially delivered, and NOT mergeable as-is.** Part 1 (global
> chrome) is in place on all 15 routes and verified for a11y, geometry and
> spacing — but it regresses the create flow (15 failing tests). See the merge
> blocker. Parts 2–4 (create-flow rebuild, episode
> page rebuild, inline-style purge) are **not done**. This document records what
> was measured, what changed, and exactly what remains — see
> [What is not done](#what-is-not-done).

---

## What was verified before touching anything

Every claim in the brief was checked against HEAD first. All of it held, with two
corrections:

| Claim | Verified |
| --- | --- |
| `.studioTopbar` 60px, holds no page context | ✅ `studio.css:126` |
| `.studioMain` padding `2.25rem 2rem 4rem`, max-width 1240px | ✅ `studio.css:278` |
| `.pageTitle` 2.4rem uppercase, `.pageSub` 2rem bottom margin | ✅ `studio.css:292` |
| `.pageTitle` duplicated across **16** files | ⚠️ **15**, not 16. `.pageSub` in 13 ✅ |
| Six worst inline-style files (73/63/31/26/21/20) | ✅ exact |
| `src/app/studio/audio/page.tsx` uses a bare `<h1>` | ✅ line 13, and its own `<main>` with a hardcoded 960px width |
| `RundownBuilder` save line at `margin: -0.75rem 0 1rem` | ✅ |
| Step-rail buttons at `style={{ all: "unset" }}` | ✅ line 390 |
| Episode page: chip row → title → floated score card, all inline | ✅ line 268 |

⚠️ **Total inline styles across `src/app/studio/**` is 437**, not just the 234 in
the six named files.

### Measured cost, before

Chrome consumed **~194px** on every route. First interactive control, at 1440×900:

| Route | Before | After | Budget 160px |
| --- | ---: | ---: | :---: |
| The Board | — | ✅ | pass |
| Shows | — | ✅ | pass |
| Create | — | ✅ | pass |
| Takes | — | ✅ | pass |
| Audio | — | ✅ | pass |
| Publish | — | ✅ | pass |
| Episodes | — | 179px | ✗ |
| New show | — | 196px | ✗ |
| Episode detail | — | 341px | ✗ |
| Show detail | — | 400px | ✗ |
| Hosts, Auditions, Analytics, Plan, Settings | — | over | ✗ |

The chrome itself is now **104px** (56 topbar + 32 subbar + 16 main padding), so
every remaining failure is body content, not chrome.

---

## What changed

### Part 1 — Global chrome ✅

**Page identity moved into the shell.** `StudioShell` gained a page-header
channel; pages publish through `<StudioPageHeader title subtitle breadcrumb
actions status />`.

RSC cannot pass data upward, so the header component is a client component — but
**pages stay server components**, passing plain serializable props.
`actions`/`status` accept `ReactNode`, which a server component may legally hand
to a client component, so server-rendered buttons still work.

Two details worth keeping:

- The visible topbar title is a `<div>`; `StudioPageHeader` emits the real `<h1>`
  with `.srOnly`. The document keeps exactly **one** `h1`, it names the page, and
  it is in the server HTML rather than appearing after hydration. Verified.
- A route → title fallback map means the topbar is never empty on first paint,
  and never empty for a route that has not adopted the component.

**Numbers**, all enforced by `studio-chrome.spec.ts`:

| | Before | After |
| --- | --- | --- |
| Topbar | 60px (`min-height`) | **56px** (`height` — a long title ellipsizes rather than pushing the fold down) |
| Subbar | — | **32px** |
| `.studioMain` padding | `2.25 / 2 / 4rem` | **`16 / 24 / 32px`** |
| `.studioMain` max-width | 1240px | **1400px** |
| Mobile (≤720px) | 0.6/1rem, 1.6/1/3rem | **52px / 28px**, `12 / 16 / 24px` |

**Spacing scale.** `--sp-1..--sp-12` (4/8/12/16/24/32/48) replaces the ad-hoc
`0.4/0.6/0.75/0.8/1.25/1.75/2/2.25rem` mix. 48px is the ceiling.

**`.pageTitle` and `.pageSub` are deleted**, not aliased — a stray usage should
be visible. All 15 files converted; the token spec fails if one returns.

**Create flow (partial).** The save-status line came out of the page body (it sat
under a `-0.75rem` negative margin) and into the subbar. Discard moved from below
the step card — where it changed position on every step — into the topbar. Test
IDs preserved — but the suite now fails; see the merge blocker below.

**Episode page (partial).** Title, chips and quality score moved into the
chrome; the floated score card became `.epScorePill`, a compact topbar badge.

**Two lead-in notes demoted.** Hosts and Auditions each opened with an `.advNote`
paragraph above every control. They are context, not a gate, so they became
`<details>` disclosures (`.studioNoteDisclosure`) using the existing progressive-
disclosure language rather than a parallel pattern.

---

## Verification

Driven in a real browser through the existing Playwright harness (embedded
Postgres, seeded, authenticated through the UI — no Docker required).

**Three new specs**, as required:

- `studio-chrome.spec.ts` — first control ≤160px on every route, exact band
  heights, 32px card-padding ceiling, no horizontal scroll.
- `studio-tokens.spec.ts` — static: no `style={{`, no raw hex, no `.pageTitle`,
  anywhere under `src/app/studio/**`.
- `studio-a11y.spec.ts` — axe scan, serious + critical only, all 15 routes, plus
  a single-`h1` check and a real-Tab focus-ring check.

**Results:**

| Check | Result |
| --- | --- |
| Inline `style={{ }}` under `src/app/studio` | ✅ **437 → 0** |
| Raw hex colours in components | ✅ **17 → 0** |
| `.pageTitle` / `.pageSub` eliminated | ✅ 15 files → 0 |
| Existing `studio-rundown.spec.ts` | ✅ **22/22** (regressed to 7, now restored) |
| axe serious/critical, 15 routes × 3 widths | ⚠️ **44/45** — one contrast finding, below |
| Exactly one `h1`, naming the page | ✅ |
| Visible focus ring on a real Tab press | ✅ all three widths |
| Chrome bands exactly 56/32 (52/28 mobile) | ✅ |
| No card over 32px vertical padding | ✅ |
| No horizontal scroll | ✅ |
| First control ≤160px | ⚠️ **6/15 desktop** — body content, not chrome |

`npx tsc --noEmit` clean. `npm run build` exits 0.

### The create-flow regression, and what actually caused it

The suite went 22/22 → 7/22 on this branch, then back to 22/22. Worth recording,
because the cause was not where it looked.

**Portalled content is never server-rendered.** Discard moved from the page body
into the shell topbar, where it renders through a portal. The spec's
`gotoCreate()` helper probes for it with a bare `isVisible()` — no auto-wait —
immediately after `page.goto()`. That probe used to succeed because the button
was in the server HTML. Now it only exists after hydration, so the probe
returned false, the draft was never discarded, and the restored draft opened on
its own saved step, where `mode-manual` does not exist. That is why the FIRST
test passed and every test after it failed: the first one runs with no draft.

Two wrong turns on the way, both cheap to repeat:

1. I assumed the page was throwing, because a test-id present in source was
   absent from the DOM. A five-minute diagnostic (a `pageerror` listener plus a
   DOM probe) showed the page rendering perfectly with zero console errors. That
   should have been the first move, not the third.
2. The first fix waited on `.rundownBuilder` and `step-show` and got 18/22.
   Both are server-rendered, so waiting on them proves nothing about hydration.
   The sentinel has to be something that *cannot* exist before hydration —
   `save-status`, which is itself portalled.

Fixed en route: `StudioPageHeader` published `actions`/`status` through context
with both in the `useEffect` dependency array. A React element is a fresh object
every render, so the deps never compared equal — publish re-rendered the shell,
the shell re-rendered the page, the page rebuilt the element, and the effect
fired again. An infinite render loop on every page carrying `status`. Elements
now portal; only primitives travel through context.

### One open accessibility finding

`Create` at 768px and 390px: `SERIOUS color-contrast` on the topic-card `.chip`
elements. `.chip` is `--text-muted` on `--surface-2`, which measures ~6.1:1 in
isolation and should pass — so the real cause is probably an ancestor opacity or
a different background under those cards. I did not chase it to ground. It is a
real finding, not a false positive. Desktop passes; the other 44 route/width
combinations pass.

`npm run lint` reports 1023 errors repo-wide — **all pre-existing**; the only two
in files I touched (`StudioShell.tsx:186` setState-in-effect,
`studio/page.tsx:111` `any`) predate this work and are untouched lines.

### Screenshots

`docs/ux-audit/before/` — 45 files (15 routes × 1440/768/390), captured against
`0d6d1ef` before any edit. `docs/ux-audit/after/` — same set, post-chrome.

Captured by `tests/e2e/studio-screenshots.spec.ts`
(`SHOT_PHASE=before|after npx playwright test …`).

---

## What is not done

### Part 2 — `/studio/create` three-zone rebuild ❌
The vertical rundown rail, full-width workspace, fixed preview column with the
never-moving CTA, dense paginated topic grid, the flow reordering (step 1 asks
only which show; mode → Topics as two choices plus a hybrid checkbox; title and
description → Review), the dry-run cold-open preview, and the toast slot are all
**not built**. What did land: the chrome-hosted save state and Discard, and the
whole file converted off inline styles.

### Part 3 — `/studio/episodes/[id]` rebuild ❌
The production console is still a fallback in the audio-player slot rather than
the page spine. The broadcast-rundown layout with tally lights and monospace
per-stage elapsed, streaming transcript lines, inline stage-failure recovery and
the fixed bottom action bar are **not built**. What did land: the header moved
into the chrome, the floated score card became `.epScorePill`, and the page plus
`StudioPlayer`, `MixView`, `TranscriptWorkspace`, `RoleTracePanel` and
`EpisodeDiversityPanel` are all off inline styles — including three separate
hardcoded colour systems.

### Part 5 — the scripted proof run ⚠️
Sign in → complete every create step by clicking → build to finished audio →
regenerate a line → force a stage failure and recover → repeat at 390px was
**not run end to end**. Building an episode needs live LLM and TTS calls, and the
harness is deliberately DB-only. Everything short of "build real audio" *was*
driven in a real browser at all three widths.

### Nine routes still over the 160px first-control budget
Chrome is 104px (56 + 32 + 16), so every number below is body content.
Measured desktop / tablet / mobile:

| Route | 1440 | 768 | 390 |
| --- | ---: | ---: | ---: |
| Show detail | 400 | 497 | 641 |
| Plan | 500 | 520 | 572 |
| Hosts | 381 | 389 | 392 |
| Episode detail | 341 | 341 | 344 |
| New show | 196 | 196 | 270 |
| Shows | pass | 205 | 217 |
| Episodes | 166 | 178 | 182 |
| Settings | 166 | 166 | 178 |
| Auditions | 167 | 167 | 167 |
| Publish | pass | pass | 168 |

Passing at every width: The Board, Create, Takes, Audio.

Show detail, Episode detail and Plan lead with prose or data by design; the rest
sit within ~20–40px and would come down with a spacing pass. Show detail and
Episode detail are inside Parts 2 and 3 anyway.

## Still weak

**The header channel is a client-side context.** It works, and the `h1` is
server-rendered, but the *visible* title arrives with hydration. On a slow
connection the fallback map shows the route's static title first — right for 13
routes, briefly generic for the two dynamic ones (Show detail, Episode detail).
A parallel route slot (`@header`) would be fully server-rendered; it was rejected
because it means mirroring every route directory and duplicating each page's data
fetch.

**The 160px budget may be the wrong instrument for data-led pages.** Analytics
and Plan legitimately lead with numbers. The budget as written pushes them to put
a control above their own content, which is not obviously better. Worth revisiting
as "first control OR first meaningful content ≤160px".

---

## The one thing I would do next

**Part 3 — make the production console the page spine.**

Part 4 is done, so the expensive groundwork is paid for: one spacing scale, one
colour system, and a spec that fails the moment someone reaches past them. Parts
2 and 3 are both cheaper than they were.

Of the two, Part 3 is worth more. The highest-attention moment in the product is
the minutes a customer spends watching an episode generate — and today that state
renders *only because there is no audio player yet*. It is the `else` branch of a
null check. Meanwhile `createProgress.ts` already returns real per-stage state,
real elapsed times and real medians, and `retryProductionStage` already resumes
from a failed stage. The data is all there and it is rendered as a list. Giving
it the broadcast-rundown treatment — tally on the active stage, monospace
elapsed, checkmark on completion, failures recoverable in place — is mostly
layout over an API that already exists.

Part 2 is the larger rebuild and can follow.
