# Studio UX audit

Measured by driving the real UI in Chromium through the Playwright harness
(`tests/e2e/`), not by reading source.

> **Status: Parts 1–4 delivered and verified. Part 5 delivered except the live
> end-to-end proof run, which this environment cannot perform.** One route
> (`/studio/plan`) does not meet the first-control budget and is recorded as a
> documented exception with its real number rather than skipped. See
> [What is not done](#what-is-not-done).

---

## What was verified before touching anything

Every claim in the brief was checked against HEAD first. All of it held, with
two corrections:

| Claim | Verified |
| --- | --- |
| `.studioTopbar` 60px, holds no page context | ✅ |
| `.studioMain` padding `2.25rem 2rem 4rem`, max-width 1240px | ✅ |
| `.pageTitle` 2.4rem uppercase, `.pageSub` 2rem bottom margin | ✅ |
| `.pageTitle` duplicated across **16** files | ⚠️ **15**, not 16. `.pageSub` in 13 ✅ |
| Six worst inline-style files (73/63/31/26/21/20) | ✅ exact |
| `src/app/studio/audio/page.tsx` uses a bare `<h1>` | ✅ and its own `<main>` at a hardcoded 960px |
| `RundownBuilder` save line at `margin: -0.75rem 0 1rem` | ✅ |
| Step-rail buttons at `style={{ all: "unset" }}` | ✅ |

⚠️ **Total inline styles across `src/app/studio/**` was 437**, not the 234 in the
six named files.

---

## Results

| Check | Result |
| --- | --- |
| Inline `style={{ }}` under `src/app/studio` | ✅ **437 → 0** |
| Raw hex colours in components | ✅ **17 → 0** |
| `.pageTitle` / `.pageSub` eliminated from Studio | ✅ 15 files → 0 |
| `studio-rundown.spec.ts` (the create flow) | ✅ **24 / 24** |
| axe serious + critical, 15 routes × 3 widths | ✅ **45 / 45** |
| Exactly one `h1`, naming the page | ✅ |
| Visible focus ring on a real Tab press | ✅ all three widths |
| Chrome bands exactly 56/32 (52/28 mobile) | ✅ |
| No card over 32px vertical padding | ✅ |
| No horizontal scroll | ✅ |
| First control ≤160px | ✅ 14 / 15 routes — `/studio/plan` documented below |

`npx tsc --noEmit` clean. `npm run build` compiles.

---

## What changed

### Part 1 — Global chrome

Page identity moved into the shell. Pages publish through
`<StudioPageHeader title subtitle breadcrumb actions status />` and stay server
components.

| | Before | After |
| --- | --- | --- |
| Topbar | 60px `min-height` | **56px** `height` (a long title ellipsizes rather than pushing the fold down) |
| Subbar | — | **32px** |
| `.studioMain` padding | `2.25 / 2 / 4rem` | **`16 / 24 / 32px`** |
| `.studioMain` max-width | 1240px | **1400px** |
| Mobile (≤720px) | 0.6/1rem, 1.6/1/3rem | **52 / 28px**, `12 / 16 / 24px` |

Two details worth keeping: the visible topbar title is a `<div>` and the real
`<h1>` is `.srOnly`, so the document keeps exactly one h1 and it is in the
server HTML; and a route → title fallback map means the topbar is never empty
on first paint.

### Part 2 — The create flow

Three zones: rail (what you have decided) | workspace (the one decision in front
of you) | preview (what it adds up to, and the button that moves it on).

- The rail is vertical and carries **values**, not just step names. The old
  horizontal pill strip could only say which step you were on.
- `StepNav` is deleted. The CTA sits at the bottom of a sticky preview column
  and changes its verb, never its position. It used to sit at the bottom of
  whichever card was open, so it moved every time the step did.
- Notices get one overlaying slot. They used to be inserted above the step card,
  pushing the form down and moving the control out from under the cursor at the
  moment they appeared.
- **Flow reordered** so each step asks one thing: step one asks only which show;
  mode moved to Topics, where the thing it governs lives, and became two choices
  with hybrid as a checkbox on top of "I'll pick them"; title and description
  moved to Review, where the rundown they name exists.
- The take list gained **opt-in** density and paging. Admin's single-column list
  is untouched.
- The Board shows an unfinished rundown — it was the one screen that never
  mentioned a draft the studio was already holding.

### Part 3 — The episode page

The production console is the page spine. It used to be the `else` branch of
"does this episode have audio yet", so the moment a master existed the pipeline
went invisible — even though show notes, chapters and cover art are written
*after* the audio, and a re-mix runs the mix stage again on an episode that
already has one. It now runs alongside the player until the pipeline is
genuinely finished, and skips the read for the three terminal statuses so a
finished episode costs what it did before.

Restyled as a broadcast rundown: a tally lamp per row, one shared monospace
clock column so a ticking second never reflows a row and two rows' times line up
digit for digit, and the state written in words as well as colour.

- **Streaming script.** Lines appear as they are written and fill in as each
  one's audio returns. A line reads as recorded only when its own
  `AudioSegment` row says ready — the ready rows serve as both the voicing
  numerator and the recorded set, so it costs one query, not two.
- **Recovery in the row that failed**, carrying the way out as well as the
  retry: a fact-check or voicing stop links to the transcript, because
  restarting the same input just fails again.
- **The blocking action moved to the console header.** When the studio is
  waiting on the operator, the button that unblocks it was inside whichever row
  was blocked — 363px down a six-stage rundown.
- **Action bar**, sticky rather than fixed, so it takes its own space and can
  never cover the last row of a panel.
- **Transcript density.** Every line spent two stacked blocks and a permanently
  reserved action strip — three rows of chrome for one row of dialogue. The
  speaker moved to a fixed left gutter; the actions leave the flow until hover
  or focus. `:focus-within` fires from the always-focusable line text, and
  `@media (hover: none)` shows them outright on touch.
- **Tabs mount on first visit.** Publishing assets, the social clip and the
  diversity report each fetch on mount and were doing so on every page view,
  including the majority that only look at the overview.

### Part 4 — The inline-style purge

437 → 0, and 17 raw hex values → 0. Three of those were real visual defects, not
merely token violations:

- `RoleTracePanel` defined `#a3131b` for failures — a **light-theme red on a
  `#0E1116` background**. The state that most needed to be seen was the least
  visible.
- `StudioPlayer` hardcoded `#58a6ff` for host B while `--host-b` is `#4C8DFF`:
  the waveform and the transcript showed **different blues for the same host**.
- `EpisodeDiversityPanel` drew `#e5e5e5` hairlines that all but vanished.

160 one-off margins were snapped onto the seven-step scale, which is the actual
reason pages now line up across routes.

---

## Four contrast failures, all one mistake

Every one was the same instinct: to make something look secondary, fade it.
Opacity does not know about contrast, so each fade walked a token that passes AA
down below the floor.

| Element | Measured | Cause |
| --- | ---: | --- |
| `.prodTickerLine` | 3.29:1 | `opacity: 0.6` on `--text-muted` |
| `TopicRundownPicker` card | 4.04:1 | `opacity: 0.72` on an unselectable card |
| `.epTabHint` (active) | 4.25:1 | `opacity: 0.9` on `--accent` |
| `.epTabHint` (inactive) | — | `opacity: 0.85` on `--text-muted` |

The first was mine, introduced in this branch. The second is worth dwelling on:
it dropped every chip on the card to 4.04:1, so the card explaining **why** a
take could not be used was the hardest one on the page to read. It survived the
inline-style purge because `TopicRundownPicker` lives under `src/components/`,
outside the token spec's `src/app/studio/**` scope.

All four now recede by token, never by fading one.

---

## The lesson this branch kept re-learning

Three separate failures, one shape: **a check that can pass before a transition
proves nothing about the transition.**

1. **The create-flow suite (22 → 7).** Discard moved into the topbar, where it
   renders through a portal. The spec's helper probed for it with a bare
   `isVisible()` immediately after `goto()`. That used to work because the
   button was in the server HTML; portalled content never is. The probe returned
   false, the draft was never discarded, and the restored draft opened on a step
   where `mode-manual` does not exist — which is why the first test passed and
   every test after it failed.
2. **The discard-reload sentinel.** Two sentinels in a row failed to detect a
   `window.location.reload()`, both because they were already true before it:
   `save-status` exists on the old document too, and `discard-draft` is
   *already* absent during the confirm step, because the confirm/cancel pair
   replaces it. Only `discard-confirm` — present until the reload, gone after —
   actually detects it.
3. **The chrome measurement.** The budget spec measured 400ms after load and
   called that settled. Page actions reach the topbar through a portal, so on
   Show detail two controls at y=8 had not appeared yet and the route was
   reported 396px over budget; Analytics, whose only controls are portalled, was
   reported as having none at all.

The fix in each case was to wait for the event rather than a duration.
`StudioPageHeader` now publishes `data-header-ready` once every chrome slot the
page fills is in the DOM — and that signal is a **passive** effect keyed on the
resolved host, not part of the layout effect that finds it, because the portal
content is not committed until the re-render `setHost` triggers.

---

## The first-control budget

Chrome is **104px** (56 topbar + 32 subbar + 16 main padding), so a route has
56px of body before the 160px budget is spent.

**The measurement was wrong for five routes and that was a bug in the test, not
the pages.** It looked only inside `main.studioMain` — a rule written before
Part 1 moved page actions into the topbar. On Show detail the page's own
"Generate an episode" sits at y≈20 while the test reported the route 400px over
budget. The roots are now everything the *page* owns: its body plus the two
chrome slots it publishes into. Shell furniture (nav, brand, the global Generate
button, the account menu) stays excluded — it is identical on every route and
would satisfy the budget everywhere while proving nothing.

That correction did **not** excuse the rest, which were fixed for real:

| Fix | Effect |
| --- | --- |
| `.sectionHead` was `2.25rem`/36px — not on the spacing scale at all | on the scale, and zero top margin for a page's first section |
| Publishing's feed bar wrapped its buttons to a second line under 720px | stops wrapping; the URL gives up width instead |
| Plan's current tier was a stacked headline | one dense row |
| `PodcastWizard` repeated page identity on `/studio/shows/new` | suppressed there — also removed a duplicate `<h1>` |
| The console's blocking action sat in the blocked row | moved to the console header |
| The console header stacked ~100px above the action on mobile | action takes the top of the header below 720px |

### The one exception

`/studio/plan` measures **488px** (desktop), 468px (tablet), 532px (mobile).

It is an in-product pricing ladder. Its first meaningful control is "choose this
plan", and a plan cannot be chosen before it has been named and priced, so the
button necessarily sits below its own card head. Meeting 160px would take *both*
putting the ladder above the usage summary *and* moving each card's button up
beside its price. Either might be defensible alone; doing both purely to satisfy
a number would be rearranging a page around its test.

It is recorded in `studio-chrome.spec.ts` as a documented exception carrying its
real number and held at a **540px ceiling**, so the test still fails if Plan gets
worse, and the failure message says so explicitly. It is not skipped and not
excluded.

---

## A regression this work introduced, and how it hid

`PodcastWizard` still used `.pageTitle` and `.pageSub` after Part 1 deleted them
from the Studio stylesheet. Precisely:

- `.pageSub` is now defined in **no** stylesheet.
- `.pageTitle` survives **only** in `src/app/admin/layout.css`, which the 15
  admin pages using it do import — those are fine and were never affected.
- `PodcastWizard` is the single component that used the class without loading
  that stylesheet, so it rendered unstyled on `/app/podcasts/new` and
  `/studio/shows/new` for the rest of the branch.

It hid because the token spec is scoped to `src/app/studio/**` while the
deletion it guarded was global. **The guard's scope did not match the change's
scope.** The spec now checks `.pageSub` across all of `src/app`.

---

## What is not done

1. **The scripted end-to-end proof run.** Building an episode through to
   finished audio, regenerating a line, and forcing then recovering a stage
   failure needs live LLM and TTS. The harness is DB-only and this account has
   no Anthropic credit. Not attempted, not simulated.
2. **Nine pre-existing `sound-diversity` failures.** All nine fail in the same
   helper, on `getByRole('region', { name: 'Player' })`.
   `/app/podcasts/[id]/sound` is a legacy redirect into
   `/studio/shows/[id]/sound`, which renders the studio layout; `PlayerBar`
   only exists under `src/app/app/layout.tsx`. Neither file differs from
   `origin/main` in a way that could have removed a player, so the assertion
   cannot have passed there either. **This may be a real bug for `/app` users —
   the redirect drops their player — but that is a call about `/app`, not this
   rebuild.** Flagged, not fixed.
3. **`/studio/plan`** — see the exception above.

## Harness note, learned the expensive way

**`studio-rundown.spec.ts` and `sound-diversity.spec.ts` cannot share a run.**
`sound-diversity` creates episodes against the same seeded podcast the rundown
spec depends on, which changes topic eligibility underneath it. Batching them
produced a confident-looking failure in `inheritance flow A` that does not
reproduce when `studio-rundown` runs alone (24/24). Run it on its own.

Setup costs ~2.5 minutes per invocation, so batching is tempting — batch the
*chrome/tokens/a11y/screenshot* specs, which only read, and never the two above.
