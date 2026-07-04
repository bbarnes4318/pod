# Take Machine — User Surface (`/app`) Design System

A separate, LIGHT, content-forward surface for end users (listeners/creators),
inspired by best-in-class audio apps (Pocket Casts, Overcast, Apple Podcasts).
Fully independent from `/admin` (operators, untouched) and `/studio`.
All styles scoped under `.userSurface` in `src/app/app/app.css`.

## Principles
1. **Content-derived color** — the defining rule. No loud brand color painted
   everywhere. Each episode/topic derives its own accent (`src/app/app/accent.ts`):
   title hash → curated 8-hue wheel (coral, ocean, moss, amber, plum, teal,
   rose, slate); topics anchor to their sport (basketball→coral,
   football→ocean, soccer→teal…). Every accent ships three strengths:
   `tint` (cover washes), `soft` (chips/tracks), `solid` (play buttons, played
   waveform). One restrained brand blue `#3B5BFF` for nav + global CTAs only.
2. **Light and spacious** — canvas `#FCFCFD`, surfaces `#FFFFFF`, hairlines
   `#EEF0F3`, radii 14–18px, soft wide shadows only on hover/lift.
3. **Typography does the hierarchy** — Inter (next/font): hero 34/800/-2%,
   page 27/800, section 17/750, card 14.5/700, body #6B7280, meta #9AA0AB.
4. **Audio always present** — persistent bottom player bar; the played portion
   of its waveform wears the current episode's accent. Space = play/pause.
5. **Listener language** — production states read "Writing the debate…",
   "Mixing the episode…", "Ready to listen" (see `lib.ts → friendlyStage`),
   never pipeline jargon.

## Pages
| Route | Purpose |
|---|---|
| `/app` | Discover: featured hero, fresh-episodes row, trending takes (debate scores + 🔥) |
| `/app/episodes` | My episodes: playable grid + friendly in-production list |
| `/app/episodes/[id]` | Detail: accent cover, play, chapters (seek), transcript, share |
| `/app/topics` | Hot topics ranked by debate score w/ sub-score glyphs |
| `/app/hosts` | Max (coral) & Doc (ocean) persona cards |
| `/app/published` | Live episodes + feed link |
| `/app/create` | Pick take → produce → listen (reuses existing ops server actions) |
| `/app/styleguide` | Living style guide (palette, accents, type, components) |

## Components (app.css)
`uSidebar/uNavItem/uCreateBtn` · `uTopbar/uSearch/uAvatar` · `uHero/uHeroCover`
· `uEpCard/uEpCover/uEpPlay` · `uTakeCard/uTakeScore/uHeat/uRecordBtn`
· `uPlayLg/uGhostBtn` · `uPlayerBar/uPbWave` (player, `PlayerBar.tsx` context:
`play / toggle / seekFrac / playAt`).

## Data
Server components read the existing Prisma models directly; no schema or
backend changes. In local dev without a DB, Discover falls back to clearly
labeled sample data (never in production — prod shows honest empty states).
Host-B functional color: `#3E7BD6` (transcript "DOC" labels).

## Access note
`/app` is intentionally public-facing (listener surface); `/admin` and
`/studio` remain behind basic auth. Gate `/app` too in `src/proxy.ts` if that
posture changes.
