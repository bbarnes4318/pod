# Studio design system

The Studio's palette was never the problem. `src/app/globals.css` `:root` already
held a coherent, well-reasoned token set. The problem was that nothing was
obliged to use it: 437 `style={{ … }}` props across `src/app/studio/**` bypassed
the stylesheet entirely, and the same page furniture was hand-rebuilt on every
route.

This document is the inventory and the rules. It **references** the existing
tokens rather than redefining them — if a value is not here, look in
`globals.css`, and if you need a new one, add it there.

---

## Tokens (defined in `src/app/globals.css`)

Do not introduce a parallel palette. Do not write a hex value in a component;
`tests/e2e/studio-tokens.spec.ts` fails the build if you do.

| Purpose | Token |
| --- | --- |
| App background | `--bg` `#0E1116` |
| Cards, panels | `--surface` `#161A21` |
| Elevated / advanced panels, wells, inputs | `--surface-2` `#1E242D` |
| Hairlines | `--border` `#2A313B`, hover `--border-hover` |
| Body text | `--text` `#EDEFF2` |
| Secondary text | `--text-muted` `#9BA3AF` |
| Primary / live / Generate **only** | `--accent` `#FF5A1F` (+ `-hover`, `-press`) |
| Host identity, seats 0–3 | `--host-a` … `--host-d` |
| Status | `--success` `--warning` `--error` |
| Small red **text** | `--error-text` — see below |
| Display face | `--font-display` |
| Timecodes, tallies, IDs | `--font-mono` |

### The `--error` / `--error-text` distinction is load-bearing

`--error` `#E5484D` is the spec value and is correct for **fills and borders**,
which only need 3:1. As small body text on an elevated panel it measures 3.99:1
and fails AA. `--error-text` `#FF6B6E` exists for that case. Use the right one;
they are not interchangeable.

### Spacing

Seven steps, and nothing between them:

```
--sp-1: 4px   --sp-2: 8px   --sp-3: 12px  --sp-4: 16px
--sp-6: 24px  --sp-8: 32px  --sp-12: 48px
```

**48px is the ceiling.** Before this scale the Studio mixed
`0.4 / 0.6 / 0.75 / 0.8 / 1.25 / 1.75 / 2 / 2.25rem` with no relationship
between the values, which is why nothing lined up across routes.

No card or `<section>` may spend more than **32px** of vertical padding.
Enforced by `studio-chrome.spec.ts`.

### Shell metrics

```
--studio-rail: 248px          --studio-rail-collapsed: 76px
--studio-topbar-h: 56px       --studio-subbar-h: 32px
--studio-topbar-h-sm: 52px    --studio-subbar-h-sm: 28px   (≤720px)
```

---

## Chrome

Page identity belongs to the **shell**, never to the page body.

```
┌─────────────────────────────────────────────────────────────┐
│ ⌂ brand │ Page title  · breadcrumb │ [actions] [Generate] [◉]│  56px  topbar
├─────────────────────────────────────────────────────────────┤
│ One line of subtitle                     status, right-aligned│  32px  subbar
├─────────────────────────────────────────────────────────────┤
│ main.studioMain — padding 16 / 24 / 32, max-width 1400px      │
```

### `<StudioPageHeader>`

```tsx
<StudioPageHeader
  title="Create an episode"                    // sentence case, goes in the topbar
  subtitle="Pick the takes. We'll build the show."   // ONE line, subbar
  breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}  // ancestors only
  actions={<button className="btnPrimary">Build a show</button>}
  status={<span>Saved 4:12 PM</span>}          // right side of the subbar
/>
```

**Why it is a client component.** The title has to render inside the shell's
topbar, which sits *above* the page in the tree, and RSC has no way to pass data
upward. Pages stay server components: they render this client component with
plain serializable props. `actions` and `status` take `ReactNode`, which a
server component may legally pass to a client component, so server-rendered
buttons still work.

The visible title in the topbar is a `<div>`. `StudioPageHeader` emits the real
`<h1>` with `.srOnly`, so the document has exactly one `h1`, it names the page,
and it is present in the server HTML rather than appearing after hydration.

A route → title fallback map in `StudioShell` means the topbar is never empty on
first paint, and never empty for a route that has not adopted the component yet.

`.pageTitle` and `.pageSub` are **deleted**, not aliased. A stray usage should be
visible, and the token spec fails if one returns.

---

## Component inventory

### Shell (`StudioShell.tsx`)
| Class | Role |
| --- | --- |
| `.studioShell` | Grid: nav rail + body. `data-collapsed`, `data-mobile-open` |
| `.studioSidebar` / `.studioNavLink` | Primary nav, `aria-current="page"` on the active item |
| `.studioTopbar` | Fixed 56px. **Height, not min-height** — a long title ellipsizes rather than pushing the fold down |
| `.studioTopbarHead` / `.studioTopbarTitle` | Page identity; `text-overflow: ellipsis` |
| `.studioCrumbs` / `.studioCrumb` | Ancestors. Separator drawn with `::after`, never typed, so it is not announced |
| `.studioTopbarActions` | Page-level controls, left of Generate |
| `.studioGenerateBtn` | The **one** accent CTA in the chrome |
| `.studioSubbar` / `.studioSubbarText` / `.studioSubbarStatus` | 32px, one line, `--text-muted` |
| `.studioMain` | max-width 1400px, padding `--sp-4 --sp-6 --sp-8` |

### Page primitives
| Class | Role |
| --- | --- |
| `.studioCard` | Surface panel. 20px vertical padding — under the 32px ceiling |
| `.sectionHead` / `.sectionTitle` / `.sectionAction` | In-page section heading row |
| `.grid2` / `.grid3` | Auto-fit responsive grids. Prefer these over a single centred column — `.studioMain` is 1400px and pages are expected to use it |
| `.emptyNote` | Empty state. Must contain a call to action, not just prose |
| `.btnPrimary` / `.btnGhost` | The two button levels |
| `.advPanel` / `.advLink` / `.advNote` | Progressive disclosure. **Use these**, do not invent a parallel pattern |
| `.studioNoteDisclosure` | `<details>` for reference copy that used to sit above every control |
| `.chip` / `.chipAccent` / `.chipSuccess` | Compact metadata |
| `.statusPill--{ok,warn,err,live}` | Pipeline state |
| `.srOnly` | Visually hidden, still announced |
| `PanelSkeleton.tsx` | Loading. Skeletons, never spinners, for anything over 200ms |

### Chrome-hosted page controls
| Class | Role |
| --- | --- |
| `.epScorePill` | Episode quality as a topbar badge, replacing a floated score card |
| `.createSaveState` | Create-flow save state in the subbar (was a `<p>` with a `-0.75rem` negative margin) |
| `.createDiscardConfirm` | Two-step discard, in the topbar so it stops moving between steps |

---

## Rules

**One accent per screen.** `--accent` is documented as primary / live / Generate
only. If two things are orange, neither reads as the action.

**The signature element is the rundown rail** — the broadcast rundown with tally
lights and monospace timecodes, shared by the create flow and the episode page.
Spend the boldness there and keep everything else quiet.

**Motion.** 120ms state changes, 200ms reveals, 320ms ceiling. Every looping cue
needs a static form under `prefers-reduced-motion` — a spinner that vanishes
reads as "finished", not as "reduced".

**Progressive disclosure.** Advanced options collapsed by default.

**Recognition over recall.** A topic card shows headline, sport, freshness and
talkability at a glance. Never make someone scroll back to check what they
picked.

**Peak-end.** The moment an episode finishes rendering is designed — tally cuts,
waveform resolves, player opens cued to the cold open. Not a toast.

---

## Copy

- Sentence case. Not Title Case Headers.
- Buttons are verbs, and the verb survives the transition: "Publish" → "Published."
- User vocabulary: "Episode length", never `targetDurationMs`.
- No emoji doing decoration's job in section headings.
- **Never use the word "booked."**
- No "Oops!", no exclamation marks, no apologising errors. Say what broke and
  what to do next.

---

## Accessibility floor

- Text ≥ 4.5:1, UI elements ≥ 3:1. Respect `--error` vs `--error-text`.
- Visible focus ring on everything interactive. `style={{ all: "unset" }}` kills
  focus visibility — that is a keyboard dead end, not a style choice.
- Full keyboard path through the create flow; tab order matches visual order.
- Preserve the existing `role="tablist"`, `aria-current` and `aria-live` usage.
- Nothing scrolls horizontally at 390px.

Enforced by `tests/e2e/studio-a11y.spec.ts` (axe, serious + critical),
`studio-chrome.spec.ts` (geometry) and `studio-tokens.spec.ts` (static).
