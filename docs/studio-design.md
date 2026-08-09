# The Studio design system

What the rules are, and why each one exists. Every rule here is enforced by a
spec in `tests/e2e/` — if it is not enforced, it is not in this document.

---

## Chrome

The shell owns page identity. A page never draws its own title.

```tsx
<StudioPageHeader
  title="Episodes"                      // sentence case, shown in the topbar
  subtitle="Finished shows up top."     // one line, in the subbar; omit rather than pad
  breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
  actions={<Link className="btnPrimary">Build a show</Link>}   // topbar
  status={<span>Saved 14:02</span>}                            // subbar, right
/>
```

| Band | Desktop | ≤720px |
| --- | --- | --- |
| Topbar | 56px | 52px |
| Subbar | 32px | 28px |
| `.studioMain` padding | `16 / 24 / 32px` | `12 / 16 / 24px` |
| `.studioMain` max-width | 1400px | — |

The topbar uses `height`, not `min-height`: a long title ellipsizes rather than
pushing the fold down.

**Pages stay server components.** `StudioPageHeader` is a client component
because RSC cannot pass data upward, but `actions` and `status` accept
`ReactNode`, which a server component may hand to a client component — so
server-rendered buttons work unchanged.

### Two channels, deliberately different

- `title` / `subtitle` / `breadcrumb` are **primitives**, published through
  context. Effect deps compare by value, so publishing settles in one pass.
- `actions` / `status` are **elements**, rendered through a **portal**. They must
  not go through context: a React element is a fresh object every render, so
  effect deps containing one never compare equal — publish re-renders the shell,
  the shell re-renders the page, the page builds a new element, and the effect
  fires again. That is an infinite loop, and it hung every page carrying
  `status` until it was split out.

### Portalled content is never server-rendered

This is the single most load-bearing fact in the system, and it caused three
separate failures on this branch.

Anything in `actions` or `status` is **client-only by construction**. It appears
on hydration, not in the initial HTML. Consequences:

- Do not put anything there that must exist for a pre-hydration or no-JS reader.
- **Never assert or measure against chrome content without waiting for it.**
  `StudioPageHeader` sets `data-header-ready="true"` on its `.srOnly` h1 once
  every slot the page fills is in the DOM. Wait for that, not for a duration.

The readiness signal is a *passive* effect keyed on the resolved portal host —
not part of the layout effect that finds it. The layout effect only locates the
node; the content is not committed until the re-render `setHost` triggers.

> **The general rule, learned three times:** a check that can pass *before* a
> transition proves nothing about the transition.

---

## Spacing

One scale. `--sp-1: 4px`, `--sp-2: 8`, `--sp-3: 12`, `--sp-4: 16`, `--sp-6: 24`,
`--sp-8: 32`, `--sp-12: 48`.

48px is the ceiling. No card carries more than 32px of vertical padding. Ad-hoc
values (`0.4 / 0.6 / 0.75 / 2.25rem`) are gone — 160 of them were snapped onto
this scale, which is why pages now line up across routes.

Utilities exist for the common cases: `.mt-*`, `.mb-*`, `.u-*`.

---

## Colour

Every colour is a token in `globals.css`. Components hold none.

| Token | Use |
| --- | --- |
| `--bg` `--surface` `--surface-2` | page, card, raised card |
| `--text` `--text-muted` | body, secondary |
| `--accent` | **primary actions, live state and Generate only** |
| `--host-a` … `--host-d` | seat-indexed host identity |
| `--error` / `--error-text` | fills and borders (3:1) / small text (AA) |
| `--success` `--warning` | terminal and cautionary states |

### Never recede text with opacity

Opacity does not know about contrast. Four AA failures on this branch were all
this one instinct:

| Element | Measured | Cause |
| --- | ---: | --- |
| console ticker line | 3.29:1 | `opacity: 0.6` on `--text-muted` |
| unselectable take card | 4.04:1 | `opacity: 0.72` on the card |
| active tab hint | 4.25:1 | `opacity: 0.9` on `--accent` |

To make something secondary, **change the token** — `--text-muted` on
`--surface` is 6.85:1 and reads as recessive without breaking the floor. To mark
something unavailable, change the **border** (dashed) and disable the control;
the reason text must stay fully legible, because it is the thing the user needs
most at that moment.

### Two escape hatches, both narrow

1. **CSS custom properties for data-driven geometry.** A value that comes from
   the data cannot live in a stylesheet:
   ```tsx
   <div className="playerHostSpan" style={{ "--span-start": "63.2%" }} />
   ```
   Setting a real CSS property inline is still a violation.
2. **`cssToken()` fallbacks.** Canvas cannot read a custom property, so
   `StudioPlayer` resolves tokens off the document at paint time. The second
   argument is a documented mirror of `globals.css`, not a second definition.

---

## Layout

**Use the width.** `.studioMain` is 1400px and pages are expected to use it —
grids and side rails, not one column down the middle.

Two established multi-zone patterns:

- **Create** — rail (what you decided) | workspace (the decision in front of
  you) | preview (what it adds up to, and the CTA). The rail and preview are
  sticky; the CTA is pinned to the bottom of the preview so the primary action
  occupies the same pixels on every step.
- **Episode** — console spine, tabbed workspace, sticky action bar. The bar is
  `position: sticky; bottom: 0` as the last element, **not** `fixed`: it takes
  its own space at the end of the document, so it can never cover the last row
  of a panel.

### First-control budget

The first control a page owns sits within **160px of the viewport top** at every
width. Chrome is 104px, leaving 56px of body.

Measured across `main.studioMain` plus the two chrome slots — the page's own
controls count wherever they render. Shell furniture does not: it is identical
on every route and would satisfy the budget everywhere while proving nothing.

One documented exception, carrying its real number:
`/studio/plan` at 488px, held at a 540px ceiling. A pricing ladder's CTA cannot
precede the plan's name and price. See `audit.md`.

---

## Copy

- Sentence case. Not Title Case, not UPPERCASE outside a styled label.
- Buttons are verbs, and the verb survives: "Record the voices", not "Voices".
- The user's vocabulary, not the system's: "takes", "shows", "episodes" —
  never "entities", "records", "jobs".
- **Never use the word "booked."**
- No decorative emoji in section headings.
- Errors say what happened and what to do. No "Oops!", no exclamation marks, no
  apologising. A refusal states its reason.
- Progress never lies: a filled bar means a real counted fraction, a sweep means
  "running, no honest percentage exists". Only voicing has a real denominator.

---

## Accessibility floor

Enforced by `studio-a11y.spec.ts` on 15 routes × 3 widths: **zero serious or
critical axe violations**.

- Exactly one `<h1>` per page, naming the page, present in the server HTML.
- Every control has an accessible name — including when a media query hides its
  label. Two mobile controls failed this because the icon was `aria-hidden` and
  the label was `display: none`.
- A visible focus ring on a real Tab press. Test it with actual key presses:
  `element.focus()` does not reliably match `:focus-visible`.
- Colour is never the only carrier of meaning. The console rundown says its
  state in words beside the tally lamp.
- Hover-only affordances get `@media (hover: none)` treatment — a wide tablet is
  still a touch screen.
- Reordering with CSS `order` is fine when DOM order still reads correctly to a
  screen reader, as on the mobile console header.

---

## Enforcement

| Spec | Guards |
| --- | --- |
| `studio-chrome` | band heights, first-control budget, card padding ceiling, no horizontal scroll |
| `studio-tokens` | no inline `style={{ }}`, no raw hex, no `.pageTitle`; `.pageSub` across all of `src/app` |
| `studio-a11y` | axe serious+critical, single h1, real-Tab focus ring |
| `studio-rundown` | the create flow end to end (24 tests) |
| `studio-screenshots` | 15 routes × 3 widths into `docs/ux-audit/` |

**Scope your guards to the scope of what they guard.** The `.pageSub` check runs
across all of `src/app`, not just `src/app/studio/**`, because the class it
guards was deleted globally — and the original studio-scoped check saw nothing
while a component outside that directory rendered unstyled for an entire branch.

**Do not batch `studio-rundown` with `sound-diversity`.** They share seeded data;
see the harness note in `audit.md`.
