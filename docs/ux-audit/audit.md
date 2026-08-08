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
| axe, serious/critical, all 15 routes | ✅ **15/15 zero violations** |
| Exactly one `h1`, naming the page | ✅ |
| Chrome band heights exactly 56/32 | ✅ |
| No card over 32px vertical padding | ✅ |
| No horizontal scroll | ✅ |
| `.pageTitle`/`.pageSub` eliminated | ✅ |
| Existing `studio-rundown.spec.ts` | 🔴 **7/22 — REGRESSION, see below** |
| First control ≤160px | ⚠️ **6/15** |
| No inline styles | ❌ 437 remain |
| No raw hex | ❌ 17 remain |

`npx tsc --noEmit` clean. `npm run build` exits 0.

### 🔴 MERGE BLOCKER — the create flow is broken

`studio-rundown.spec.ts` passed **22/22** against `0d6d1ef` before any edit.
After the chrome work, a clean solo run gives **7 passed, 15 failed**.

This is a real regression, not a harness artefact. (An earlier run was
inconclusive because two Playwright harnesses overlapped on the shared fixed
port; re-running it alone reproduced the failures.)

The failure is the same in every case:

```
expect(locator).toBeVisible() failed
Locator: getByTestId('mode-manual')
Error: element(s) not found
```

`mode-manual` is the mode control on create step 1, which this work never
touched. A test-id that vanishes without being edited points at the page failing
to render at all rather than at a moved control — i.e. a client-side exception
in `RundownBuilder` or in the header it now mounts.

**Prime suspect: the `<StudioPageHeader>` added to `RundownBuilder`.** It is the
only structural change to that component, and it is the only page that passes
`status` (the live save state). One loop was already found and fixed there —
`actions`/`status` in the effect deps — but the fix has not been re-verified
against this suite, and the remaining failures may be a second instance of the
same class of problem.

**Cheapest path back to green:** revert just the `<StudioPageHeader>` block in
`RundownBuilder.tsx` (restoring the in-body save line and discard button), re-run
the suite, and confirm 22/22. That isolates the fault to the header integration
without giving up the chrome on the other 14 routes. Then reintroduce it with the
browser console open.

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

Stated plainly rather than partially attempted.

### Part 2 — `/studio/create` three-zone rebuild ❌
The vertical rundown rail, full-width workspace, fixed preview column with the
never-moving CTA, dense paginated topic grid, the flow reordering (step 1 asks
only which show; mode → Topics as two choices + a hybrid checkbox; title and
description → Review), the dry-run cold-open preview, and the toast slot are all
**not built**. Only the chrome-hosted save state and discard landed.

### Part 3 — `/studio/episodes/[id]` rebuild ❌
The production console is still a fallback in the audio-player slot rather than
the page spine. The broadcast-rundown layout with tally lights and monospace
per-stage elapsed, streaming transcript lines, inline stage-failure recovery,
transcript density pass and the fixed bottom action bar are **not built**. Only
the header moved.

### Part 4 — Inline style purge ❌
**437** `style={{ }}` props and **17** raw hex values remain. The exact hex list
is in the `studio-tokens.spec.ts` failure output; the worst offenders are
`StudioPlayer.tsx` (canvas gradient stops `#ffb224`/`#ff5a1f`, and a
`HOST_COLORS` array duplicating `--host-a`/`--host-b`), `RoleTracePanel.tsx`
(a whole parallel status palette: `#1f7a4d`/`#a3131b`/`#7a6a1f`), and five
`#b45309` amber literals in `RundownBuilder.tsx` shadowing `--warning-color`.

### Part 5 — Proof run ⚠️
The scripted click-through (sign in → complete every create step → build to
finished audio → regenerate a line → force and recover a stage failure → repeat
at 390px) was **not run**. Building an episode end-to-end requires live LLM and
TTS calls; the harness is explicitly DB-only. Route-level verification at all
three widths did run.

### Nine routes still over the 160px budget
All of it body content. Show detail (400px) and Episode detail (341px) lead with
prose and a player; both are inside Parts 2/3. Episodes (179px) and Auditions are
within ~20–40px and would come down with a spacing pass.

---

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

**Part 4, the inline-style purge — before Parts 2 or 3.**

It is the least glamorous item and the highest leverage. Parts 2 and 3 rebuild
two pages; the purge fixes the reason *every* page looks unrelated to the next,
and it is what makes the rebuilds cheap — right now a card's padding on the
create page has no relationship to the same card on the episode page, so any
layout work gets re-litigated per file. The spec that enforces it already exists
and already fails, so the work is bounded and verifiable: drive
`studio-tokens.spec.ts` to green.

Start with `RoleTracePanel.tsx` and `StudioPlayer.tsx` — between them they carry
a complete second colour system that has to die before a third one appears.
