# Take Machine — "ON AIR" Design System

One identity across the whole product: **a dark broadcast studio with a single
signature accent**. Defined in `src/app/globals.css`; everything cascades
through CSS custom properties.

## Why this direction
A sports-debate audio product needs heat (sports media) and craft (studio
gear). The dark base reads as a control room / recording booth; the single
**Signal Orange `#FF5A1F`** accent is the ON-AIR lamp and VU-meter needle —
energy without the scoreboard cliché of red/blue. Restricting to one accent
keeps every page unmistakably the same product and makes the accent *mean*
something (live, hot, act here).

## Tokens (change values, never names — legacy pages consume these)
| Token | Value | Use |
|---|---|---|
| `--bg-primary` | `#0B0D12` | App background |
| `--bg-secondary` | `#12151D` | Cards, panels |
| `--bg-tertiary` | `#1A1E29` | Inputs, hover wells |
| `--text-primary` | `#F2F0EB` | Body text (warm white) |
| `--text-secondary` | `#97A0B5` | Secondary text |
| `--accent-color` | `#FF5A1F` | THE accent. Buttons, active nav, scores, ON-AIR |
| `--wave-hot` / `--wave-warm` | `#FF5A1F` / `#FFB224` | Waveforms & score bars ONLY |
| success / warning / error | muted green/amber/red | Semantic states, kept quiet |

**Sanctioned second hue:** `#58A6FF` (ice blue) is *functional only* — it
identifies Host B (Dr. Linebreak) in the player host-strip and transcripts.
Never use it decoratively.

**Buttons on accent:** text is `#0B0D12` (dark on orange ≈ 6:1 contrast), not white.

## Type
- **Display** (`--font-display`, Barlow Condensed via `next/font`): page titles,
  scores, "broadcast" moments. Always uppercase, tight leading.
- **Body** (`--font-family`, Inter): everything else.
- Scale: 12 / 14 / 16 / 20 / ~28 (section) / clamp-to-96 (hero).

## Components (globals.css)
`.studioCard` `.chip/.chipAccent/.chipSuccess` `.scoreBarTrack/.scoreBarFill`
`.scoreBadge` `.eq` (equalizer motif) `.onAirDot` `.displayTitle` `.fadeUp`
plus studio-shell primitives in `src/app/studio/studio.css`
(`.btnPrimary` `.btnGhost` `.pageTitle` `.sectionTitle` `.axisRow` `.epCard` …).
**Rule: reach for these before writing new per-page CSS.**

## Motion
150–250ms ease; score bars grow on mount; equalizer/on-air pulse loops are
decorative and paused when idle. Everything is disabled under
`prefers-reduced-motion`. Focus states: 2px accent ring via `:focus-visible`.

## Surfaces
- **`/studio`** — the product (Home, Create, Episodes+Player, Takes, Hosts,
  Publish). User intent, product language.
- **`/admin`** — the ops console (pipeline consoles, diagnostics, providers,
  logs). Same skin, denser layout, operator language. Both are basic-auth
  protected via `src/proxy.ts`.
