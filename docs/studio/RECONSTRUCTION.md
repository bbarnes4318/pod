# Studio reconstruction — manifest

Branch `ui/studio-reconstruction`, cut from `origin/main` @ `fd6b2c4`.
This file is the durable record: what was wrong, what the new structure is,
what has been built, what has **not**, and how to continue. Update it with
every milestone. Continue from here; do not restart the design.

---

## 1. Honest status

| | |
| --- | --- |
| Built | Workstream A (foundation) and B (creator headquarters) in full; the business half of C; the structural part of D; a first pass of E. |
| Not built | See section 7. The largest gaps are AI-assisted script revision, the three-mode episode creation, the Talent creation workflow, and the audio workspace. |
| Verified by | Local CI `fast` (exit 0), ten Playwright suites, screenshots at five widths in both themes, and a hands-on browser pass. All run in a cloud session on 2026-11-27, against the seeded test app. Section 8 has every command and result line. |
| Still failing | `show-format`: 1 of 2 desktop tests fails (expects configuration snapshot `version` 3, the pipeline writes 5). The spec and `src/lib` are byte-identical to `main`, so this is not from this branch; it was left alone because the snapshot belongs to the generation pipeline. |
| **Not verified** | Anything that needs a live provider: script generation, fact-check, voices (TTS), mix, show notes, voice design, business research runs. No LLM or TTS call was made. The tests use seeded database rows and silent audio. Production data, real cover art and long real titles have not been seen in the new layout. `full` CI (Docker image build and boot) was not run: this branch does not touch `prisma/`, the worker, the `Dockerfile`, `package.json` or startup code. |
| CI | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m48s` on commit `619b13f` (Node 20.20.2). |

The browser acceptance criteria are met **for seeded data**: screenshots at
five widths, zero serious or critical axe violations on 16 routes at three
widths in the charcoal theme, and no capture wider than its viewport. Axe was
not run in the light theme; that theme was checked by eye at 1440 only.

---

## 2. Product audit (before)

Read from the code on `main`, not from a running app.

1. **Two homes, neither a home.** `/studio` was "The Board", a sports take
   browser. A business creator landed on a sports page. Nothing on it said
   what was in production, what was stuck, or what needed a decision.
2. **Sports owned the navigation.** "Sports desk" was a top-level nav group;
   business research had no place outside an individual show's six tabs.
3. **No way to answer "what should I make next?" for business.** Topics were
   only visible per show, in unranked cards, mixed with rejected ones.
4. **Audio stopped at the page edge.** The only player lived on the episode
   page. No list could play anything; leaving the page stopped playback.
5. **Production was invisible unless you were looking at it.** State existed
   only on the one episode's console.
6. **Search found pages, not work.** The palette listed navigation only.
7. **Creators were sent to the ops console.** The episode overview linked
   `/admin/rss`, `/admin/final-audio`, `/admin/scripts`; the create flow
   linked `/app/podcasts/:id` for show settings.
8. **Identity was a generic light SaaS skin** (indigo on grey-white, Inter
   only, pills and cards on every page).
9. **Three privacy holes** (fixed here, see section 6):
   - `/studio/episodes/[id]` rendered any episode to any signed-in account.
   - `/app/episodes/[id]` rendered any episode to anyone, signed in or not.
   - `/app` Discover listed every episode with audio, whatever its owner or
     stage.

---

## 3. Information architecture (after)

Primary navigation, each named for a job:

| Destination | Route | Also lights up for |
| --- | --- | --- |
| Home | `/studio` | |
| Shows | `/studio/shows` | `/studio/shows/*` |
| Editorial desk | `/studio/desk` | `/studio/takes` |
| Episodes | `/studio/episodes` | `/studio/create` |
| Talent | `/studio/hosts` | `/studio/auditions` |
| Audio library | `/studio/audio` | |
| Publishing | `/studio/publish` | |
| Analytics | `/studio/analytics` | |

Utility (sidebar foot + account menu): Plan & usage, Settings, theme.
"Your shows" is a second sidebar section, on every page.

Global: **New episode** (topbar, `N`), **New show** (`+` beside "Your shows",
Shows page, palette), search (`Ctrl/⌘ K` or `/`), `G` then a letter to jump
(`H S D E T A P`), production activity (topbar), player dock (bottom).

Sports and Business are equal: one Editorial desk with two sides; the side
that opens follows the shows the viewer has.

---

## 4. Design system

Source of truth: the token block at the top of `src/app/studio/studio.css`,
plus `src/app/studio/control-room.css` for everything this branch added.
`docs/studio-design.md` still describes the chrome, spacing, copy and
enforcement rules, which are unchanged.

- **Two themes, one token set.** Charcoal (default) and Paper (light).
  `data-theme` on `.studioShell`, chosen by the `tm_theme` cookie, read on
  the server so the first byte of HTML is already the right theme.
- **One accent: the tally lamp** (`--accent`). Primary action, selection,
  live state. Nothing else.
- **Type.** Inter for work. Newsreader (`--font-editorial`) only where the
  product speaks as an editor: the Home briefing, a show's name, a topic's
  headline.
- **Shape.** Radius 4 / 6 / 8 / 10. Pills are status only.
- **Contrast.** Every text token was computed against every surface step in
  both themes; all pairs are ≥ 4.5:1 (lowest: `--text-subtle` on
  `--surface-3`, 4.83 dark / 4.94 light). axe-verified in the charcoal theme
  (section 8); the light theme is computed only.
- **Show art.** A show without a cover gets its initials on a token field,
  hue chosen by a stable hash of its id (`showHue`, `showInitials` in
  `src/app/studio/lib.ts`).
- **A production as one line** (`.prodRow`): lamp + state word + headline.
  State is never colour alone.

New shared components:

| Component | File | Purpose |
| --- | --- | --- |
| `StudioAudioProvider`, `PlayButton` | `StudioAudio.tsx` | One player for the Studio; survives navigation. |
| `ActivityMenu`, `ProductionRow` | `ActivityMenu.tsx` | Production state from every page. |
| `getStudioProductions` | `productions.ts` | The single read behind Home and the activity menu. |
| `searchStudio`, `getStudioActivity` | `searchActions.ts` | Owner-scoped search and activity. |
| `BusinessDesk` | `desk/BusinessDesk.tsx` | Ranked research board + evidence inspector. |

---

## 5. What was built, by workstream

### A — Product foundation (done)
- New token set and two themes; theme toggle; editorial typeface.
- Shell: flat eight-item nav, "Your shows", utility area, operator-only ops
  link, keyboard shortcuts, recents.
- Command palette: searches owned shows, episodes, talent, sports takes and
  business topics on the server; recents; shortcut hints.
- Studio-wide player dock. It yields when the episode page's own waveform
  player starts, so two things never play at once. While open it adds its own
  height to the page's bottom padding and lifts the episode action bar.
- Production activity menu, polling every 30s while the tab is visible.

### B — Creator headquarters (done)
- **Home** (`/studio`): one briefing (a fixed priority rule over real state),
  Needs you, In production, Ready to release (with play), Worth making next,
  Your shows. First-time creators get the five-step path instead.
- **Shows**: mastheads with art, purpose, cadence, last activity, New episode.
- **Show headquarters (sports)**: masthead, playable episode catalog,
  storyline board, side rail (next beat, hosts, sound and release, quality).
- **Show headquarters (business)**: masthead, pipeline-ordered sections.
- "New episode" from a show opens the rundown **inside that show**
  (`/studio/create?show=<id>`), on the Topics step.

### C — Editorial intelligence (business side done; sports side moved)
- `/studio/desk`: the sports board, unchanged in behaviour, moved off Home.
- `/studio/desk?desk=business`: every open topic across the viewer's
  business shows, ranked by the stored opportunity score, filterable by
  pipeline stage (Discover / Investigate / Approve / Produce) and by show.
  The inspector separates **measured** signals (sources cited, demand
  strength, verified claims, achieved information advantage) from
  **estimates** (opportunity score, potential advantage, confidence,
  evidence quality), lists key claims with verdicts and source links, lists
  weaknesses, and carries the existing approve / research / produce buttons.

### D — Episode production (structure done; editor not)
- Episode tabs are lifecycle stages with done / current / not-started lamps:
  Overview, Rundown, Script, Audio and mix, Release. The page opens on the
  stage that needs the visitor.
- New Rundown stage (segments from the real script).
- Promo clip lives in Release.
- Ownership check on the page (see section 6).

### E — Talent and audio (first pass)
- "Hosts" is "Talent"; voice auditions sit under it.
- Play buttons in the episode library, Home and the show catalog.

### F — Distribution and refinement (not started)

---

## 6. Route migration and compatibility

| Route | Before | Now |
| --- | --- | --- |
| `/studio` | The Board (sports) | Home |
| `/studio/desk` | did not exist | Editorial desk (sports board; `?desk=business` for research) |
| `/studio?league=…&conf=…&team=…` | Board drill-down | Redirects to `/studio/desk` with the same query. |
| `/studio/takes` | Takes | Unchanged; breadcrumb to the desk. |
| `/studio/hosts` | Hosts | Talent (same URL). |
| `/studio/create?show=<id>` | ignored | Starts the rundown inside that show. |
| `/studio/episodes/[id]#promote` | Promote tab | Opens Release (alias). |
| `/app/create`, `/app/podcasts*` | redirects into Studio | Unchanged. |
| `/app` (Discover) | every episode with audio | Published episodes only. |
| `/app/episodes/[id]` | any episode by id | Published, or the viewer's own. |
| `/app/episodes` | viewer's episodes (listening list) | **Kept.** Owner-scoped, read-only. Two e2e specs depend on it. |
| `/app/login`, `/app/signup`, `/rss*`, `/api/episodes/[id]/download` | | Unchanged. |
| `/admin/*` | operator console | Unchanged. Linked from Studio for operators only. |

No routes were deleted. No database migration. No environment variable.

---

## 7. Remaining work (exact)

Ordered by dependency. Nothing below has been started unless it says so.

**Must happen before merge**
Items 1 to 4 of the original list (CI, Playwright, five-width screenshots,
both themes) are done; see section 8. What is left:
1. Decide what to do about `show-format` (failing on `main` too; see section 1).
2. Run axe with the `tm_theme=light` cookie. Not done.
3. One real episode through the whole pipeline on the deployed app, to see
   real titles, real audio and a real business dossier in the new layout.

**Known rough edges seen in the screenshots, not fixed**
- Business show page at 390px: the show's name is squeezed out of the topbar by
  "Run discovery" (the crumb and subbar still say where you are).
- Editorial desk, business side, below 1100px: the inspector sits above the
  list. Deliberate (tapping a row reloads to the top), but worth a second look.
- The Audio library is skinned, not redesigned.

**Workstream B**
- Show creation: Quick start (AI recommends a whole configuration from a
  sentence) beside the existing Show Forge. Needs a new server action over
  the existing LLM routing; Show Forge is the Custom path.
- Business show Overview: fold "Deeper context" and the checklist into the
  masthead layout.

**Workstream C**
- Sports desk: give takes the same inspector (the research brief exists on
  `TopicCandidate.researchBrief`).

**Workstream D**
- Episode creation in three named modes. The existing `mode`
  (manual / automatic / hybrid) maps onto Manual / AI Producer / Guided;
  this is presentation over `RundownBuilder`, which should be split into
  per-step modules while doing it. `studio-rundown.spec.ts` is the contract.
- Business episodes are created from the desk, not from `/studio/create`.
  The create flow should offer the viewer's business shows and hand off.
- Script editor: select a passage and ask for a revision. **No such service
  exists**; it needs a new server action that calls the script model, shows
  a preview, and on accept goes through the same save path as a manual edit
  so verification and audio are invalidated exactly as they are today.
- Quality control view: one list of release blockers versus warnings,
  linking to the line. The data is in `getEpisodeTranscriptVM().gate`,
  `evaluateDownstreamBlock` and `businessVerification`.

**Workstream E**
- Talent library as casting cards with voice preview; the creation workflow
  in Identity / Personality / Performance / Voice / Review steps over the
  existing `CharacterStudio` fields.
- Audio workspace: `MixView` and `StudioPlayer` in one timeline composition.

**Workstream F**
- Episode library: artwork grid view beside the table.
- Publishing as a release checklist (`getPublishState().publishBlockers`).
- Analytics: distinguish "no data yet" from zero.
- A mobile bottom bar. Today the phone layout is the desktop one with the
  nav in a drawer.

---

## 8. What was actually run

### 8a. Cloud validation, 2026-11-27 (final code commit `619b13f`)

Linux container, Node 20.20.2, Docker for CI's PostgreSQL 16 and Redis 7,
Playwright 1.61.1 with Chromium. The app under test is `next dev` on port 3311
with a throwaway seeded PostgreSQL (`tests/e2e/global-setup.ts`). **No LLM,
TTS, research or payment provider was called by anything below.**

| Command | Result line |
| --- | --- |
| `bash scripts/ci/run.sh fast` (first run, commit `ef9a168`) | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m49s` |
| `bash scripts/ci/run.sh fast` (final, commit `619b13f`) | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m48s`, exit 0 |
| `npm run build` | Ran as CI's `build` step in a clean export: `PASS build (45s)` |

Playwright, one suite at a time, `npx playwright test tests/e2e/<suite>.spec.ts --trace off`.
Final result on the final code unless noted. "Skipped" is the suites' own
desktop-only guard on the tablet and phone projects, not something switched off.

| Suite | Final | First run on this branch |
| --- | --- | --- |
| `studio-tokens` | 12 passed | 12 passed |
| `studio-chrome` | 60 passed | 57 passed, 3 failed (Home first-control budget) |
| `studio-a11y` | 54 passed | 52 passed, 2 failed (focus probe landed on Next's dev badge) |
| `studio-board` | 27 passed | 27 passed |
| `studio-rundown` | 24 passed, 42 skipped | same |
| `owner-isolation` | 10 passed, 20 skipped | 8 passed, 2 failed (test read the page too early) |
| `sound-diversity` | 11 passed, 22 skipped | 2 passed, 9 failed (waited for the wrong shell; fails on `main` too) |
| `player-bar-overlap` | 2 passed, 4 skipped | same (run before the last CSS commits; it tests `/app`, which they do not touch) |
| `audio-asset-isolation` | 5 passed, 10 skipped | same (as above) |
| `show-format` | **1 passed, 1 failed**, 4 skipped | same. Not fixed; see section 1 |
| `studio-screenshots` (`SHOT_PHASE=after BUSINESS_PODCASTS_ENABLED=1`) | 126 passed, 89 skipped | 126 captures; `overflow.json` listed 3 pages wider than their viewport, now none |

**Bugs found and fixed in the product**
- `/studio?league=NFL` did redirect, but late: Home's skeleton flashed and the
  browser logged a React error. Now a real HTTP 307 from `src/proxy.ts`.
- Phone topbar: page actions pushed the title out and the business show page
  scrolled sideways (483px in a 390px viewport).
- Two "New episode" buttons side by side in a show page's topbar.
- Command palette results overlapped each other at 390px.
- Audio library: bare browser controls on charcoal, sideways scroll at 390 and
  1280, and (once it scrolled inside itself) a table the keyboard could not reach.

**Assertions changed, and why**
- `studio-chrome`: Home is a documented exception to the 160px first-control
  budget, held at 240px (measured 186 / 214 / 236). Home opens on a sentence
  and then its button; the button cannot come first. Intentional new design.
- `studio-a11y`: the focus-ring probe ignores `<nextjs-portal>`, Next's
  dev-mode badge, which is not in a production build.
- `owner-isolation`: the six open-by-URL tests now wait for the not-found page
  instead of reading the body once. Stricter, not looser: the new episode leak
  checks could previously pass on a half-loaded page.
- `sound-diversity`: waits for the Studio shell instead of the `/app` player
  bar, which the sound page stopped rendering in when it moved into the Studio.

**Harness changes** (no test logic)
- `global-setup.ts`: makes the throwaway database directory usable when the
  run is root (embedded PostgreSQL drops privileges and could not start).
- `playwright.config.ts`: 1920x1080 and 1280x800 projects, only when
  `SHOT_PHASE` is set, so the assertion suites still run three widths.
- `studio-screenshots.spec.ts`: adds its own business show, research topics and
  a finished episode (the shared seed has none), a light-theme pass, UI-state
  captures, and the overflow report.

**Screenshots** (`docs/ux-audit/after/`, 129 files): 19 routes at 1920, 1440,
1280, 768 and 390 in charcoal; the same 19 at 1440 in light; and
`state-*` for the collapsed sidebar, activity menu, phone drawer, command
palette and player dock. Looked at: every phone capture of the pages this
branch built, the tablet set for Home, desk, show and episode, the light set
for Home, desk and episode, and all `state-*`. Not every one of the 129 was
opened; the overflow report covers all of them for sideways scroll.

**By hand in the browser** (a scripted Chromium session, results read back)
- Ctrl+K: "overtime" returns The Overtime Show; "awaiting" returns the
  episode and Enter opens it; another account's rows never appear. Pass.
- `G` then `S` / `D` / `E` land on Shows, Editorial desk, Episodes. Pass.
- Theme toggle: sets `tm_theme`, the server's HTML already carries
  `data-theme="light"` on reload (so no flash), toggles back. Pass.
- Play from the Episodes list, navigate to Shows, then Home: still playing,
  position advancing (2.4s, 4.5s, 6.1s). Pass.
- Starting the episode page's own player pauses the dock. Pass. The action bar
  sits directly above the dock (775-836 and 836-900 of 900), no overlap.
- `/studio/create?show=<id>` opens on step 2, Topics, inside that show. Pass.
- `/studio?league=NFL`: failed cleanly at first (see bugs); passes after the fix.
- The seeded script-draft episode opens on the Script stage. Pass.

### 8b. Before the cloud run (owner's machine, no browser)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | clean (no output) |
| `testTopicFreshnessAutomation` | PASS |
| `testShowForgeDiscoverability` | 16 passed, 0 failed (was failing on `main`: it asserted the copy "Build a show", which `main` no longer has; the assertion now checks the "New show" action) |
| `testShowForgeCapabilities` | 10 passed, 0 failed |
| `testBusinessIntelligence` | 29 passed, 0 failed |
| `testHostStudioCapabilities` | 12 passed, 0 failed |
| `testProductionChain` | 14 passed, 0 failed |
| `testHonestControls` | 9 passed, 0 failed |

### 8c. Never run

| Check | Why |
| --- | --- |
| Live LLM / TTS / research | Needs provider credit. Not attempted, not faked. |
| `bash scripts/ci/run.sh full` | Not required for this change (see section 1). |
| axe in the light theme | Not done. |
| lint (`npm run lint`) on its own | Not run separately. |

---

## 9. Capability preservation

Nothing in `src/lib`, `prisma/`, the worker, the queue, prompts or providers
was changed. Every server action keeps its signature.

| Capability | Touched? | Where it is now |
| --- | --- | --- |
| Sports intelligence, take board | Moved | `/studio/desk` |
| Business research, dossiers, approval | Presentation added | Show page (unchanged) + desk |
| Topic lifecycle, freshness window | No | |
| Show configuration, Show Forge | No | Show page disclosure, `/studio/shows/new` |
| Host personality, voice design, provenance | Renamed only | Talent |
| TTS providers, model routing | No | |
| Script generation, fact-check | No | Episode, Script stage |
| Editorial gate, release gate, publish gate | No | Episode Overview and Release |
| Sound design, mix, line regeneration | No | Episode, Audio and mix |
| Continuity, listener learning | No | |
| Queue contracts, job logs | Read only | Home, activity menu |
| Auth, ownership | **Tightened** | Three reads now enforce it |
| Existing episodes, shows, RSS, audio URLs | No | |

---

## 10. Deploy and rollback

- No migration, no new environment variable, no worker change.
- Merging to `main` deploys web and worker automatically.
- After deploy, `/api/readiness` shows the commit.
- **Rollback:** revert the merge commit and let it deploy. Nothing to undo in
  the database. A `tm_theme` cookie left in a browser is ignored by the old
  code.
- One behaviour change users will notice immediately: `/studio` is Home, and
  the sports board is under "Editorial desk".

---

## 11. Decisions worth knowing

- **Charcoal is the default theme.** The brief asked for a production
  aesthetic; the light theme is one click away and remembered.
- **The briefing is a rule, not a model.** Same state, same advice, every
  word read from a row. An LLM-written briefing would be slower, cost money
  on every page view, and could say something untrue.
- **Home reads full progress for at most 8 in-flight episodes** (about ten
  queries each). Marked `ponytail:` in `productions.ts` with the upgrade
  path.
- **`/app/episodes` stays.** It is an owner-scoped listening list, and two
  specs that cannot be run here depend on it.
- **Competitive study was not done in a browser.** The structural choices
  (command palette and `G` chords, a persistent player dock, a list-plus-
  inspector research board, lifecycle stages as the episode's navigation)
  come from general knowledge of Linear, Spotify for Creators, Descript and
  NotebookLM, not from fresh inspection of them.
